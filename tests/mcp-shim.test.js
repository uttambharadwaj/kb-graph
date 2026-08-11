import './helpers/tmp-kb.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { startDaemon } from '../src/daemon.js';
import { startWedgedDaemon } from './helpers/wedged-daemon.js';

// Drives `kb mcp-shim` as a real child process against a real in-process
// daemon — the daemon is the same code daemon.test.js exercises, just fronted
// here by the shim's byte-forwarding pipe instead of the SDK client directly.
const KB_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kb.js');
const MCP_SHIM_MODULE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'mcp-shim.js');
const CASE_TIMEOUT_MS = 60_000;
const REQUEST_PROTOCOL_VERSION = '2025-06-18';

const scratchDirs = [];
const liveDaemons = new Set();
const strayChildren = new Set();

after(async () => {
  for (const child of strayChildren) child.kill('SIGKILL');
  strayChildren.clear();
  for (const daemon of liveDaemons) await daemon.close().catch(() => {});
  liveDaemons.clear();
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

// The control socket defaults to a KB_DIR-based path shared by the whole
// file — fine in production (one daemon per KB_DIR) but wrong for tests,
// which start many daemons against one KB_DIR. Co-locate it with the main
// socket's own fresh dir unless a test overrides it explicitly.
async function startTestDaemon(options) {
  const controlSocketPath = options.socketPath ? join(dirname(options.socketPath), 'ctl.sock') : undefined;
  const daemon = await startDaemon({ controlSocketPath, ...options });
  liveDaemons.add(daemon);
  return daemon;
}

// Its own short dir per test, same rationale as daemon.test.js: sockaddr_un
// caps the path, and two tests sharing one path would race each other.
function freshSocketPath() {
  const dir = mkdtempSync(join(tmpdir(), 'kb-shim-sock-'));
  scratchDirs.push(dir);
  return join(dir, 'd.sock');
}

function withDeadline(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms); }),
  ]);
}

function spawnShim(extraArgs = [], extraEnv = {}) {
  const child = spawn(process.execPath, [KB_BIN, 'mcp-shim', ...extraArgs], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });
  strayChildren.add(child);
  child.once('exit', () => strayChildren.delete(child));
  return child;
}

function waitForExit(child) {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

function collectStderr(child) {
  let text = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { text += chunk; });
  return () => text;
}

/**
 * Hand-rolled JSON-RPC over a child's stdio, same rationale as
 * tests/mcp-wire-identity.test.js: the shim is a dumb pipe, so this drives
 * the exact bytes a client would send rather than routing through the SDK's
 * own client (which the shim is explicitly not allowed to depend on).
 * Also asserts every non-empty stdout line parses as JSON-RPC — the shim
 * must never put anything else on the protocol channel.
 */
