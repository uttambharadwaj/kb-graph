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
import { chmodSync, lstatSync, unlinkSync } from 'fs';
import { connect, createServer } from 'net';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { CLAUDE_CALL_TIMEOUT_MS } from './claude-cli.js';
import { CONTROL_SOCKET_PATH, DAEMON_SOCKET_PATH } from './daemon-paths.js';
import { HOOK_OPS } from './daemon-hook-ops.js';
import { createKbServer } from './mcp-factory.js';
import { callIdentity } from './retrieval.js';
import { MAX_HELLO_LINE_BYTES, parseHelloLine } from './shim-hello.js';

// Re-exported for existing importers (serve.js, mcp-shim.js) — the constants
// themselves live in daemon-paths.js so trigger-hook.js's cold path can
// import CONTROL_SOCKET_PATH without pulling in this file's mcp-factory.js
// -> db.js chain.
export { CONTROL_SOCKET_PATH, DAEMON_SOCKET_PATH };

// sockaddr_un.sun_path is 104 bytes on darwin, 108 on linux. Over the limit,
// bind() fails with an EINVAL that says nothing about path length.
const MAX_SOCKET_PATH_BYTES = 104;

const DRAIN_POLL_MS = 25;
const PROBE_TIMEOUT_MS = 1_000;

// Must outlast the longest a single tool call can take, or shutdown cuts off
// work the tool itself was still willing to wait for. Whatever supervises the
// process may SIGKILL sooner; that is its budget to set, not ours to pre-empt.
const DEFAULT_DRAIN_TIMEOUT_MS = CLAUDE_CALL_TIMEOUT_MS + 10_000;

function connectProbe(socketPath, timeoutMs, connectFn = connect) {
  return new Promise((resolve) => {
    const socket = connectFn(socketPath);
    let settled = false;
    const finish = (state, reason, errorCode = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ state, reason, errorCode });
    };
    const timer = setTimeout(() => finish('unknown', 'timeout'), timeoutMs);
    socket.once('connect', () => finish('live', 'connected'));
    socket.once('error', (err) => {
      if (err.code === 'ENOENT') return finish('absent', 'error', err.code);
      if (err.code === 'ECONNREFUSED') return finish('stale', 'error', err.code);
      finish('unknown', 'error', err.code ?? null);
    });
  });
}

/**
 * What is behind a socket path. Only `stale` is safe to unlink.
 *
 * The type check has to come first, because connect's errno cannot carry it:
 * a regular file answers ENOTSOCK on darwin but ECONNREFUSED on linux, which
 * is the same code a dead socket gives. Classifying on errno alone therefore
 * deletes an innocent file on linux and refuses on darwin. lstat rather than
 * stat: a symlink parked here is not ours to follow or remove either.
 *
 * A successful connect is the only proof another daemon holds the socket, and
 * silence is NOT proof of absence — a live daemon busy enough to fill its
 * accept backlog also fails to answer. So `unknown` counts as occupied and the
 * unlink decision never rests on a timeout.
 *
 * @returns {Promise<'live'|'stale'|'absent'|'occupied'|'unknown'>}
 */
export async function probeSocketDetailed(socketPath, {
  timeoutMs = PROBE_TIMEOUT_MS,
  connectFn = connect,
} = {}) {
  const stats = lstatSync(socketPath, { throwIfNoEntry: false });
  if (stats && !stats.isSocket()) return { state: 'occupied', reason: 'not_socket', errorCode: null };
  return connectProbe(socketPath, timeoutMs, connectFn);
}

