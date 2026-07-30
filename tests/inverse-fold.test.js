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
