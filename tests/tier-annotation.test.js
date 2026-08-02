// A tier printed on every row is a tier that tells the reader nothing. Every
// note in the store is `inferred` and nothing has ever been promoted, so the
// mark introduced with tiers sat on 100% of hint items and 100% of briefing
// rows — the same defect as a hint that never declines, on the same surfaces.
import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getDb } from '../src/db.js';
import { TIER, tiersDiscriminate } from '../src/tiers.js';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'run-hook.mjs');
const runHook = (name, input) => execFileSync(process.execPath, [HELPER, name], {
  input: JSON.stringify(input), env: process.env, encoding: 'utf8',
});

// A note the hint will actually return, plus a sibling so its vocabulary is not
// a singleton, and enough filler for document frequencies to mean something.
function seed() {
  const db = getDb();
  const insert = db.prepare('INSERT INTO documents (title, content, doc_type, tags) VALUES (?, ?, ?, ?)');
  const first = insert.run('Sundial calibration drifts after a leap second', 'the offset is reapplied on restart', 'lesson', 'timekeeping');
  insert.run('Leap second handling in the sundial exporter', 'calibration offsets per reading', 'note', 'timekeeping');
  for (let i = 0; i < 300; i++) insert.run(`Filler ${i}`, `unremarkable prose zq${i}xj${i}kv`, 'note', 'misc');
  db.prepare("INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type) VALUES (?, ?, ?, ?, 'state')")
    .run('state/widget.md', 'hash-widget', first.lastInsertRowid, 'Sundial calibration drifts after a leap second');
  return first.lastInsertRowid;
}

const PROMPT = 'the sundial calibration drifts every time we take a leap second';

describe('tiersDiscriminate', () => {
  it('is false for one tier however many notes carry it', () => {
    assert.strictEqual(tiersDiscriminate([{ tier: TIER.INFERRED, count: 2131 }]), false);
  });

  it('is false for an empty store, and for buckets that exist but are empty', () => {
    assert.strictEqual(tiersDiscriminate([]), false);
    assert.strictEqual(tiersDiscriminate(undefined), false);
    assert.strictEqual(tiersDiscriminate([{ tier: TIER.INFERRED, count: 4 }, { tier: TIER.VERIFIED, count: 0 }]), false);
  });

  it('is true as soon as a second tier is populated', () => {
    assert.strictEqual(tiersDiscriminate([{ tier: TIER.INFERRED, count: 4 }, { tier: TIER.VERIFIED, count: 1 }]), true);
  });
});

describe('the push surfaces annotate only when the tier separates notes', () => {
  it('says nothing about tiers while the whole store sits at one', () => {
    const id = seed();

    const hint = runHook('prompt-hint', { session_id: 'sess-tier-uniform', prompt: PROMPT });
    assert.match(hint, /KB HINT/, 'the hint must still fire — this is about the label, not the hint');
    assert.ok(!hint.includes('⚠'), `uniform store still marked every hint row: ${hint}`);
    assert.ok(!hint.includes(TIER.INFERRED), `uniform store still named the tier: ${hint}`);

    const briefing = runHook('wakeup-hook', { session_id: 'sess-tier-uniform-b' });
    assert.match(briefing, /KB BRIEFING/);
    assert.ok(!briefing.includes('standing:'), `standing line printed for a single-tier store: ${briefing}`);
    assert.ok(!briefing.includes(TIER.INFERRED), `briefing named the tier anyway: ${briefing}`);
    assert.ok(briefing.includes(`#${id}`), 'the state note must still be listed');
  });

  it('starts annotating on its own once a note is promoted', () => {
    const id = getDb().prepare("SELECT id FROM documents WHERE doc_type = 'lesson'").get().id;
    getDb().prepare("UPDATE documents SET tier = ? WHERE id = ?").run(TIER.VERIFIED, id);

    const hint = runHook('prompt-hint', { session_id: 'sess-tier-mixed', prompt: PROMPT });
    assert.match(hint, /KB HINT/);
    assert.ok(hint.includes(TIER.VERIFIED), `a mixed store must label the hint rows: ${hint}`);
    assert.match(hint, /unconfirmed model conclusion/, 'the caveat returns with the labels it explains');

    const briefing = runHook('wakeup-hook', { session_id: 'sess-tier-mixed-b' });
    assert.match(briefing, /standing:/, `a mixed store must show the distribution: ${briefing}`);
    assert.ok(briefing.includes('⚠'), 'the floor is still marked once there is something to contrast it with');
  });
});