export async function probeSocket(socketPath, options) {
  return (await probeSocketDetailed(socketPath, options)).state;
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

// Same ceiling daemon.test.js proves the MCP read buffer enforces (see
// "survives a response too large for the client read buffer") — reused here
// so a control-socket client that never sends a newline cannot grow this
// buffer without bound.
const MAX_CONTROL_LINE_BYTES = 10 * 1024 * 1024;

async function claimSocket(socketPath) {
  assertSocketPathFits(socketPath);
  const occupancy = await probeSocket(socketPath);
  if (occupancy === 'live') throw new Error(`A daemon is already listening on ${socketPath}`);
  if (occupancy === 'occupied') throw new Error(`${socketPath} exists and is not a socket; refusing to remove it`);
  if (occupancy === 'unknown') throw new Error(`Cannot tell what holds ${socketPath}; refusing to start`);
  // Proven a socket that nothing accepts on, so no process owns this file.
  if (occupancy === 'stale') unlinkSync(socketPath);
}

// bind() applies the umask, so this is what makes the socket 0600 from birth.
// Chmod-after-listen would leave it accepting at the ambient mode for the
// window in between, and both sockets this daemon exposes have no auth of
// their own — the filesystem is the gate. The umask is process-wide, so it
// must come back off before anything else creates a file: nothing does inside
// this await, and leaving it on makes every later mkdir unreadable.
async function bindSocket(server, socketPath) {
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
  // Belt and braces: a platform that ignores the umask on bind still ends 0600.
  chmodSync(socketPath, 0o600);
}

/**
 * Consumes the shim's identity line off a fresh connection before the MCP
 * transport is ever attached, then hands the connection over with every
 * remaining byte intact.
 *
 * Ordering is the whole problem: the hello and the client's first JSON-RPC
 * message routinely arrive in ONE chunk, so the leftover cannot simply be
 * dropped or re-emitted later. The socket is put back in paused mode, the
 * leftover unshifted to the head of its read buffer, the transport attached,
 * and only then resumed — the transport's own 'data' listener is installed
 * synchronously inside serveStdio (StdioServerTransport.start() has no await
 * before `_stdin.on('data', ...)`, verified in node_modules), so nothing is
 * emitted into the gap.
 *
 * `onReady(null)` for anything that is not a hello: an older shim, an
 * in-process client speaking straight JSON-RPC, `kb serve --status`, the
 * shim's own liveness probe. Those get exactly today's behaviour — the walk
 * from the daemon's own ancestry, which resolves to NULL.
 */
function readShimHello(socket, onReady) {
  let buffer = Buffer.alloc(0);

  const finish = (identity, rest) => {
    socket.off('data', onData);
    socket.pause();
    if (rest.length > 0) socket.unshift(rest);
    onReady(identity);
    socket.resume();
  };

  const onData = (chunk) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    const newline = buffer.indexOf(0x0a);
    if (newline === -1) {
      // Past the bound with no line break: whatever this client is sending,
      // it is not a hello. Hand back everything read so far — the transport
      // reads the rest of the line off the socket itself.
      if (buffer.length > MAX_HELLO_LINE_BYTES) finish(null, buffer);
      return;
    }
    const identity = parseHelloLine(buffer.subarray(0, newline).toString('utf8'));
    // Not a hello means the line belongs to the client: give the WHOLE
    // buffer back, newline included, not just what followed it.
    finish(identity, identity ? buffer.subarray(newline + 1) : buffer);
  };

  socket.on('data', onData);
}

/**
 * Binds the socket and serves MCP on it until close(). Foreground: whatever
 * supervises the process owns daemonization and restart.
 *
 * @param {object} [options]
 * @param {string} [options.socketPath]
 * @param {string} [options.controlSocketPath] Second socket serving the
 *   line-delimited JSON hook-op protocol (prompt-hint, trigger-hook,
 *   wakeup-hook) — see src/cli/hook-io.js's callDaemonOp for the client side.
 * @param {(context: { era: string, wrapHandler: Function }) => import('@modelcontextprotocol/server').McpServer} [options.serverFactory]
 *   Builds the instance for one connection. Defaults to the shared KB factory.
 *   Handlers passed through `wrapHandler` are the ones the drain waits on.
 * @param {(error: Error) => void} [options.onError]
 */
