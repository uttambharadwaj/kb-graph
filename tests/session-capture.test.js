import './helpers/tmp-kb.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync,
  realpathSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { startDaemon } from '../src/daemon.js';
import { LOGS_DIR } from '../src/paths.js';
import {
  CURSOR_CAPTURE_DISABLED_MARKER, CURSOR_CAPTURE_ENABLED_MARKER,
  SESSION_CAPTURE_DECLINE_REASON, SESSION_CAPTURE_LOG,
  SESSION_CAPTURE_QUEUE_DIR, SESSION_CAPTURE_RECEIPT_DIR, captureRequest,
  enqueueSessionCapture, ensureSessionCaptureDirectories,
  processSessionCaptureQueue, resolveCaptureTranscript, sessionCaptureQueueStatus,
  writeJsonExclusive,
} from '../src/session-capture.js';
import {
  MAX_SESSION_CAPTURE_STDIN_BYTES,
  readSessionCaptureInput,
} from '../src/cli/session-capture-hook.js';

const CURSOR_CONVERSATION_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_CURSOR_CONVERSATION_ID = '99999999-8888-4777-8666-555555555555';
const scratch = [];
beforeEach(() => {
  writeFileSync(CURSOR_CAPTURE_ENABLED_MARKER, '');
  rmSync(CURSOR_CAPTURE_DISABLED_MARKER, { force: true });
});
afterEach(() => {
  rmSync(SESSION_CAPTURE_QUEUE_DIR, { recursive: true, force: true });
  rmSync(SESSION_CAPTURE_RECEIPT_DIR, { recursive: true, force: true });
  rmSync(CURSOR_CAPTURE_ENABLED_MARKER, { force: true });
  rmSync(CURSOR_CAPTURE_DISABLED_MARKER, { force: true });
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function transcript(name = 'session.jsonl') {
  const dir = mkdtempSync(join(tmpdir(), 'kb-capture-'));
  scratch.push(dir);
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify({ type: 'user', message: { content: 'remember the durable result' } })}\n`);
  return path;
}

const files = dir => {
  try { return readdirSync(dir); } catch { return []; }
};

function fixture(name) {
  return JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'));
}

function fileMode(path) {
  return statSync(path).mode & 0o777;
}

function runCaptureHook({ socketPath, input, umask, agent = 'codex', env = {} }) {
  return new Promise((resolve, reject) => {
    const commandArgs = [
      join(import.meta.dirname, '..', 'bin', 'kb.js'),
      'session-capture-hook', '--agent', agent, '--reason=session_end',
    ];
    let executable = process.execPath;
    let args = commandArgs;
    if (umask !== undefined) {
      executable = '/bin/sh';
      args = [
        '-c', `umask ${umask.toString(8)}; exec "$@"`, 'kb-capture-hook',
        process.execPath, ...commandArgs,
      ];
    }
    const child = spawn(executable, args, {
      env: {
        ...process.env,
        KB_SKIP_NODE_REEXEC: '1',
        KB_CONTROL_SOCKET_PATH: socketPath,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

function cursorTranscript(root, conversationId, project = 'workspace') {
  const transcriptDir = join(root, project, 'agent-transcripts', conversationId);
  mkdirSync(transcriptDir, { recursive: true });
  const path = join(transcriptDir, `${conversationId}.jsonl`);
  writeFileSync(path, JSON.stringify({
    role: 'user',
    message: { content: [{ type: 'text', text: 'scrubbed Cursor transcript fixture' }] },
  }));
  return path;
}

function cursorPayload(conversationId, transcriptPath, hookEventName = 'stop') {
  return {
    conversation_id: conversationId,
    cursor_version: '3.21.16',
    hook_event_name: hookEventName,
    transcript_path: transcriptPath,
  };
}

describe('session capture queue', () => {
  it('declines malformed and oversized hook stdin before queue parsing', async () => {
    assert.deepEqual(
      await readSessionCaptureInput(Readable.from(['{broken'])),
      { ok: false, reason: SESSION_CAPTURE_DECLINE_REASON.MALFORMED_JSON },
    );
    assert.deepEqual(
      await readSessionCaptureInput(Readable.from(['x'.repeat(MAX_SESSION_CAPTURE_STDIN_BYTES + 1)])),
      { ok: false, reason: SESSION_CAPTURE_DECLINE_REASON.INPUT_TOO_LARGE },
    );
    let chunksRead = 0;
    async function* oversizedInput() {
      chunksRead++;
      yield Buffer.alloc(MAX_SESSION_CAPTURE_STDIN_BYTES + 1);
      chunksRead++;
      yield Buffer.from('{}');
    }
    await readSessionCaptureInput(oversizedInput());
    assert.equal(chunksRead, 1, 'oversized stdin must stop before consuming later chunks');

    const encoded = Buffer.from(JSON.stringify({ cwd: '/workspace/café' }));
    const split = encoded.indexOf(Buffer.from('é')) + 1;
    const parsed = await readSessionCaptureInput(Readable.from([
      encoded.subarray(0, split),
      encoded.subarray(split),
    ]));
    assert.deepEqual(parsed, { ok: true, hookInput: { cwd: '/workspace/café' } });
    assert.deepEqual(files(SESSION_CAPTURE_QUEUE_DIR), []);
  });

  it('reports capture directory setup failures without preventing daemon startup', async () => {
    for (const operation of ['mkdir', 'chmod']) {
      const repairError = Object.assign(new Error(`${operation} permission denied`), { code: 'EPERM' });
      const daemonErrors = [];
      const socketDir = mkdtempSync(join(tmpdir(), 'kb-capture-daemon-'));
      scratch.push(socketDir);
      const daemon = await startDaemon({
        socketPath: join(socketDir, 'daemon.sock'),
        controlSocketPath: join(socketDir, 'control.sock'),
        onError: err => daemonErrors.push(err),
        capturePollMs: 60_000,
        ensureCaptureDirectories: ({ onRepairError }) => ensureSessionCaptureDirectories({
          [operation]: () => { throw repairError; },
          onRepairError,
        }),
      });
      await daemon.close();
      assert.deepEqual(daemonErrors, [repairError, repairError]);
    }
  });

  it('repairs existing owner capture directories that are not writable', () => {
    mkdirSync(SESSION_CAPTURE_QUEUE_DIR, { recursive: true, mode: 0o700 });
    mkdirSync(SESSION_CAPTURE_RECEIPT_DIR, { recursive: true, mode: 0o700 });
    chmodSync(SESSION_CAPTURE_QUEUE_DIR, 0o500);
    chmodSync(SESSION_CAPTURE_RECEIPT_DIR, 0o500);

    const result = enqueueSessionCapture({
      hookInput: { session_id: 'read-only-queue' },
      agent: 'claude',
      reason: 'session_end',
    }, { now: 1000 });

    assert.equal(result.queued, true);
    assert.equal(statSync(SESSION_CAPTURE_QUEUE_DIR).mode & 0o777, 0o700);
    assert.equal(statSync(SESSION_CAPTURE_RECEIPT_DIR).mode & 0o777, 0o700);
  });

  it('upserts one item and records a receipt only after successful harvest', async () => {
    const path = transcript();
    const payload = { hookInput: { session_id: 's-1', transcript_path: path }, agent: 'codex', reason: 'session_end' };
    assert.equal(enqueueSessionCapture(payload, { now: 1000 }).queued, true);
    assert.equal(enqueueSessionCapture(payload, { now: 1001 }).queued, true);
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).length, 1, 'daemon timeout fallback must not duplicate the job');

    let calls = 0;
    const result = await processSessionCaptureQueue({
      now: 1001,
      runHarvestFn: async options => {
        calls++;
        assert.equal(options.onlyPath, path);
        assert.equal(options.sessionId, 's-1');
        assert.equal(options.agent, 'codex');
        assert.equal(options.facts, false);
        assert.equal(options.maintenance, false);
        return { sessions: 0, notes: 0, tooShort: 1, errors: 0, coverageComplete: true };
      },
    });
    assert.deepEqual(result, { processed: 1, failed: 0, skipped: 0 });
    assert.equal(calls, 1);
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).length, 0);
    assert.equal(files(SESSION_CAPTURE_RECEIPT_DIR).length, 1);
    assert.equal(enqueueSessionCapture(payload, { now: 1002 }).reason, 'already_processed');
  });

  it('keeps one queue item when a later hook enriches the same session with a transcript path', () => {
    const path = transcript('enriched.jsonl');
    assert.equal(enqueueSessionCapture({
      hookInput: { session_id: 'same-session' },
      agent: 'codex',
      reason: 'activity',
    }, { now: 1000 }).queued, true);
    assert.equal(enqueueSessionCapture({
      hookInput: { session_id: 'same-session', transcript_path: path },
      agent: 'codex',
      reason: 'session_end',
    }, { now: 1001 }).queued, true);

    const queued = files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json'));
    assert.equal(queued.length, 1);
    const request = JSON.parse(readFileSync(join(SESSION_CAPTURE_QUEUE_DIR, queued[0]), 'utf8'));
    assert.equal(request.sessionId, 'same-session');
    assert.equal(request.transcriptPath, path);
    assert.equal(request.reason, 'session_end');
    assert.equal(request.dueAt, 1001);
  });

  it('keeps Cursor provider capture default-off and lets the disabled marker win', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-cursor-gate-'));
    scratch.push(root);
    const path = cursorTranscript(root, CURSOR_CONVERSATION_ID);
    const payload = {
      hookInput: cursorPayload(CURSOR_CONVERSATION_ID, path),
      agent: 'cursor',
      reason: 'activity',
    };

    rmSync(CURSOR_CAPTURE_ENABLED_MARKER);
    assert.equal(
      enqueueSessionCapture(payload, { now: 900, cursorTranscriptRoot: root }).reason,
      SESSION_CAPTURE_DECLINE_REASON.CURSOR_CAPTURE_NOT_ENABLED,
    );
    assert.deepEqual(files(SESSION_CAPTURE_QUEUE_DIR), []);

    writeFileSync(CURSOR_CAPTURE_ENABLED_MARKER, '');
    writeFileSync(CURSOR_CAPTURE_DISABLED_MARKER, '');
    assert.equal(
      enqueueSessionCapture(payload, { now: 901, cursorTranscriptRoot: root }).reason,
      SESSION_CAPTURE_DECLINE_REASON.CURSOR_CAPTURE_DISABLED,
    );
    assert.deepEqual(files(SESSION_CAPTURE_QUEUE_DIR), []);

    rmSync(CURSOR_CAPTURE_DISABLED_MARKER);
    assert.equal(
      enqueueSessionCapture(payload, { now: 902, cursorTranscriptRoot: root }).queued,
      true,
    );
    writeFileSync(CURSOR_CAPTURE_DISABLED_MARKER, '');
    const codexPath = transcript('cursor-kill-switch-neighbor.jsonl');
    assert.equal(enqueueSessionCapture({
      hookInput: { session_id: 'codex-neighbor', transcript_path: codexPath },
      agent: 'codex',
      reason: 'session_end',
    }, { now: 40 * 60 * 1000 }).queued, true);
    let harvests = 0;
    assert.deepEqual(await processSessionCaptureQueue({
      now: 41 * 60 * 1000,
      cursorTranscriptRoot: root,
      runHarvestFn: async options => {
        harvests++;
        assert.equal(options.agent, 'codex');
        return { sessions: 1, notes: 1, tooShort: 0, errors: 0, coverageComplete: true };
      },
    }), { processed: 1, failed: 0, skipped: 0 });
    assert.equal(harvests, 1, 'the kill switch must not starve other agents behind Cursor work');
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json')).length, 1);

    rmSync(CURSOR_CAPTURE_DISABLED_MARKER);
    rmSync(CURSOR_CAPTURE_ENABLED_MARKER);
    assert.deepEqual(await processSessionCaptureQueue({
      now: 42 * 60 * 1000,
      cursorTranscriptRoot: root,
      runHarvestFn: async () => {
        throw new Error('an opted-out Cursor queue item must not reach the provider');
      },
    }), { processed: 0, failed: 0, skipped: 0 });
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json')).length, 1);
  });

  it('uses observed Cursor lifecycle identities to resolve a primary transcript', () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-cursor-capture-'));
    scratch.push(root);
    const path = cursorTranscript(root, CURSOR_CONVERSATION_ID);

    for (const name of ['cursor-stop.json', 'cursor-precompact.json']) {
      const hookInput = fixture(name);
      hookInput.transcript_path = path;
      const request = captureRequest(hookInput, {
        agent: 'cursor',
        reason: 'session_end',
        now: 1000,
        cursorTranscriptRoot: root,
      });
      assert.equal(request.sessionId, CURSOR_CONVERSATION_ID);
      assert.equal(request.transcriptPath, realpathSync(path));
    }
  });

  it('reproduces a dual-location Cursor ID collision and accepts only the primary path', () => {
    const root = join(import.meta.dirname, 'fixtures', 'cursor-collision');
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const primaryPath = join(
      root,
      'project-primary',
      'agent-transcripts',
      conversationId,
      `${conversationId}.jsonl`,
    );
    const subagentPath = join(
      root,
      'project-subagent',
      'agent-transcripts',
      'parent-conversation',
      'subagents',
      `${conversationId}.jsonl`,
    );

    const accepted = enqueueSessionCapture({
      hookInput: cursorPayload(conversationId, primaryPath),
      agent: 'cursor',
      reason: 'session_end',
    }, { now: 1500, cursorTranscriptRoot: root });
    assert.equal(accepted.queued, true);

    const result = enqueueSessionCapture({
      hookInput: cursorPayload(conversationId, subagentPath),
      agent: 'cursor',
      reason: 'session_end',
    }, { now: 1501, cursorTranscriptRoot: root });

    assert.equal(result.queued, false);
    assert.equal(result.reason, SESSION_CAPTURE_DECLINE_REASON.INVALID_PATH);
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json')).length, 1);
  });

  it('requires Cursor to provide its primary path and never root-walks by ID', () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-cursor-no-root-walk-'));
    scratch.push(root);
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    cursorTranscript(root, conversationId);

    const result = enqueueSessionCapture({
      hookInput: cursorPayload(conversationId, null),
      agent: 'cursor',
      reason: 'session_end',
    }, { now: 1600, cursorTranscriptRoot: root });

    assert.equal(result.queued, false);
    assert.equal(result.reason, SESSION_CAPTURE_DECLINE_REASON.MISSING_PATH);
    assert.equal(resolveCaptureTranscript(
      { agent: 'cursor', sessionId: conversationId },
      [root],
    ), null);
    assert.deepStrictEqual(files(SESSION_CAPTURE_QUEUE_DIR), []);
  });

  it('declines observed null-path and missing-ID Cursor lifecycle payloads', () => {
    for (const name of ['cursor-session-end-broken.json', 'cursor-subagent-null-path.json']) {
      const result = enqueueSessionCapture({
        hookInput: fixture(name),
        agent: 'cursor',
        reason: 'session_end',
      });
      assert.equal(result.queued, false);
      assert.equal(result.reason, SESSION_CAPTURE_DECLINE_REASON.MISSING_PATH);
    }
    const missingId = fixture('cursor-stop.json');
    delete missingId.conversation_id;
    assert.equal(enqueueSessionCapture({
      hookInput: missingId,
      agent: 'cursor',
      reason: 'activity',
    }).reason, SESSION_CAPTURE_DECLINE_REASON.MISSING_ID);
  });

  it('rejects Cursor symlinks, traversal outside the root, wrong extensions, and ID mismatch', () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-cursor-boundary-'));
    const outside = mkdtempSync(join(tmpdir(), 'kb-cursor-outside-'));
    scratch.push(root, outside);
    const conversationId = CURSOR_CONVERSATION_ID;
    const valid = cursorTranscript(root, conversationId);
    const symlink = join(root, 'linked.jsonl');
    symlinkSync(valid, symlink);
    const outsidePath = cursorTranscript(outside, conversationId);
    const traversalPath = `${root}/../${basename(outside)}/${outsidePath.slice(outside.length + 1)}`;
    const wrongExtension = valid.replace(/\.jsonl$/, '.txt');
    writeFileSync(wrongExtension, 'not jsonl');
    const otherId = OTHER_CURSOR_CONVERSATION_ID;
    const otherPath = cursorTranscript(root, otherId, 'other-window');
    const nestedPath = cursorTranscript(root, conversationId, 'project/nested');

    for (const [path, id, reason] of [
      [symlink, conversationId, SESSION_CAPTURE_DECLINE_REASON.INVALID_PATH],
      [traversalPath, conversationId, SESSION_CAPTURE_DECLINE_REASON.INVALID_PATH],
      [wrongExtension, conversationId, SESSION_CAPTURE_DECLINE_REASON.INVALID_PATH],
      [nestedPath, conversationId, SESSION_CAPTURE_DECLINE_REASON.INVALID_PATH],
      [otherPath, conversationId, SESSION_CAPTURE_DECLINE_REASON.IDENTITY_MISMATCH],
      [valid, conversationId.slice(0, 13), SESSION_CAPTURE_DECLINE_REASON.IDENTITY_MISMATCH],
    ]) {
      const result = enqueueSessionCapture({
        hookInput: cursorPayload(id, path),
        agent: 'cursor',
        reason: 'activity',
      }, { cursorTranscriptRoot: root });
      assert.equal(result.queued, false);
      assert.equal(result.reason, reason);
    }
    assert.deepStrictEqual(files(SESSION_CAPTURE_QUEUE_DIR), []);
  });

  it('independently enforces root containment and the jsonl extension', () => {
    const base = mkdtempSync(join(tmpdir(), 'kb-cursor-independent-guards-'));
    scratch.push(base);
    const root = join(base, 'projects');
    mkdirSync(root);
    const outsideDir = join(base, 'agent-transcripts', CURSOR_CONVERSATION_ID);
    mkdirSync(outsideDir, { recursive: true });
    const outside = join(outsideDir, `${CURSOR_CONVERSATION_ID}.jsonl`);
    writeFileSync(outside, '{}');

    const extensionlessDir = join(
      root,
      'workspace',
      'agent-transcripts',
      CURSOR_CONVERSATION_ID,
    );
    mkdirSync(extensionlessDir, { recursive: true });
    const extensionless = join(extensionlessDir, CURSOR_CONVERSATION_ID);
    writeFileSync(extensionless, '{}');

    for (const path of [outside, extensionless]) {
      const result = enqueueSessionCapture({
        hookInput: cursorPayload(CURSOR_CONVERSATION_ID, path),
        agent: 'cursor',
        reason: 'activity',
      }, { cursorTranscriptRoot: root });
      assert.equal(result.queued, false);
      assert.equal(result.reason, SESSION_CAPTURE_DECLINE_REASON.INVALID_PATH);
    }
  });

  it('revalidates the Cursor path after enqueue and discards a TOCTOU symlink swap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-cursor-toctou-'));
    const outside = mkdtempSync(join(tmpdir(), 'kb-cursor-toctou-outside-'));
    scratch.push(root, outside);
    const conversationId = CURSOR_CONVERSATION_ID;
    const path = cursorTranscript(root, conversationId);
    const outsidePath = cursorTranscript(outside, conversationId);
    const payload = {
      hookInput: cursorPayload(conversationId, path),
      agent: 'cursor',
      reason: 'session_end',
    };
    assert.equal(enqueueSessionCapture(
      payload,
      { now: 1700, cursorTranscriptRoot: root },
    ).queued, true);
    rmSync(path);
    symlinkSync(outsidePath, path);

    let harvests = 0;
    const result = await processSessionCaptureQueue({
      now: 1700,
      cursorTranscriptRoot: root,
      runHarvestFn: async () => {
        harvests++;
        return { sessions: 1, notes: 1, tooShort: 0, errors: 0, coverageComplete: true };
      },
    });
    assert.deepEqual(result, { processed: 0, failed: 0, skipped: 1 });
    assert.equal(harvests, 0);
    assert.deepStrictEqual(files(SESSION_CAPTURE_QUEUE_DIR), []);
    assert.deepStrictEqual(files(SESSION_CAPTURE_RECEIPT_DIR), []);
  });

  it('retries a Cursor capture when its validated path is temporarily unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-cursor-transient-'));
    scratch.push(root);
    const path = cursorTranscript(root, CURSOR_CONVERSATION_ID);
    const payload = {
      hookInput: cursorPayload(CURSOR_CONVERSATION_ID, path),
      agent: 'cursor',
      reason: 'session_end',
    };
    assert.equal(enqueueSessionCapture(
      payload,
      { now: 1750, cursorTranscriptRoot: root },
    ).queued, true);
    rmSync(path);

    const result = await processSessionCaptureQueue({
      now: 1750,
      cursorTranscriptRoot: root,
      runHarvestFn: async () => {
        throw new Error('an unavailable path must not reach harvest');
      },
    });
    assert.deepEqual(result, { processed: 0, failed: 1, skipped: 0 });
    const [queued] = files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json'));
    const retry = JSON.parse(readFileSync(join(SESSION_CAPTURE_QUEUE_DIR, queued), 'utf8'));
    assert.equal(retry.attempts, 1);
    assert.equal(retry.lastError, SESSION_CAPTURE_DECLINE_REASON.UNAVAILABLE);
  });

  it('keeps separate Cursor windows separate while duplicate events coalesce', () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-cursor-windows-'));
    scratch.push(root);
    const firstId = CURSOR_CONVERSATION_ID;
    const secondId = OTHER_CURSOR_CONVERSATION_ID;
    const first = cursorTranscript(root, firstId, 'window-one');
    const second = cursorTranscript(root, secondId, 'window-two');

    const firstStop = enqueueSessionCapture({
      hookInput: cursorPayload(firstId, first),
      agent: 'cursor',
      reason: 'activity',
    }, { now: 1800, cursorTranscriptRoot: root });
    const firstPreCompact = enqueueSessionCapture({
      hookInput: cursorPayload(firstId, first, 'preCompact'),
      agent: 'cursor',
      reason: 'precompact',
    }, { now: 1800, cursorTranscriptRoot: root });
    const secondStop = enqueueSessionCapture({
      hookInput: cursorPayload(secondId, second),
      agent: 'cursor',
      reason: 'activity',
    }, { now: 1800, cursorTranscriptRoot: root });

    assert.equal(firstStop.queued, true);
    assert.equal(firstPreCompact.key, firstStop.key);
    assert.notEqual(secondStop.key, firstStop.key);
    const expectedFirstKey = createHash('sha256').update(`cursor\0${firstId}`).digest('hex');
    assert.equal(firstStop.key, expectedFirstKey);
    const queueFiles = files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json'));
    assert.equal(queueFiles.length, 2);
    assert.ok(queueFiles.includes(`${firstStop.key}.json`));
    const firstRequest = JSON.parse(
      readFileSync(join(SESSION_CAPTURE_QUEUE_DIR, `${firstStop.key}.json`), 'utf8'),
    );
    assert.equal(firstRequest.reason, 'precompact');
    assert.equal(firstRequest.dueAt, 1800 + (5 * 60 * 1000));
  });

  it('keeps incomplete harvest coverage queued without consuming a retry attempt', async () => {
    const path = transcript('incomplete.jsonl');
    enqueueSessionCapture({ hookInput: { session_id: 's-incomplete', transcript_path: path }, agent: 'codex', reason: 'session_end' }, { now: 3000 });
    const result = await processSessionCaptureQueue({
      now: 3000,
      runHarvestFn: async () => ({ sessions: 1, notes: 1, tooShort: 0, errors: 0, coverageComplete: false }),
    });
    assert.deepEqual(result, { processed: 0, failed: 0, skipped: 0 });
    assert.equal(files(SESSION_CAPTURE_RECEIPT_DIR).length, 0);
    const [queued] = files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json'));
    const request = JSON.parse(readFileSync(join(SESSION_CAPTURE_QUEUE_DIR, queued), 'utf8'));
    assert.equal(request.attempts, 0);
    assert.equal(request.dueAt, 3000 + 5 * 60 * 1000);
    assert.equal(request.lastError, 'harvest coverage incomplete');
  });

  it('does not accept a harvest result that omits its coverage status', async () => {
    const path = transcript('missing-coverage.jsonl');
    enqueueSessionCapture({
      hookInput: { session_id: 'missing-coverage', transcript_path: path },
      agent: 'codex',
      reason: 'session_end',
    }, { now: 3100 });

    const result = await processSessionCaptureQueue({
      now: 3100,
      runHarvestFn: async () => ({ sessions: 1, notes: 1, tooShort: 0, errors: 0 }),
    });

    assert.deepStrictEqual(result, { processed: 0, failed: 0, skipped: 0 });
    assert.deepStrictEqual(files(SESSION_CAPTURE_RECEIPT_DIR), []);
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json')).length, 1);
  });

  it('backs off incomplete harvest coverage when extraction also failed', async () => {
    const path = transcript('errored-incomplete.jsonl');
    enqueueSessionCapture({ hookInput: { session_id: 's-error-incomplete', transcript_path: path }, agent: 'codex', reason: 'session_end' }, { now: 3500 });
    const result = await processSessionCaptureQueue({
      now: 3500,
      runHarvestFn: async () => ({ sessions: 1, notes: 0, tooShort: 0, errors: 1, coverageComplete: false }),
    });
    assert.deepEqual(result, { processed: 0, failed: 1, skipped: 0 });
    assert.equal(files(SESSION_CAPTURE_RECEIPT_DIR).length, 0);
    const [queued] = files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json'));
    const request = JSON.parse(readFileSync(join(SESSION_CAPTURE_QUEUE_DIR, queued), 'utf8'));
    assert.equal(request.attempts, 1);
    assert.equal(request.dueAt, 3500 + 5 * 60 * 1000);
    assert.equal(request.lastError, 'harvest reported 1 extraction error(s)');
  });

  it('keeps a failed extraction queued for retry', async () => {
    const path = transcript('retry.jsonl');
    enqueueSessionCapture({ hookInput: { session_id: 's-2', transcript_path: path }, agent: 'claude', reason: 'session_end' }, { now: 2000 });
    const result = await processSessionCaptureQueue({
      now: 2000,
      runHarvestFn: async () => ({ sessions: 1, notes: 0, tooShort: 0, errors: 1 }),
    });
    assert.deepEqual(result, { processed: 0, failed: 1, skipped: 0 });
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json')).length, 1);
    assert.equal(files(SESSION_CAPTURE_RECEIPT_DIR).length, 0);
    assert.equal(sessionCaptureQueueStatus(2001).failed, 1);
  });

  it('ignores malformed queue JSON before sorting or processing due work', async () => {
    const path = transcript('valid-with-corrupt-neighbor.jsonl');
    enqueueSessionCapture({ hookInput: { session_id: 'valid-with-corrupt-neighbor', transcript_path: path }, agent: 'claude', reason: 'session_end' }, { now: 2100 });
    writeFileSync(join(SESSION_CAPTURE_QUEUE_DIR, 'corrupt.json'), '{not-json');

    assert.deepEqual(sessionCaptureQueueStatus(2100), { queued: 1, due: 1, failed: 0, oldestOverdueMs: 0 });

    let calls = 0;
    const result = await processSessionCaptureQueue({
      now: 2100,
      runHarvestFn: async () => {
        calls++;
        return { sessions: 1, notes: 1, tooShort: 0, errors: 0, coverageComplete: true };
      },
    });

    assert.deepEqual(result, { processed: 1, failed: 0, skipped: 0 });
    assert.equal(calls, 1);
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name === 'corrupt.json').length, 1);
  });

  it('repairs a mode-000 queue item before processing it', async () => {
    const path = transcript('private-queue.jsonl');
    enqueueSessionCapture({ hookInput: { session_id: 'private-queue', transcript_path: path }, agent: 'claude', reason: 'session_end' }, { now: 2200 });
    const [queued] = files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json'));
    const queuePath = join(SESSION_CAPTURE_QUEUE_DIR, queued);
    chmodSync(queuePath, 0o000);

    const result = await processSessionCaptureQueue({
      now: 2200,
      runHarvestFn: async () => ({ sessions: 1, notes: 1, tooShort: 0, errors: 0, coverageComplete: true }),
    });

    assert.deepEqual(result, { processed: 1, failed: 0, skipped: 0 });
    assert.equal(files(SESSION_CAPTURE_RECEIPT_DIR).length, 1);
  });

  it('recovers an expired working lease and processes it', async () => {
    const path = transcript('orphan.jsonl');
    enqueueSessionCapture({ hookInput: { session_id: 'orphan', transcript_path: path }, agent: 'claude', reason: 'session_end' }, { now: 4000 });
    const [queued] = files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json'));
    const queuePath = join(SESSION_CAPTURE_QUEUE_DIR, queued);
    const request = JSON.parse(readFileSync(queuePath, 'utf8'));
    writeFileSync(`${queuePath}.working`, `${JSON.stringify({
      ...request,
      lease: { owner: 'dead-worker', startedAt: 4000, expiresAt: 5000 },
    })}\n`);
    rmSync(queuePath);

    const result = await processSessionCaptureQueue({
      now: 5001,
      runHarvestFn: async () => ({ sessions: 1, notes: 1, tooShort: 0, errors: 0, coverageComplete: true }),
    });
    assert.deepEqual(result, { processed: 1, failed: 0, skipped: 0 });
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.working')).length, 0);
    assert.equal(files(SESSION_CAPTURE_RECEIPT_DIR).length, 1);
  });

  it('repairs and recovers an expired mode-000 working lease', async () => {
    const path = transcript('private-orphan.jsonl');
    enqueueSessionCapture({ hookInput: { session_id: 'private-orphan', transcript_path: path }, agent: 'claude', reason: 'session_end' }, { now: 4000 });
    const [queued] = files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json'));
    const queuePath = join(SESSION_CAPTURE_QUEUE_DIR, queued);
    const request = JSON.parse(readFileSync(queuePath, 'utf8'));
    const workingPath = `${queuePath}.working`;
    writeFileSync(workingPath, `${JSON.stringify({
      ...request,
      lease: { owner: 'dead-worker', startedAt: 4000, expiresAt: 5000 },
    })}\n`);
    chmodSync(workingPath, 0o000);
    rmSync(queuePath);

    const result = await processSessionCaptureQueue({
      now: 5001,
      runHarvestFn: async () => ({ sessions: 1, notes: 1, tooShort: 0, errors: 0, coverageComplete: true }),
    });

    assert.deepEqual(result, { processed: 1, failed: 0, skipped: 0 });
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.working')).length, 0);
    assert.equal(files(SESSION_CAPTURE_RECEIPT_DIR).length, 1);
  });

  it('removes a stale unreadable lease so its queued capture can drain', async () => {
    const path = transcript('corrupt-orphan.jsonl');
    enqueueSessionCapture({ hookInput: { session_id: 'corrupt-orphan', transcript_path: path }, agent: 'claude', reason: 'session_end' }, { now: 4000 });
    const [queued] = files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json'));
    const workingPath = join(SESSION_CAPTURE_QUEUE_DIR, `${queued}.working`);
    writeFileSync(workingPath, '{truncated');
    chmodSync(workingPath, 0o000);
    const old = (Date.now() - 20 * 60 * 1000) / 1000;
    utimesSync(workingPath, old, old);

    const result = await processSessionCaptureQueue({
      now: Date.now(),
      runHarvestFn: async () => ({ sessions: 1, notes: 1, tooShort: 0, errors: 0, coverageComplete: true }),
    });

    assert.deepEqual(result, { processed: 1, failed: 0, skipped: 0 });
    assert.equal(existsSync(workingPath), false);
    assert.equal(files(SESSION_CAPTURE_RECEIPT_DIR).length, 1);
  });

  it('does not remove a fresh unreadable lease', async () => {
    const path = transcript('fresh-corrupt-orphan.jsonl');
    enqueueSessionCapture({ hookInput: { session_id: 'fresh-corrupt-orphan', transcript_path: path }, agent: 'claude', reason: 'session_end' });
    const [queued] = files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json'));
    const workingPath = join(SESSION_CAPTURE_QUEUE_DIR, `${queued}.working`);
    writeFileSync(workingPath, '{truncated');
    chmodSync(workingPath, 0o000);

    let harvests = 0;
    const result = await processSessionCaptureQueue({
      runHarvestFn: async () => {
        harvests++;
        return { sessions: 1, notes: 1, tooShort: 0, errors: 0, coverageComplete: true };
      },
    });

    assert.deepEqual(result, { processed: 0, failed: 0, skipped: 0 });
    assert.equal(harvests, 0);
    assert.equal(existsSync(workingPath), true);
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json')).length, 1);
  });

  it('removes an exclusive lease when private-mode repair fails', () => {
    const workingPath = join(SESSION_CAPTURE_QUEUE_DIR, 'chmod-failure.json.working');
    const chmodError = Object.assign(new Error('chmod failed'), { code: 'EPERM' });

    assert.throws(
      () => writeJsonExclusive(workingPath, { key: 'chmod-failure' }, {
        chmod: () => { throw chmodError; },
      }),
      error => error === chmodError,
    );
    assert.equal(existsSync(workingPath), false);
  });

  it('propagates ENOSPC without leaving a partial exclusive queue artifact', () => {
    const workingPath = join(SESSION_CAPTURE_QUEUE_DIR, 'enospc.json.working');
    const diskFull = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    assert.throws(
      () => writeJsonExclusive(workingPath, { key: 'enospc' }, {
        write: () => { throw diskFull; },
      }),
      error => error === diskFull,
    );
    assert.equal(existsSync(workingPath), false);
  });

  it('does not close an exclusive lease descriptor twice when close fails', () => {
    const workingPath = join(SESSION_CAPTURE_QUEUE_DIR, 'close-failure.json.working');
    const closeError = Object.assign(new Error('close failed'), { code: 'EIO' });
    let closes = 0;

    assert.throws(
      () => writeJsonExclusive(workingPath, { key: 'close-failure' }, {
        close: () => {
          closes++;
          throw closeError;
        },
      }),
      error => error === closeError,
    );
    assert.equal(closes, 1);
    assert.equal(existsSync(workingPath), false);
  });

  it('recovers an old legacy working item that has no lease metadata', async () => {
    const path = transcript('legacy-working.jsonl');
    enqueueSessionCapture({ hookInput: { session_id: 'legacy-working', transcript_path: path }, agent: 'claude', reason: 'session_end' }, { now: 9000 });
    const [queued] = files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json'));
    const queuePath = join(SESSION_CAPTURE_QUEUE_DIR, queued);
    const request = JSON.parse(readFileSync(queuePath, 'utf8'));
    const workingPath = `${queuePath}.working`;
    writeFileSync(workingPath, `${JSON.stringify(request)}\n`);
    rmSync(queuePath);

    const old = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(workingPath, old, old);
    const result = await processSessionCaptureQueue({
      now: Date.now(),
      runHarvestFn: async () => ({ sessions: 1, notes: 1, tooShort: 0, errors: 0, coverageComplete: true }),
    });

    assert.deepEqual(result, { processed: 1, failed: 0, skipped: 0 });
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.working')).length, 0);
    assert.equal(files(SESSION_CAPTURE_RECEIPT_DIR).length, 1);
  });

  it('does not steal a fresh legacy working item that has no lease metadata', async () => {
    const path = transcript('fresh-legacy-working.jsonl');
    enqueueSessionCapture({ hookInput: { session_id: 'fresh-legacy-working', transcript_path: path }, agent: 'claude', reason: 'session_end' }, { now: 9500 });
    const [queued] = files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json'));
    const queuePath = join(SESSION_CAPTURE_QUEUE_DIR, queued);
    const request = JSON.parse(readFileSync(queuePath, 'utf8'));
    writeFileSync(`${queuePath}.working`, `${JSON.stringify(request)}\n`);
    rmSync(queuePath);

    const result = await processSessionCaptureQueue({
      now: Date.now(),
      runHarvestFn: async () => {
        throw new Error('fresh legacy working item must not be processed by another worker');
      },
    });

    assert.deepEqual(result, { processed: 0, failed: 0, skipped: 0 });
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.working')).length, 1);
    assert.equal(files(SESSION_CAPTURE_RECEIPT_DIR).length, 0);
  });

  it('does not let read-only queue status steal a live lease', () => {
    const path = transcript('status-live.jsonl');
    enqueueSessionCapture({ hookInput: { session_id: 'status-live', transcript_path: path }, agent: 'codex', reason: 'session_end' }, { now: 10000 });
    const [queued] = files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json'));
    const queuePath = join(SESSION_CAPTURE_QUEUE_DIR, queued);
    const request = JSON.parse(readFileSync(queuePath, 'utf8'));
    writeFileSync(`${queuePath}.working`, `${JSON.stringify({
      ...request,
      lease: { owner: 'live-worker', startedAt: 10000, expiresAt: 10000 + 10 * 60 * 1000 },
    })}\n`);
    rmSync(queuePath);

    const status = sessionCaptureQueueStatus(10001);

    assert.deepEqual(status, { queued: 0, due: 0, failed: 0, oldestOverdueMs: 0 });
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.working')).length, 1);
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json')).length, 0);
  });

  it('does not let read-only queue status recover an expired lease', () => {
    const path = transcript('status-expired.jsonl');
    enqueueSessionCapture({ hookInput: { session_id: 'status-expired', transcript_path: path }, agent: 'codex', reason: 'session_end' }, { now: 11000 });
    const [queued] = files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json'));
    const queuePath = join(SESSION_CAPTURE_QUEUE_DIR, queued);
    const request = JSON.parse(readFileSync(queuePath, 'utf8'));
    writeFileSync(`${queuePath}.working`, `${JSON.stringify({
      ...request,
      lease: { owner: 'dead-worker', startedAt: 11000, expiresAt: 11001 },
    })}\n`);
    rmSync(queuePath);

    const status = sessionCaptureQueueStatus(12000);

    assert.deepEqual(status, { queued: 0, due: 0, failed: 0, oldestOverdueMs: 0 });
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.working')).length, 1);
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json')).length, 0);
  });

  it('does not steal a live working lease', async () => {
    const path = transcript('live.jsonl');
    enqueueSessionCapture({ hookInput: { session_id: 'live', transcript_path: path }, agent: 'codex', reason: 'session_end' }, { now: 6000 });
    const [queued] = files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json'));
    const queuePath = join(SESSION_CAPTURE_QUEUE_DIR, queued);
    const request = JSON.parse(readFileSync(queuePath, 'utf8'));
    writeFileSync(`${queuePath}.working`, `${JSON.stringify({
      ...request,
      lease: { owner: 'live-worker', startedAt: 6000, expiresAt: 6000 + 10 * 60 * 1000 },
    })}\n`);
    rmSync(queuePath);

    const result = await processSessionCaptureQueue({
      now: 6001,
      runHarvestFn: async () => {
        throw new Error('live lease must not be processed by another worker');
      },
    });
    assert.deepEqual(result, { processed: 0, failed: 0, skipped: 0 });
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.working')).length, 1);
    assert.equal(files(SESSION_CAPTURE_RECEIPT_DIR).length, 0);
  });

  it('does not remove or replace another live lease when a queue file remains', async () => {
    const path = transcript('queued-live.jsonl');
    enqueueSessionCapture({ hookInput: { session_id: 'queued-live', transcript_path: path }, agent: 'codex', reason: 'session_end' }, { now: 7000 });
    const [queued] = files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json'));
    const queuePath = join(SESSION_CAPTURE_QUEUE_DIR, queued);
    const request = JSON.parse(readFileSync(queuePath, 'utf8'));
    const liveLease = {
      ...request,
      lease: { owner: 'live-worker', startedAt: 7000, expiresAt: 7000 + 10 * 60 * 1000 },
    };
    writeFileSync(`${queuePath}.working`, `${JSON.stringify(liveLease)}\n`);

    const result = await processSessionCaptureQueue({
      now: 7001,
      runHarvestFn: async () => {
        throw new Error('live lease must not be replaced by another worker');
      },
    });
    assert.deepEqual(result, { processed: 0, failed: 0, skipped: 0 });
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json')).length, 1);
    const working = JSON.parse(readFileSync(`${queuePath}.working`, 'utf8'));
    assert.equal(working.lease.owner, 'live-worker');
    assert.equal(working.lease.expiresAt, liveLease.lease.expiresAt);
    assert.equal(files(SESSION_CAPTURE_RECEIPT_DIR).length, 0);
  });

  it('only lets one concurrent processor harvest a queued item', async () => {
    const path = transcript('concurrent.jsonl');
    enqueueSessionCapture({ hookInput: { session_id: 'concurrent', transcript_path: path }, agent: 'codex', reason: 'session_end' }, { now: 8000 });
    let calls = 0;
    const harvest = async () => {
      calls++;
      await delay(20);
      return { sessions: 1, notes: 1, tooShort: 0, errors: 0, coverageComplete: true };
    };

    const results = await Promise.all([
      processSessionCaptureQueue({ now: 8000, runHarvestFn: harvest }),
      processSessionCaptureQueue({ now: 8000, runHarvestFn: harvest }),
    ]);
    assert.deepEqual(results, [
      { processed: 1, failed: 0, skipped: 0 },
      { processed: 0, failed: 0, skipped: 0 },
    ]);
    assert.equal(calls, 1);
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).length, 0);
    assert.equal(files(SESSION_CAPTURE_RECEIPT_DIR).length, 1);
  });

  it('resolves Codex rollout filenames when the hook provides only a session id', () => {
    const path = transcript('rollout-2026-08-28-codex-session.jsonl');
    assert.equal(resolveCaptureTranscript({ sessionId: 'codex-session' }, [join(path, '..')]), path);
  });

  it('treats a stale Cursor receipt as reprocessable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-cursor-stale-receipt-'));
    scratch.push(root);
    const conversationId = CURSOR_CONVERSATION_ID;
    const path = cursorTranscript(root, conversationId);
    const payload = {
      hookInput: cursorPayload(conversationId, path),
      agent: 'cursor',
      reason: 'session_end',
    };
    const first = enqueueSessionCapture(
      payload,
      { now: 12000, cursorTranscriptRoot: root },
    );
    rmSync(SESSION_CAPTURE_QUEUE_DIR, { recursive: true, force: true });
    ensureSessionCaptureDirectories();
    writeFileSync(
      join(SESSION_CAPTURE_RECEIPT_DIR, `${first.key}.json`),
      JSON.stringify({ processedMtime: statSync(path).mtimeMs - 1 }),
    );
    assert.equal(enqueueSessionCapture(
      payload,
      { now: 12001, cursorTranscriptRoot: root },
    ).queued, true);

    const result = await processSessionCaptureQueue({
      now: 12001,
      cursorTranscriptRoot: root,
      runHarvestFn: async () => ({
        sessions: 1,
        notes: 1,
        tooShort: 0,
        errors: 0,
        coverageComplete: true,
      }),
    });
    assert.deepEqual(result, { processed: 1, failed: 0, skipped: 0 });
  });

  it('declines malformed and oversized stdin through the real hook entrypoint', async () => {
    for (const input of ['{broken', 'x'.repeat(MAX_SESSION_CAPTURE_STDIN_BYTES + 1)]) {
      const answer = await runCaptureHook({
        socketPath: join(tmpdir(), `missing-kb-control-${process.pid}.sock`),
        input,
      });
      assert.equal(answer.code, 0, answer.stderr);
      assert.equal(answer.stdout, '');
      assert.deepEqual(files(SESSION_CAPTURE_QUEUE_DIR), []);
    }
  });

  it('queues a valid Cursor primary transcript through daemon fallback', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kb-cursor-fallback-home-'));
    scratch.push(home);
    const root = join(home, '.cursor', 'projects');
    const conversationId = CURSOR_CONVERSATION_ID;
    const path = cursorTranscript(root, conversationId);
    const answer = await runCaptureHook({
      socketPath: join(tmpdir(), `missing-kb-control-${process.pid}.sock`),
      input: cursorPayload(conversationId, path),
      agent: 'cursor',
      env: { HOME: home },
    });
    assert.equal(answer.code, 0, answer.stderr);
    assert.equal(answer.stdout, '');
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json')).length, 1);
  });

  it('fails open to the filesystem queue when the daemon is unavailable', async () => {
    const path = transcript('fallback.jsonl');
    const started = Date.now();
    const answer = await runCaptureHook({
      socketPath: join(tmpdir(), `missing-kb-control-${process.pid}.sock`),
      input: { session_id: 'fallback', transcript_path: path, hook_event_name: 'Stop' },
    });
    assert.equal(answer.code, 0, answer.stderr);
    assert.equal(answer.stdout, '');
    assert.ok(Date.now() - started < 1500, 'an unavailable daemon must not turn capture into a blocking hook');
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json')).length, 1);
  });

  it('writes queue, lease, and receipt files with mode 0600 under umask 0777', async () => {
    const path = transcript('restrictive-umask.jsonl');
    rmSync(LOGS_DIR, { recursive: true, force: true });
    const started = Date.now();
    const answer = await runCaptureHook({
      socketPath: join(tmpdir(), `missing-kb-control-${process.pid}.sock`),
      input: { session_id: 'restrictive-umask', transcript_path: path, hook_event_name: 'Stop' },
      umask: 0o777,
    });
    assert.equal(answer.code, 0, answer.stderr);
    assert.ok(Date.now() - started < 1500);
    assert.equal(fileMode(SESSION_CAPTURE_QUEUE_DIR), 0o700);
    assert.equal(fileMode(SESSION_CAPTURE_RECEIPT_DIR), 0o700);
    assert.equal(fileMode(LOGS_DIR), 0o700);
    assert.equal(fileMode(SESSION_CAPTURE_LOG), 0o600);

    const [queued] = files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json'));
    assert.ok(queued, 'the fail-open hook must leave a durable queue item');
    const queuePath = join(SESSION_CAPTURE_QUEUE_DIR, queued);
    assert.equal(fileMode(queuePath), 0o600);
    assert.equal(JSON.parse(readFileSync(queuePath, 'utf8')).sessionId, 'restrictive-umask');

    let releaseHarvest;
    let markHarvestStarted;
    const harvestStarted = new Promise(resolve => { markHarvestStarted = resolve; });
    const previousUmask = process.umask(0o777);
    try {
      const processing = processSessionCaptureQueue({
        runHarvestFn: async () => {
          markHarvestStarted();
          await new Promise(resolve => { releaseHarvest = resolve; });
          return { sessions: 1, notes: 1, tooShort: 0, errors: 0, coverageComplete: true };
        },
      });
      const startedOrFinished = await Promise.race([
        harvestStarted.then(() => 'started'),
        processing.then(result => ({ result })),
      ]);
      assert.equal(startedOrFinished, 'started',
        `processor finished before harvest started: ${JSON.stringify(startedOrFinished)}`);
      const [working] = files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.working'));
      assert.ok(working, 'the processor must claim the queue item');
      assert.equal(fileMode(join(SESSION_CAPTURE_QUEUE_DIR, working)), 0o600);
      releaseHarvest();
      assert.deepEqual(await processing, { processed: 1, failed: 0, skipped: 0 });
    } finally {
      process.umask(previousUmask);
    }

    const [receipt] = files(SESSION_CAPTURE_RECEIPT_DIR).filter(name => name.endsWith('.json'));
    assert.equal(fileMode(join(SESSION_CAPTURE_RECEIPT_DIR, receipt)), 0o600);
  });

  it('repairs an existing mode-000 capture log before appending', () => {
    mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(SESSION_CAPTURE_LOG, 'existing\n', { mode: 0o600 });
    chmodSync(SESSION_CAPTURE_LOG, 0o000);

    enqueueSessionCapture({
      hookInput: { session_id: 'private-log' },
      agent: 'claude',
      reason: 'session_end',
    }, { now: 1000 });

    assert.equal(fileMode(SESSION_CAPTURE_LOG), 0o600);
    assert.equal(readFileSync(SESSION_CAPTURE_LOG, 'utf8').trim().split('\n').length, 2);
  });

  it('completes a hook control request through the resident daemon asynchronously', async () => {
    const path = transcript('roundtrip.jsonl');
    const dir = mkdtempSync(join(tmpdir(), 'kb-capture-sock-'));
    scratch.push(dir);
    let harvestCalls = 0;
    const daemon = await startDaemon({
      socketPath: join(dir, 'mcp.sock'),
      controlSocketPath: join(dir, 'ctl.sock'),
      capturePollMs: 10,
      captureProcessor: () => processSessionCaptureQueue({
        runHarvestFn: async () => {
          harvestCalls++;
          return { sessions: 0, notes: 0, tooShort: 1, errors: 0, coverageComplete: true };
        },
      }),
    });
    try {
      const answer = await runCaptureHook({
        socketPath: daemon.controlSocketPath,
        input: { session_id: 'roundtrip', transcript_path: path, hook_event_name: 'Stop' },
      });
      assert.equal(answer.code, 0, answer.stderr);
      assert.equal(answer.stdout, '', 'capture hooks never inject session context');
      for (let i = 0; i < 100 && files(SESSION_CAPTURE_RECEIPT_DIR).length === 0; i++) await delay(10);
      assert.equal(harvestCalls, 1);
      assert.equal(files(SESSION_CAPTURE_RECEIPT_DIR).length, 1);
    } finally {
      await daemon.close();
    }
  });
});