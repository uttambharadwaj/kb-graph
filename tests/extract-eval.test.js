import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Prompt regressions for kb_extract, replayed against the real model — slow,
// non-deterministic, and needs the claude CLI, so it is opt-in:
//   KB_EVAL=1 node --test tests/extract-eval.test.js
const tmp = mkdtempSync(join(tmpdir(), 'kb-extract-eval-'));
process.env.KB_DIR = tmp;

const { extractFacts, chunkForExtract, canonicalTriple } = await import('../src/extract.js');

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
    const { facts } = await extractFacts(
      'decimalToScaledInteger in ux-labs was fixed for negative decimals, in PR #3798.',
    );
    const broken = facts.filter(f =>
      f.subject.toLowerCase().includes('decimal') &&
      /incorrect|broken|fails|mishandl|bug|wrong/.test(`${f.predicate} ${f.object}`.toLowerCase()));
    assert.deepStrictEqual(broken, [], 'stamped the pre-fix state as currently true');
  });

  // Observed 2026-07-29: every stated fact dropped in favour of two inferences,
  // with skipped: [] claiming nothing was passed over.
  it('records stated PR/commit/reviewer facts, or admits skipping them', async () => {
    const { facts, skipped } = await extractFacts(`
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
    const { facts } = await extractFacts(
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
    const { facts } = await extractFacts(
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
    const { facts } = await extractFacts(
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
    const { facts } = await extractFacts(
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

  // The chunking ticket's own case: a claim and the very next sentence that
  // qualifies it, split onto either side of a chunk boundary by unrelated
  // preceding text. Measured on this exact input: 1/1 dropped the qualifier
  // before neighbours were passed as context (skipped as "pronoun with no
  // antecedent" — the qualifying sentence never saw what "This" referred to),
  // 1/1 recovered it after.
  it('recovers a qualifier split from its claim by a chunk boundary', async () => {
    const text = 'The team spent the morning triaging billing alerts after a spike in webhook retries. '
      + 'Most of the retries turned out to be a benign side effect of a provider maintenance window. '
      + 'Production Metronome configuration points at sandbox Metronome. '
      + 'This is temporary and tracked by TICKET-42 for revert.';
    const chunks = chunkForExtract(text);
    assert.notStrictEqual(
      chunks.findIndex(c => c.includes('This is temporary')),
      chunks.findIndex(c => c.includes('Production Metronome configuration')),
      'fixture no longer splits the claim from its qualifier onto different chunks — re-pad it',
    );

    const { facts } = await extractFacts(text);
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
    const { facts } = await extractFacts(
      'PR #48 is still open and not merged; it is approved and in the merge queue.',
    );
    const statuses = facts.filter(f => f.predicate.toLowerCase() === 'status');
    assert.ok(statuses.length <= 1, `${statuses.length} status rows for one PR: ${JSON.stringify(statuses)}`);
    assert.ok(mentions(facts, 'approved'), 'dropped the review state instead of moving it off status');
  });

  // Observed in production on the ticket-in-parentheses shape below: the ticket
  // landed in the subject of `implements`, which asserts that a ticket built
  // something and leaves "what implements tkt-99" unanswered. Asserted on the
  // canonical triple, since that is what reaches the graph — generation is not
  // reproducible enough to gate on the raw emission, and the guard that has to
  // hold is that no work item is ever stored as an implementer.
  it('never stores a work item as the implementer', async () => {
    const { facts } = await extractFacts(
      'PR #48 (tkt-99, the threshold config client) merged to main on 2026-07-30 as squash commit 380c761.',
    );
    // implements only: a work item cannot build code, but it can target a
    // problem, so it is a legitimate subject of fixes/addresses/closes.
    const inverted = facts.map(canonicalTriple).filter(f =>
      f.predicate === 'implements' && /^tkt-\d+$/i.test(f.subject.trim()));
    assert.deepStrictEqual(inverted, [], 'stored a ticket as the thing doing the implementing');
    assert.ok(mentions(facts, 'tkt-99'), 'dropped the ticket the PR belongs to');
  });
});
