import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Point the KB at a throwaway dir BEFORE importing anything that opens the DB.
const tmp = mkdtempSync(join(tmpdir(), 'kb-extract-'));
process.env.KB_DIR = tmp;

// Per-install cardinality override — read at module load, so write it first.
writeFileSync(join(tmp, 'predicates.json'), JSON.stringify({
  single_valued: ['pinned_to'],
  many_valued: ['version'],
  // No built-in single-valued predicate has an alias, so the override supplies
  // one — otherwise the stored-predicate normalisation has no retirement path
  // left to exercise.
  aliases: { pinned_at: 'pinned_to' },
}));

// Fake claude so kbExtract's plumbing is testable without the model. It answers
// off the prompt it is fed, so one stub covers both response shapes.
const fakeClaude = join(tmp, 'fake-claude.sh');
const envelope = payload => JSON.stringify({ result: JSON.stringify(payload) });
writeFileSync(fakeClaude, `#!/bin/sh
prompt=$(cat)
echo x >> "$KB_DIR/calls"   # so tests can assert how many times the model was asked
case "$prompt" in
  *DEAD_CHUNK*) exit 3 ;;
  *"preview me"*) echo '{"result": "{\"facts\": [{\"subject\": \"pr #777\", \"predicate\": \"merged_via\", \"object\": \"commit abc1234\"}], \"skipped\": []}"}' ;;
  *"alias me"*) echo '${envelope({
    facts: [{ subject: 'pr #888', predicate: 'merged_as', object: 'commit def5678' }],
    skipped: [],
  })}' ;;
  *"contradict me"*) echo '${envelope({
    facts: [
      { subject: 'pr #999', predicate: 'status', object: 'open' },
      { subject: 'pr #999', predicate: 'status', object: 'approved' },
    ],
    skipped: [],
  })}' ;;
  *LEGACY_NO_SKIPPED*) echo '${envelope({ facts: [{ subject: 'a', predicate: 'b', object: 'c' }] })}' ;;
  *) echo '${envelope({
    facts: [{ subject: 'pr #539', predicate: 'merged_via', object: 'commit fde94d6' }],
    skipped: [{ assertion: 'CodeRabbit raised a Major finding', reason: 'resolved in the same PR' }],
  })}' ;;
esac
`);
chmodSync(fakeClaude, 0o755);
process.env.CLAUDE_PATH = fakeClaude;

const { consolidate, kbExtract, chunkForExtract, extractFacts, canonicalTriple, MAX_EXTRACT_CHARS } = await import('../src/extract.js');
const callCount = () => (existsSync(join(tmp, 'calls')) ? readFileSync(join(tmp, 'calls'), 'utf-8').trim().split('\n').length : 0);
const { initFactSchema, addFact, queryFact, invalidateFact, mergeEntity } = await import('../src/facts.js');

const currentObject = (subject, predicate) =>
  queryFact(subject, { direction: 'outgoing' })
    .filter(r => r.current && r.predicate === predicate)
    .map(r => r.object);

