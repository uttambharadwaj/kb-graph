import './helpers/tmp-kb.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startDaemon } from '../src/daemon.js';
import {
  SESSION_CAPTURE_QUEUE_DIR, SESSION_CAPTURE_RECEIPT_DIR, enqueueSessionCapture,
  processSessionCaptureQueue, resolveCaptureTranscript, sessionCaptureQueueStatus,
} from '../src/session-capture.js';

const scratch = [];
afterEach(() => {
  rmSync(SESSION_CAPTURE_QUEUE_DIR, { recursive: true, force: true });
  rmSync(SESSION_CAPTURE_RECEIPT_DIR, { recursive: true, force: true });
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

function runCaptureHook({ socketPath, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      join(import.meta.dirname, '..', 'bin', 'kb.js'),
      'session-capture-hook', '--agent', 'codex', '--reason=session_end',
    ], {
      env: { ...process.env, KB_SKIP_NODE_REEXEC: '1', KB_CONTROL_SOCKET_PATH: socketPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

describe('session capture queue', () => {
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
        assert.equal(options.facts, false);
        assert.equal(options.maintenance, false);
        return { sessions: 0, notes: 0, tooShort: 1, errors: 0 };
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
        return { sessions: 1, notes: 1, tooShort: 0, errors: 0 };
      },
    });

    assert.deepEqual(result, { processed: 1, failed: 0, skipped: 0 });
    assert.equal(calls, 1);
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name === 'corrupt.json').length, 1);
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
      runHarvestFn: async () => ({ sessions: 1, notes: 1, tooShort: 0, errors: 0 }),
    });
    assert.deepEqual(result, { processed: 1, failed: 0, skipped: 0 });
    assert.equal(files(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.working')).length, 0);
    assert.equal(files(SESSION_CAPTURE_RECEIPT_DIR).length, 1);
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
      runHarvestFn: async () => ({ sessions: 1, notes: 1, tooShort: 0, errors: 0 }),
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
      return { sessions: 1, notes: 1, tooShort: 0, errors: 0 };
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
          return { sessions: 0, notes: 0, tooShort: 1, errors: 0 };
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