import './helpers/tmp-kb.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { connectDaemonClient } from '../src/daemon-client.js';
import { probeSocket, startDaemon } from '../src/daemon.js';

// A listening server holds the event loop open, so a daemon a test failed to
// close does not fail that test — it hangs the whole file, long after the TAP
// output says every case passed. Nothing here may rely on a test's happy path
// to release a handle.
const scratchDirs = [];
const liveDaemons = new Set();
const CASE_TIMEOUT_MS = 60_000;

after(async () => {
  for (const daemon of liveDaemons) await daemon.close().catch(() => {});
  liveDaemons.clear();
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

async function startTestDaemon(options) {
  const daemon = await startDaemon(options);
  liveDaemons.add(daemon);
  return daemon;
}

async function closeDaemon(daemon) {
  liveDaemons.delete(daemon);
  await daemon.close();
}

/**
 * Asserts a start is refused. The finally matters: when startDaemon wrongly
 * SUCCEEDS, assert.rejects throws, and without this the daemon it just bound
 * is never closed — which is exactly how a one-line assertion failure turns
 * into a test run that never terminates.
 */
async function assertStartRefused(options, match) {
  let daemon = null;
  try {
    await assert.rejects(async () => { daemon = await startDaemon(options); }, match);
  } finally {
    if (daemon) await daemon.close().catch(() => {});
  }
}

// Its own short dir per test: sockaddr_un caps the path, and two tests sharing
// one path would make the stale-socket cases race each other.
function freshSocketPath() {
  const dir = mkdtempSync(join(tmpdir(), 'kb-sock-'));
  scratchDirs.push(dir);
  return join(dir, 'd.sock');
}

// node:test has no default per-test timeout, so an unbounded wait on a
// notification that never arrives hangs CI instead of failing it.
function withDeadline(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms); }),
  ]);
}

/**
 * Leaves a socket file on disk with nothing behind it, the way a SIGKILLed
 * daemon does. Bounded end to end and killed in a finally: a child that never
 * reaches its readiness line must fail this in seconds, not wait forever on a
 * stdout chunk that is not coming.
 */
async function abandonSocket(socketPath) {
  const script = `require('net').createServer().listen(${JSON.stringify(socketPath)}, () => console.log('ready'))`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await withDeadline(
      new Promise((resolve, reject) => {
        child.once('error', reject);
        exited.then(code => reject(new Error(`helper exited before binding, code ${code}`)));
        child.stdout.once('data', resolve);
      }),
      10_000,
      'the socket-holding helper to bind',
    );
    child.kill('SIGKILL');
    await withDeadline(exited, 10_000, 'the helper to die');
  } finally {
    child.kill('SIGKILL');
  }
}

