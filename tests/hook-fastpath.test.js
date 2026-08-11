// Hooks-via-daemon fast path: the control socket daemon.js serves
// (prompt-hint / trigger-hook / wakeup-hook ops) and the CLI-side client
// (callDaemonOp, in each hook's own wrapper) that dials it with a deadline
// and falls back to the existing in-process compute on any failure.
//
// The key claim under test throughout: daemon-served and fallback-served
// output must be byte-identical for the same input — see "golden
// comparison" below. Busy-tolerance for the fallback path's own retrieval-log
// write is unit-tested in retrieval.test.js; this file adds the
// hint-still-prints half of that claim.
import './helpers/tmp-kb.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { getDb } from '../src/db.js';
import { DB_PATH } from '../src/paths.js';
import { HOOK_OP } from '../src/daemon-paths.js';
import { startDaemon } from '../src/daemon.js';
import { callDaemonOp } from '../src/cli/hook-io.js';
import { computePromptHint } from '../src/cli/prompt-hint.js';
import { computeWakeupHook } from '../src/cli/wakeup-hook.js';
import { computeTriggerHook, TRIGGER_HOOK_ENABLED_FLAG } from '../src/cli/trigger-hook.js';
import { startWedgedDaemon } from './helpers/wedged-daemon.js';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'run-hook.mjs');

function runHook(name, hookInput, extraEnv = {}) {
  return execFileSync(process.execPath, [HELPER, name], {
    input: JSON.stringify(hookInput),
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
  });
}

// Its own short dir per daemon, same rationale as daemon.test.js: sockaddr_un
// caps the path, and two daemons sharing one path would race each other.
const scratchDirs = [];
const liveDaemons = new Set();

after(async () => {
  for (const daemon of liveDaemons) await daemon.close().catch(() => {});
  liveDaemons.clear();
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function freshSocketPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'kb-fastpath-sock-'));
  scratchDirs.push(dir);
  return { socketPath: join(dir, 'd.sock'), controlSocketPath: join(dir, 'ctl.sock') };
}

async function startTestDaemon() {
  const { socketPath, controlSocketPath } = freshSocketPaths();
  const daemon = await startDaemon({ socketPath, controlSocketPath });
  liveDaemons.add(daemon);
  return daemon;
}

function insertHintableDoc(title, body) {
  const db = getDb();
  return db.prepare(
    `INSERT INTO documents (title, content, doc_type, tags) VALUES (?, ?, 'note', '')`
  ).run(title, body).lastInsertRowid;
}

function insertStateNote(title, content) {
  const db = getDb();
  const doc = db.prepare(`INSERT INTO documents (title, content, doc_type) VALUES (?, ?, 'note')`).run(title, content);
  db.prepare(
    `INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type) VALUES (?, ?, ?, ?, 'state')`
  ).run(`state/${doc.lastInsertRowid}.md`, `hash-${doc.lastInsertRowid}`, doc.lastInsertRowid, title);
  return doc.lastInsertRowid;
}

const BASH = (command, session_id) => ({ session_id, tool_name: 'Bash', tool_input: { command }, cwd: '/x' });

// getHealth({recordBacklog: true}) — which every computeWakeupHook call makes
// — deliberately writes a new backlog baseline on every call (its own doc
// comment: "marks this call as a session boundary, which is the clock the
// backlog warnings measure growth against"). Two back-to-back calls are
// therefore NOT guaranteed to print the same health line even against
// identical document data: the second call always measures zero growth
// against the baseline the first call just wrote. That is correct product
// behavior, not something this file's golden-output comparisons should be
// tripped up by — strip the one stateful line before comparing.
const stripHealthLine = (text) => text.split('\n').filter(l => !l.startsWith('health:')).join('\n');

