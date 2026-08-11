import './helpers/tmp-kb.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { connectDaemonClient } from '../src/daemon-client.js';
import { startDaemon } from '../src/daemon.js';

const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

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

/** Leaves a socket file on disk with nothing behind it, the way a SIGKILLed daemon does. */
function abandonSocket(socketPath) {
  const script = `require('net').createServer().listen(${JSON.stringify(socketPath)}, () => console.log('ready'))`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.on('error', reject);
    child.stdout.once('data', () => {
      child.on('exit', () => resolve());
      child.kill('SIGKILL');
    });
  });
}

describe('resident daemon', () => {
  it('serves initialize, tools/list and tools/call over a socket', async () => {
    const daemon = await startDaemon({ socketPath: freshSocketPath() });
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
      await daemon.close();
    }
  });

  it('pins one instance per connection and does not cross concurrent calls', async () => {
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

    const daemon = await startDaemon({ socketPath: freshSocketPath(), serverFactory });
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
      await daemon.close();
    }
  });

  it('delivers a server-initiated notification to that connection only', async () => {
    const instances = [];
    const serverFactory = () => {
      const server = new McpServer({ name: 'probe', version: '1.0.0' });
      server.registerTool('noop', { description: 'Present so the server declares tools', inputSchema: {} }, async () => ({
        content: [{ type: 'text', text: 'ok' }],
      }));
      instances.push(server);
      return server;
    };

    const daemon = await startDaemon({ socketPath: freshSocketPath(), serverFactory });
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
      await daemon.close();
    }
  });

  it('lets an in-flight call finish before shutdown completes', async () => {
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

    const daemon = await startDaemon({ socketPath: freshSocketPath(), serverFactory });
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

  it('reclaims a socket file left behind by a dead daemon', async () => {
    const socketPath = freshSocketPath();
    await abandonSocket(socketPath);
    assert.ok(existsSync(socketPath), 'the dead process must have left its socket file');

    const daemon = await startDaemon({ socketPath });
    try {
      const client = await connectDaemonClient(socketPath);
      await client.listTools();
      await client.close();
    } finally {
      await daemon.close();
    }
  });

  it('refuses a non-socket file at the socket path instead of deleting it', async () => {
    const socketPath = freshSocketPath();
    writeFileSync(socketPath, 'not a socket');

    await assert.rejects(() => startDaemon({ socketPath }), /already listening/);
    assert.strictEqual(readFileSync(socketPath, 'utf8'), 'not a socket', 'only a refused connect may clear a path');
  });

  it('refuses to start when a live daemon holds the socket', async () => {
    const daemon = await startDaemon({ socketPath: freshSocketPath() });
    try {
      await assert.rejects(
        () => startDaemon({ socketPath: daemon.socketPath }),
        /already listening/,
      );
      // The refusal must leave the running daemon usable, not unlink it.
      const client = await connectDaemonClient(daemon.socketPath);
      await client.listTools();
      await client.close();
    } finally {
      await daemon.close();
    }
  });

  it('removes its socket on close', async () => {
    const daemon = await startDaemon({ socketPath: freshSocketPath() });
    await daemon.close();
    assert.ok(!existsSync(daemon.socketPath), 'a clean shutdown must not leave a socket file');
  });
});
