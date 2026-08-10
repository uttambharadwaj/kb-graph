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

function insertStateNote(db, { title, content, updatedAt }) {
  const doc = db.prepare(`INSERT INTO documents (title, content, doc_type) VALUES (?, ?, 'note')`).run(title, content);
  if (updatedAt) db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(updatedAt, doc.lastInsertRowid);
  db.prepare(
    `INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type) VALUES (?, ?, ?, ?, 'state')`
  ).run(`state/${doc.lastInsertRowid}.md`, `hash-${doc.lastInsertRowid}`, doc.lastInsertRowid, title);
  return doc.lastInsertRowid;
}

describe('wakeup-hook post-compact recovery', () => {
  it('appends the active state note content when source is compact', () => {
    const db = getDb();
    // Fixed far-future date so this note unambiguously outranks whatever
    // other tests in this file have already inserted with "now" timestamps.
    insertStateNote(db, { title: 'State: recovery test', content: 'body worth recovering', updatedAt: '2031-01-01T00:00:00Z' });

    const stdout = runHook('wakeup-hook', { session_id: 'sess-compact-basic', source: 'compact' });

    assert.match(stdout, /--- Active workstream state \(post-compact recovery\): State: recovery test \(#\d+\) ---/);
    assert.match(stdout, /body worth recovering/);
  });

  it('does not append anything when source is not compact', () => {
    const db = getDb();
    insertStateNote(db, { title: 'State: no injection', content: 'should not appear' });

    const stdout = runHook('wakeup-hook', { session_id: 'sess-not-compact' });

    assert.doesNotMatch(stdout, /post-compact recovery/);
    assert.doesNotMatch(stdout, /should not appear/);
  });

  it('prefers the state note this session read over the most recently updated one', () => {
    const db = getDb();
    const older = insertStateNote(db, { title: 'State: session read', content: 'what this session was actually doing', updatedAt: '2020-01-01T00:00:00Z' });
    // Deliberately the most-recently-updated live state note in the whole DB —
    // the fallback path would pick this one. A genuine session-scoped read
    // must win over it.
    insertStateNote(db, { title: 'State: unrelated newer', content: 'a different workstream', updatedAt: '2032-01-01T00:00:00Z' });

    // Simulate this session having read the older note earlier (e.g. via kb_read).
    // Must be a READ surface, not 'briefing' — the hook's own states loop logs
    // BRIEFING rows for every live state under the current session on every
    // run, so a query that didn't filter by surface would just match its own push.
    db.prepare("INSERT INTO retrievals (doc_id, surface, session) VALUES (?, 'kb_read', ?)").run(older, 'sess-scoped-pick');

    const stdout = runHook('wakeup-hook', { session_id: 'sess-scoped-pick', source: 'compact' });

    assert.match(stdout, /State: session read/);
    assert.match(stdout, /what this session was actually doing/);
    assert.doesNotMatch(stdout, /a different workstream/);
  });

  it('truncates the injected note at the cap and points at kb_read for the rest', () => {
    const db = getDb();
    const longContent = 'x'.repeat(7000);
    const id = insertStateNote(db, { title: 'State: oversized', content: longContent, updatedAt: '2033-01-01T00:00:00Z' });

    const stdout = runHook('wakeup-hook', { session_id: 'sess-truncate', source: 'compact' });

    assert.match(stdout, new RegExp(`\\[truncated at 6000 chars — kb_read\\(${id}\\) for the rest\\]`));
    assert.ok(!stdout.includes(longContent), 'full untruncated content should not appear');
    assert.ok(stdout.includes('x'.repeat(6000)), 'truncated content up to the cap should appear');
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
      // The attributes are how a subagent's report arrives, and an envelope
      // filter that only knows bare tags passed the whole report through.
      '<agent-message from="scheduled-audit">\nRead-only audit complete, nothing to report.\n</agent-message>',
      "<agent-message from='scheduled-audit' to='main'>done</agent-message>",
    ]) runHook('prompt-hint', { session_id: 'sess-envelope', prompt });
    const after = db.prepare("SELECT COUNT(*) c FROM retrievals WHERE surface = 'hint'").get().c;
    assert.strictEqual(after, before, 'a harness envelope is not a user prompt');

    // Opening with a tag is not enough: the prompt has to BE the element.
    for (const [session, prompt] of [
      ['sess-markup', '<div> is not rendering right on the settings page'],
      ['sess-quoting', '<agent-message from="a">it failed</agent-message> what do you make of that'],
    ]) {
      runHook('prompt-hint', { session_id: session, prompt });
      assert.strictEqual(
        db.prepare('SELECT COUNT(*) c FROM retrievals WHERE session = ?').get(session).c, 1,
        'someone asking about markup, or quoting one, is still a user',
      );
    }
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
  const errorLog = join(broken, 'logs', 'hook-errors.log');
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
    const healthy = join(process.env.KB_DIR, 'logs', 'hook-errors.log');
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

// A8: this log is shared infrastructure now (prompt-hint.js and
// trigger-hook.js both fail into it) — it used to be named after the one
// hook that first needed it, which would misleadingly file a trigger-hook
// failure under "prompt hint" during triage.
describe('the shared hook error log is named for what it is, not for the first hook that needed it', () => {
  it('HOOK_ERROR_LOG points at hook-errors.log, not prompt-hint-errors.log', async () => {
    const { HOOK_ERROR_LOG } = await import('../src/cli/hook-io.js');
    assert.match(HOOK_ERROR_LOG, /\/hook-errors\.log$/);
    assert.doesNotMatch(HOOK_ERROR_LOG, /prompt-hint/);
  });

  it('prompt-hint.js re-exports the exact same constant, not a copy', async () => {
    const fromHookIo = (await import('../src/cli/hook-io.js')).HOOK_ERROR_LOG;
    const fromPromptHint = (await import('../src/cli/prompt-hint.js')).HOOK_ERROR_LOG;
    assert.strictEqual(fromPromptHint, fromHookIo);
  });
});