describe('kb_extract consolidation', () => {
  before(() => initFactSchema());
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('adds new facts and keeps the corrected one over a retracted alternative', () => {
    // The extractor already drops the retracted "SQS" claim, so it only emits HTTP.
    const res = consolidate([
      { subject: '1password bare domains', predicate: 'drops', object: 'credentials' },
      { subject: 'alice', predicate: 'owns', object: 'auth-service' },
      { subject: 'my-app', predicate: 'calls_over_http', object: 'auth-service' },
    ], { source: 'test', observationDate: '2026-06-24' });

    assert.strictEqual(res.added.length, 3);
    assert.strictEqual(res.invalidated.length, 0);
    assert.deepStrictEqual(currentObject('my-app', 'calls_over_http'), ['auth-service']);
  });

  it('retires a stale fact when a new one contradicts it (in_review -> done)', () => {
    addFact('pf-4100', 'status', 'in_review', { validFrom: '2026-01-01', source: 'seed' });
    assert.deepStrictEqual(currentObject('pf-4100', 'status'), ['in_review']);

    const res = consolidate(
      [{ subject: 'pf-4100', predicate: 'status', object: 'done' }],
      { source: 'test', observationDate: '2026-06-24' },
    );

    assert.strictEqual(res.invalidated.length, 1);
    assert.strictEqual(res.added.length, 1);
    // Only done is current now; in_review is retired (no longer in the current set).
    assert.deepStrictEqual(currentObject('pf-4100', 'status'), ['done']);
    // A retirement says which fact displaced it — otherwise a wrong one is
    // unrecognisable without reconstructing the extractor's reasoning.
    assert.strictEqual(res.invalidated[0].superseded_by, 'done');
    assert.match(res.invalidated[0].reason, /single_valued/);
  });

  it('keeps both rows when a single-valued predicate lands on a project subject', () => {
    // A repo accumulates statuses; they are not successive values of one state
    // variable. "v1.1-complete" and a sync statement are both true, and the live
    // graph shows what retiring them costs: browser_profiles asserted `ga` three
    // separate times, each retired by the next phrasing to arrive.
    addFact('knowledge-base-server', 'status', 'v1.1-complete', {
      validFrom: '2026-07-14', source: 'seed',
    });

    const res = consolidate(
      [{ subject: 'knowledge-base-server', predicate: 'status', object: 'deploy branch in sync' }],
      { source: 'test', observationDate: '2026-07-29' },
    );

    assert.strictEqual(res.invalidated.length, 0);
    assert.strictEqual(res.added.length, 1);
    assert.deepStrictEqual(
      currentObject('knowledge-base-server', 'status').sort(),
      ['deploy branch in sync', 'v1.1-complete'],
    );
  });

  it('does not mistake a name that merely ends in a digit for a ticket id', () => {
    // web3, oauth2, sqlite3, es2022, S3, zod_v4, lease_v2 — 239 subjects in the
    // live graph end in a digit without being an id. A ticket id has a separator
    // or # in front of its number; a technology name does not.
    addFact('oauth2', 'status', 'evaluating', { validFrom: '2026-07-01', source: 'seed' });

    const res = consolidate(
      [{ subject: 'oauth2', predicate: 'status', object: 'adopted' }],
      { source: 'test', observationDate: '2026-07-29' },
    );

    assert.strictEqual(res.invalidated.length, 0);
    assert.deepStrictEqual(currentObject('oauth2', 'status').sort(), ['adopted', 'evaluating']);
  });

  it('still retires for an issue-in-repo subject, not just a bare ticket id', () => {
    addFact('vault-service#59', 'status', 'open', { validFrom: '2026-07-01', source: 'seed' });

    const res = consolidate(
      [{ subject: 'vault-service#59', predicate: 'status', object: 'closed' }],
      { source: 'test', observationDate: '2026-07-29' },
    );

    assert.strictEqual(res.invalidated.length, 1);
    assert.deepStrictEqual(currentObject('vault-service#59', 'status'), ['closed']);
  });

  it('never retires a choice, because choosing one thing does not un-choose another', () => {
    addFact('pf-4101', 'chose', 'embeddings at write time', {
      validFrom: '2026-07-01', source: 'seed',
    });

    const res = consolidate(
      [{ subject: 'pf-4101', predicate: 'chose', object: 'restart on source change' }],
      { source: 'test', observationDate: '2026-07-29' },
    );

    // Single-entity subject, so the subject rule would allow it — `chose` is out
    // of single_valued entirely, because a decision log is cumulative.
    assert.strictEqual(res.invalidated.length, 0);
    assert.strictEqual(currentObject('pf-4101', 'chose').length, 2);
  });

  it('does not let an older observation retire a fact recorded after it', () => {
    // Replaying yesterday's text asserts yesterday's state against whatever
    // a session has written since.
    addFact('pf-9001', 'status', 'done', { validFrom: '2026-07-29', source: 'debrief' });

    const res = consolidate(
      [{ subject: 'pf-9001', predicate: 'status', object: 'in_review' }],
      { source: 'replay', observationDate: '2026-07-28' },
    );

    assert.strictEqual(res.invalidated.length, 0);
    assert.strictEqual(res.added.length, 0);
    assert.deepStrictEqual(currentObject('pf-9001', 'status'), ['done']);
    assert.strictEqual(res.skipped[0].reason, 'stale_observation');
    assert.strictEqual(res.skipped[0].existing_since, '2026-07-29');
  });

  it('does not let a same-day older transcript retire an afternoon correction', () => {
    // Both sides truncate to the same YYYY-MM-DD, so only the recorded instant
    // can order them: 10am text replayed against a 4pm debrief.
    addFact('pf-9010', 'status', 'done', { validFrom: '2026-07-29', source: 'debrief' });

    const res = consolidate(
      [{ subject: 'pf-9010', predicate: 'status', object: 'in_review' }],
      { source: 'replay', observationDate: '2026-07-29', observedAt: '2026-07-29 10:00:00' },
    );

    assert.strictEqual(res.invalidated.length, 0);
    assert.deepStrictEqual(currentObject('pf-9010', 'status'), ['done']);
    assert.strictEqual(res.skipped[0].reason, 'stale_observation');
  });

  // recorded_at is compared as a string, so 'T' sorting above ' ' makes an ISO
  // instant look newer than every same-day row — the guard fails open on the
  // spelling a caller is most likely to reach for.
  it('orders an ISO-8601 observed_at against recorded_at, not above it', () => {
    addFact('pf-9020', 'status', 'done', { validFrom: '2026-07-29', source: 'debrief' });

    const res = consolidate(
      [{ subject: 'pf-9020', predicate: 'status', object: 'in_review' }],
      { source: 'replay', observationDate: '2026-07-29', observedAt: '2026-07-29T10:00:00.000Z' },
    );

    assert.strictEqual(res.invalidated.length, 0, 'an older observation must not retire the newer fact');
    assert.deepStrictEqual(currentObject('pf-9020', 'status'), ['done']);
    assert.strictEqual(res.skipped[0].reason, 'stale_observation');
  });

  // Truncation is not a model decision, so nothing downstream reports it. An
  // `added` list with no matching `skipped` entry claims the whole input was
  // examined, which for anything over the window it was not.
  it('reports input it never sent to the model', async () => {
    const tail = 'THE_TAIL_FACT: svc-z depends_on svc-y.';
    const res = await extractFacts('x'.repeat(MAX_EXTRACT_CHARS) + tail);

    const truncation = res.skipped.find(s => s.reason?.startsWith('input_truncated'));
    assert.ok(truncation, `no truncation entry in ${JSON.stringify(res.skipped)}`);
    assert.match(truncation.reason, new RegExp(`${tail.length.toLocaleString('en-US')} of`), 'must say how much was dropped');
    // Exact, not a match: slicing one char early would still contain the marker.
    assert.strictEqual(truncation.assertion, tail, 'and show what was dropped, from its first character');
  });

  it('says nothing about truncation when nothing was truncated', async () => {
    const res = await extractFacts('svc-a depends_on svc-b.');
    assert.deepStrictEqual(res.skipped.filter(s => s.reason?.startsWith('input_truncated')), []);
  });

  it('rejects an observed_at that is not a date rather than mis-ordering it', () => {
    assert.throws(
      () => consolidate([{ subject: 'pf-9030', predicate: 'status', object: 'done' }], { observedAt: 'yesterday' }),
      /observed_at is not a date/,
    );
  });

  it('still retires when the observation is later than the held row was recorded', () => {
    addFact('pf-9011', 'status', 'in_review', { validFrom: '2026-07-29', source: 'seed' });

    const res = consolidate(
      [{ subject: 'pf-9011', predicate: 'status', object: 'done' }],
      { source: 'debrief', observationDate: '2026-07-29', observedAt: '2999-01-01 00:00:00' },
    );

    assert.strictEqual(res.invalidated.length, 1);
    assert.deepStrictEqual(currentObject('pf-9011', 'status'), ['done']);
  });

  it('refuses when any live row of the triple would invert, not just the first', () => {
    // mergeEntity collapses two entities into one triple, leaving several live
    // rows; the UPDATE hits all of them, so the latest start decides.
    addFact('pf-9012', 'status', 'label-alpha', { validFrom: '2026-07-01', source: 'seed' });
    addFact('pf-9012', 'status', 'label-beta', { validFrom: '2026-07-29', source: 'seed' });
    mergeEntity('label-alpha', 'label-beta');

    const res = invalidateFact('pf-9012', 'status', 'label-beta', { ended: '2026-07-15' });

    assert.strictEqual(res.invalidated, 0);
    assert.strictEqual(res.refused, 'ended_before_valid_from');
    assert.strictEqual(
      queryFact('pf-9012', { direction: 'outgoing', exact: true })
        .filter(r => r.valid_to && r.valid_from > r.valid_to).length,
      0,
      'left an inverted interval on a row the .get() never looked at',
    );
  });

  it('still retires when the held fact carries no valid_from to compare', () => {
    addFact('pf-9002', 'status', 'open', { source: 'seed' });

    const res = consolidate(
      [{ subject: 'pf-9002', predicate: 'status', object: 'done' }],
      { source: 'test', observationDate: '2026-07-28' },
    );

    assert.strictEqual(res.invalidated.length, 1);
    assert.deepStrictEqual(currentObject('pf-9002', 'status'), ['done']);
  });

  it('refuses to end a fact before it began, and says so', () => {
    addFact('pf-9003', 'status', 'shipped', { validFrom: '2026-07-29', source: 'seed' });

    const res = invalidateFact('pf-9003', 'status', 'shipped', { ended: '2026-07-01' });

    assert.strictEqual(res.invalidated, 0);
    assert.strictEqual(res.refused, 'ended_before_valid_from');
    // Still current — an inverted interval would have hidden it from every
    // as-of query instead, at every date.
    assert.deepStrictEqual(currentObject('pf-9003', 'status'), ['shipped']);
    assert.strictEqual(queryFact('pf-9003', { direction: 'outgoing', exact: true, asOf: '2026-07-30' }).length, 1);
  });

  it('does not retire a fact in favour of a re-spelling of itself', () => {
    addFact('pf-2988', 'shipped_via', 'ux-labs PR #3865', { validFrom: '2026-07-20', source: 'seed' });

    const res = consolidate(
      [{ subject: 'pf-2988', predicate: 'shipped_via', object: 'pr #3865' }],
      { source: 'test', observationDate: '2026-07-29' },
    );

    assert.strictEqual(res.invalidated.length, 0, 'retired a row in favour of itself');
    assert.strictEqual(res.added.length, 0, 'wrote a second spelling of a live fact');
    assert.strictEqual(res.skipped[0].reason, 'equivalent_spelling_of_existing');
    // The spelling already in the graph wins, so re-runs converge instead of churning.
    assert.deepStrictEqual(currentObject('pf-2988', 'shipped_via'), ['ux-labs PR #3865']);
  });

  it('still retires a genuine contradiction when a variant of the new value is also held', () => {
    // kb_fact_add writes without consolidating, so a single-valued predicate can
    // already hold both a spelling of the incoming value and a real contradiction.
    addFact('pf-9004', 'assigned_to', 'ux-labs PR #100', { validFrom: '2026-07-01', source: 'seed' });
    addFact('pf-9004', 'assigned_to', 'ux-labs PR #200', { validFrom: '2026-07-02', source: 'seed' });

    const res = consolidate(
      [{ subject: 'pf-9004', predicate: 'assigned_to', object: 'pr #100' }],
      { source: 'test', observationDate: '2026-07-29' },
    );

    assert.strictEqual(res.invalidated.length, 1, 'left a contradicted object current');
    assert.strictEqual(res.invalidated[0].object, 'ux-labs PR #200');
    assert.strictEqual(res.skipped[0].reason, 'equivalent_spelling_of_existing');
    assert.deepStrictEqual(currentObject('pf-9004', 'assigned_to'), ['ux-labs PR #100']);
  });

  it('keeps same-numbered PRs in different repos apart', () => {
    addFact('pf-9001', 'reviewed_by', 'internal-tools-backend PR #539', { validFrom: '2026-07-20', source: 'seed' });

    const res = consolidate(
      [{ subject: 'pf-9001', predicate: 'reviewed_by', object: 'ux-labs PR #539' }],
      { source: 'test', observationDate: '2026-07-29' },
    );

    assert.strictEqual(res.added.length, 1, 'merged two different PRs that share a number');
    assert.strictEqual(currentObject('pf-9001', 'reviewed_by').length, 2);
  });

  it('treats a bare commit SHA and its qualified form as one entity', () => {
    addFact('pf-9002', 'merged_via', 'commit fde94d6', { validFrom: '2026-07-20', source: 'seed' });

    const res = consolidate(
      [{ subject: 'pf-9002', predicate: 'merged_via', object: 'fde94d6' }],
      { source: 'test', observationDate: '2026-07-29' },
    );

    assert.strictEqual(res.invalidated.length, 0);
    assert.strictEqual(res.skipped[0].reason, 'equivalent_spelling_of_existing');
  });

  it('keeps both objects of a many-valued predicate (owning a new epic ≠ dropping the old)', () => {
    addFact('uttam', 'owns', 'PF-2746', { validFrom: '2026-01-01', source: 'seed' });

    const res = consolidate(
      [{ subject: 'uttam', predicate: 'owns', object: 'PF-2986' }],
      { source: 'test', observationDate: '2026-06-24' },
    );

    assert.strictEqual(res.invalidated.length, 0);
    assert.deepStrictEqual(currentObject('uttam', 'owns').sort(), ['PF-2746', 'PF-2986']);
  });

  it('defaults an unregistered predicate to many-valued rather than retiring', () => {
    addFact('goldfish', 'talks_to', 'wadl', { validFrom: '2026-01-01', source: 'seed' });

    const res = consolidate(
      [{ subject: 'goldfish', predicate: 'talks_to', object: 'eva' }],
      { source: 'test', observationDate: '2026-06-24' },
    );

    assert.strictEqual(res.invalidated.length, 0);
    assert.strictEqual(currentObject('goldfish', 'talks_to').length, 2);
  });

  it('honours the per-install predicates.json (adds single-valued, removes built-ins)', () => {
    // Ticket-shaped subjects: a single-valued predicate only retires for a
    // subject that names one state-bearing thing, so bare 'tetra' would prove
    // nothing about the override.
    addFact('tetra#1', 'pinned_to', 'v1', { validFrom: '2026-01-01', source: 'seed' });
    addFact('eva#1', 'version', '1.0', { validFrom: '2026-01-01', source: 'seed' });

    const res = consolidate([
      { subject: 'tetra#1', predicate: 'pinned_to', object: 'v2' }, // added by the override
      { subject: 'eva#1', predicate: 'version', object: '2.0' },    // built-in, demoted by the override
    ], { source: 'test', observationDate: '2026-06-24' });

    assert.deepStrictEqual(currentObject('tetra#1', 'pinned_to'), ['v2']);
    assert.deepStrictEqual(currentObject('eva#1', 'version').sort(), ['1.0', '2.0']);
    assert.strictEqual(res.invalidated.length, 1);
  });

  it('passes the extractor\'s own skips through to the caller', async () => {
    const res = await kbExtract('...', { source: 'test', observationDate: '2026-06-24' });

    assert.strictEqual(res.added.length, 1);
    assert.strictEqual(res.skipped.length, 1);
    assert.strictEqual(res.skipped[0].reason, 'resolved in the same PR');
  });

  it('folds predicate synonyms onto one canonical edge', () => {
    const res = consolidate([
      { subject: 'pf-3013', predicate: 'child_ticket_of', object: 'pf-2991' },
      { subject: 'readMetronomeContractId', predicate: 'declared_by', object: 'rates_stack' },
    ], { source: 'test', observationDate: '2026-07-29' });

    assert.strictEqual(res.added.length, 2);
    // kb_fact_query matches on predicate, so synonyms must converge or every
    // query under-returns across the silos.
    assert.deepStrictEqual(currentObject('pf-3013', 'child_of'), ['pf-2991']);
    assert.deepStrictEqual(currentObject('readMetronomeContractId', 'declared_in'), ['rates_stack']);
  });

  it('matches a row stored under a pre-alias spelling', () => {
    // Written before pinned_at was aliased, so the graph holds the old spelling.
    addFact('pf-8001', 'pinned_at', 'v1', { validFrom: '2026-07-01', source: 'seed' });

    const res = consolidate(
      [{ subject: 'pf-8001', predicate: 'pinned_to', object: 'v2' }],
      { source: 'test', observationDate: '2026-07-20' },
    );

    // Without normalising the stored predicate the old row is invisible here,
    // and a single-valued predicate ends up with two live objects.
    assert.strictEqual(res.invalidated.length, 1);
    assert.deepStrictEqual(currentObject('pf-8001', 'pinned_at'), []);
    assert.deepStrictEqual(currentObject('pf-8001', 'pinned_to'), ['v2']);
  });

  it('dedups across a real alias even where neither side retires', () => {
    // merged_as/merged_via is the shipped alias pair, and merged_via is
    // many-valued — so normalisation has to hold for the duplicate check too,
    // not just for retirement, or the same commit lands twice.
    addFact('pf-8002', 'merged_as', 'commit aaa1111', { validFrom: '2026-07-01', source: 'seed' });

    const res = consolidate(
      [{ subject: 'pf-8002', predicate: 'merged_via', object: 'commit aaa1111' }],
      { source: 'test', observationDate: '2026-07-20' },
    );

    assert.strictEqual(res.added.length, 0);
    assert.strictEqual(res.invalidated.length, 0);
    assert.strictEqual(currentObject('pf-8002', 'merged_as').length, 1);
  });

  it('previews the canonical predicate, not the alias the extractor emitted', async () => {
    const res = await kbExtract('alias me', { source: 'test', observationDate: '2026-07-29', dryRun: true });

    assert.strictEqual(res.candidates[0].predicate, 'merged_via');
    // And the commit writes that same edge, which is the promise of a preview.
    const committed = await kbExtract('alias me', { source: 'test', observationDate: '2026-07-29' });
    assert.strictEqual(committed.from_preview, true);
    assert.deepStrictEqual(currentObject('pr #888', 'merged_via'), ['commit def5678']);
  });

  // The preview is the last place a self-contradicting batch can be caught: on
  // the dry-run-then-commit flow the retirements it used to cause landed at
  // commit time, where nobody was looking.
  it('previews the conflict a batch is about to contradict itself with', async () => {
    const res = await kbExtract('contradict me', { source: 'test', observationDate: '2026-07-29', dryRun: true });

    assert.deepStrictEqual(
      res.conflicts.map(c => [c.subject, c.predicate, c.objects]),
      [['pr #999', 'status', ['open', 'approved']]],
    );

    const committed = await kbExtract('contradict me', { source: 'test', observationDate: '2026-07-29' });
    assert.deepStrictEqual(committed.invalidated, []);
    assert.deepStrictEqual(currentObject('pr #999', 'status').sort(), ['approved', 'open']);
    assert.strictEqual(committed.conflicts.length, 1);
  });

  it('splits a comma-joined list of references into one row each', () => {
    const res = consolidate(
      [{ subject: 'wallet rates stack', predicate: 'includes', object: 'pr #3835, pr #3849, and pr #3865' }],
      { source: 'test', observationDate: '2026-07-29' },
    );

    assert.strictEqual(res.added.length, 3, 'kept an unqueryable comma-joined object');
    assert.deepStrictEqual(currentObject('wallet rates stack', 'includes').sort(), ['pr #3835', 'pr #3849', 'pr #3865']);
  });

  it('leaves a prose object with commas whole', () => {
    const res = consolidate(
      [{ subject: 'metronome', predicate: 'calculates', object: 'recharge_to, minus current balance' }],
      { source: 'test', observationDate: '2026-07-29' },
    );

    assert.strictEqual(res.added.length, 1);
  });

  it('commits exactly what the dry run previewed, without asking the model twice', async () => {
    const args = { source: 'test', observationDate: '2026-07-29' };
    const before = callCount();

    const preview = await kbExtract('preview me', { ...args, dryRun: true });
    const committed = await kbExtract('preview me', args);

    assert.strictEqual(preview.dry_run, true);
    assert.strictEqual(committed.from_preview, true, 'commit re-ran the extractor');
    assert.strictEqual(callCount() - before, 1, 'model was called twice for one preview+commit');
    assert.deepStrictEqual(
      committed.added.map(f => `${f.subject}|${f.predicate}|${f.object}`),
      preview.candidates.map(f => `${f.subject}|${f.predicate}|${f.object}`),
    );
  });

  it('extracts fresh when no preview matches the input', async () => {
    const before = callCount();
    const res = await kbExtract('never previewed', { source: 'test', observationDate: '2026-07-29' });

    assert.strictEqual(res.from_preview, false);
    assert.strictEqual(callCount() - before, 1);
  });

  it('splits a paragraph on sentence boundaries and caps the fan-out', () => {
    const long = 'a'.repeat(40) + '. ';
    const chunks = chunkForExtract(long.repeat(30)); // 1260 chars

    assert.ok(chunks.length > 1, 'did not split');
    assert.ok(chunks.every(c => c.trimEnd().endsWith('.')), 'split mid-sentence');
    // 8 calls is 8 claude subprocesses; longer input widens chunks instead.
    assert.ok(chunkForExtract('word. '.repeat(4000)).length <= 8);
    assert.deepStrictEqual(chunkForExtract('one fact.'), ['one fact.']);
  });

  it('splits on width when the text has no sentence boundaries', () => {
    // Otherwise one call gets the whole window, which is what loses it.
    const chunks = chunkForExtract('x'.repeat(12000));

    assert.ok(chunks.length > 1, 'handed the whole window to one call');
    assert.ok(chunks.length <= 8, `${chunks.length} chunks is more than the fan-out allows`);
    assert.strictEqual(chunks.join(''), 'x'.repeat(12000), 'dropped or duplicated text');
  });

  it('reports a dead chunk instead of returning the survivors as complete', async () => {
    const res = await kbExtract('DEAD_CHUNK', { source: 'test', observationDate: '2026-06-24' });

    assert.strictEqual(res.added.length, 0);
    assert.match(res.skipped[0].reason, /chunk_failed/);
  });

  it('reports missing accounting rather than an empty skipped list', async () => {
    // A response with no skipped key knows nothing about what it passed over —
    // reporting [] there would be the same silent omission in a new place.
    const res = await kbExtract('LEGACY_NO_SKIPPED', { source: 'test', observationDate: '2026-06-24' });

    assert.strictEqual(res.skipped[0].reason, 'extractor_returned_no_skipped_list');
  });

  it('is idempotent — re-running the same facts is a no-op', () => {
    const facts = [{ subject: 'my-app', predicate: 'calls_over_http', object: 'auth-service' }];
    consolidate(facts, { source: 'test', observationDate: '2026-06-24' });
    const again = consolidate(facts, { source: 'test', observationDate: '2026-06-24' });

    assert.strictEqual(again.added.length, 0);
    assert.strictEqual(again.invalidated.length, 0);
    assert.strictEqual(again.skipped[0].reason, 'duplicate');
  });

  it('skips incomplete triples instead of writing junk', () => {
    const res = consolidate([{ subject: 'my-app', predicate: 'uses' }], {});
    assert.strictEqual(res.added.length, 0);
    assert.strictEqual(res.skipped[0].reason, 'incomplete_triple');
  });

  it('resolves entity aliases on write and query after a merge', async () => {
    const { mergeEntity } = await import('../src/facts.js');
    addFact('old-name', 'owns', 'thing-a', { validFrom: '2026-01-01' });
    const res = mergeEntity('old-name', 'new-name');
    assert.strictEqual(res.merged, true);
    assert.strictEqual(res.facts_rewritten, 1);
    // Query by the OLD name lands on the canonical node...
    assert.deepStrictEqual(currentObject('old-name', 'owns'), ['thing-a']);
    // ...and a write via the old name dedups against the canonical fact.
    const dup = addFact('old-name', 'owns', 'thing-a');
    assert.strictEqual(dup.already_exists, true);
  });

  it('does not retire facts of prefix-related qualifier entities', () => {
    // queryFact prefix-matches qualifiers ("auth-service" also returns
    // "auth-service sandbox" facts) — consolidation must not read those
    // as contradictions of the base entity.
    addFact('auth-service sandbox', 'status', 'smoke-tested', { validFrom: '2026-05-01', source: 'seed' });

    const res = consolidate(
      [{ subject: 'auth-service', predicate: 'status', object: 'live' }],
      { source: 'test', observationDate: '2026-06-24' },
    );

    assert.strictEqual(res.invalidated.length, 0);
    assert.strictEqual(res.added.length, 1);
    assert.deepStrictEqual(currentObject('auth-service sandbox', 'status'), ['smoke-tested']);
  });

  // Observed in production: one response gave a PR three statuses — open
  // (lifecycle), approved (review), queued_for_merge (the merge queue) — and
  // consolidation retired two of them on arrival, so the survivor was whichever
  // the loop reached last. The batch also contradicted itself in both
  // directions when a repeated value came back from a second chunk.
  describe('a batch that contradicts itself', () => {
    it('keeps all three values and retires none', () => {
      const res = consolidate([
        { subject: 'pr #4801', predicate: 'status', object: 'open' },
        { subject: 'pr #4801', predicate: 'status', object: 'approved' },
        { subject: 'pr #4801', predicate: 'status', object: 'queued_for_merge' },
      ], { source: 'test', observationDate: '2026-07-30' });

      assert.strictEqual(res.added.length, 3);
      assert.deepStrictEqual(res.invalidated, []);
      assert.deepStrictEqual(
        currentObject('pr #4801', 'status').sort(),
        ['approved', 'open', 'queued_for_merge'],
      );
      assert.deepStrictEqual(
        res.conflicts.map(c => [c.subject, c.predicate, c.objects]),
        [['pr #4801', 'status', ['open', 'approved', 'queued_for_merge']]],
      );
    });

    it('does not retire what the graph already held either', () => {
      // A batch with no agreed value has nothing to supersede the old one with,
      // so the pre-existing row survives too.
      addFact('pr #4802', 'status', 'draft', { validFrom: '2026-07-01', source: 'seed' });

      const res = consolidate([
        { subject: 'pr #4802', predicate: 'status', object: 'approved' },
        { subject: 'pr #4802', predicate: 'status', object: 'queued_for_merge' },
      ], { source: 'test', observationDate: '2026-07-30' });

      assert.deepStrictEqual(res.invalidated, []);
      assert.ok(currentObject('pr #4802', 'status').includes('draft'));
      assert.strictEqual(res.conflicts.length, 1);
    });

    it('reads two spellings of one value as one value', () => {
      // pinned_to is single-valued in this install's override.
      const res = consolidate([
        { subject: 'tkt-4831', predicate: 'pinned_to', object: 'web-app pr #48' },
        { subject: 'tkt-4831', predicate: 'pinned_to', object: 'pr #48' },
      ], { source: 'test', observationDate: '2026-07-30' });

      assert.deepStrictEqual(res.conflicts, []);
      assert.deepStrictEqual(res.invalidated, []);
      assert.deepStrictEqual(currentObject('tkt-4831', 'pinned_to'), ['web-app pr #48']);
    });

    it('groups two spellings of one subject as one pair', () => {
      // The facts table collapses these to one subject, so a group keyed any
      // other way would miss the collision and let one row retire the other.
      const res = consolidate([
        { subject: 'pr #4803', predicate: 'status', object: 'open' },
        { subject: 'PR_#4803', predicate: 'status', object: 'approved' },
      ], { source: 'test', observationDate: '2026-07-30' });

      assert.deepStrictEqual(res.invalidated, []);
      assert.strictEqual(res.conflicts.length, 1);
    });

    it('still loses to a fact recorded after the text it is replaying', () => {
      // Suppressing the retirement must not also suppress the staleness guard:
      // old text stays old whether or not the batch carrying it agreed with
      // itself, or a replay would write two dead values as current.
      addFact('pr #4804', 'status', 'done', { validFrom: '2026-07-30', source: 'seed' });

      const res = consolidate([
        { subject: 'pr #4804', predicate: 'status', object: 'open' },
        { subject: 'pr #4804', predicate: 'status', object: 'approved' },
      ], { source: 'test', observationDate: '2026-07-01' });

      assert.deepStrictEqual(res.added, []);
      assert.deepStrictEqual(res.skipped.map(s => s.reason), ['stale_observation', 'stale_observation']);
      assert.deepStrictEqual(currentObject('pr #4804', 'status'), ['done']);
    });

    it('groups two names an entity merge has folded together', () => {
      // entityKey follows the alias table, so a merged pair is one subject here
      // exactly as it is in the facts table.
      addFact('tkt-4840', 'status', 'in_review', { validFrom: '2026-07-01', source: 'seed' });
      mergeEntity('tkt-4840', 'pr #4840');

      const res = consolidate([
        { subject: 'tkt-4840', predicate: 'status', object: 'open' },
        { subject: 'pr #4840', predicate: 'status', object: 'approved' },
      ], { source: 'test', observationDate: '2026-07-30' });

      assert.deepStrictEqual(res.invalidated, []);
      assert.strictEqual(res.conflicts.length, 1);
    });

    it('still retires across calls, where the order is real', () => {
      consolidate([{ subject: 'tkt-4832', predicate: 'status', object: 'in_review' }],
        { source: 'test', observationDate: '2026-07-29' });
      const res = consolidate([{ subject: 'tkt-4832', predicate: 'status', object: 'done' }],
        { source: 'test', observationDate: '2026-07-30' });

      assert.strictEqual(res.invalidated.length, 1);
      assert.deepStrictEqual(res.conflicts, []);
      assert.deepStrictEqual(currentObject('tkt-4832', 'status'), ['done']);
    });
  });

  // Observed in production: "pr #45 (tkt-99, the config client) merged" put the
  // ticket in the subject of `implements`. Both entities are real and the
  // predicate is right, so it reads as a sentence — and it asserts that a ticket
  // built something while leaving "what implements tkt-99" unanswered.
  describe('role direction for work-item predicates', () => {
    const roles = f => [f.subject, f.predicate, f.object];

    it('puts the work item in the object and answers the incoming query', () => {
      const res = consolidate(
        [{ subject: 'tkt-4821', predicate: 'implements', object: 'threshold_config_client' }],
        { source: 'test', observationDate: '2026-07-30' },
      );

      assert.deepStrictEqual(res.added.map(roles), [['threshold_config_client', 'implements', 'tkt-4821']]);
      assert.deepStrictEqual(
        queryFact('tkt-4821', { direction: 'incoming' }).filter(r => r.current).map(r => r.subject),
        ['threshold_config_client'],
      );
    });

    it('leaves a pull request as the implementer', () => {
      // pr-73 is work-item shaped in every respect but the marker that says a
      // pull request implements things rather than being one.
      assert.deepStrictEqual(
        roles(canonicalTriple({ subject: 'pr-73', predicate: 'implements', object: 'lease_ownership_check' })),
        ['pr-73', 'implements', 'lease_ownership_check'],
      );
    });

    it('leaves a relationship between two work items alone', () => {
      assert.deepStrictEqual(
        roles(canonicalTriple({ subject: 'tkt-4821', predicate: 'fixes', object: 'tkt-4900' })),
        ['tkt-4821', 'fixes', 'tkt-4900'],
      );
    });

    it('leaves a work item that carries a label after it in the object', () => {
      // Still a relationship between two work items, so still no way to tell
      // from the shape which of them implements the other.
      assert.deepStrictEqual(
        roles(canonicalTriple({ subject: 'tkt-4821', predicate: 'implements', object: 'tkt-4900_step_1_save_back' })),
        ['tkt-4821', 'implements', 'tkt-4900_step_1_save_back'],
      );
    });

    it('leaves a name that merely ends in digits alone', () => {
      assert.deepStrictEqual(
        roles(canonicalTriple({ subject: 'oauth2', predicate: 'implements', object: 'token_refresh' })),
        ['oauth2', 'implements', 'token_refresh'],
      );
    });

    it('resolves the inverse spelling first, then the roles', () => {
      assert.deepStrictEqual(
        roles(canonicalTriple({ subject: 'threshold_config_client', predicate: 'implemented_by', object: 'tkt-4822' })),
        ['threshold_config_client', 'implements', 'tkt-4822'],
      );
    });
  });
});
