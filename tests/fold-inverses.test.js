import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Point the KB at a throwaway dir BEFORE importing anything that opens the DB.
process.env.KB_DIR = mkdtempSync(join(tmpdir(), 'kb-fold-cli-'));

const { foldInverses } = await import('../src/cli/fold-inverses.js');
const { addFact, queryFact, invalidateFact } = await import('../src/facts.js');
const { consolidate } = await import('../src/extract.js');

// addFact writes without consolidating, which is exactly how a row from before
// the fold shipped looks: stored in whichever direction the extractor picked.
const legacy = (s, p, o, validFrom) => addFact(s, p, o, { validFrom, source: 'pre-fold' });
const liveFor = name => queryFact(name, { direction: 'both' }).filter(r => r.current);

// predicates.json is read once at import, so a per-install override needs its
// own process. `body` runs with addFact, foldInverses and report() in scope;
// report(entity) prints that entity's live triples, which the caller gets back.
async function inOverrideInstall(config, body) {
  const { writeFileSync, mkdtempSync: mkd } = await import('fs');
  const { execFileSync } = await import('child_process');
  const dir = mkd(join(tmpdir(), 'kb-fold-override-'));
  writeFileSync(join(dir, 'predicates.json'), JSON.stringify(config));

  const url = p => JSON.stringify(new URL(p, import.meta.url).href);
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { addFact, queryFact } = await import(${url('../src/facts.js')});
    const { foldInverses } = await import(${url('../src/cli/fold-inverses.js')});
    const report = name => console.log('RESULT ' + JSON.stringify(
      queryFact(name, { direction: 'both' }).filter(r => r.current)
        .map(r => [r.subject, r.predicate, r.object]).sort()));
    ${body}
  `], { env: { ...process.env, KB_DIR: dir }, encoding: 'utf8' });

  const line = out.split('\n').find(l => l.startsWith('RESULT '));
  assert.ok(line, `subprocess printed no RESULT line:\n${out}`);
  return JSON.parse(line.slice('RESULT '.length));
}

describe('fold-inverses migration', () => {
  it('rewrites a minority-direction row onto the canonical one', () => {
    legacy('pf_200', 'blocks', 'pf_201', '2026-07-01');
    foldInverses({ apply: true });

    const live = liveFor('pf_200');
    assert.strictEqual(live.length, 1);
    assert.strictEqual(live[0].predicate, 'blocked_by');
    assert.strictEqual(live[0].subject, 'pf_201');
    assert.strictEqual(live[0].object, 'pf_200');
  });

  it('preserves valid_from when it rewrites', () => {
    legacy('svc_a', 'part_of', 'repo_a', '2026-06-15');
    foldInverses({ apply: true });
    assert.strictEqual(liveFor('svc_a')[0].valid_from, '2026-06-15');
  });

  it('merges a legacy row into the twin that already holds the relationship', () => {
    legacy('pf_300', 'blocks', 'pf_301', '2026-07-02');
    legacy('pf_301', 'blocked_by', 'pf_300', '2026-07-05');
    foldInverses({ apply: true });

    const live = liveFor('pf_301');
    assert.strictEqual(live.length, 1, `expected one row, got ${JSON.stringify(live)}`);
    // The survivor keeps the earlier date — the relationship has been true since
    // the legacy row said so, not since the canonical row restated it.
    assert.strictEqual(live[0].valid_from, '2026-07-02');
  });

  // A retired row is history, not a competing assertion, so it is folded for
  // consistency but must never be merged away into a live twin — that would
  // delete the record of when the relationship stopped being stated that way.
  it('folds a retired row without merging it into a live twin', () => {
    legacy('pf_500', 'blocks', 'pf_501', '2026-07-01');
    invalidateFact('pf_500', 'blocks', 'pf_501', { ended: '2026-07-03' });
    legacy('pf_501', 'blocked_by', 'pf_500', '2026-07-04');

    foldInverses({ apply: true });

    const all = queryFact('pf_501', { direction: 'both' });
    assert.strictEqual(all.length, 2, `retired row must survive: ${JSON.stringify(all)}`);
    assert.ok(all.every(r => r.predicate === 'blocked_by'), 'both rows fold to the canonical direction');
    assert.strictEqual(all.filter(r => r.current).length, 1);
  });

  it('reports without writing on a dry run', () => {
    legacy('pf_600', 'blocks', 'pf_601', '2026-07-01');
    const res = foldInverses();

    assert.strictEqual(res.folded, 1);
    assert.strictEqual(res.merged, 0);
    const live = liveFor('pf_600');
    assert.strictEqual(live[0].predicate, 'blocks', 'a dry run must not rewrite');
  });

  it('is re-runnable: a second pass finds nothing left to do', () => {
    legacy('pf_700', 'owned_by', 'team_x', '2026-07-01');
    foldInverses({ apply: true });
    assert.deepStrictEqual(foldInverses({ apply: true }), { folded: 0, merged: 0 });
  });

  // A row written before an alias was registered carries the raw spelling, so
  // selecting by the alias-resolved predicate alone would walk straight past it.
  it('folds a row stored under an alias of a fold source', async () => {
    const out = await inOverrideInstall(
      { aliases: { obstructs: 'blocks' }, inverses: { obstructs: 'blocked_by' } },
      `addFact('a1', 'obstructs', 'b1', { validFrom: '2026-07-01' });
       foldInverses({ apply: true });
       report('a1');`,
    );
    assert.deepStrictEqual(out, [['b1', 'blocked_by', 'a1']]);
  });

  // Both sources fold to blocked_by, and neither is canonical yet, so no twin
  // lookup finds the other. Left alone that writes two identical live rows which
  // no re-run can merge, because neither uses a source predicate any more.
  it('collapses two sources that fold onto the same relationship', async () => {
    const out = await inOverrideInstall(
      { inverses: { blocks: 'blocked_by', obstructs: 'blocked_by' } },
      `addFact('a2', 'blocks', 'b2', { validFrom: '2026-07-01' });
       addFact('a2', 'obstructs', 'b2', { validFrom: '2026-07-04' });
       foldInverses({ apply: true });
       report('a2');`,
    );
    assert.deepStrictEqual(out, [['b2', 'blocked_by', 'a2']]);
  });

  // The migration exists because consolidate's dedup cannot see the old
  // direction. Once folded, the next mention must land as a duplicate, not a
  // second live row.
  it('stops a legacy row from duplicating on the next mention', () => {
    legacy('pf_800', 'blocks', 'pf_801', '2026-07-01');
    foldInverses({ apply: true });

    const res = consolidate([{ subject: 'pf_800', predicate: 'blocks', object: 'pf_801' }],
      { observationDate: '2026-07-30' });

    assert.strictEqual(res.added.length, 0);
    assert.strictEqual(liveFor('pf_801').length, 1);
  });
});
