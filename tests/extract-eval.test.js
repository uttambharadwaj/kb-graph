import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

// Prompt regressions for kb_extract, replayed against the real model — slow,
// non-deterministic, and needs the claude CLI, so it is opt-in:
//   KB_EVAL=1 node --test tests/extract-eval.test.js
const tmp = mkdtempSync(join(tmpdir(), 'kb-extract-eval-'));
process.env.KB_DIR = tmp;
const corpus = JSON.parse(readFileSync(
  new URL('./fixtures/extract-debrief-corpus.json', import.meta.url),
  'utf8',
));
// A prompt score is only comparable when the model is fixed too. Pin the
// corpus run before claude-cli.js reads its module-load default.
process.env.CLASSIFY_MODEL = corpus.baseline.model;

const {
  extractFacts,
  chunkForExtract,
  canonicalTriple,
  EXTRACT_PROMPT,
  extractPromptWithoutRule,
} = await import('../src/extract.js');
const { scoreExtractCorpus } = await import('./helpers/extract-corpus.js');

const omittedRule = process.env.KB_EXTRACT_OMIT_RULE;
const evalPrompt = omittedRule === undefined
  ? EXTRACT_PROMPT
  : extractPromptWithoutRule(Number(omittedRule));
const runEval = text => extractFacts(text, { basePrompt: evalPrompt });

const mentions = (facts, token) =>
  facts.some(f => `${f.subject} ${f.predicate} ${f.object}`.toLowerCase().includes(token));