describe('resident daemon', () => {
  it('serves initialize, tools/list and tools/call over a socket', { timeout: CASE_TIMEOUT_MS }, async () => {
    const daemon = await startTestDaemon({ socketPath: freshSocketPath() });
    const client = await connectDaemonClient(daemon.socketPath);
    try {
      assert.deepStrictEqual(client.getServerVersion(), { name: 'knowledge-base', version: '1.0.0' });

      const { tools } = await client.listTools();
      assert.ok(tools.some(tool => tool.name === 'kb_search'), 'kb_search must be registered');

      const result = await client.callTool({ name: 'kb_search', arguments: { query: 'daemon smoke test' } });
      assert.ok(!result.isError, `kb_search failed: ${JSON.stringify(result.content)}`);
      assert.strictEqual(result.content[0].type, 'text');
    } finally {
      await client.close();
      await closeDaemon(daemon);
    }
  });

  it('pins one instance per connection and does not cross concurrent calls', { timeout: CASE_TIMEOUT_MS }, async () => {
    let built = 0;
    let releaseHold;
    const hold = new Promise((resolve) => { releaseHold = resolve; });

    const serverFactory = () => {
      const instance = ++built;
      const server = new McpServer({ name: 'probe', version: '1.0.0' });
      server.registerTool(
        'whoami',
        { description: 'Reports which instance served the call', inputSchema: { wait: z.boolean().optional() } },
        async ({ wait }) => {
          if (wait) await hold;
          return { content: [{ type: 'text', text: `instance-${instance}` }] };
        },
      );
      return server;
    };

    const daemon = await startTestDaemon({ socketPath: freshSocketPath(), serverFactory });
    const first = await connectDaemonClient(daemon.socketPath);
    const second = await connectDaemonClient(daemon.socketPath);
    try {
      assert.strictEqual(built, 2, 'each connection builds its own instance');
      assert.strictEqual(daemon.connectionCount(), 2);

      // First call parks inside the handler, so the second client's call is
      // in flight at the same time on the same daemon.
      const parked = first.callTool({ name: 'whoami', arguments: { wait: true } });
      await delay(50);
      const secondAnswer = await second.callTool({ name: 'whoami', arguments: {} });
      releaseHold();
      const firstAnswer = await parked;

      const firstId = firstAnswer.content[0].text;
      const secondId = secondAnswer.content[0].text;
      assert.notStrictEqual(firstId, secondId, 'answers must come from different instances');

      const firstAgain = await first.callTool({ name: 'whoami', arguments: {} });
      assert.strictEqual(firstAgain.content[0].text, firstId, 'a connection stays pinned to its instance');
    } finally {
      await first.close();
      await second.close();
      await closeDaemon(daemon);
    }
  });

  it('delivers a server-initiated notification to that connection only', { timeout: CASE_TIMEOUT_MS }, async () => {
    const instances = [];
    const serverFactory = () => {
      const server = new McpServer({ name: 'probe', version: '1.0.0' });
      server.registerTool('noop', { description: 'Present so the server declares tools', inputSchema: {} }, async () => ({
        content: [{ type: 'text', text: 'ok' }],
      }));
      instances.push(server);
      return server;
    };

    const daemon = await startTestDaemon({ socketPath: freshSocketPath(), serverFactory });
    const changes = { first: 0, second: 0 };
    const listChangedFor = (key, onFire) => ({
      tools: { autoRefresh: false, debounceMs: 0, onChanged: () => { changes[key] += 1; onFire?.(); } },
    });

    let sawFirstChange;
    const firstChanged = new Promise((resolve) => { sawFirstChange = resolve; });
    const first = await connectDaemonClient(daemon.socketPath, { listChanged: listChangedFor('first', () => sawFirstChange()) });
    const second = await connectDaemonClient(daemon.socketPath, { listChanged: listChangedFor('second') });

    try {
      await instances[0].sendToolListChanged();
      await withDeadline(firstChanged, 5_000, 'the tools/list_changed notification');
      // Long enough that a notification leaking onto the other connection
      // would have arrived by now.
      await delay(200);

      assert.strictEqual(changes.first, 1, 'the emitting connection receives the notification');
      assert.strictEqual(changes.second, 0, 'the other connection receives nothing');
    } finally {
      await first.close();
      await second.close();
      await closeDaemon(daemon);
    }
  });

  it('lets an in-flight call finish before shutdown completes', { timeout: CASE_TIMEOUT_MS }, async () => {
    let releaseHold;
    const hold = new Promise((resolve) => { releaseHold = resolve; });

    const serverFactory = ({ wrapHandler }) => {
      const server = new McpServer({ name: 'probe', version: '1.0.0' });
      server.registerTool('slow', { description: 'Parks until released', inputSchema: {} }, wrapHandler(async () => {
        await hold;
        return { content: [{ type: 'text', text: 'finished' }] };
      }));
      return server;
    };

    const daemon = await startTestDaemon({ socketPath: freshSocketPath(), serverFactory });
    const client = await connectDaemonClient(daemon.socketPath);
    const parked = client.callTool({ name: 'slow', arguments: {} });
    await delay(50);
    assert.strictEqual(daemon.inFlightCount(), 1, 'the parked call must be counted');

    let shutdownDone = false;
    const shutdown = daemon.close().then(() => { shutdownDone = true; });
    await delay(100);
    assert.strictEqual(shutdownDone, false, 'shutdown must not complete while a call is in flight');

    releaseHold();
    const answer = await withDeadline(parked, 5_000, 'the drained call to answer');
    assert.strictEqual(answer.content[0].text, 'finished', 'the call must be answered, not cut off');

    await withDeadline(shutdown, 5_000, 'shutdown to complete');
    await client.close();
  });

  it('survives a response too large for the client read buffer', { timeout: CASE_TIMEOUT_MS }, async () => {
    // One byte over the SDK's 10MB ceiling, which ReadBuffer.append enforces by
    // throwing. Unguarded that throw is an uncaughtException in a socket 'data'
    // handler, which kills this whole process rather than the connection.
    const oversized = 'x'.repeat(11 * 1024 * 1024);
    const serverFactory = () => {
      const server = new McpServer({ name: 'probe', version: '1.0.0' });
      server.registerTool('firehose', { description: 'Answers with more than the client can buffer', inputSchema: {} }, async () => ({
        content: [{ type: 'text', text: oversized }],
      }));
      return server;
    };

    const daemon = await startTestDaemon({ socketPath: freshSocketPath(), serverFactory });
    const client = await connectDaemonClient(daemon.socketPath);
    const errors = [];
    client.onerror = (err) => errors.push(err);

    try {
      await assert.rejects(
        () => withDeadline(client.callTool({ name: 'firehose', arguments: {} }), 15_000, 'the oversized call to fail'),
        (err) => !/timed out/.test(err.message),
        'the call must fail rather than hang',
      );
      assert.ok(
        errors.some(err => /exceeded maximum size/.test(err.message)),
        `expected a read-buffer error, got: ${errors.map(e => e.message).join(', ')}`,
      );
      // Reaching this line at all is the assertion that matters: an unguarded
      // append() would have taken the test process down with it.
      assert.strictEqual(typeof process.pid, 'number');
    } finally {
      await client.close();
      await closeDaemon(daemon);
    }
  });

  it('creates the socket at 0600 and leaves the process umask alone', { timeout: CASE_TIMEOUT_MS }, async () => {
    const before = process.umask();
    const daemon = await startTestDaemon({ socketPath: freshSocketPath() });
    try {
      assert.strictEqual(statSync(daemon.socketPath).mode & 0o777, 0o600);
      // The mode is bought by narrowing the process-wide umask across bind, so
      // failing to put it back would silently narrow every later file too.
      assert.strictEqual(process.umask(), before, 'the umask must be restored');
    } finally {
      await closeDaemon(daemon);
    }
  });

  it('reclaims a socket file left behind by a dead daemon', { timeout: CASE_TIMEOUT_MS }, async () => {
    const socketPath = freshSocketPath();
    await abandonSocket(socketPath);
    assert.ok(existsSync(socketPath), 'the dead process must have left its socket file');

    const daemon = await startTestDaemon({ socketPath });
    try {
      const client = await connectDaemonClient(socketPath);
      await client.listTools();
      await client.close();
    } finally {
      await closeDaemon(daemon);
    }
  });

  // connect() cannot answer "is this a socket": darwin says ENOTSOCK, linux
  // says ECONNREFUSED, the same code a dead socket gives. Classifying on errno
  // passed here on darwin while deleting the file on linux.
  it('refuses a non-socket file at the socket path instead of deleting it', { timeout: CASE_TIMEOUT_MS }, async () => {
    const socketPath = freshSocketPath();
    writeFileSync(socketPath, 'not a socket');

    await assertStartRefused({ socketPath }, /is not a socket/);
    assert.strictEqual(readFileSync(socketPath, 'utf8'), 'not a socket', 'only a proven dead socket may be cleared');
  });

  it('refuses a directory at the socket path', { timeout: CASE_TIMEOUT_MS }, async () => {
    const socketPath = freshSocketPath();
    mkdirSync(socketPath);

    await assertStartRefused({ socketPath }, /is not a socket/);
    assert.ok(statSync(socketPath).isDirectory(), 'the directory must survive');
  });

  it('classifies a symlink at the socket path as occupied, not stale', { timeout: CASE_TIMEOUT_MS }, async () => {
    const socketPath = freshSocketPath();
    // lstat, not stat: a symlink is not ours to follow or remove, whether or
    // not it resolves to something live.
    symlinkSync('/nowhere', socketPath);

    assert.strictEqual(await probeSocket(socketPath), 'occupied');
    await assertStartRefused({ socketPath }, /is not a socket/);
  });

  it('refuses to start when a live daemon holds the socket', { timeout: CASE_TIMEOUT_MS }, async () => {
    const daemon = await startTestDaemon({ socketPath: freshSocketPath() });
    try {
      await assertStartRefused({ socketPath: daemon.socketPath }, /already listening/);
      // The refusal must leave the running daemon usable, not unlink it.
      const client = await connectDaemonClient(daemon.socketPath);
      await client.listTools();
      await client.close();
    } finally {
      await closeDaemon(daemon);
    }
  });

  it('removes its socket on close', { timeout: CASE_TIMEOUT_MS }, async () => {
    const daemon = await startTestDaemon({ socketPath: freshSocketPath() });
    await closeDaemon(daemon);
    assert.ok(!existsSync(daemon.socketPath), 'a clean shutdown must not leave a socket file');
  });
});
