import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Point the KB at a throwaway dir BEFORE importing anything that opens the DB.
process.env.KB_DIR = mkdtempSync(join(tmpdir(), 'kb-inverse-'));

const { canonicalTriple, consolidate } = await import('../src/extract.js');
const { queryFact } = await import('../src/facts.js');

const triple = (subject, predicate, object) => ({ subject, predicate, object });

describe('inverse predicate folding', () => {
  // The shipped config, not the code: folding is only safe because no inverse
  // touches a single-valued predicate, and nothing stops a later edit to
  // predicates.json from adding one. Retirement is subject-scoped, so this flat
  // check is stricter than the rule it protects — which is the right direction.
  it('ships no inverse that touches a single-valued predicate', async () => {
    const { readFileSync } = await import('fs');
    const cfg = JSON.parse(readFileSync(new URL('../src/predicates.json', import.meta.url), 'utf8'));
    const single = new Set(cfg.single_valued);
    const overlap = Object.entries(cfg.inverses ?? {})
      .flat()
      .filter(p => single.has(p));
    assert.deepStrictEqual(overlap, [], `these would move a retirement onto a different subject: ${overlap}`);
  });


  it('swaps subject and object onto the canonical direction', () => {
    assert.deepStrictEqual(
      canonicalTriple(triple('eva', 'owned_by', 'core_technologies')),
      triple('core_technologies', 'owns', 'eva'),
    );
  });

  it('leaves a predicate that is already canonical alone', () => {
    assert.deepStrictEqual(
      canonicalTriple(triple('core_technologies', 'owns', 'eva')),
      triple('core_technologies', 'owns', 'eva'),
    );
  });

  it('normalizes the predicate of a fact it does not swap', () => {
    assert.deepStrictEqual(
      canonicalTriple(triple('pf-1', 'Subtask Of', 'pf-2')),
      triple('pf-1', 'child_of', 'pf-2'),
    );
  });

  // Measured across three runs of one identical input: the same relationship
  // came back with subject and object swapped between runs, under a different
  // predicate each time. Direction is not a stable property of a call, so both
  // spellings have to land on one edge.
  for (const [emitted, canonical] of [
    [triple('tkt-99', 'fixed_in', 'pr #48'), triple('pr #48', 'fixes', 'tkt-99')],
    [triple('pr #48', 'written_by', 'robin'), triple('robin', 'authored', 'pr #48')],
    [triple('robin', 'approved', 'pr #48'), triple('pr #48', 'approved_by', 'robin')],
  ]) {
    it(`folds ${emitted.predicate} onto ${canonical.predicate}`, () => {
      assert.deepStrictEqual(canonicalTriple(emitted), canonical);
      // and the direction it is already in survives the round trip
      assert.deepStrictEqual(canonicalTriple(canonical), canonical);
    });
  }

  // authored_by is an alias of written_by, which is a fold source: the lookup
  // resolves the alias first, so a two-hop spelling still converges.
  it('folds a spelling that is an alias of a fold source', () => {
    assert.deepStrictEqual(
      canonicalTriple(triple('pr #48', 'authored_by', 'robin')),
      triple('robin', 'authored', 'pr #48'),
    );
  });

  it('carries fields it does not own through the fold', () => {
    const folded = canonicalTriple({ ...triple('a', 'blocks', 'b'), category: 'status' });
    assert.strictEqual(folded.category, 'status');
  });

  // The bug: both directions live, so a change phrased in one leaves the other
  // asserting the old state. One row means one thing to retire.
  it('stores both spellings of one relationship as a single fact', () => {
    const first = consolidate([triple('pf_2815', 'blocks', 'pf_2816')], { observationDate: '2026-07-01' });
    assert.strictEqual(first.added.length, 1);

    const second = consolidate([triple('pf_2816', 'blocked_by', 'pf_2815')], { observationDate: '2026-07-02' });
    assert.strictEqual(second.added.length, 0, 'the mirrored spelling must not add a second row');
    assert.strictEqual(second.skipped[0].reason, 'duplicate');

    const live = queryFact('pf_2816', { direction: 'both' }).filter(r => r.current);
    assert.strictEqual(live.length, 1, `expected one live row, got ${JSON.stringify(live)}`);
    assert.strictEqual(live[0].predicate, 'blocked_by');
  });

  // Folding a single-valued predicate would move its retirement onto a different
  // subject — the exact failure the map exists to prevent, so a configured one is
  // dropped rather than applied.
  it('refuses an inverse that would fold a single-valued predicate', async () => {
    const { writeFileSync, mkdtempSync: mkd } = await import('fs');
    const dir = mkd(join(tmpdir(), 'kb-inverse-override-'));
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify({ inverses: { assigned_to: 'owns' } }));

    const { execFileSync } = await import('child_process');
    const script = `
      const { canonicalTriple } = await import(${JSON.stringify(new URL('../src/extract.js', import.meta.url).href)});
      const t = canonicalTriple({ subject: 'pf-1', predicate: 'assigned_to', object: 'alice' });
      console.log(JSON.stringify(t));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, KB_DIR: dir },
      encoding: 'utf8',
    });
    assert.deepStrictEqual(JSON.parse(out.trim()), triple('pf-1', 'assigned_to', 'alice'));
  });

  // An alias resolves to a single-valued predicate, so checking the raw spelling
  // reads it as many-valued and lets the fold through — defeating the refusal
  // above and storing the un-aliased predicate on top of it.
  it('refuses an inverse whose target only reaches single-valued through an alias', async () => {
    const { writeFileSync, mkdtempSync: mkd } = await import('fs');
    const dir = mkd(join(tmpdir(), 'kb-inverse-aliased-'));
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
      aliases: { assigned: 'assigned_to' },
      inverses: { owned_by: 'assigned' },
    }));

    const { execFileSync } = await import('child_process');
    const script = `
      const { canonicalTriple } = await import(${JSON.stringify(new URL('../src/extract.js', import.meta.url).href)});
      console.log(JSON.stringify(canonicalTriple({ subject: 'pf-1', predicate: 'owned_by', object: 'alice' })));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, KB_DIR: dir },
      encoding: 'utf8',
    });
    assert.deepStrictEqual(JSON.parse(out.trim()), triple('pf-1', 'owned_by', 'alice'));
  });

  // A key the alias map rewrites can never be looked up, because canonicalTriple
  // resolves the predicate before consulting the inverse map.
  it('folds an inverse whose source is itself an alias', async () => {
    const { writeFileSync, mkdtempSync: mkd } = await import('fs');
    const dir = mkd(join(tmpdir(), 'kb-inverse-aliassrc-'));
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
      aliases: { obstructs: 'blocks' },
      inverses: { obstructs: 'blocked_by' },
    }));

    const { execFileSync } = await import('child_process');
    const script = `
      const { canonicalTriple } = await import(${JSON.stringify(new URL('../src/extract.js', import.meta.url).href)});
      console.log(JSON.stringify(canonicalTriple({ subject: 'a', predicate: 'obstructs', object: 'b' })));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, KB_DIR: dir },
      encoding: 'utf8',
    });
    assert.deepStrictEqual(JSON.parse(out.trim()), triple('b', 'blocked_by', 'a'));
  });

  // Overrides merge by source key, so choosing the opposite direction of a
  // built-in leaves both entries and the fold toggles instead of converging.
  it('refuses an inverse pair that would never converge', async () => {
    const { writeFileSync, mkdtempSync: mkd } = await import('fs');
    const dir = mkd(join(tmpdir(), 'kb-inverse-cycle-'));
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify({ inverses: { blocked_by: 'blocks' } }));

    const { execFileSync } = await import('child_process');
    const script = `
      const { canonicalTriple } = await import(${JSON.stringify(new URL('../src/extract.js', import.meta.url).href)});
      console.log(JSON.stringify([
        canonicalTriple({ subject: 'a', predicate: 'blocks', object: 'b' }),
        canonicalTriple({ subject: 'b', predicate: 'blocked_by', object: 'a' }),
      ]));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, KB_DIR: dir },
      encoding: 'utf8',
    });
    // Neither folds: both entries are dropped, which is the pre-fold behaviour.
    // A toggle would swap each of these into the other.
    assert.deepStrictEqual(JSON.parse(out.trim()), [
      triple('a', 'blocks', 'b'),
      triple('b', 'blocked_by', 'a'),
    ]);
  });

  // Reassignment is what the refusal above protects: it only supersedes because
  // the ticket is the subject.
  it('supersedes an assignment when the ticket keeps the subject position', () => {
    consolidate([triple('pf-2794', 'assigned_to', 'uttam')], { observationDate: '2026-07-01' });
    const res = consolidate([triple('pf-2794', 'assigned_to', 'catherine')], { observationDate: '2026-07-02' });

    assert.strictEqual(res.invalidated.length, 1);
    const live = queryFact('pf-2794', { direction: 'outgoing' }).filter(r => r.current);
    assert.deepStrictEqual(live.map(r => r.object), ['catherine']);
  });
});