// 15 minutes for the suite: a case is one model call per chunk and a
// multi-chunk case runs to ~110s on its own, so a budget sized for the old
// single-sentence cases cancels the newer ones and reports it as a failure.
describe('kb_extract prompt behaviour', { skip: !process.env.KB_EVAL, timeout: 900000 }, () => {
  after(() => rmSync(tmp, { recursive: true, force: true }));

  // Observed 2026-07-28: extracted "decimalToScaledInteger incorrectly_handles
  // negative_decimals" — the problem, out of a sentence stating the fix.
  it('extracts the post-change state from a "was fixed" sentence', async () => {
    const { facts } = await runEval(
      'decimalToScaledInteger in sample-web was fixed for negative decimals, in PR #3798.',
    );
    const broken = facts.filter(f =>
      f.subject.toLowerCase().includes('decimal') &&
      /incorrect|broken|fails|mishandl|bug|wrong/.test(`${f.predicate} ${f.object}`.toLowerCase()));
    assert.deepStrictEqual(broken, [], 'stamped the pre-fix state as currently true');
  });

  // Observed 2026-07-29: every stated fact dropped in favour of two inferences,
  // with skipped: [] claiming nothing was passed over.
  it('records stated PR/commit/reviewer facts, or admits skipping them', async () => {
    const { facts, skipped } = await runEval(`
On 2026-07-29, PR #539 in acme-co/billing-api was squash-merged to main as
commit fde94d6 by robin. It was approved by dana. The merge triggered workflow
container_CD_frontend.yml run 30422764087, which deployed the billing frontend to
production successfully. CodeRabbit reviewed PR #539 and raised one Major finding about regex
head-injection, which was fixed in commit b1d6832.`);

    const accounted = skipped.map(s => JSON.stringify(s).toLowerCase()).join(' ');
    for (const token of ['fde94d6', 'dana', 'production', 'coderabbit', 'b1d6832']) {
      assert.ok(
        mentions(facts, token) || accounted.includes(token),
        `"${token}" is stated in the input but appears in neither facts nor skipped`,
      );
    }
    assert.ok(mentions(facts, '539'), 'PR #539 was not treated as an entity');
  });

  // Observed once in production 2026-07-29: wrote "production_metronome
  // misconfigured_to sandbox_metronome" from a sentence calling the pointing
  // deliberate. Subject and object right; the predicate supplied a judgment the
  // text contradicts, which reads downstream as a finding, not a description.
  //
  // This case has never been reproduced: 0/6 on the pre-fix prompt from the
  // sentence alone, 0/6 embedded in a full debrief, and 0/6 with the qualifier
  // stripped (the shape a split chunk produces — see the chunking ticket). It is a guard
  // for a rule we believe in, not a regression test for a measured failure.
  it('does not editorialize a deliberate configuration into a defect', async () => {
    const { facts } = await runEval(
      'Production Metronome and Stripe configuration points at sandbox Metronome and Stripe test mode, ' +
      'which is temporary and tracked by TICKET-42 for revert.',
    );
    const judged = facts.filter(f =>
      /misconfigur|broken|violat|wrong|incorrect|bad_/.test(f.predicate.toLowerCase()));
    assert.deepStrictEqual(judged, [], 'asserted a defect the source called deliberate');
    assert.ok(
      mentions(facts, 'metronome') || mentions(facts, 'stripe'),
      'dropped the configuration fact entirely rather than describing it neutrally',
    );
  });

  // Observed 2026-07-29: wrote "wallet_identity migrated_to users_row" from a
  // sentence saying the eight PRs doing it are all open. Past-tense predicate
  // for unmerged work — the completion is asserted before it happens.
  // Reproduces: 3/6 runs on the pre-fix prompt (migrated_to, moved_to), 0/6 with
  // the tense rule. This one is a real regression test.
  it('does not report in-flight work as completed', async () => {
    const { facts } = await runEval(
      'Alice owns an 8-PR stack moving wallet identity off the wallets table and onto the users row. ' +
      'All eight PRs are still open.',
    );
    const completed = facts.filter(f =>
      /^(migrated_to|moved_to|renamed_to|replaced_by)$/.test(f.predicate.toLowerCase()));
    assert.deepStrictEqual(completed, [], 'asserted a migration the source says is unmerged');
    // Without this the test passes on an empty extraction, which is not the
    // behaviour being bought — the work still has to be recorded, as a proposal.
    assert.ok(mentions(facts, 'wallet'), 'dropped the in-flight migration instead of recording it');
  });

  // The mirror of the case above: a state the text says has ENDED, with nothing
  // naming what replaced it. Reproduced 1/1 on the pre-fix prompt as "harvest
  // reads model_calls_as_work_sessions" — present tense, from "used to read".
  // The past event is still wanted; only the past state is not.
  it('does not report an ended state as current', async () => {
    const { facts } = await runEval(
      'Harvest used to read its own model calls as if they were work sessions. That caused the backlog.',
    );
    const current = facts.filter(f =>
      /^(reads|processes|includes|treats)$/.test(f.predicate.toLowerCase()) &&
      /model.call|own.call/.test(f.object.toLowerCase()));
    assert.deepStrictEqual(current, [], 'asserted a behaviour the source says has ended');
    assert.ok(mentions(facts, 'backlog'), 'dropped the past event too — only the past state should go');
  });

  // The one that mattered most, because it is invisible without the fix.
  // English simple past says both "was and still is" and "was and no longer
  // is", and the sentence that disambiguates is the *next* one — which the
  // ~250-char split routinely puts in another chunk. Measured on this exact
  // text: 3/3 runs emitted a false current fact before neighbours were passed
  // as context, 0/3 after.
  it('uses neighbouring chunks to tell an ended state from a current one', async () => {
    const { facts } = await runEval(
      'The team spent the morning tracing a duplicate-note problem in the knowledge base. ' +
      'Several notes on the same subject had accumulated over three weeks without anyone noticing. ' +
      'The investigation began by measuring the two code paths against each other on identical input. ' +
      'The duplicate threshold was declared in three modules and the debrief skill instructed callers ' +
      'to use 0.7, while the write used 0.85. PR #22 moved DUP_THRESHOLD into src/embeddings/search.js ' +
      'and added a shared duplicatesIn verdict function that both paths call. ' +
      'The skill was corrected at the same time to pass no threshold at all.',
    );
    const stale = facts.filter(f => /0\.7|three.modules/i.test(`${f.subject} ${f.predicate} ${f.object}`));
    assert.deepStrictEqual(stale, [], 'dated the pre-fix configuration today');
    assert.ok(mentions(facts, '22') || mentions(facts, 'dup_threshold'), 'dropped the change itself');
  });

  // The chunking case: a claim and the very next sentence that qualifies it,
  // pushed onto either side of a chunk boundary by unrelated preceding text.
  // Measured on this exact input while the boundary still separated them: 3 of
  // 12 runs dropped the qualifier and emitted a bare "points_at", every one of
  // them skipping the qualifier as a pronoun with no antecedent. The extractor
  // could see the referent in its context block and would not use it — "per
  // instructions, surrounding text is context-only, not a source to mine for
  // facts", in its own words. Passing neighbours as context cannot fix that by
  // construction; the qualifier has to be in the chunk.
  it('recovers a qualifier split from its claim by a chunk boundary', async () => {
    const text = 'The team spent the morning triaging billing alerts after a spike in webhook retries. '
      + 'Most of the retries turned out to be a benign side effect of a provider maintenance window. '
      + 'Production Metronome configuration points at sandbox Metronome. '
      + 'This is temporary and tracked by TICKET-42 for revert.';
    const chunks = chunkForExtract(text);
    // The premise of the case, and what makes it deterministic: the chunker
    // fuses the pair, so one chunk carries both. Asserted here so a chunker
    // change that splits them again is reported as the cause rather than
    // showing up as a model that went flaky. Deterministic coverage of the
    // same property lives in tests/extract-context.test.js.
    assert.ok(chunks.length > 1, 'fixture no longer splits at all — re-pad it');
    assert.strictEqual(
      chunks.findIndex(c => c.includes('This is temporary')),
      chunks.findIndex(c => c.includes('Production Metronome configuration')),
      'the chunker split the claim from its qualifier again',
    );

    const { facts } = await runEval(text);
    const judged = facts.filter(f => /misconfigur|broken|violat|wrong|incorrect|bad_/.test(f.predicate.toLowerCase()));
    assert.deepStrictEqual(judged, [], 'asserted a defect the source called deliberate');
    assert.ok(
      mentions(facts, 'ticket-42') || facts.some(f => /deliberat|temporary|revert/.test(f.predicate.toLowerCase())),
      'dropped the qualifier that the chunk split put out of view',
    );
  });

  // Reproduced on the pre-fix prompt from this sentence: three "statuses" for
  // one PR in production, two in a replay here. They are three variables —
  // lifecycle, review, merge queue — flattened onto one predicate name, and
  // consolidation reads them as competing values of one, so all but the last
  // are retired the moment they are written.
  it('does not flatten lifecycle, review and queue standing onto one status', async () => {
    const { facts } = await runEval(
      'PR #48 is still open and not merged; it is approved and in the merge queue.',
    );
    const statuses = facts.filter(f => f.predicate.toLowerCase() === 'status');
    assert.ok(statuses.length <= 1, `${statuses.length} status rows for one PR: ${JSON.stringify(statuses)}`);
    assert.ok(mentions(facts, 'approved'), 'dropped the review state instead of moving it off status');
  });

  // Replaying one identical input three times produced source_of_truth_for
  // twice and is_source_of_truth_for once — one relationship, two edges, and
  // neither can retire the other. The copula is not a choice the prompt can take
  // away, so the guard is on the stored triple: whatever the model types, the
  // canonical predicate carries no leading copula.
  it('stores no predicate under a leading copula', async () => {
    const { facts } = await runEval(
      'The wallet ledger is the source of truth for balances now, replacing the mirror.',
    );
    const copular = facts.map(canonicalTriple)
      .filter(f => /^(is|are|was|were|be)_/.test(f.predicate));
    assert.deepStrictEqual(copular, [], 'a copula-prefixed predicate reached the graph');
    assert.ok(mentions(facts, 'ledger'), 'dropped the relationship instead of describing it');
  });

  // Observed in production on the ticket-in-parentheses shape below: the ticket
  // landed in the subject of `implements`, which asserts that a ticket built
  // something and leaves "what implements tkt-99" unanswered. Asserted on the
  // canonical triple, since that is what reaches the graph — generation is not
  // reproducible enough to gate on the raw emission, and the guard that has to
  // hold is that no work item is ever stored as an implementer.
  it('never stores a work item as the implementer', async () => {
    const { facts } = await runEval(
      'PR #48 (tkt-99, the threshold config client) merged to main on 2026-07-30 as squash commit 380c761.',
    );
    // implements only: a work item cannot build code, but it can target a
    // problem, so it is a legitimate subject of fixes/addresses/closes.
    const inverted = facts.map(canonicalTriple).filter(f =>
      f.predicate === 'implements' && /^tkt-\d+$/i.test(f.subject.trim()));
    assert.deepStrictEqual(inverted, [], 'stored a ticket as the thing doing the implementing');
    assert.ok(mentions(facts, 'tkt-99'), 'dropped the ticket the PR belongs to');
  });

  it('uses one source-grounded spelling for a repeated entity', async () => {
    const { facts } = await runEval(
      'TKT-71 is owned by team Platform Foundations. '
      + 'TKT-72 is owned by team Platform Foundations. '
      + 'TKT-73 is owned by team Platform Foundations.',
    );
    const ownership = facts.filter(f => /owns|assigned_to/.test(f.predicate));
    assert.ok(ownership.length >= 2, `dropped the repeated ownership facts: ${JSON.stringify(facts)}`);

    const ownerOf = f => /^tkt-\d+$/i.test(f.subject.trim()) ? f.object : f.subject;
    const owners = new Set(ownership.map(f => ownerOf(f).toLowerCase().replace(/[\s_-]+/g, '_')));
    assert.strictEqual(owners.size, 1,
      `invented multiple spellings for one source entity: ${JSON.stringify(ownership)}`);
  });

  it('emits each referenced PR as its own fact', async () => {
    const { facts } = await runEval(
      'PR #101 merged to main. PR #102 merged to main. Both changes shipped on 2026-08-29.',
    );
    assert.ok(mentions(facts, '#101') || mentions(facts, '101'), 'dropped PR #101');
    assert.ok(mentions(facts, '#102') || mentions(facts, '102'), 'dropped PR #102');
    assert.ok(!facts.some(f => /#?101.*#?102|#?102.*#?101/.test(String(f.object))),
      `joined two PRs into one object: ${JSON.stringify(facts)}`);
  });

  it('keeps only the corrected state', async () => {
    const { facts } = await runEval(
      'Correction: billing-api does not use Redis for its ledger. It uses Postgres.',
    );
    assert.ok(mentions(facts, 'postgres'), `dropped the corrected state: ${JSON.stringify(facts)}`);
    assert.ok(!facts.some(f => /redis/i.test(`${f.predicate} ${f.object}`)),
      `kept the retracted Redis state: ${JSON.stringify(facts)}`);
  });

  it('keeps the terminal state of a narrated transition', async () => {
    const { facts, skipped } = await runEval(
      "Two pre-launch support adjustments were repaired on production — flipped to pending and driven through the shipped mirror; the ledger and Metronome now agree.",
    );
    const status = facts.filter(f => f.predicate === 'status');
    assert.ok(!status.some(f => /pending/i.test(f.object)),
      `recorded the transient step as current: ${JSON.stringify(status)}`);
    assert.ok(facts.length > 0 || skipped.length > 0,
      `returned no disposition for the narrated transition: ${JSON.stringify({ facts, skipped })}`);
  });

  it('does not treat a commit mention as merge evidence', async () => {
    const { facts } = await runEval(
      'PR #42 has commit abc1234 with the fix, but the PR is still open and awaiting review.',
    );
    assert.ok(mentions(facts, '#42') || mentions(facts, '42'), 'dropped the open PR');
    assert.ok(!facts.some(f => f.predicate === 'merged_via' || (f.predicate === 'status' && /merged/.test(f.object))),
      `invented merge evidence: ${JSON.stringify(facts)}`);
  });

  it('does not turn acknowledgments or speculation into facts', async () => {
    const { facts } = await runEval(
      'Makes sense. I think the billing service might move to Kafka someday, but nobody has proposed or decided that.',
    );
    assert.deepStrictEqual(facts, [], `recorded acknowledgment or speculation: ${JSON.stringify(facts)}`);
  });

  it('uses a listed atomic predicate for a multi-clause relationship', async () => {
    const { facts, skipped } = await runEval(
      'PR #12 merged to main and that merge deployed billing-api to production.',
    );
    const accounted = `${JSON.stringify(facts)} ${JSON.stringify(skipped)}`.toLowerCase();
    assert.match(accounted, /#12|pr 12/, 'did not account for the merge');
    assert.match(accounted, /production/, 'did not account for the deployment');
    assert.ok(!facts.some(f => /merge.*deploy|deploy.*merge/.test(f.predicate)),
      `built a compound predicate: ${JSON.stringify(facts)}`);
  });

  it('stores assignment with the ticket as subject', async () => {
    const { facts } = await runEval('TKT-42 is assigned to Alice.');
    assert.ok(facts.some(f => /^tkt-42$/i.test(f.subject) && f.predicate === 'assigned_to' && /alice/i.test(f.object)),
      `stored assignment in the wrong direction: ${JSON.stringify(facts)}`);
  });

  it('keeps the grammatical owner as the subject', async () => {
    const { facts } = await runEval(
      'The Codex CLI enabled_tools list for the knowledge-base MCP server contains 35 tools.',
    );
    assert.ok(!facts.some(f => /knowledge.?base/i.test(f.subject) && f.predicate === 'supports' && /codex/i.test(f.object)),
      `inverted the client-owned property: ${JSON.stringify(facts)}`);
    assert.ok(mentions(facts, '35') || mentions(facts, 'enabled_tools'),
      `dropped the client-owned fact: ${JSON.stringify(facts)}`);
  });

  it('uses a stated event date', async () => {
    const { facts } = await runEval('PR #77 merged to main on 2026-08-29.');
    const merged = facts.find(f => /#?77/.test(`${f.subject} ${f.object}`));
    assert.ok(merged, `dropped the dated merge: ${JSON.stringify(facts)}`);
    assert.strictEqual(merged.valid_from, '2026-08-29');
  });

  it('records one recall score for the held-out debrief corpus', async () => {
    const promptSha256 = createHash('sha256').update(EXTRACT_PROMPT).digest('hex');
    assert.strictEqual(
      promptSha256,
      corpus.baseline.prompt_sha256,
      'extract prompt changed; record a fresh corpus baseline for this revision',
    );

    const predictions = [];
    for (const fixture of corpus.cases) {
      const { facts } = await runEval(fixture.input);
      predictions.push({ id: fixture.id, facts });
    }

    const score = scoreExtractCorpus(corpus, predictions);
    assert.strictEqual(score.expected, corpus.baseline.expected);
    assert.ok(
      score.matched >= corpus.baseline.matched,
      `held-out recall regressed: ${score.matched}/${score.expected} < baseline ${corpus.baseline.matched}/${corpus.baseline.expected}; missing ${JSON.stringify(score.cases.filter(item => item.missing.length > 0))}`,
    );
    console.log(`KB_EXTRACT_CORPUS_SCORE ${JSON.stringify({
      ...score,
      baseline_matched: corpus.baseline.matched,
      matched_delta: score.matched - corpus.baseline.matched,
    })}`);
  });
});
