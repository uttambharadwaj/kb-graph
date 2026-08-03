// Exercises wakeup-hook.js and prompt-hint.js as real subprocesses (they
// process.exit() themselves — see tests/helpers/run-hook.mjs) fed the same
// stdin JSON shape Claude Code pipes into a hook.
import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getDb } from '../src/db.js';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'run-hook.mjs');

function runHook(name, hookInput, extraEnv = {}) {
  return execFileSync(process.execPath, [HELPER, name], {
    input: JSON.stringify(hookInput),
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
  });
}

// Our own `claude -p` subprocesses inherit the user's hooks despite the
// --settings '{"hooks":{}}' they are spawned with. Without this gate the hooks
// brief and hint a model that has no tools to act on either, and the read-path
// meter counts those as sessions — 83 of 83 briefed "sessions" in the first
// day of telemetry were this.
describe('batch calls are not sessions', () => {
  for (const hook of ['wakeup-hook', 'prompt-hint']) {
    it(`${hook} prints nothing and logs nothing when KB_BATCH is set`, () => {
      const db = getDb();
      const before = db.prepare('SELECT COUNT(*) c FROM retrievals').get().c;

      const stdout = runHook(
        hook,
        { session_id: `sess-batch-${hook}`, prompt: 'a prompt long enough to clear the hint length gate' },
        { KB_BATCH: '1' }
      );

      assert.strictEqual(stdout, '', 'a batch call must receive no injected context');
      assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM retrievals').get().c, before);
    });
  }
});

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

  it('logs nothing for markup the harness sent rather than the user', () => {
    const db = getDb();
    const before = db.prepare("SELECT COUNT(*) c FROM retrievals WHERE surface = 'hint'").get().c;
    for (const prompt of [
      '<task-notification>\n<task-id>abc123</task-id>\n<status>failed</status>\n</task-notification>',
      '<system-reminder>the task list has not been used recently, consider updating it</system-reminder>',
    ]) runHook('prompt-hint', { session_id: 'sess-envelope', prompt });
    const after = db.prepare("SELECT COUNT(*) c FROM retrievals WHERE surface = 'hint'").get().c;
    assert.strictEqual(after, before, 'a harness envelope is not a user prompt');

    // Opening with a tag is not enough: the prompt has to BE the element.
    runHook('prompt-hint', { session_id: 'sess-markup', prompt: '<div> is not rendering right on the settings page' });
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) c FROM retrievals WHERE session = 'sess-markup'").get().c, 1,
      'someone asking about markup is still a user',
    );
  });

  it('logs a miss when a real prompt clears no entry, so the hit rate keeps its denominator', () => {
    const db = getDb();
    const prompt = 'zqxjkv unrelatable phrasing that matches no stored entry at all';
    runHook('prompt-hint', { session_id: 'sess-hint-miss', prompt });

    const row = db.prepare(
      "SELECT * FROM retrievals WHERE surface = 'hint' AND session = 'sess-hint-miss'"
    ).get();
    assert.ok(row, 'expected a miss row for a prompt that surfaced nothing');
    assert.strictEqual(row.doc_id, null, 'a miss is recorded as a NULL doc_id, not an absent row');
    assert.strictEqual(row.query, prompt);
  });
});

// The intermittent "Failed to write to socket" on prompt submit has never been
// attributable to a hook, because a hook that fails and one that had nothing to
// say produce the same thing: no output, no row, no trace.
describe('prompt-hint leaves a marker when it fails', () => {
  // Its own KB dir, holding a kb.db that is not a database — a failure the hook
  // meets on the read path, where a real one would happen.
  const broken = mkdtempSync(join(tmpdir(), 'kb-hook-fail-'));
  const errorLog = join(broken, 'logs', 'prompt-hint-errors.log');
  const logLines = () => (existsSync(errorLog) ? readFileSync(errorLog, 'utf8').trim().split('\n').filter(Boolean) : []);

  it('records the failure instead of swallowing it, and still injects nothing', () => {
    writeFileSync(join(broken, 'kb.db'), 'not a sqlite file');
    const stdout = runHook(
      'prompt-hint',
      { session_id: 'sess-hook-failure', prompt: 'a prompt long enough to clear the hint length gate' },
      { KB_DIR: broken },
    );

    assert.strictEqual(stdout, '', 'a failed hint still injects nothing — non-blocking is the rule');
    const lines = logLines();
    assert.strictEqual(lines.length, 1, 'exactly one line per failure');
    assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z hint: /);
  });

  it('says nothing when the hook works', () => {
    const healthy = join(process.env.KB_DIR, 'logs', 'prompt-hint-errors.log');
    runHook('prompt-hint', { session_id: 'sess-hook-ok', prompt: 'a prompt long enough to clear the hint length gate' });
    assert.strictEqual(existsSync(healthy), false, 'a working hook writes no error line');
  });
});

// Node hands EPIPE to this callback when the reader is gone — verified directly
// against a real pipe, since a test that kills a reader mid-write is a race.
// What is checked here is the wiring: an errored write must be recorded as one.
describe('a hint that is written but not delivered says so', () => {
  it('records the failed write under its own stage', async () => {
    const { deliver, HOOK_ERROR_LOG } = await import('../src/cli/prompt-hint.js');
    const refuses = { write: (_data, cb) => cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })) };

    await deliver('KB HINT: something', refuses);

    const lines = readFileSync(HOOK_ERROR_LOG, 'utf8').trim().split('\n');
    assert.match(lines.at(-1), /deliver: .*EPIPE/);
  });
});
