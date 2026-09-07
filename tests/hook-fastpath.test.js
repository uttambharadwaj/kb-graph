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
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connect, createServer } from 'node:net';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { getDb } from '../src/db.js';
import { DB_PATH } from '../src/paths.js';
import { HOOK_OP } from '../src/daemon-paths.js';
import { startDaemon } from '../src/daemon.js';
import { callDaemonOp } from '../src/cli/hook-io.js';
import { computePromptHint } from '../src/cli/prompt-hint.js';
import { computeWakeupHook } from '../src/cli/wakeup-hook.js';
import { computeTriggerHook, TRIGGER_HOOK_ENABLED_FLAG, TRIGGERS_LOG_DIR } from '../src/cli/trigger-hook.js';
import { startWedgedDaemon } from './helpers/wedged-daemon.js';
import { startSlowDaemon } from './helpers/slow-daemon.js';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'run-hook.mjs');

function runHook(name, hookInput, extraEnv = {}, args = []) {
  return execFileSync(process.execPath, [HELPER, name, ...args], {
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
  it('preserves UTF-8 characters split across request chunks', { timeout: 5000 }, async () => {
    const { socketPath, controlSocketPath } = freshSocketPaths();
    const errors = [];
    const daemon = await startDaemon({ socketPath, controlSocketPath, onError: err => errors.push(err) });
    liveDaemons.add(daemon);
    const socket = connect(controlSocketPath);
    socket.setEncoding('utf8');
    let response = '';
    socket.on('data', chunk => { response += chunk; });
    const ended = once(socket, 'end');
    try {
      await once(socket, 'connect');
      const op = 'unknown-é中🐟';
      // Separate every byte so 2-, 3-, and 4-byte characters cross chunks.
      for (const byte of Buffer.from(`${JSON.stringify({ op, payload: {} })}\n`)) {
        socket.write(Buffer.of(byte));
        await delay(2);
      }
      await ended;
      assert.deepStrictEqual(JSON.parse(response), { ok: false, error: `unknown control op "${op}"` });
      assert.strictEqual(errors[0]?.message, `unknown control op "${op}"`);
    } finally {
      socket.destroy();
    }
  });

  it('preserves UTF-8 characters split across response chunks in output and plan', { timeout: 5000 }, async () => {
    const { controlSocketPath } = freshSocketPaths();
    const expected = { ok: true, output: 'é中🐟', plan: { session: 'é中🐟' } };
    let peer;
    const server = createServer(socket => { peer = socket; });
    server.listen(controlSocketPath);
    await once(server, 'listening');
    try {
      const connected = once(server, 'connection');
      const result = callDaemonOp(HOOK_OP.PROMPT_HINT, {}, { socketPath: controlSocketPath, timeoutMs: 3000 });
      const [socket] = await connected;
      await once(socket, 'data');
      for (const byte of Buffer.from(`${JSON.stringify(expected)}\n`)) {
        socket.write(Buffer.of(byte));
        await delay(2);
      }
      assert.deepStrictEqual(await result, expected);
    } finally {
      peer?.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('prompt-hint: same hint text and structure from the daemon as from computePromptHint directly', async () => {
    insertHintableDoc('Gizmo rotation calibration guide', 'gizmo rotation calibration guide for new hires');
    const prompt = 'gizmo rotation calibration guide walkthrough';
    const session = 'sess-golden-hint';

    const daemon = await startTestDaemon();
    const viaDaemon = await callDaemonOp(HOOK_OP.PROMPT_HINT, { prompt, session }, { timeoutMs: 2000, socketPath: daemon.controlSocketPath });
    assert.strictEqual(viaDaemon.ok, true);

    const { output: viaCompute } = computePromptHint({ prompt, session: `${session}-direct` });
    assert.strictEqual(viaDaemon.output, viaCompute, 'the daemon and the direct compute must answer identically for the same fixture');
    assert.ok(viaDaemon.plan, 'a daemon answer with a hint must carry an uncommitted plan for the client to commit');
    assert.match(viaDaemon.output, /^KB HINT:/);
  });

  it('wakeup-hook: same briefing text from the daemon as from computeWakeupHook directly', async () => {
    insertStateNote('State: fastpath golden', 'body worth briefing');
    const hookInput = { session_id: 'sess-golden-wakeup' };

    const daemon = await startTestDaemon();
    const viaDaemon = await callDaemonOp(HOOK_OP.WAKEUP_HOOK, { hookInput, session: hookInput.session_id }, { timeoutMs: 2000, socketPath: daemon.controlSocketPath });
    assert.strictEqual(viaDaemon.ok, true);

    const { output: viaCompute } = computeWakeupHook({ hookInput: { session_id: 'sess-golden-wakeup-direct' }, session: 'sess-golden-wakeup-direct' });
    assert.strictEqual(stripHealthLine(viaDaemon.output), stripHealthLine(viaCompute));
    assert.ok(viaDaemon.plan, 'a daemon briefing answer must carry an uncommitted plan for the client to commit');
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

    const { output: viaCompute } = computeTriggerHook(BASH('gh pr merge 1 --delete-branch', 'sess-golden-trigger-direct'));
    assert.strictEqual(viaDaemon.output, viaCompute);
    assert.match(viaDaemon.output, /"additionalContext":"⚠ KB TRIGGER: note #501/);
    assert.ok(viaDaemon.plan?.marker, 'a daemon trigger answer must carry an uncommitted marker for the client to commit');
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

    const { output: expected } = computePromptHint({ prompt, session: 'sess-fallback-hint-direct', fastWrite: true });
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

    const { output: expected } = computeWakeupHook({ hookInput: { session_id: 'sess-fallback-wakeup-direct' }, session: 'sess-fallback-wakeup-direct', fastWrite: true });
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
      ({ output } = computePromptHint({ prompt, session: 'sess-busy-hint', fastWrite: true }));
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

// Direct regression coverage for the double-log/burned-marker race: a
// healthy daemon computes with commit: false and writes nothing itself; the
// CLIENT commits its plan exactly once, right before delivering. A slow
// daemon whose answer arrives after the client's own deadline already fired
// must therefore write NOTHING when it finally responds — the client has
// already fallen back, computed, and committed its own answer by then.
// Before this fix, both the daemon (writing directly, unconditionally) and
// the fallback (also writing directly) could log the same decision twice, or
// — for the trigger marker — the daemon could burn it for a warning the
// deadline discarded, permanently and silently suppressing every later
// occurrence in that session.
describe('exactly one process ever commits the outcome of one hook decision', () => {
  it('prompt-hint: a healthy daemon writes nothing itself — the client commits the plan once', async () => {
    insertHintableDoc('Coolant flush interval guide', 'coolant flush interval guide for the bay crew');
    const prompt = 'coolant flush interval guide for the bay crew';
    const daemon = await startTestDaemon();

    const stdout = runHook(
      'prompt-hint',
      { session_id: 'sess-onelog-healthy', prompt },
      { KB_CONTROL_SOCKET_PATH: daemon.controlSocketPath, KB_HOOK_DAEMON_TIMEOUT_MS: '2000' },
    );
    assert.match(stdout, /^KB HINT:/);

    const rows = getDb().prepare("SELECT * FROM retrievals WHERE session = 'sess-onelog-healthy'").all();
    assert.strictEqual(rows.length, 1, 'exactly one retrieval row for one delivered hint');
  });

  it('prompt-hint: a daemon slower than the deadline logs nothing — the fallback\'s row is the only one', async () => {
    insertHintableDoc('Bearing seal replacement checklist', 'bearing seal replacement checklist for the bay crew');
    const prompt = 'bearing seal replacement checklist for bay crew';
    const { controlSocketPath } = freshSocketPaths();
    const session = 'sess-onelog-slow-hint';
    const slow = await startSlowDaemon(controlSocketPath, {
      delayMs: 500,
      buildResponse: (op, payload) => {
        assert.strictEqual(op, HOOK_OP.PROMPT_HINT);
        const result = computePromptHint({ ...payload, commit: false });
        return { ok: true, output: result.output, plan: result.plan };
      },
    });
    try {
      const stdout = runHook(
        'prompt-hint',
        { session_id: session, prompt },
        { KB_CONTROL_SOCKET_PATH: controlSocketPath, KB_HOOK_DAEMON_TIMEOUT_MS: '150' },
      );
      assert.match(stdout, /^KB HINT:/, 'the fallback must still deliver the hint the client itself computed');

      // Long enough for the slow daemon's delayed answer to actually reach
      // the (by now closed) socket and attempt to matter.
      await delay(700);

      const rows = getDb().prepare(`SELECT * FROM retrievals WHERE session = '${session}'`).all();
      assert.strictEqual(rows.length, 1, 'exactly one row — the fallback\'s; the discarded daemon answer must write nothing');
    } finally {
      await slow.close();
    }
  });

  it('trigger-hook: a daemon slower than the deadline never burns the marker — the fallback re-decides and fires', async () => {
    writeFileSync(join(process.env.KB_DIR, 'trigger-index.json'), JSON.stringify([
      { id: 504, title: 'Force-delete branch (race)', tier: 'observed', patterns: [{ parts: ['gh pr merge', '--delete-branch'], hits: 2, sessions: 1 }] },
    ]));
    writeFileSync(TRIGGER_HOOK_ENABLED_FLAG, '');
    const { controlSocketPath } = freshSocketPaths();
    const session = 'sess-onelog-slow-trigger';
    const slow = await startSlowDaemon(controlSocketPath, {
      delayMs: 500,
      buildResponse: (op, payload) => {
        assert.strictEqual(op, HOOK_OP.TRIGGER_HOOK);
        const result = computeTriggerHook(payload.hookInput, { commit: false });
        return { ok: true, output: result.output, plan: result.plan };
      },
    });
    try {
      const stdout = runHook(
        'trigger-hook',
        BASH('gh pr merge 1 --delete-branch', session),
        { KB_CONTROL_SOCKET_PATH: controlSocketPath, KB_HOOK_DAEMON_TIMEOUT_MS: '150' },
      );
      // Proves the marker was NOT already burned by the discarded daemon
      // answer: if it had been, the fallback's own decideAndRecord would
      // see this id as already-fired and decline to re-emit, and stdout
      // would be empty — a warning silently lost to the deadline race.
      assert.match(stdout, /"additionalContext":"⚠ KB TRIGGER: note #504/, 'the warning must still be re-eligible after the discarded daemon answer');

      await delay(700);

      const marker = JSON.parse(readFileSync(join(TRIGGERS_LOG_DIR, `${session}.json`), 'utf8'));
      assert.deepStrictEqual(marker, [504], 'exactly one marker entry — the fallback\'s own write, not a second from the discarded daemon answer');

      // The marker alone doesn't catch a duplicate: appendMarker no-ops on an
      // id already present, so two writers racing to add the SAME id can
      // look like one. The JSONL fire-log has no such dedup — it records the
      // decision was made, not that it landed uniquely — so a second,
      // discarded write shows up here even when the marker hides it.
      const jsonlPath = join(TRIGGERS_LOG_DIR, `fires-${new Date().toISOString().slice(0, 10)}.jsonl`);
      const fireLines = readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
      assert.strictEqual(
        fireLines.filter(l => l.session === session).length, 1,
        'exactly one fire-log line for this session — the fallback\'s, not a second from the discarded daemon answer',
      );
    } finally {
      await slow.close();
    }
  });
});

// Hooks run daemon-side with a CLI fallback, so an agent tag that only
// travels on one of those paths is a tag that disappears the moment the
// daemon is up — the common case, not the edge one.
describe('the agent travels the daemon path, not just the fallback', () => {
  // execFileSync blocks THIS process's event loop, so an in-process stand-in
  // daemon could never accept the child's connection — every such run would
  // silently prove the fallback path instead. Spawned async, the stand-in can
  // actually answer, which is the only way to see what the client sent.
  function runHookAsync(name, hookInput, extraEnv, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [HELPER, name, ...args], { env: { ...process.env, ...extraEnv } });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.once('error', reject);
      child.once('close', () => resolve(stdout));
      child.stdin.end(JSON.stringify(hookInput));
    });
  }

  it('prompt-hint: the client sends its agent in the payload and tags the committed row with it', async () => {
    insertHintableDoc('Manifold purge sequence guide', 'manifold purge sequence guide for the bay crew');
    const prompt = 'manifold purge sequence guide for the bay crew';
    const { controlSocketPath } = freshSocketPaths();
    const session = 'sess-daemon-agent-codex';
    const seen = [];
    const daemon = await startSlowDaemon(controlSocketPath, {
      delayMs: 0,
      buildResponse: (op, payload) => {
        seen.push(payload);
        const result = computePromptHint({ ...payload, commit: false });
        return { ok: true, output: result.output, plan: result.plan };
      },
    });
    try {
      const stdout = await runHookAsync(
        'prompt-hint',
        { session_id: session, prompt },
        { KB_CONTROL_SOCKET_PATH: controlSocketPath, KB_HOOK_DAEMON_TIMEOUT_MS: '2000' },
        ['--agent', 'codex'],
      );

      assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /^KB HINT:/);
      assert.deepStrictEqual(seen.map(p => p.agent), ['codex'], 'the daemon must be told which client is asking');

      const rows = getDb().prepare('SELECT agent FROM retrievals WHERE session = ?').all(session);
      assert.ok(rows.length > 0, 'the delivering client commits the daemon-computed plan');
      assert.ok(rows.every(r => r.agent === 'codex'), 'a daemon-served hint is still attributed to the client that asked');
    } finally {
      await daemon.close();
    }
  });

  it('wakeup-hook: same, through the real daemon rather than a stand-in', async () => {
    insertStateNote('State: daemon-agent-briefing', 'body');
    const daemon = await startTestDaemon();
    const session = 'sess-daemon-agent-briefing';

    const stdout = runHook(
      'wakeup-hook',
      { session_id: session, hook_event_name: 'SessionStart' },
      { KB_CONTROL_SOCKET_PATH: daemon.controlSocketPath, KB_HOOK_DAEMON_TIMEOUT_MS: '3000' },
      ['--agent', 'codex'],
    );

    assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /^KB BRIEFING/);
    const rows = getDb().prepare("SELECT agent FROM retrievals WHERE surface = 'briefing' AND session = ?").all(session);
    assert.ok(rows.length > 0, 'the briefing rows are committed by the client that printed them');
    assert.ok(rows.every(r => r.agent === 'codex'));
  });
});
