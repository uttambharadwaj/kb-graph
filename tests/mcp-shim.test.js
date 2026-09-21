import './helpers/tmp-kb.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { McpServer } from '@modelcontextprotocol/server';
import packageJson from '../package.json' with { type: 'json' };
import { reconnectDelay } from '../src/cli/mcp-shim.js';
import { startReplacementDaemon } from '../src/cli/serve.js';
import { getDb } from '../src/db.js';
import { startDaemon } from '../src/daemon.js';
import { markDaemonRestart, restartMarkerPath } from '../src/daemon-restart.js';
import { resolveHarnessAncestry } from '../src/process-ancestry.js';
import { SESSION_MAP_DIR } from '../src/session-map.js';
import { SHIM_PATH_LOG, SHIM_RECOVERY_STAGES } from '../src/shim-path-meter.js';
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

function processChildren(parentPid) {
  const result = spawnSync('ps', ['-eo', 'ppid=,args='], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout.split('\n').filter((line) => {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    return match && Number(match[1]) === parentPid;
  });
}

function collectStderr(child) {
  let text = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { text += chunk; });
  return () => text;
}

function readShimPathEvents() {
  return readFileSync(SHIM_PATH_LOG, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

function lastShimPathEvent() {
  return readShimPathEvents().at(-1);
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
  it('never jitters reconnect delay past the configured maximum', () => {
    assert.strictEqual(reconnectDelay(20, 100, 2_000, () => 1), 2_000);
    assert.strictEqual(reconnectDelay(1, 100, 2_000, () => 0), 75);
  });

  it('keeps direct kb mcp as a one-process stdio path', { timeout: CASE_TIMEOUT_MS }, async () => {
    const child = spawn(process.execPath, [KB_BIN, 'mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    strayChildren.add(child);
    child.once('exit', () => strayChildren.delete(child));
    const driver = jsonRpcDriver(child);
    try {
      const init = await withDeadline(initialize(driver), 15_000, 'direct kb mcp to initialize');
      assert.strictEqual(init.result.serverInfo.name, 'knowledge-base');
      assert.deepStrictEqual(
        processChildren(child.pid),
        [],
        'direct kb mcp must not spawn a child process',
      );
      const exited = waitForExit(child);
      child.stdin.end();
      assert.deepStrictEqual(
        await withDeadline(exited, 5_000, 'direct kb mcp to exit on client EOF'),
        { code: 0, signal: null },
      );
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });

  it('forwards initialize, tools/list and tools/call through the daemon socket', { timeout: CASE_TIMEOUT_MS }, async () => {
    const daemon = await startTestDaemon({ socketPath: freshSocketPath() });
    const child = spawnShim([`--socket=${daemon.socketPath}`]);
    const driver = jsonRpcDriver(child);
    try {
      const init = await initialize(driver);
      assert.deepStrictEqual(init.result.serverInfo, { name: 'knowledge-base', version: packageJson.version });

      const list = await driver.call('tools/list');
      assert.ok(list.result.tools.some((tool) => tool.name === 'kb_search'), 'kb_search must be registered');

      const result = await driver.call('tools/call', { name: 'kb_search', arguments: { query: 'mcp shim smoke test' } });
      assert.ok(!result.result.isError, `kb_search failed: ${JSON.stringify(result.result.content)}`);
      assert.strictEqual(result.result.content[0].type, 'text');
      assert.strictEqual(lastShimPathEvent().path, 'daemon');
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
      // The readiness preface must not instantiate an MCP server. The only
      // instance belongs to the real client connection.
      await until(() => instances.length === 1, 'the daemon to build the real connection server instance');

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

  it('retries a cold daemon at startup instead of falling back', { timeout: CASE_TIMEOUT_MS }, async () => {
    const socketPath = freshSocketPath();
    let rejectFirstProbe;
    const firstProbe = new Promise((resolve) => { rejectFirstProbe = resolve; });
    const rejectingServer = createServer((socket) => {
      socket.destroy();
      rejectFirstProbe();
    });
    await new Promise((resolve, reject) => {
      rejectingServer.once('error', reject);
      rejectingServer.listen(socketPath, resolve);
    });

    const child = spawnShim([`--socket=${socketPath}`], {
      KB_SHIM_STARTUP_READINESS_TIMEOUT_MS: '2000',
      KB_SHIM_PROBE_ATTEMPT_TIMEOUT_MS: '200',
    });
    const stderr = collectStderr(child);
    const driver = jsonRpcDriver(child);
    let daemon = null;
    try {
      await withDeadline(firstProbe, 5_000, 'the first startup probe');
      await new Promise((resolve, reject) => rejectingServer.close((error) => error ? reject(error) : resolve()));

      daemon = await startTestDaemon({ socketPath });
      await initialize(driver);

      assert.ok(!stderr().includes('serving in-process'), stderr());
      assert.deepStrictEqual(
        { path: lastShimPathEvent().path, reason: lastShimPathEvent().reason },
        { path: 'daemon', reason: 'cold_ready' },
      );
    } finally {
      child.kill();
      await new Promise(resolve => rejectingServer.close(() => resolve()));
      if (daemon) {
        liveDaemons.delete(daemon);
        await daemon.close().catch(() => {});
      }
    }
  });

  it('falls back to the in-process server when the daemon is unreachable, keeping stdout protocol-only', { timeout: CASE_TIMEOUT_MS }, async () => {
    const socketPath = freshSocketPath(); // nobody is listening here
    const child = spawnShim([`--socket=${socketPath}`], { KB_SHIM_STARTUP_READINESS_TIMEOUT_MS: '300' });
    const stderr = collectStderr(child);
    const driver = jsonRpcDriver(child);
    try {
      const init = await withDeadline(initialize(driver), 15_000, 'the fallback in-process server to answer initialize');
      assert.strictEqual(init.result.serverInfo.name, 'knowledge-base');
      await until(() => stderr().includes('kb mcp-shim: daemon unreachable, serving in-process'), 'the fallback stderr line');
      assert.deepStrictEqual(
        { path: lastShimPathEvent().path, reason: lastShimPathEvent().reason },
        { path: 'fallback', reason: 'connection_refused' },
      );
      assert.deepStrictEqual(
        processChildren(child.pid),
        [],
        'fallback must stay in the shim process instead of spawning a child process',
      );
      const exited = waitForExit(child);
      child.stdin.end();
      assert.deepStrictEqual(
        await withDeadline(exited, 5_000, 'the direct fallback to exit on client EOF'),
        { code: 0, signal: null },
      );
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });

  it('preserves an explicit Cursor agent tag through the in-process fallback', { timeout: CASE_TIMEOUT_MS }, async () => {
    const socketPath = freshSocketPath();
    const child = spawnShim([`--socket=${socketPath}`, '--agent=cursor']);
    const driver = jsonRpcDriver(child);
    const query = 'cursor-explicit-agent-fallback';
    try {
      await initialize(driver);
      const result = await driver.call('tools/call', { name: 'kb_search', arguments: { query } });
      assert.ok(!result.result.isError, `kb_search failed: ${JSON.stringify(result.result.content)}`);
      const rows = getDb().prepare('SELECT agent FROM retrievals WHERE query = ?').all(query);
      assert.ok(rows.length > 0, 'the fallback search must log a retrieval row');
      for (const row of rows) assert.strictEqual(row.agent, 'cursor');
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
      assert.deepStrictEqual(
        { path: lastShimPathEvent().path, reason: lastShimPathEvent().reason },
        { path: 'fallback', reason: 'readiness_timeout' },
      );
    } finally {
      child.kill();
      await wedged.close();
    }
  });

  it('waits through an explicitly marked cold restart without changing the ordinary startup deadline', { timeout: CASE_TIMEOUT_MS }, async () => {
    const socketPath = freshSocketPath();
    markDaemonRestart(socketPath);
    const child = spawnShim([`--socket=${socketPath}`], {
      KB_SHIM_STARTUP_READINESS_TIMEOUT_MS: '150',
      KB_SHIM_RESTART_GRACE_TIMEOUT_MS: '5000',
      KB_SHIM_RESTART_MARKER_MAX_AGE_MS: '5000',
      KB_SHIM_PROBE_ATTEMPT_TIMEOUT_MS: '100',
    });
    const stderr = collectStderr(child);
    const driver = jsonRpcDriver(child);
    try {
      const initialized = initialize(driver);
      await delay(1500);
      await startTestDaemon({ socketPath });

      const init = await withDeadline(initialized, 5_000, 'the replacement daemon to answer initialize');
      assert.deepStrictEqual(init.result.serverInfo, { name: 'knowledge-base', version: packageJson.version });
      assert.ok(!stderr().includes('serving in-process'), stderr());
      assert.deepStrictEqual(
        { path: lastShimPathEvent().path, reason: lastShimPathEvent().reason },
        { path: 'daemon', reason: 'cold_restart_ready' },
      );
    } finally {
      child.kill();
    }
  });

  it('ignores a stale restart marker and preserves fallback availability', { timeout: CASE_TIMEOUT_MS }, async () => {
    const socketPath = freshSocketPath();
    markDaemonRestart(socketPath, { now: Date.now() - 10_000 });
    const child = spawnShim([`--socket=${socketPath}`], {
      KB_SHIM_STARTUP_READINESS_TIMEOUT_MS: '150',
      KB_SHIM_RESTART_GRACE_TIMEOUT_MS: '2000',
      KB_SHIM_RESTART_MARKER_MAX_AGE_MS: '1000',
      KB_SHIM_PROBE_ATTEMPT_TIMEOUT_MS: '100',
    });
    const driver = jsonRpcDriver(child);
    try {
      const init = await withDeadline(initialize(driver), 5_000, 'the fallback server to answer initialize');
      assert.strictEqual(init.result.serverInfo.name, 'knowledge-base');
      assert.deepStrictEqual(
        { path: lastShimPathEvent().path, reason: lastShimPathEvent().reason },
        { path: 'fallback', reason: 'connection_refused' },
      );
    } finally {
      child.kill();
    }
  });

  it('bounds a marked restart when the replacement daemon never appears', { timeout: CASE_TIMEOUT_MS }, async () => {
    const socketPath = freshSocketPath();
    markDaemonRestart(socketPath);
    const child = spawnShim([`--socket=${socketPath}`], {
      KB_SHIM_STARTUP_READINESS_TIMEOUT_MS: '150',
      KB_SHIM_RESTART_GRACE_TIMEOUT_MS: '2500',
      KB_SHIM_RESTART_MARKER_MAX_AGE_MS: '5000',
      KB_SHIM_PROBE_ATTEMPT_TIMEOUT_MS: '100',
    });
    const driver = jsonRpcDriver(child);
    try {
      const init = await withDeadline(initialize(driver), 5_000, 'the bounded restart grace to fall back');
      assert.strictEqual(init.result.serverInfo.name, 'knowledge-base');
      assert.deepStrictEqual(
        { path: lastShimPathEvent().path, reason: lastShimPathEvent().reason },
        { path: 'fallback', reason: 'restart_readiness_timeout' },
      );
    } finally {
      child.kill();
    }
  });

  it('consumes a successful replacement marker before a later crash', { timeout: CASE_TIMEOUT_MS }, async () => {
    const socketPath = freshSocketPath();
    markDaemonRestart(socketPath);
    const daemon = await startReplacementDaemon(socketPath, {
      start: path => startTestDaemon({ socketPath: path }),
    });
    assert.equal(existsSync(restartMarkerPath(socketPath)), false);

    await daemon.close();
    liveDaemons.delete(daemon);
    const child = spawnShim([`--socket=${socketPath}`], {
      KB_SHIM_STARTUP_READINESS_TIMEOUT_MS: '300',
      KB_SHIM_RESTART_GRACE_TIMEOUT_MS: '5000',
      KB_SHIM_RESTART_MARKER_MAX_AGE_MS: '5000',
    });
    const driver = jsonRpcDriver(child);
    try {
      const init = await withDeadline(initialize(driver), 5_000, 'ordinary fallback after the replacement crash');
      assert.strictEqual(init.result.serverInfo.name, 'knowledge-base');
      assert.deepStrictEqual(
        { path: lastShimPathEvent().path, reason: lastShimPathEvent().reason },
        { path: 'fallback', reason: 'connection_refused' },
      );
    } finally {
      child.kill();
    }
  });

  it('honors the startup readiness deadline independently from reconnect handshakes', () => {
    // Reads the exported constant in a fresh process rather than timing a
    // real fallback against wall-clock — a loaded test runner makes any
    // absolute-duration assertion flaky, and this proves the same thing: the
    // env var, not the 2s default, decides the deadline.
    const readTimeoutMs = (envOverride = {}) => {
      const url = pathToFileURL(MCP_SHIM_MODULE).href;
      // Base env deliberately excludes any ambient KB_SHIM_PROBE_TIMEOUT_MS
      // so the unset case is a real unset, not an accident of this shell.
      const {
        KB_SHIM_PROBE_TIMEOUT_MS: _legacyUnused,
        KB_SHIM_STARTUP_READINESS_TIMEOUT_MS: _unused,
        ...baseEnv
      } = process.env;
      const result = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(url)}).then(m => console.log(m.PROBE_TIMEOUT_MS))`], {
        env: { ...baseEnv, ...envOverride },
        encoding: 'utf8',
      });
      assert.strictEqual(result.status, 0, result.stderr);
      return Number(result.stdout.trim());
    };

    assert.strictEqual(readTimeoutMs(), 8000, 'defaults to an 8s cold-start window when unset');
    assert.strictEqual(readTimeoutMs({ KB_SHIM_STARTUP_READINESS_TIMEOUT_MS: '150' }), 150);
    assert.strictEqual(readTimeoutMs({ KB_SHIM_PROBE_TIMEOUT_MS: '175' }), 175, 'retains the old env override');
  });

  it('keeps an initialized session usable when the daemon restarts', { timeout: CASE_TIMEOUT_MS }, async () => {
    const socketPath = freshSocketPath();
    const daemon = await startTestDaemon({ socketPath });
    const child = spawnShim([`--socket=${daemon.socketPath}`]);
    const stderr = collectStderr(child);
    const driver = jsonRpcDriver(child);
    try {
      await initialize(driver);

      liveDaemons.delete(daemon);
      await daemon.close();
      await until(() => stderr().includes('daemon connection closed unexpectedly; reconnecting'), 'the reconnect notice');

      const unavailable = await driver.call('tools/list');
      assert.match(unavailable.error.message, /daemon is reconnecting/);

      await startTestDaemon({ socketPath });
      await until(() => stderr().includes('daemon connection restored'), 'the restored notice');
      const list = await Promise.race([
        driver.call('tools/list'),
        waitForExit(child).then(({ code, signal }) => assert.fail(`shim exited during recovery: code=${code} signal=${signal}`)),
      ]);

      assert.ok(list.result.tools.some((tool) => tool.name === 'kb_search'), 'kb_search must remain registered');
      assert.ok(
        driver.notifications.some((notification) => notification.method === 'notifications/tools/list_changed'),
        'recovery must invalidate the client\'s cached tool list',
      );
      const recoveryRows = readShimPathEvents()
        .filter((row) => row.event === 'shim_recovery');
      const restored = recoveryRows.findLast((row) => row.outcome === 'restored');
      assert.ok(restored, 'a successful recovery must be metered');
      assert.ok(
        recoveryRows.some((row) => row.recovery_id === restored.recovery_id && row.outcome === 'started'),
        'the recovery denominator must include the matching start',
      );
    } finally {
      child.kill();
    }
  });

  it('uses the recovery handshake budget independently from the connect budget', { timeout: CASE_TIMEOUT_MS }, async () => {
    const socketPath = freshSocketPath();
    const delayedServerFactory = async () => {
      await delay(200);
      const server = new McpServer({ name: 'slow-handshake-test', version: '1.0.0' });
      server.registerTool('noop', { description: 'recovery probe', inputSchema: {} }, async () => ({
        content: [{ type: 'text', text: 'ok' }],
      }));
      return server;
    };
    const daemon = await startTestDaemon({ socketPath, serverFactory: delayedServerFactory });
    const child = spawnShim([`--socket=${socketPath}`], {
      KB_SHIM_CONNECT_TIMEOUT_MS: '50',
      KB_SHIM_RECOVERY_HANDSHAKE_TIMEOUT_MS: '1000',
      KB_SHIM_RECONNECT_DELAY_MS: '10',
    });
    const stderr = collectStderr(child);
    const driver = jsonRpcDriver(child);
    let replacement = null;
    try {
      await initialize(driver);

      liveDaemons.delete(daemon);
      await daemon.close();
      await until(() => stderr().includes('daemon connection closed unexpectedly; reconnecting'), 'the shim to enter recovery');

      replacement = await startTestDaemon({ socketPath, serverFactory: delayedServerFactory });
      await until(() => stderr().includes('daemon connection restored'), 'a slow recovery handshake to finish');

      const list = await driver.call('tools/list');
      assert.ok(list.result.tools.some((tool) => tool.name === 'noop'));
    } finally {
      child.kill();
      if (replacement) {
        liveDaemons.delete(replacement);
        await replacement.close().catch(() => {});
      }
    }
  });

  it('abandons an in-flight recovery on stdin EOF without restoring an orphan', { timeout: CASE_TIMEOUT_MS }, async () => {
    const socketPath = freshSocketPath();
    const daemon = await startTestDaemon({ socketPath });
    const child = spawnShim([`--socket=${socketPath}`], {
      KB_SHIM_CONNECT_TIMEOUT_MS: '100',
      KB_SHIM_RECOVERY_HANDSHAKE_TIMEOUT_MS: '5000',
      KB_SHIM_RECONNECT_DELAY_MS: '10',
    });
    const stderr = collectStderr(child);
    const driver = jsonRpcDriver(child);
    let replacementServer = null;

    try {
      await initialize(driver);
      liveDaemons.delete(daemon);
      await daemon.close();
      await until(() => stderr().includes('daemon connection closed unexpectedly; reconnecting'), 'the shim to enter recovery');

      let resolveReplay;
      const replaySeen = new Promise((resolve) => { resolveReplay = resolve; });
      let resolveReplacementClosed;
      const replacementClosed = new Promise((resolve) => { resolveReplacementClosed = resolve; });
      replacementServer = createServer((socket) => {
        let buffer = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            let message;
            try { message = JSON.parse(line); } catch { continue; }
            if (message.method === 'initialize') resolveReplay({ message, socket });
          }
        });
        socket.once('close', resolveReplacementClosed);
      });
      await new Promise((resolve, reject) => {
        replacementServer.once('error', reject);
        replacementServer.listen(socketPath, resolve);
      });

      const replay = await withDeadline(replaySeen, 5_000, 'the replacement initialize replay');
      child.stdout.pause();
      replay.socket.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 'backpressure',
        result: { payload: 'x'.repeat(2 * 1024 * 1024) },
      })}\n`);
      await until(() => child.stdout.readableLength > 0, 'the shim stdout to become backpressured');

      child.stdin.end();
      let abandoned;
      await until(() => {
        abandoned = readShimPathEvents().findLast(row => row.event === 'shim_recovery'
          && row.pid === child.pid
          && row.outcome === 'abandoned');
        return abandoned != null;
      }, 'the in-flight recovery to be abandoned');
      assert.strictEqual(child.exitCode, null, 'stdout backpressure must keep the cancellation race observable');

      replay.socket.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: replay.message.id,
        result: {},
      })}\n`);
      await withDeadline(replacementClosed, 5_000, 'the cancelled recovery socket to close');

      const outcomes = readShimPathEvents()
        .filter(row => row.event === 'shim_recovery' && row.recovery_id === abandoned.recovery_id)
        .map(row => row.outcome);
      assert.deepStrictEqual(outcomes, ['started', 'abandoned']);

      child.stdout.resume();
      const { code } = await withDeadline(waitForExit(child), 5_000, 'the cancelled shim to exit');
      assert.strictEqual(code, 0);
    } finally {
      child.stdout.resume();
      child.kill();
      if (replacementServer) {
        await new Promise(resolve => replacementServer.close(() => resolve()));
      }
    }
  });

  it('bounds a 15-shim legacy-timeout wave without handshake retry amplification', { timeout: CASE_TIMEOUT_MS }, async () => {
    const socketPath = freshSocketPath();
    let serverBuilds = 0;
    const makeServer = (buildDelayMs = 0) => () => {
      serverBuilds++;
      const deadline = Date.now() + buildDelayMs;
      while (Date.now() < deadline) {
        // Models synchronous per-connection registration work. Under the old
        // 2s deadline, the tail of 15 simultaneous handshakes timed out and
        // retried, multiplying the queued work and producing EPIPE bursts.
      }
      const server = new McpServer({ name: 'stampede-test', version: '1.0.0' });
      server.registerTool('noop', { description: 'restart probe', inputSchema: {} }, async () => ({
        content: [{ type: 'text', text: 'ok' }],
      }));
      return server;
    };
    const daemon = await startTestDaemon({ socketPath, serverFactory: makeServer() });
    const children = Array.from({ length: 15 }, () => spawnShim([`--socket=${socketPath}`], {
      // Models the already-running shim generation present during rollout.
      KB_SHIM_RECOVERY_HANDSHAKE_TIMEOUT_MS: '2000',
    }));
    const stderrs = children.map(collectStderr);
    const drivers = children.map(jsonRpcDriver);
    let replacement = null;
    try {
      await Promise.all(drivers.map(initialize));

      const recoveryStartedAt = Date.now();
      liveDaemons.delete(daemon);
      await daemon.close();
      await until(
        () => stderrs.every((stderr) => stderr().includes('daemon connection closed unexpectedly; reconnecting')),
        'all 15 shims to enter recovery',
      );

      const daemonErrors = [];
      replacement = await startTestDaemon({
        socketPath,
        serverFactory: makeServer(150),
        onError: (err) => daemonErrors.push(err),
      });
      serverBuilds = 0;
      await until(
        () => stderrs.every((stderr) => stderr().includes('daemon connection restored')),
        'all 15 shims to restore',
      );
      const recoveryDurationMs = Date.now() - recoveryStartedAt;

      const lists = await Promise.all(drivers.map((driver) => driver.call('tools/list')));
      assert.ok(lists.every((list) => list.result.tools.some((tool) => tool.name === 'noop')));

      const childPids = new Set(children.map((child) => child.pid));
      const restored = readShimPathEvents()
        .filter((row) => row.event === 'shim_recovery'
          && row.outcome === 'restored'
          && childPids.has(row.pid)
          && new Date(row.ts).getTime() >= recoveryStartedAt);
      assert.strictEqual(restored.length, 15, 'every shim must emit a restored denominator row');
      assert.ok(restored.every((row) => row.attempts <= 3), JSON.stringify(restored));
      const handshakeFailures = readShimPathEvents()
        .filter((row) => row.event === 'shim_recovery_attempt'
          && row.stage === SHIM_RECOVERY_STAGES.HANDSHAKE
          && childPids.has(row.pid)
          && new Date(row.ts).getTime() >= recoveryStartedAt);
      assert.ok(
        handshakeFailures.length <= children.length,
        `each shim may time out once, but the wave must not multiply: ${JSON.stringify(handshakeFailures)}`,
      );
      assert.ok(serverBuilds <= children.length * 2, `server builds amplified: ${serverBuilds}`);
      assert.ok(recoveryDurationMs < 8000, `15-shim recovery exceeded 8s SLO: ${recoveryDurationMs}ms`);
      assert.ok(
        daemonErrors.every((err) => err.code !== 'EPIPE' && err.message !== 'write EPIPE'),
        `one-attempt recovery must not leave timed-out writes: ${daemonErrors.map((err) => err.message).join(', ')}`,
      );
    } finally {
      for (const child of children) child.kill();
      if (replacement) {
        liveDaemons.delete(replacement);
        await replacement.close().catch(() => {});
      }
    }
  });

  // The whole identity path in production shape: a real shim child resolving
  // its OWN ancestry, writing its own hello, and a real daemon reading it —
  // no hand-written line anywhere. The shim is a child of this test process,
  // so both walk to the same harness; the map entry is seeded under that pid
  // the way prompt-hint/wakeup-hook would have written it.
  it('tags a retrieval with the session and agent its own hello named', { timeout: CASE_TIMEOUT_MS }, async (t) => {
    const { harnessPid, pidStart, agent } = resolveHarnessAncestry();
    // A visible skip, not a silent pass: with no harness above this process
    // (CI, a bare shell) there is no identity for the shim to find, and a
    // green tick would claim this was proven when it was not.
    if (harnessPid == null) return t.skip('no harness process above the test runner');
    mkdirSync(SESSION_MAP_DIR, { recursive: true });
    writeFileSync(
      join(SESSION_MAP_DIR, `${harnessPid}.json`),
      JSON.stringify({ pid: harnessPid, pid_start: pidStart, session_id: 'sess-real-shim', agent, ts: new Date().toISOString() }),
    );

    const daemon = await startTestDaemon({ socketPath: freshSocketPath() });
    const child = spawnShim([`--socket=${daemon.socketPath}`]);
    const stderr = collectStderr(child);
    const driver = jsonRpcDriver(child);
    const query = 'real-shim-identity-e2e';
    try {
      await initialize(driver);
      const result = await driver.call('tools/call', { name: 'kb_search', arguments: { query } });
      assert.ok(!result.result.isError, `kb_search failed: ${JSON.stringify(result.result.content)}`);
      // Proves the row came through the daemon rather than the in-process
      // fallback, which would tag it correctly for the wrong reason.
      assert.ok(!stderr().includes('serving in-process'), `the shim fell back instead of using the daemon: ${stderr()}`);

      const rows = getDb().prepare('SELECT session, agent FROM retrievals WHERE query = ?').all(query);
      assert.ok(rows.length > 0, 'the search must have logged a retrieval row');
      for (const row of rows) {
        assert.strictEqual(row.session, 'sess-real-shim');
        assert.strictEqual(row.agent, agent);
      }
    } finally {
      child.kill();
    }
  });

  it('uses an explicit Cursor agent tag when process ancestry cannot name the harness', { timeout: CASE_TIMEOUT_MS }, async () => {
    const daemon = await startTestDaemon({ socketPath: freshSocketPath() });
    const child = spawnShim([`--socket=${daemon.socketPath}`, '--agent=cursor']);
    const stderr = collectStderr(child);
    const driver = jsonRpcDriver(child);
    const query = 'cursor-explicit-agent-daemon';
    try {
      await initialize(driver);
      const result = await driver.call('tools/call', { name: 'kb_search', arguments: { query } });
      assert.ok(!result.result.isError, `kb_search failed: ${JSON.stringify(result.result.content)}`);
      assert.ok(!stderr().includes('serving in-process'), `the shim fell back instead of using the daemon: ${stderr()}`);
      const rows = getDb().prepare('SELECT agent FROM retrievals WHERE query = ?').all(query);
      assert.ok(rows.length > 0, 'the daemon search must log a retrieval row');
      for (const row of rows) assert.strictEqual(row.agent, 'cursor');
    } finally {
      child.kill();
    }
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
