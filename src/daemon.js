// The resident KB service: one process, one unix socket, one MCP connection
// per accepted socket, in place of the supervisor+child pair every editor
// session spawns today. Nothing registers against it yet — the stdio shim
// that dials it lands separately.
//
// Each connection is served by serveStdio() over a StdioServerTransport bound
// to the socket rather than to process stdio. That is the SDK's sanctioned
// custom-transport path (see ServeStdioOptions.transport in
// @modelcontextprotocol/server/stdio) and it is why the socket, not stateless
// HTTP, is the wire: serveStdio gives full bidirectional JSON-RPC, so
// server->client notifications work.
//
// No src/ watcher here on purpose: the per-session supervisor reloads its
// child because it owns one connection, while a restart of this process drops
// every session at once. Whatever supervises `kb serve` owns that decision.
import { chmodSync, unlinkSync } from 'fs';
import { connect, createServer } from 'net';
import { join } from 'path';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { CLAUDE_CALL_TIMEOUT_MS } from './claude-cli.js';
import { createKbServer } from './mcp-factory.js';
import { KB_DIR } from './paths.js';

export const DAEMON_SOCKET_PATH = join(KB_DIR, 'daemon.sock');

// sockaddr_un.sun_path is 104 bytes on darwin, 108 on linux. Over the limit,
// bind() fails with an EINVAL that says nothing about path length.
const MAX_SOCKET_PATH_BYTES = 104;

const DRAIN_POLL_MS = 25;
const PROBE_TIMEOUT_MS = 1_000;

// Must outlast the longest a single tool call can take, or shutdown cuts off
// work the tool itself was still willing to wait for. Whatever supervises the
// process may SIGKILL sooner; that is its budget to set, not ours to pre-empt.
const DEFAULT_DRAIN_TIMEOUT_MS = CLAUDE_CALL_TIMEOUT_MS + 10_000;

/**
 * What is behind a socket path, judged by connect() alone.
 *
 * A successful connect is the only proof another daemon holds the socket, and
 * silence is NOT proof of absence — a live daemon busy enough to fill its
 * accept backlog also fails to answer. So `unknown` counts as occupied and the
 * unlink decision below never rests on a timeout.
 *
 * @returns {Promise<'live'|'stale'|'absent'|'unknown'>}
 */
export function probeSocket(socketPath, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    let settled = false;
    const finish = (state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(state);
    };
    const timer = setTimeout(() => finish('unknown'), timeoutMs);
    socket.once('connect', () => finish('live'));
    socket.once('error', (err) => {
      if (err.code === 'ENOENT') return finish('absent');
      if (err.code === 'ECONNREFUSED') return finish('stale');
      finish('unknown');
    });
  });
}

function assertSocketPathFits(socketPath) {
  const bytes = Buffer.byteLength(socketPath);
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`Socket path is ${bytes} bytes, over the ${MAX_SOCKET_PATH_BYTES}-byte limit: ${socketPath}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function drain(isBusy, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isBusy() && Date.now() < deadline) await sleep(DRAIN_POLL_MS);
  return !isBusy();
}

/**
 * Binds the socket and serves MCP on it until close(). Foreground: whatever
 * supervises the process owns daemonization and restart.
 *
 * @param {object} [options]
 * @param {string} [options.socketPath]
 * @param {(context: { era: string, wrapHandler: Function }) => import('@modelcontextprotocol/server').McpServer} [options.serverFactory]
 *   Builds the instance for one connection. Defaults to the shared KB factory.
 *   Handlers passed through `wrapHandler` are the ones the drain waits on.
 * @param {(error: Error) => void} [options.onError]
 */
export async function startDaemon({
  socketPath = DAEMON_SOCKET_PATH,
  serverFactory,
  onError = (err) => console.error(`[kb serve] ${err.message}`),
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
} = {}) {
  assertSocketPathFits(socketPath);

  const occupancy = await probeSocket(socketPath);
  if (occupancy === 'live' || occupancy === 'unknown') {
    throw new Error(`A daemon is already listening on ${socketPath}`);
  }
  // Nothing answered a connect, so no process owns this file.
  if (occupancy === 'stale') unlinkSync(socketPath);

  let inFlight = 0;
  const track = (handler) => async (...args) => {
    inFlight++;
    try {
      return await handler(...args);
    } finally {
      inFlight--;
    }
  };
  // The SDK calls the factory with { era }; the daemon adds the wrapper whose
  // counter the shutdown drain waits on, so a call in flight is never cut off.
  const buildServer = (context) => (serverFactory ?? createKbServer)({ ...context, wrapHandler: track });

  const connections = new Set();
  const server = createServer((socket) => {
    // Keeps a peer disconnect from throwing as an unhandled 'error'. The error
    // is not lost: the transport below listens on the same socket and reports
    // it through onerror.
    socket.on('error', () => {});

    const handle = serveStdio(buildServer, {
      transport: new StdioServerTransport(socket, socket),
      onerror: onError,
    });
    const entry = { handle, socket };
    connections.add(entry);
    socket.once('close', () => {
      connections.delete(entry);
      handle.close().catch(onError);
    });
  });

  // bind() applies the umask, so this is what makes the socket 0600 from birth.
  // Chmod-after-listen would leave it accepting at the ambient mode for the
  // window in between, and this daemon exposes full KB tool access with no auth
  // of its own — the filesystem is the gate. The umask is process-wide, so it
  // must come back off before anything else creates a file: nothing does inside
  // this await, and leaving it on makes every later mkdir unreadable.
  const priorUmask = process.umask(0o177);
  try {
    await new Promise((resolve, reject) => {
      const onListenError = (err) => reject(err);
      server.once('error', onListenError);
      server.listen(socketPath, () => {
        server.off('error', onListenError);
        resolve();
      });
    });
  } finally {
    process.umask(priorUmask);
  }
  server.on('error', onError);
  // Belt and braces: a platform that ignores the umask on bind still ends 0600.
  chmodSync(socketPath, 0o600);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const stopped = new Promise((resolve) => server.close(resolve));
    if (!await drain(() => inFlight > 0, drainTimeoutMs)) {
      onError(new Error(`Shut down with ${inFlight} tool call(s) still in flight after ${drainTimeoutMs}ms`));
    }
    for (const entry of [...connections]) {
      // serveStdio's transport only detaches its stream listeners on close —
      // the socket is ours to take down.
      await entry.handle.close().catch(onError);
      entry.socket.destroy();
    }
    connections.clear();
    await stopped;
  };

  return {
    socketPath,
    close,
    connectionCount: () => connections.size,
    inFlightCount: () => inFlight,
  };
}