describe('control-socket round trip: daemon-served output equals the in-process compute', () => {
  it('prompt-hint: same hint text and structure from the daemon as from computePromptHint directly', async () => {
    insertHintableDoc('Gizmo rotation calibration guide', 'gizmo rotation calibration guide for new hires');
    const prompt = 'gizmo rotation calibration guide walkthrough';
    const session = 'sess-golden-hint';

    const daemon = await startTestDaemon();
    const viaDaemon = await callDaemonOp(HOOK_OP.PROMPT_HINT, { prompt, session }, { timeoutMs: 2000, socketPath: daemon.controlSocketPath });
    assert.strictEqual(viaDaemon.ok, true);

    const viaCompute = computePromptHint({ prompt, session: `${session}-direct` });
    assert.strictEqual(viaDaemon.output, viaCompute, 'the daemon and the direct compute must answer identically for the same fixture');
    assert.match(viaDaemon.output, /^KB HINT:/);
  });

  it('wakeup-hook: same briefing text from the daemon as from computeWakeupHook directly', async () => {
    insertStateNote('State: fastpath golden', 'body worth briefing');
    const hookInput = { session_id: 'sess-golden-wakeup' };

    const daemon = await startTestDaemon();
    const viaDaemon = await callDaemonOp(HOOK_OP.WAKEUP_HOOK, { hookInput, session: hookInput.session_id }, { timeoutMs: 2000, socketPath: daemon.controlSocketPath });
    assert.strictEqual(viaDaemon.ok, true);

    const viaCompute = computeWakeupHook({ hookInput: { session_id: 'sess-golden-wakeup-direct' }, session: 'sess-golden-wakeup-direct' });
    assert.strictEqual(stripHealthLine(viaDaemon.output), stripHealthLine(viaCompute));
    assert.match(viaDaemon.output, /^KB BRIEFING/);
    assert.match(viaDaemon.output, /State: fastpath golden/);
  });

  it('trigger-hook: same trigger envelope from the daemon as from computeTriggerHook directly', async () => {
    writeFileSync(join(process.env.KB_DIR, 'trigger-index.json'), JSON.stringify([
      { id: 501, title: 'Force-delete branch', tier: 'observed', patterns: [{ parts: ['gh pr merge', '--delete-branch'], hits: 2, sessions: 1 }] },
    ]));
    writeFileSync(TRIGGER_HOOK_ENABLED_FLAG, '');
    const hookInput = BASH('gh pr merge 1 --delete-branch', 'sess-golden-trigger');

    const daemon = await startTestDaemon();
    const viaDaemon = await callDaemonOp(HOOK_OP.TRIGGER_HOOK, { hookInput }, { timeoutMs: 2000, socketPath: daemon.controlSocketPath });
    assert.strictEqual(viaDaemon.ok, true);

    const viaCompute = computeTriggerHook(BASH('gh pr merge 1 --delete-branch', 'sess-golden-trigger-direct'));
    assert.strictEqual(viaDaemon.output, viaCompute);
    assert.match(viaDaemon.output, /"additionalContext":"⚠ KB TRIGGER: note #501/);
  });

  it('an unknown op is refused rather than silently answering ok, and logged server-side', async () => {
    const { socketPath, controlSocketPath } = freshSocketPaths();
    const errors = [];
    const daemon = await startDaemon({ socketPath, controlSocketPath, onError: (err) => errors.push(err) });
    liveDaemons.add(daemon);

    const result = await callDaemonOp('not-a-real-op', {}, { timeoutMs: 2000, socketPath: daemon.controlSocketPath });
    assert.strictEqual(result.ok, false);
    assert.ok(
      errors.some(err => /unknown control op "not-a-real-op"/.test(err.message)),
      'a bad op must reach onError, not only the client that is about to fall back',
    );
  });
});

describe('CLI hooks fall back cleanly when the daemon is unreachable', () => {
  it('prompt-hint: fallback output matches computePromptHint, well inside the timeout budget', () => {
    insertHintableDoc('Widget onboarding guide', 'widget onboarding guide for new hires');
    const prompt = 'widget onboarding guide walkthrough';
    const { controlSocketPath } = freshSocketPaths(); // nobody is listening here

    const started = Date.now();
    const stdout = runHook(
      'prompt-hint',
      { session_id: 'sess-fallback-hint', prompt },
      { KB_CONTROL_SOCKET_PATH: controlSocketPath, KB_HOOK_DAEMON_TIMEOUT_MS: '400' },
    );
    const elapsed = Date.now() - started;

    const expected = computePromptHint({ prompt, session: 'sess-fallback-hint-direct', fastWrite: true });
    assert.strictEqual(stdout.trim(), expected);
    assert.ok(elapsed < 3000, `expected the fallback to stay well inside the 400ms deadline, took ${elapsed}ms`);
  });

  it('wakeup-hook: fallback output matches computeWakeupHook', () => {
    insertStateNote('State: fastpath fallback', 'body worth briefing on fallback');
    const { controlSocketPath } = freshSocketPaths();

    const stdout = runHook(
      'wakeup-hook',
      { session_id: 'sess-fallback-wakeup' },
      { KB_CONTROL_SOCKET_PATH: controlSocketPath, KB_HOOK_DAEMON_TIMEOUT_MS: '400' },
    );

    const expected = computeWakeupHook({ hookInput: { session_id: 'sess-fallback-wakeup-direct' }, session: 'sess-fallback-wakeup-direct', fastWrite: true });
    assert.strictEqual(stripHealthLine(stdout.trim()), stripHealthLine(expected.trim()));
    assert.match(stdout, /State: fastpath fallback/);
  });

  it('trigger-hook: fallback output matches computeTriggerHook', () => {
    writeFileSync(join(process.env.KB_DIR, 'trigger-index.json'), JSON.stringify([
      { id: 502, title: 'Force-delete branch (fallback)', tier: 'observed', patterns: [{ parts: ['gh pr merge', '--delete-branch'], hits: 2, sessions: 1 }] },
    ]));
    writeFileSync(TRIGGER_HOOK_ENABLED_FLAG, '');
    const { controlSocketPath } = freshSocketPaths();

    const stdout = runHook(
      'trigger-hook',
      BASH('gh pr merge 1 --delete-branch', 'sess-fallback-trigger'),
      { KB_CONTROL_SOCKET_PATH: controlSocketPath, KB_HOOK_DAEMON_TIMEOUT_MS: '400' },
    );

    assert.match(stdout, /"additionalContext":"⚠ KB TRIGGER: note #502/);
  });
});

describe('CLI hooks honor the deadline against a wedged daemon and never emit partial output', () => {
  it('prompt-hint: falls back within the deadline, prints only a complete, well-formed hint', async () => {
    insertHintableDoc('Rotor alignment procedure', 'rotor alignment procedure for the calibration bay');
    const prompt = 'rotor alignment procedure walkthrough for the bay';
    const { controlSocketPath } = freshSocketPaths();
    const wedged = await startWedgedDaemon(controlSocketPath);
    try {
      const started = Date.now();
      const stdout = runHook(
        'prompt-hint',
        { session_id: 'sess-wedged-hint', prompt },
        { KB_CONTROL_SOCKET_PATH: controlSocketPath, KB_HOOK_DAEMON_TIMEOUT_MS: '300' },
      );
      const elapsed = Date.now() - started;

      assert.ok(elapsed < 3000, `expected the 300ms deadline to be honored, took ${elapsed}ms`);
      // Exactly one well-formed line, not a truncated fragment of one.
      const lines = stdout.split('\n').filter(Boolean);
      assert.strictEqual(lines.length, 1);
      assert.match(lines[0], /^KB HINT:.*Check them with kb_read\(id\) before exploring from scratch\.$/);
    } finally {
      await wedged.close();
    }
  });

  it('trigger-hook: falls back within the deadline, prints only complete JSON', async () => {
    writeFileSync(join(process.env.KB_DIR, 'trigger-index.json'), JSON.stringify([
      { id: 503, title: 'Force-delete branch (wedged)', tier: 'observed', patterns: [{ parts: ['gh pr merge', '--delete-branch'], hits: 2, sessions: 1 }] },
    ]));
    writeFileSync(TRIGGER_HOOK_ENABLED_FLAG, '');
    const { controlSocketPath } = freshSocketPaths();
    const wedged = await startWedgedDaemon(controlSocketPath);
    try {
      const started = Date.now();
      const stdout = runHook(
        'trigger-hook',
        BASH('gh pr merge 1 --delete-branch', 'sess-wedged-trigger'),
        { KB_CONTROL_SOCKET_PATH: controlSocketPath, KB_HOOK_DAEMON_TIMEOUT_MS: '300' },
      );
      const elapsed = Date.now() - started;

      assert.ok(elapsed < 3000, `expected the 300ms deadline to be honored, took ${elapsed}ms`);
      const lines = stdout.split('\n').filter(Boolean);
      assert.strictEqual(lines.length, 1);
      assert.doesNotThrow(() => JSON.parse(lines[0]), 'must be complete, parseable JSON, not a truncated fragment');
    } finally {
      await wedged.close();
    }
  });
});

describe('the fallback path still answers when its own retrieval-log write is busy', () => {
  it('prompt-hint still returns a hint while a concurrent writer holds the DB lock', () => {
    insertHintableDoc('Torque wrench calibration steps', 'torque wrench calibration steps for the bay crew');
    const prompt = 'torque wrench calibration steps for bay crew';

    const blocker = new Database(DB_PATH);
    blocker.pragma('journal_mode = WAL');
    blocker.exec('BEGIN IMMEDIATE');
    let output;
    const started = Date.now();
    try {
      output = computePromptHint({ prompt, session: 'sess-busy-hint', fastWrite: true });
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
    const elapsed = Date.now() - started;

    assert.match(output, /^KB HINT:/, 'the hint must still be produced even though its log write was dropped');
    assert.ok(elapsed < 1000, `expected the busy write to fail fast rather than block, took ${elapsed}ms`);
    const row = getDb().prepare("SELECT * FROM retrievals WHERE session = 'sess-busy-hint'").get();
    assert.strictEqual(row, undefined, 'the retrieval row must be dropped, not eventually written');
  });
});
