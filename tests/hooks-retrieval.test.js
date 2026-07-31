// Exercises wakeup-hook.js and prompt-hint.js as real subprocesses (they
// process.exit() themselves — see tests/helpers/run-hook.mjs) fed the same
// stdin JSON shape Claude Code pipes into a hook.
import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getDb } from '../src/db.js';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'run-hook.mjs');

function runHook(name, hookInput) {
  return execFileSync(process.execPath, [HELPER, name], {
    input: JSON.stringify(hookInput),
    env: process.env,
    encoding: 'utf8',
  });
}

describe('wakeup-hook retrieval logging', () => {
  it('logs a briefing row, tagged with the hook session id, for the active-workstream id it prints', () => {
    const db = getDb();
    const doc = db.prepare(`INSERT INTO documents (title, content, doc_type) VALUES ('State: widget', 'body', 'note')`).run();
    db.prepare(
      `INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type) VALUES (?, ?, ?, ?, 'state')`
    ).run('state/widget.md', 'hash-widget', doc.lastInsertRowid, 'State: widget');

    const stdout = runHook('wakeup-hook', { session_id: 'sess-briefing-abc' });
    assert.match(stdout, /State: widget/); // sanity: the briefing actually printed it

    const row = db.prepare("SELECT * FROM retrievals WHERE surface = 'briefing' AND doc_id = ?").get(doc.lastInsertRowid);
    assert.ok(row, 'expected a briefing retrieval row for the surfaced state doc');
    assert.strictEqual(row.session, 'sess-briefing-abc');
  });

  it('does not log a row for a recent-entries doc, which the briefing shows by title only (no id to act on)', () => {
    const db = getDb();
    const doc = db.prepare(`INSERT INTO documents (title, content, doc_type) VALUES ('Recent only note', 'body', 'note')`).run();
    db.prepare(
      `INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type) VALUES (?, ?, ?, ?, 'lesson')`
    ).run('lesson/recent-only.md', 'hash-recent', doc.lastInsertRowid, 'Recent only note');

    runHook('wakeup-hook', { session_id: 'sess-recent-only' });

    const row = db.prepare("SELECT * FROM retrievals WHERE surface = 'briefing' AND doc_id = ?").get(doc.lastInsertRowid);
    assert.strictEqual(row, undefined);
  });

  it('does not crash on malformed stdin — briefing still prints', () => {
    const stdout = execFileSync(process.execPath, [HELPER, 'wakeup-hook'], {
      input: 'not json',
      env: process.env,
      encoding: 'utf8',
    });
    assert.match(stdout, /KB BRIEFING/);
  });
});

describe('prompt-hint retrieval logging', () => {
  it('logs a hint row per surfaced doc id, carrying the prompt as query and the hook session id', () => {
    const db = getDb();
    const doc = db.prepare(
      `INSERT INTO documents (title, content, doc_type, tags) VALUES ('Widget onboarding guide', 'widget onboarding guide for new hires', 'note', '')`
    ).run();

    const prompt = 'widget onboarding guide walkthrough';
    runHook('prompt-hint', { session_id: 'sess-hint-xyz', prompt });

    const row = db.prepare("SELECT * FROM retrievals WHERE surface = 'hint' AND doc_id = ?").get(doc.lastInsertRowid);
    assert.ok(row, 'expected a hint retrieval row');
    assert.strictEqual(row.session, 'sess-hint-xyz');
    assert.strictEqual(row.query, prompt);
  });

  it('logs nothing when the prompt is too short to hint on', () => {
    const db = getDb();
    const before = db.prepare("SELECT COUNT(*) c FROM retrievals WHERE surface = 'hint'").get().c;
    runHook('prompt-hint', { session_id: 'sess-short', prompt: 'hi' });
    const after = db.prepare("SELECT COUNT(*) c FROM retrievals WHERE surface = 'hint'").get().c;
    assert.strictEqual(after, before);
  });
});