export async function startDaemon({
  socketPath = DAEMON_SOCKET_PATH,
  controlSocketPath = CONTROL_SOCKET_PATH,
  serverFactory,
  onError = (err) => console.error(`[kb serve] ${err.message}`),
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
} = {}) {
  // Validated for both before binding either — a daemon must not half-start.
  await claimSocket(socketPath);
  await claimSocket(controlSocketPath);

  let inFlight = 0;
  const track = (handler) => async (...args) => {
    inFlight++;
    try {
      return await handler(...args);
    } finally {
      inFlight--;
    }
  };
  // Runs the handler under this connection's identity, so resolveSessionId /
  // resolveAgent inside it answer for the harness that dialed rather than for
  // the daemon's own launchd ancestry. Per connection, not per process: two
  // sessions calling concurrently each see their own.
  const bindIdentity = (identity, handler) =>
    (identity ? (...args) => callIdentity.run(identity, () => handler(...args)) : handler);
  // The SDK calls the factory with { era }; the daemon adds the wrapper whose
  // counter the shutdown drain waits on, so a call in flight is never cut off.
  const buildServer = (identity) => (context) => (serverFactory ?? createKbServer)({
    ...context,
    wrapHandler: (handler) => track(bindIdentity(identity, handler)),
  });

  const connections = new Set();
  const server = createServer((socket) => {
    // Keeps a peer disconnect from throwing as an unhandled 'error'. The error
    // is not lost: the transport below listens on the same socket and reports
    // it through onerror.
    socket.on('error', () => {});

    // Registered before the hello is read, not after: a client that connects
    // and then goes silent still has to be tracked, or close() leaves its
    // socket open and the daemon never finishes shutting down.
    const entry = { handle: null, socket };
    connections.add(entry);
    socket.once('close', () => {
      connections.delete(entry);
      entry.handle?.close().catch(onError);
    });

    readShimHello(socket, (identity) => {
      entry.handle = serveStdio(buildServer(identity), {
        transport: new StdioServerTransport(socket, socket),
        onerror: onError,
      });
    });
  });

  // One request per connection: read up to the first newline, dispatch,
  // answer, close. A client that never sends one is bounded by
  // MAX_CONTROL_LINE_BYTES rather than growing this buffer forever.
  //
  // A compute core's OWN errors (a real hint/briefing/trigger failure) are
  // already caught and filed by recordHookFailure inside it — this catch is
  // the backstop for what's left (unknown op, a malformed request line, a
  // bug in the dispatch itself), and onError is what makes that backstop
  // visible server-side instead of only ever reaching the client that's
  // about to fall back and forget it happened.
  //
  // Trust model: this socket is 0600, same-user only (bindSocket). The
  // `session` a caller supplies in payload is taken on faith — there is no
  // narrower boundary to check it against, because a caller who can reach
  // this socket at all already has direct read/write access to kb.db under
  // the same user account. The filesystem permission is the whole gate.
  function serveControlConnection(socket) {
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffer = '';
    let handled = false;
    socket.on('data', async (chunk) => {
      if (handled) return;
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) {
        if (Buffer.byteLength(buffer) > MAX_CONTROL_LINE_BYTES) {
          handled = true;
          socket.destroy();
        }
        return;
      }
      handled = true;
      let response;
      try {
        const { op, payload } = JSON.parse(buffer.slice(0, newline));
        const handler = HOOK_OPS[op];
        if (!handler) throw new Error(`unknown control op "${op}"`);
        // HOOK_OPS handlers run in commit: false mode — { output, plan },
        // never a bare string. `plan` rides along unread by anything here;
        // only the client, once it has committed to delivering `output`,
        // knows it is safe to write.
        const result = await track(() => handler(payload))();
        response = { ok: true, output: result?.output ?? null, plan: result?.plan ?? null };
      } catch (err) {
        onError(err);
        response = { ok: false, error: err.message };
      }
      socket.end(`${JSON.stringify(response)}\n`);
    });
  }

  const controlConnections = new Set();
  const controlServer = createServer((socket) => {
    controlConnections.add(socket);
    socket.once('close', () => controlConnections.delete(socket));
    serveControlConnection(socket);
  });

  await bindSocket(server, socketPath);
  server.on('error', onError);
  try {
    await bindSocket(controlServer, controlSocketPath);
  } catch (err) {
    // Must not leave the main socket bound behind a daemon that never
    // finished starting — no process would ever close it. server.close()
    // removes the socket file itself (proven by "removes its socket on
    // close" below); nothing left to unlink by hand.
    await new Promise((resolve) => server.close(resolve));
    throw err;
  }
  controlServer.on('error', onError);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const stopped = new Promise((resolve) => server.close(resolve));
    const controlStopped = new Promise((resolve) => controlServer.close(resolve));
    if (!await drain(() => inFlight > 0, drainTimeoutMs)) {
      onError(new Error(`Shut down with ${inFlight} tool call(s) still in flight after ${drainTimeoutMs}ms`));
    }
    for (const entry of [...connections]) {
      // serveStdio's transport only detaches its stream listeners on close —
      // the socket is ours to take down. handle is null for a connection that
      // never got past the hello read; the socket still has to go.
      await entry.handle?.close().catch(onError);
      entry.socket.destroy();
    }
    connections.clear();
    for (const socket of [...controlConnections]) socket.destroy();
    controlConnections.clear();
    await stopped;
    await controlStopped;
  };

  return {
    socketPath,
    controlSocketPath,
    close,
    connectionCount: () => connections.size,
    inFlightCount: () => inFlight,
  };
}
