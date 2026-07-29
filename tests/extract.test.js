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
  *LEGACY_NO_SKIPPED*) echo '${envelope({ facts: [{ subject: 'a', predicate: 'b', object: 'c' }] })}' ;;
  *) echo '${envelope({
    facts: [{ subject: 'pr #539', predicate: 'merged_via', object: 'commit fde94d6' }],
    skipped: [{ assertion: 'CodeRabbit raised a Major finding', reason: 'resolved in the same PR' }],
  })}' ;;
esac
`);
chmodSync(fakeClaude, 0o755);
process.env.CLAUDE_PATH = fakeClaude;

const { consolidate, kbExtract, chunkForExtract } = await import('../src/extract.js');
const callCount = () => (existsSync(join(tmp, 'calls')) ? readFileSync(join(tmp, 'calls'), 'utf-8').trim().split('\n').length : 0);
const { initFactSchema, addFact, queryFact } = await import('../src/facts.js');

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

  it('retires a stale fact when a new one contradicts it (beta -> GA)', () => {
    addFact('browser profiles', 'status', 'beta', { validFrom: '2026-01-01', source: 'seed' });
    assert.deepStrictEqual(currentObject('browser profiles', 'status'), ['beta']);

    const res = consolidate(
      [{ subject: 'browser profiles', predicate: 'status', object: 'ga' }],
      { source: 'test', observationDate: '2026-06-24' },
    );

    assert.strictEqual(res.invalidated.length, 1);
    assert.strictEqual(res.added.length, 1);
    // Only GA is current now; beta is retired (no longer in the current set).
    assert.deepStrictEqual(currentObject('browser profiles', 'status'), ['ga']);
    // A retirement says which fact displaced it — otherwise a wrong one is
    // unrecognisable without reconstructing the extractor's reasoning.
    assert.strictEqual(res.invalidated[0].superseded_by, 'ga');
    assert.match(res.invalidated[0].reason, /single_valued/);
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
    addFact('pf-9004', 'shipped_via', 'ux-labs PR #100', { validFrom: '2026-07-01', source: 'seed' });
    addFact('pf-9004', 'shipped_via', 'ux-labs PR #200', { validFrom: '2026-07-02', source: 'seed' });

    const res = consolidate(
      [{ subject: 'pf-9004', predicate: 'shipped_via', object: 'pr #100' }],
      { source: 'test', observationDate: '2026-07-29' },
    );

    assert.strictEqual(res.invalidated.length, 1, 'left a contradicted object current');
    assert.strictEqual(res.invalidated[0].object, 'ux-labs PR #200');
    assert.strictEqual(res.skipped[0].reason, 'equivalent_spelling_of_existing');
    assert.deepStrictEqual(currentObject('pf-9004', 'shipped_via'), ['ux-labs PR #100']);
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
    addFact('tetra', 'pinned_to', 'v1', { validFrom: '2026-01-01', source: 'seed' });
    addFact('eva', 'version', '1.0', { validFrom: '2026-01-01', source: 'seed' });

    const res = consolidate([
      { subject: 'tetra', predicate: 'pinned_to', object: 'v2' }, // added by the override
      { subject: 'eva', predicate: 'version', object: '2.0' },    // built-in, demoted by the override
    ], { source: 'test', observationDate: '2026-06-24' });

    assert.deepStrictEqual(currentObject('tetra', 'pinned_to'), ['v2']);
    assert.deepStrictEqual(currentObject('eva', 'version').sort(), ['1.0', '2.0']);
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
    // Written before merged_as was aliased, so the graph holds the old spelling.
    addFact('pf-8001', 'merged_as', 'commit aaa1111', { validFrom: '2026-07-01', source: 'seed' });

    const res = consolidate(
      [{ subject: 'pf-8001', predicate: 'merged_via', object: 'commit bbb2222' }],
      { source: 'test', observationDate: '2026-07-20' },
    );

    // Without normalising the stored predicate the old row is invisible here,
    // and a single-valued predicate ends up with two live objects.
    assert.strictEqual(res.invalidated.length, 1);
    assert.deepStrictEqual(currentObject('pf-8001', 'merged_as'), []);
    assert.deepStrictEqual(currentObject('pf-8001', 'merged_via'), ['commit bbb2222']);
  });

  it('previews the canonical predicate, not the alias the extractor emitted', async () => {
    const res = await kbExtract('alias me', { source: 'test', observationDate: '2026-07-29', dryRun: true });

    assert.strictEqual(res.candidates[0].predicate, 'merged_via');
    // And the commit writes that same edge, which is the promise of a preview.
    const committed = await kbExtract('alias me', { source: 'test', observationDate: '2026-07-29' });
    assert.strictEqual(committed.from_preview, true);
    assert.deepStrictEqual(currentObject('pr #888', 'merged_via'), ['commit def5678']);
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
});
