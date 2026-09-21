import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  consumeDaemonRestart,
  markDaemonRestart,
  readRecentDaemonRestart,
  restartGenerationPath,
  restartMarkerPath,
  snapshotDaemonRestart,
} from '../src/daemon-restart.js';
import {
  isManagedRestartEnvironment,
  registerServeShutdown,
  startReplacementDaemon,
} from '../src/cli/serve.js';

function freshSocketPath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-restart-marker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, socketPath: join(dir, 'daemon.sock') };
}

describe('daemon restart marker lifecycle', () => {
  it('publishes a private atomic generation without temp residue', (t) => {
    const { dir, socketPath } = freshSocketPath(t);
    assert.equal(markDaemonRestart(socketPath, {
      now: 1_000,
      pid: 42,
      generation: 'generation-a',
    }), true);

    const markerPath = restartMarkerPath(socketPath);
    const generationPath = restartGenerationPath(socketPath, 'generation-a');
    assert.deepEqual(JSON.parse(readFileSync(markerPath, 'utf8')), {
      startedAt: 1_000,
      pid: 42,
      generation: 'generation-a',
    });
    assert.equal(statSync(markerPath).mode & 0o777, 0o600);
    assert.equal(statSync(generationPath).mode & 0o777, 0o600);
    assert.deepEqual(
      readdirSync(dir).filter(name => name.startsWith(`${basename(markerPath)}.`) && name.endsWith('.tmp')),
      [],
    );
  });

  it('returns false even when failed-write cleanup also fails', (t) => {
    const { socketPath } = freshSocketPath(t);
    const generationPath = restartGenerationPath(socketPath, 'collision');
    const temporaryPath = `${generationPath}.42.tmp`;
    mkdirSync(temporaryPath);
    assert.doesNotThrow(() => {
      assert.equal(markDaemonRestart(socketPath, {
        now: 1_000,
        pid: 42,
        generation: 'collision',
      }), false);
    });
  });

  it('preserves the canonical generation when the legacy mirror cannot update', (t) => {
    const { socketPath } = freshSocketPath(t);
    mkdirSync(restartMarkerPath(socketPath));

    assert.equal(markDaemonRestart(socketPath, {
      now: 1_000,
      pid: 42,
      generation: 'canonical-only',
    }), true);
    assert.equal(
      readRecentDaemonRestart(socketPath, { now: 1_100 })?.generation,
      'canonical-only',
    );
  });

  it('accepts only well-formed fresh current or legacy generations', (t) => {
    const { socketPath } = freshSocketPath(t);
    const markerPath = restartMarkerPath(socketPath);
    writeFileSync(markerPath, JSON.stringify({ startedAt: 1_000, pid: 42, generation: 'current' }));
    assert.deepEqual(readRecentDaemonRestart(socketPath, { now: 2_000, maxAgeMs: 1_000 }), {
      startedAt: 1_000,
      pid: 42,
      generation: 'current',
    });

    writeFileSync(markerPath, JSON.stringify({ startedAt: 1_000, pid: 42 }));
    assert.deepEqual(readRecentDaemonRestart(socketPath, { now: 1_500, maxAgeMs: 1_000 }), {
      startedAt: 1_000,
      pid: 42,
    });

    for (const invalid of [
      '{bad json',
      JSON.stringify({ startedAt: 1_000, pid: 0, generation: 'bad-pid' }),
      JSON.stringify({ startedAt: 1_000, pid: 42, generation: '' }),
      JSON.stringify({ startedAt: 2_001, pid: 42, generation: 'future' }),
      JSON.stringify({ startedAt: 999, pid: 42, generation: 'stale' }),
    ]) {
      writeFileSync(markerPath, invalid);
      assert.equal(readRecentDaemonRestart(socketPath, { now: 2_000, maxAgeMs: 1_000 }), null);
    }

    markDaemonRestart(socketPath, { now: 1_500, pid: 42, generation: 'canonical' });
    rmSync(markerPath);
    assert.equal(
      readRecentDaemonRestart(socketPath, { now: 2_000, maxAgeMs: 1_000 })?.generation,
      'canonical',
      'new shims use the immutable generation when the compatibility mirror is absent',
    );
  });

  it('consumes only the exact captured generation', (t) => {
    const { socketPath } = freshSocketPath(t);
    const markerPath = restartMarkerPath(socketPath);
    markDaemonRestart(socketPath, { now: 1_000, pid: 42, generation: 'a' });
    const snapshot = snapshotDaemonRestart(socketPath, { now: 1_100 });
    markDaemonRestart(socketPath, { now: 1_050, pid: 43, generation: 'b' });

    assert.equal(consumeDaemonRestart(snapshot), false);
    assert.equal(JSON.parse(readFileSync(markerPath, 'utf8')).generation, 'b');

    const latest = snapshotDaemonRestart(socketPath, { now: 1_100 });
    assert.equal(consumeDaemonRestart(latest), true);
    assert.equal(existsSync(markerPath), false);
  });

  it('preserves retryability on failed startup and cleans after success', async (t) => {
    const { socketPath } = freshSocketPath(t);
    const markerPath = restartMarkerPath(socketPath);
    const fakeDaemon = { close: async () => {} };
    markDaemonRestart(socketPath, { now: Date.now(), pid: 42, generation: 'retry' });
    await assert.rejects(
      startReplacementDaemon(socketPath, { start: async () => { throw new Error('bind failed'); } }),
      /bind failed/,
    );
    assert.equal(existsSync(markerPath), true);

    assert.equal(
      await startReplacementDaemon(socketPath, { start: async () => fakeDaemon }),
      fakeDaemon,
    );
    assert.equal(existsSync(markerPath), false);
    assert.equal(existsSync(restartGenerationPath(socketPath, 'retry')), false);
  });

  it('preserves a newer writer while startup is pending', async (t) => {
    const { socketPath } = freshSocketPath(t);
    const markerPath = restartMarkerPath(socketPath);
    let resolveStart;
    const start = new Promise(resolve => { resolveStart = resolve; });
    markDaemonRestart(socketPath, { now: Date.now(), pid: 42, generation: 'a' });
    const starting = startReplacementDaemon(socketPath, {
      start: async () => start,
      warn: () => {},
    });
    markDaemonRestart(socketPath, { now: Date.now(), pid: 43, generation: 'b' });
    resolveStart({ close: async () => {} });
    await starting;

    assert.equal(JSON.parse(readFileSync(markerPath, 'utf8')).generation, 'b');
    assert.equal(existsSync(restartGenerationPath(socketPath, 'a')), false);
    assert.equal(existsSync(restartGenerationPath(socketPath, 'b')), true);
  });

  it('cleans captured stale and malformed files only after successful startup', async (t) => {
    for (const raw of [
      '{bad json',
      JSON.stringify({ startedAt: 1, pid: 42, generation: 'stale' }),
    ]) {
      const { socketPath } = freshSocketPath(t);
      const markerPath = restartMarkerPath(socketPath);
      writeFileSync(markerPath, raw);
      await startReplacementDaemon(socketPath, { start: async () => ({ close: async () => {} }) });
      assert.equal(existsSync(markerPath), false);
    }
  });

  it('marks before close, drains after marker failure, and ignores repeated signals', async () => {
    const signalSource = new EventEmitter();
    const calls = [];
    let resolveClose;
    const closed = new Promise(resolve => { resolveClose = resolve; });
    const exitCodes = [];
    registerServeShutdown(
      {
        close: async () => {
          calls.push('close');
          await closed;
        },
      },
      '/tmp/daemon.sock',
      {
        signalSource,
        managedRestart: true,
        markRestart: () => {
          calls.push('mark');
          throw new Error('disk full');
        },
        log: message => calls.push(message),
        setExitCode: code => exitCodes.push(code),
      },
    );

    signalSource.emit('SIGTERM');
    signalSource.emit('SIGINT');
    assert.deepEqual(calls.slice(0, 3), [
      '[kb serve] SIGTERM — draining',
      'mark',
      '[kb serve] could not mark the planned restart; new sessions will use the ordinary fallback deadline',
    ]);
    assert.equal(calls.filter(call => call === 'close').length, 1);

    resolveClose();
    await closed;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(exitCodes, [0]);
  });

  it('refreshes a managed restart through drain and after socket closure', async () => {
    const signalSource = new EventEmitter();
    let resolveClose;
    const closed = new Promise(resolve => { resolveClose = resolve; });
    let refresh;
    let cleared = false;
    let marks = 0;
    const exitCodes = [];
    registerServeShutdown(
      { close: async () => closed },
      '/tmp/daemon.sock',
      {
        signalSource,
        managedRestart: true,
        markRestart: () => { marks++; return true; },
        log: () => {},
        setExitCode: code => exitCodes.push(code),
        setIntervalFn: callback => {
          refresh = callback;
          return {};
        },
        clearIntervalFn: () => { cleared = true; },
      },
    );

    signalSource.emit('SIGTERM');
    assert.equal(marks, 1, 'marks before draining');
    refresh();
    assert.equal(marks, 2, 'refreshes while a long drain is pending');
    resolveClose();
    await closed;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(marks, 3, 'refreshes after both sockets close');
    assert.equal(cleared, true);
    assert.deepEqual(exitCodes, [0]);
  });

  it('does not classify a foreground stop as a planned restart', async () => {
    const signalSource = new EventEmitter();
    let marks = 0;
    const exited = new Promise(resolve => {
      registerServeShutdown(
        { close: async () => {} },
        '/tmp/daemon.sock',
        {
          signalSource,
          managedRestart: false,
          markRestart: () => { marks++; return true; },
          log: () => {},
          setExitCode: resolve,
        },
      );
    });

    signalSource.emit('SIGINT');
    assert.equal(await exited, 0);
    assert.equal(marks, 0);
  });

  it('detects managed restart environments without treating XPC zero as a service', () => {
    assert.equal(isManagedRestartEnvironment({ XPC_SERVICE_NAME: '0' }), false);
    assert.equal(isManagedRestartEnvironment({ XPC_SERVICE_NAME: 'com.example.service' }), true);
    assert.equal(isManagedRestartEnvironment({ INVOCATION_ID: 'systemd-run' }), true);
    assert.equal(isManagedRestartEnvironment({
      XPC_SERVICE_NAME: 'com.example.service',
      KB_SERVE_RESTART_ON_SIGNAL: 'false',
    }), false);
    assert.equal(isManagedRestartEnvironment({ KB_SERVE_RESTART_ON_SIGNAL: 'yes' }), true);
  });
});