function jsonRpcDriver(child) {
  const pending = new Map();
  const notifications = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        assert.fail(`shim wrote a non-JSON-RPC line to stdout: ${line.slice(0, 200)}`);
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else if (msg.id === undefined) {
        notifications.push(msg);
      }
    }
  });

  let nextId = 1;
  const call = (method, params) => new Promise((res, rej) => {
    const id = nextId++;
    const timer = setTimeout(() => rej(new Error(`timed out waiting for a response to ${method}`)), 10_000);
    pending.set(id, (msg) => { clearTimeout(timer); res(msg); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };

  return { call, notify, notifications };
}

async function initialize(driver) {
  const response = await driver.call('initialize', {
    protocolVersion: REQUEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'mcp-shim-test', version: '1.0.0' },
  });
  driver.notify('notifications/initialized');
  return response;
}

async function until(condition, what) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe('kb mcp-shim', () => {
  it('forwards initialize, tools/list and tools/call through the daemon socket', { timeout: CASE_TIMEOUT_MS }, async () => {
    const daemon = await startTestDaemon({ socketPath: freshSocketPath() });
    const child = spawnShim([`--socket=${daemon.socketPath}`]);
    const driver = jsonRpcDriver(child);
    try {
      const init = await initialize(driver);
      assert.deepStrictEqual(init.result.serverInfo, { name: 'knowledge-base', version: '1.0.0' });

      const list = await driver.call('tools/list');
      assert.ok(list.result.tools.some((tool) => tool.name === 'kb_search'), 'kb_search must be registered');

      const result = await driver.call('tools/call', { name: 'kb_search', arguments: { query: 'mcp shim smoke test' } });
      assert.ok(!result.result.isError, `kb_search failed: ${JSON.stringify(result.result.content)}`);
      assert.strictEqual(result.result.content[0].type, 'text');
    } finally {
      child.kill();
    }
  });

  it('passes a server-initiated notification through to stdout', { timeout: CASE_TIMEOUT_MS }, async () => {
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
    const child = spawnShim([`--socket=${daemon.socketPath}`]);
    const driver = jsonRpcDriver(child);
    try {
      await initialize(driver);
      // Two instances: the liveness probe's short-lived connection, then the
      // real pipe connection — in that order, since the shim awaits the
      // probe before ever dialing the second socket. The last one is ours.
      await until(() => instances.length === 2, 'the daemon to build server instances for the probe and the real connection');

      await instances.at(-1).sendToolListChanged();
      await withDeadline(
        until(() => driver.notifications.some((n) => n.method === 'notifications/tools/list_changed'), 'the notification on stdout'),
        5_000,
        'the tools/list_changed notification to reach the shim\'s stdout',
      );
    } finally {
      child.kill();
    }
  });

  it('falls back to the in-process server when the daemon is unreachable, keeping stdout protocol-only', { timeout: CASE_TIMEOUT_MS }, async () => {
    const socketPath = freshSocketPath(); // nobody is listening here
    const child = spawnShim([`--socket=${socketPath}`]);
    const stderr = collectStderr(child);
    const driver = jsonRpcDriver(child);
    try {
      const init = await withDeadline(initialize(driver), 15_000, 'the fallback in-process server to answer initialize');
      assert.strictEqual(init.result.serverInfo.name, 'knowledge-base');
      await until(() => stderr().includes('kb mcp-shim: daemon unreachable, serving in-process'), 'the fallback stderr line');
    } finally {
      child.kill();
    }
  });

  it('falls back when the daemon accepts but never answers (wedged)', { timeout: CASE_TIMEOUT_MS }, async () => {
    const socketPath = freshSocketPath();
    const wedged = await startWedgedDaemon(socketPath);
    // Short override so the probe's fallback deadline doesn't slow the suite.
    const child = spawnShim([`--socket=${socketPath}`], { KB_SHIM_PROBE_TIMEOUT_MS: '300' });
    const stderr = collectStderr(child);
    const driver = jsonRpcDriver(child);
    try {
      const init = await withDeadline(initialize(driver), 15_000, 'the fallback in-process server to answer initialize despite the wedged daemon');
      assert.strictEqual(init.result.serverInfo.name, 'knowledge-base');
      await until(() => stderr().includes('kb mcp-shim: daemon unresponsive, serving in-process'), 'the unresponsive fallback stderr line');
    } finally {
      child.kill();
      await wedged.close();
    }
  });

  it('honors KB_SHIM_PROBE_TIMEOUT_MS as the probe deadline', () => {
    // Reads the exported constant in a fresh process rather than timing a
    // real fallback against wall-clock — a loaded test runner makes any
    // absolute-duration assertion flaky, and this proves the same thing: the
    // env var, not the 2s default, decides the deadline.
    const readTimeoutMs = (envOverride = {}) => {
      const url = pathToFileURL(MCP_SHIM_MODULE).href;
      // Base env deliberately excludes any ambient KB_SHIM_PROBE_TIMEOUT_MS
      // so the unset case is a real unset, not an accident of this shell.
      const { KB_SHIM_PROBE_TIMEOUT_MS: _unused, ...baseEnv } = process.env;
      const result = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(url)}).then(m => console.log(m.PROBE_TIMEOUT_MS))`], {
        env: { ...baseEnv, ...envOverride },
        encoding: 'utf8',
      });
      assert.strictEqual(result.status, 0, result.stderr);
      return Number(result.stdout.trim());
    };

    assert.strictEqual(readTimeoutMs(), 2000, 'defaults to 2000ms when unset');
    assert.strictEqual(readTimeoutMs({ KB_SHIM_PROBE_TIMEOUT_MS: '150' }), 150);
  });

  it('exits nonzero promptly when the daemon dies mid-session', { timeout: CASE_TIMEOUT_MS }, async () => {
    const daemon = await startTestDaemon({ socketPath: freshSocketPath() });
    const child = spawnShim([`--socket=${daemon.socketPath}`]);
    const stderr = collectStderr(child);
    const driver = jsonRpcDriver(child);
    await initialize(driver);

    liveDaemons.delete(daemon);
    await daemon.close();

    const { code } = await withDeadline(waitForExit(child), 5_000, 'the shim to exit after the daemon dies');
    assert.notStrictEqual(code, 0, 'a mid-session daemon death must not report success');
    assert.match(stderr(), /daemon connection closed unexpectedly/);
  });

  it('exits 0 on stdin EOF', { timeout: CASE_TIMEOUT_MS }, async () => {
    const daemon = await startTestDaemon({ socketPath: freshSocketPath() });
    const child = spawnShim([`--socket=${daemon.socketPath}`]);
    const driver = jsonRpcDriver(child);
    await initialize(driver);

    child.stdin.end();
    const { code } = await withDeadline(waitForExit(child), 5_000, 'the shim to exit after stdin EOF');
    assert.strictEqual(code, 0);
  });
});
