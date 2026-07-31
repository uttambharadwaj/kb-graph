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

  // An alias renames without swapping, so a row on the old spelling keeps its
  // subject and only its predicate is stale. A fold check asking the inverse map
  // sees nothing to do and back-fills none of them — every synonym registered
  // since this migration shipped stayed on its old spelling in the graph, which
  // is where the duplicates the fold exists to prevent come from.
  it('folds a row whose predicate is aliased but whose direction is right', async () => {
    const out = await inOverrideInstall(
      { aliases: { landed_on: 'merged_to' } },
      `addFact('pr #48', 'landed_on', 'main', { validFrom: '2026-07-01' });
       foldInverses({ apply: true });
       report('pr #48');`,
    );
    assert.deepStrictEqual(out, [['pr #48', 'merged_to', 'main']]);
  });

  // The same blind spot reached through morphology rather than a list entry.
  it('folds a row stored under an inflection of a registered predicate', async () => {
    const out = await inOverrideInstall(
      { preferred: ['deployed_to'] },
      `addFact('web-app', 'deploys_to', 'production', { validFrom: '2026-07-01' });
       foldInverses({ apply: true });
       report('web-app');`,
    );
    assert.deepStrictEqual(out, [['web-app', 'deployed_to', 'production']]);
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

  // The canonical row is stored under an alias of the canonical predicate, so
  // an exact predicate comparison walks past it and writes a second live row —
  // and neither is a fold source afterwards, so no re-run can merge them.
  it('merges into a twin stored under an alias of the canonical predicate', async () => {
    const out = await inOverrideInstall(
      { aliases: { hampered_by: 'blocked_by' }, inverses: { blocks: 'blocked_by' } },
      `addFact('b3', 'hampered_by', 'a3', { validFrom: '2026-07-05' });
       addFact('a3', 'blocks', 'b3', { validFrom: '2026-07-01' });
       foldInverses({ apply: true });
       report('a3');`,
    );
    assert.strictEqual(out.length, 1, `expected one row, got ${JSON.stringify(out)}`);
  });

  // consolidate matches its subject exactly and its object through sameEntity,
  // so "ux-labs pr #3865" and "pr #3865" are one fact to the writer. Matching
  // objects exactly here would split what the next write then treats as a
  // duplicate — two live rows the writer believes are one.
  it('merges into a twin whose object is an equivalent spelling', () => {
    legacy('pr #3865', 'blocks', 'svc_q', '2026-07-01');
    legacy('svc_q', 'blocked_by', 'ux-labs pr #3865', '2026-07-05');
    foldInverses({ apply: true });

    const live = liveFor('svc_q');
    assert.strictEqual(live.length, 1, `expected one row, got ${JSON.stringify(live)}`);
    // The graph's existing spelling wins, as it does in consolidate.
    assert.strictEqual(live[0].object, 'ux-labs pr #3865');
    assert.strictEqual(live[0].valid_from, '2026-07-01');
  });

  // Two live rows whose objects are equivalent is a pre-existing duplicate the
  // fold now has to choose between. It must join the oldest, which it gets from
  // the scan's ORDER BY rather than from any explicit sort — so this locks that
  // ordering, which otherwise reads as cosmetic.
  it('merges into the oldest of several equivalent twins', () => {
    legacy('svc_r', 'blocked_by', 'ux-labs pr #4100', '2026-06-20');
    legacy('svc_r', 'blocked_by', 'pr #4100', '2026-06-25');
    // Older than both, so whichever twin absorbs it is the one that gets
    // backdated — that is what makes the choice observable at all.
    legacy('pr #4100', 'blocks', 'svc_r', '2026-06-01');
    foldInverses({ apply: true });

    const live = liveFor('svc_r').filter(r => r.predicate === 'blocked_by');
    const backdated = live.filter(r => r.valid_from === '2026-06-01');
    assert.deepStrictEqual(backdated.map(r => r.object), ['ux-labs pr #4100'],
      `the oldest twin must be the one that absorbed it: ${JSON.stringify(live)}`);
    assert.strictEqual(live.length, 2, `the fold must not add a third row: ${JSON.stringify(live)}`);
  });

  // An as-of query reads a null valid_from as valid before any date, so it is
  // the earliest start there is. Treating it as a missing one and keeping the
  // dated survivor hides the relationship for every date before that.
  it('carries an unbounded start onto the survivor', () => {
    legacy('svc_s', 'blocked_by', 'pf_910', '2026-06-01');
    addFact('pf_910', 'blocks', 'svc_s', { source: 'pre-fold' }); // no valid_from
    foldInverses({ apply: true });

    const live = liveFor('svc_s');
    assert.strictEqual(live.length, 1, `expected one row, got ${JSON.stringify(live)}`);
    assert.strictEqual(live[0].valid_from, null, 'the unbounded start must survive the merge');

    // The point of preserving it: the fact still answers a query dated earlier.
    const before = queryFact('svc_s', { direction: 'both', asOf: '2026-01-01' });
    assert.strictEqual(before.length, 1, 'must still be valid before the dated twin started');
  });

  // valid_from and source describe one observation. Taking the date without the
  // source leaves the survivor claiming a provenance that never saw the fact
  // that early — a mismatch consolidate never creates, because it does not
  // backdate at all.
  it('carries source along with the date it backdates to', () => {
    addFact('svc_t', 'blocked_by', 'pf_920', { validFrom: '2026-06-01', source: 'canonical-src' });
    addFact('pf_920', 'blocks', 'svc_t', { validFrom: '2026-05-01', source: 'legacy-src' });
    foldInverses({ apply: true });

    const live = liveFor('svc_t');
    assert.strictEqual(live.length, 1);
    assert.strictEqual(live[0].valid_from, '2026-05-01');
    assert.strictEqual(live[0].source, 'legacy-src', 'the date and its source must come from the same row');
  });

  // The role fold re-points a relationship whose predicate is already canonical,
  // so a migration that asks the predicate alone walks straight past these rows —
  // and consolidate would then write the corrected direction as a second live row.
  it('rewrites a row stored with the work item as its subject', () => {
    legacy('tkt-7001', 'implements', 'threshold_config_client', '2026-07-01');
    foldInverses({ apply: true });

    const live = liveFor('tkt-7001');
    assert.strictEqual(live.length, 1);
    assert.deepStrictEqual(
      [live[0].subject, live[0].predicate, live[0].object],
      ['threshold_config_client', 'implements', 'tkt-7001'],
    );
  });

  it('leaves a pull request row in the direction it was written', () => {
    legacy('pr-7002', 'implements', 'lease_ownership_check', '2026-07-01');
    foldInverses({ apply: true });

    const live = liveFor('pr-7002');
    assert.strictEqual(live.length, 1);
    assert.deepStrictEqual(
      [live[0].subject, live[0].predicate, live[0].object],
      ['pr-7002', 'implements', 'lease_ownership_check'],
    );
  });

  it('rewrites the predicate of a row whose two folds cancel out', () => {
    // implemented_by folds onto implements, which swaps the roles, and the role
    // rule swaps them back — so the row keeps its subject and changes only its
    // predicate. Swapping the stored columns blind would undo the first fold.
    legacy('config_client_y', 'implemented_by', 'tkt-7004', '2026-07-01');
    foldInverses({ apply: true });

    const live = liveFor('config_client_y');
    assert.strictEqual(live.length, 1);
    assert.deepStrictEqual(
      [live[0].subject, live[0].predicate, live[0].object],
      ['config_client_y', 'implements', 'tkt-7004'],
    );
  });

  it('merges a role-inverted row into the canonical one it duplicates', () => {
    addFact('config_client_x', 'implements', 'tkt-7003', { validFrom: '2026-06-01', source: 'canonical-src' });
    legacy('tkt-7003', 'implements', 'config_client_x', '2026-05-01');
    foldInverses({ apply: true });

    const live = liveFor('tkt-7003');
    assert.strictEqual(live.length, 1, 'the fold created the duplicate it exists to prevent');
    assert.strictEqual(live[0].valid_from, '2026-05-01');
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
