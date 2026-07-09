import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Point the KB at a throwaway dir BEFORE importing anything that opens the DB.
const tmp = mkdtempSync(join(tmpdir(), 'kb-extract-'));
process.env.KB_DIR = tmp;

const { consolidate } = await import('../src/extract.js');
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
