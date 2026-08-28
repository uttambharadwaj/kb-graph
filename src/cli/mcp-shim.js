// Per-session stdio shim: connects this process's stdio to the resident
// `kb serve` daemon over its unix socket. It relays newline-delimited JSON-RPC
// while retaining only the MCP initialization handshake. That bounded state
// is enough to reconnect an already-initialized client when launchd replaces
// the daemon without closing the client's stdio transport or tool registry.
//
// Each daemon connection starts with one shim hello line
// (src/shim-hello.js): which harness this session runs under, which only a
// child of that harness can answer. Ordinary client/server traffic is relayed;
// only restart recovery originates handshake replay and cache invalidations.
//
// If the daemon is unreachable or unresponsive at startup, this falls back
// to the existing in-process supervisor path (`kb mcp`) so a session never
// loses its KB tools because the daemon happens to be down. Once connected,
// a daemon loss keeps this stdio process alive, fails any interrupted calls
// explicitly, and retries the socket until the resident service is back.
import { connect } from 'net';
import { readFlagValue } from './flags.js';
import { DAEMON_SOCKET_PATH } from '../daemon.js';
import { resolveHarnessAncestry } from '../process-ancestry.js';
import { encodeHello } from '../shim-hello.js';
import { recordShimPath, recordShimRecovery } from '../shim-path-meter.js';

const DEFAULT_PROBE_TIMEOUT_MS = 2000;
const DEFAULT_RECONNECT_DELAY_MS = 100;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 2000;
const MAX_JSON_RPC_LINE_BYTES = 10 * 1024 * 1024;
const SERVER_ERROR = -32000;
const RECONNECTING_MESSAGE = 'knowledge-base daemon is reconnecting; retry the request';
// Overridable so a test exercising a wedged daemon isn't stuck waiting out a
// real-world deadline. Exported so that override is checkable directly
// rather than by timing a real fallback against wall-clock, which is flaky
// under a loaded test runner.
export const PROBE_TIMEOUT_MS = Number(process.env.KB_SHIM_PROBE_TIMEOUT_MS) || DEFAULT_PROBE_TIMEOUT_MS;
export const RECONNECT_DELAY_MS = Number(process.env.KB_SHIM_RECONNECT_DELAY_MS) || DEFAULT_RECONNECT_DELAY_MS;
export const RECONNECT_MAX_DELAY_MS = Number(process.env.KB_SHIM_RECONNECT_MAX_DELAY_MS)
  || DEFAULT_RECONNECT_MAX_DELAY_MS;

function socketPathFrom(args) {
  return readFlagValue(args, '--socket') || DAEMON_SOCKET_PATH;
}

// Hand-rolled rather than adding an SDK client dependency: the probe only
// needs one initialize request and treats any response bytes as liveness.
function probeInitializeLine() {
  return `${JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'kb-mcp-shim-probe', version: '1.0.0' },
    },
  })}\n`;
}

/**
 * Proves the daemon is not just listening but actually answering, before
 * committing the session to it. connect() alone is not enough: a daemon
 * whose event loop is blocked or whose accept handler is stuck completes
 * connect() and then never sends a byte, which without this would hang the
 * session tool-less instead of falling back.
 *
 * Costs one extra per-connection server instance on the daemon side — the
 * same cost `kb serve --status` already pays every time it runs (see
 * daemon.test.js / #96), proven cheap there.
 *
 * @returns {Promise<'alive'|'unresponsive'|'unreachable'>}
 */
function probeDaemonAlive(socketPath, timeoutMs) {
  return new Promise((resolve) => {
    const probe = connect(socketPath);
    let settled = false;
    let connected = false;
    const finish = (state, errorCode = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.destroy();
      resolve({ state, errorCode });
    };
    const timer = setTimeout(() => finish(connected ? 'unresponsive' : 'unreachable', 'TIMEOUT'), timeoutMs);
    probe.once('connect', () => {
      connected = true;
      probe.write(probeInitializeLine());
    });
    // Liveness only — any bytes at all count. Parsing the response is the
    // real connection's job.
    probe.once('data', () => finish('alive'));
    probe.once('error', (err) => finish('unreachable', err.code ?? null));
  });
}

const FALLBACK_REASONS = {
  unreachable: 'daemon unreachable',
  unresponsive: 'daemon unresponsive',
};

async function serveInProcess(reason, { startedAt, metricReason = reason, errorCode = null }) {
  recordShimPath({
    path: 'fallback',
    reason: metricReason,
    durationMs: Date.now() - startedAt,
    errorCode,
  });
  console.error(`kb mcp-shim: ${FALLBACK_REASONS[reason]}, serving in-process`);
  const { superviseMcpServer } = await import('../mcp-supervisor.js');
  // Owns process.stdin/stdout and its own exit handling from here on, same
  // as running `kb mcp` directly.
  superviseMcpServer();
}

// Exits the process once anything queued on stdout has actually gone out —
// stdout is a pipe here, so process.exit() can otherwise cut off the last
// bytes the socket handed it. This only drains bytes the socket already
// handed to us; it says nothing about daemon-side work still in flight for
// the request that triggered the exit. That is by design: stdin closing is
// the shutdown signal here, the same as `kb mcp`'s child being killed on its
// own stdin EOF, not a request to wait for an answer.
function exitAfterFlush(code) {
  if (process.stdout.writableLength > 0) {
    process.stdout.once('drain', () => process.exit(code));
  } else {
    process.exit(code);
  }
}

const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

const isRequest = (msg) => msg?.id !== undefined && msg?.method !== undefined;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function onLines(stream, handle, onOverflow) {
  let tail = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const lines = (tail + chunk).split('\n');
    tail = lines.pop();
    if (Buffer.byteLength(tail) > MAX_JSON_RPC_LINE_BYTES) return onOverflow();
    for (const line of lines) {
      if (Buffer.byteLength(line) > MAX_JSON_RPC_LINE_BYTES) return onOverflow();
      if (line.trim()) handle(line.replace(/\r$/, ''));
    }
  });
}

function openSocket(socketPath, timeoutMs) {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    // Covers the few microtasks between resolving a successful connect and
    // replayHandshake/attachSocket installing the listener that owns errors.
    socket.on('error', () => {});
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
      resolve(result);
    };
    const onConnect = () => finish({ socket, errorCode: null });
    const onError = (err) => {
      socket.destroy();
      finish({ socket: null, errorCode: err.code ?? null });
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish({ socket: null, errorCode: 'TIMEOUT' });
    }, timeoutMs);
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

/**
 * Replays only the MCP initialization state a fresh server instance requires.
 * The duplicate initialize response is consumed here because the client has
 * already accepted the original daemon's response. Everything after that is
 * relayed normally by attachSocket().
 */
function replayHandshake(socket, handshake, identity, timeoutMs) {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (ok, errorCode = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (!ok) socket.destroy();
      resolve({ ok, errorCode });
    };
    const onError = (err) => finish(false, err.code ?? null);
    const onClose = () => finish(false, 'CLOSED');
    const onData = (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_JSON_RPC_LINE_BYTES) return finish(false, 'OVERSIZE');
      while (true) {
        const newline = buffer.indexOf(0x0a);
        if (newline === -1) return;
        const line = buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '');
        buffer = buffer.subarray(newline + 1);
        const msg = parse(line);
        if (msg?.id !== handshake.id || msg?.method !== undefined) {
          // No current KB server emits traffic before initialization finishes,
          // but preserving it is safer than silently changing that contract.
          process.stdout.write(`${line}\n`);
          continue;
        }
        if (msg.error) return finish(false, `INIT_${msg.error.code ?? 'ERROR'}`);

        socket.pause();
        if (buffer.length > 0) socket.unshift(buffer);
        socket.write(`${handshake.initialized}\n`);
        finish(true);
        return;
      }
    };
    const timer = setTimeout(() => finish(false, 'TIMEOUT'), timeoutMs);
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.write(encodeHello(identity));
    socket.write(`${handshake.initialize}\n`);
  });
}

function relayThroughDaemon(initialSocket, { socketPath, identity }) {
  let stdinEnded = false;
  let exiting = false;
  let socket = null;
  let handshake = null;
  let recovery = null;
  let recoverySequence = 0;
  const pending = new Set();
  const warned = new Set();

  const exitOnce = (code) => {
    if (exiting) return;
    exiting = true;
    if (recovery) {
      recordShimRecovery({
        recoveryId: recovery.id,
        outcome: 'abandoned',
        attempts: recovery.attempts,
        durationMs: Date.now() - recovery.startedAt,
        errorCode: recovery.lastErrorCode,
      });
      recovery = null;
    }
    exitAfterFlush(code);
  };

  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: SERVER_ERROR, message } });
  const warnOnce = (key, message) => {
    if (warned.has(key)) return;
    warned.add(key);
    console.error(`kb mcp-shim: ${message}`);
  };
  const failPending = (message) => {
    for (const id of pending) fail(id, message);
    pending.clear();
  };

  const fromDaemon = (line) => {
    const msg = parse(line);
    if (!msg) {
      warnOnce('non-json', `dropped non-JSON daemon output: ${line.slice(0, 120)}`);
      return;
    }
    if (isRequest(msg)) {
      warnOnce('server-request', 'the daemon sent a request to the client; its id cannot survive a restart');
    }
    if (msg.id !== undefined && msg.method === undefined) pending.delete(msg.id);
    process.stdout.write(`${line}\n`);
  };

  const attachSocket = (connected) => {
    socket = connected;
    onLines(
      connected,
      fromDaemon,
      () => {
        console.error('kb mcp-shim: daemon response exceeded the JSON-RPC line limit');
        connected.destroy();
      },
    );
    connected.once('error', (err) => {
      if (connected === socket) console.error(`kb mcp-shim: daemon connection error: ${err.message}`);
    });
    connected.once('close', () => {
      if (connected !== socket) return;
      socket = null;
      if (stdinEnded) return exitOnce(0);
      if (!handshake?.initialized) {
        console.error('kb mcp-shim: daemon connection closed before initialization could be preserved');
        return exitOnce(1);
      }
      failPending('knowledge-base daemon restarted during the request; retry the request');
      console.error('kb mcp-shim: daemon connection closed unexpectedly; reconnecting');
      void recover();
    });
    connected.resume();
  };

  const recover = async () => {
    if (recovery || stdinEnded || exiting) return;
    recovery = {
      id: `${process.pid}-${Date.now()}-${++recoverySequence}`,
      startedAt: Date.now(),
      attempts: 0,
      lastErrorCode: null,
    };
    recordShimRecovery({
      recoveryId: recovery.id,
      outcome: 'started',
      attempts: 0,
      durationMs: 0,
    });

    while (recovery && !stdinEnded && !exiting) {
      recovery.attempts++;
      const opened = await openSocket(socketPath, PROBE_TIMEOUT_MS);
      recovery.lastErrorCode = opened.errorCode;
      if (opened.socket) {
        const replayed = await replayHandshake(opened.socket, handshake, identity, PROBE_TIMEOUT_MS);
        recovery.lastErrorCode = replayed.errorCode;
        if (replayed.ok && recovery && !stdinEnded && !exiting) {
          const completed = recovery;
          recovery = null;
          attachSocket(opened.socket);
          recordShimRecovery({
            recoveryId: completed.id,
            outcome: 'restored',
            attempts: completed.attempts,
            durationMs: Date.now() - completed.startedAt,
            errorCode: completed.lastErrorCode,
          });
          console.error(
            `kb mcp-shim: daemon connection restored after ${completed.attempts} attempt(s) in ${Date.now() - completed.startedAt}ms`,
          );
          send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
          send({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' });
          return;
        }
      }
      const delayMs = Math.min(
        RECONNECT_DELAY_MS * (2 ** Math.min(recovery.attempts - 1, 10)),
        RECONNECT_MAX_DELAY_MS,
      );
      await sleep(delayMs);
    }
  };

  const fromClient = (line) => {
    const msg = parse(line);
    if (msg?.method === 'initialize') handshake = { initialize: line, id: msg.id, initialized: null };
    else if (msg?.method === 'notifications/initialized' && handshake) handshake.initialized = line;
    else if (msg?.method === 'notifications/cancelled') pending.delete(msg.params?.requestId);
    else if (msg?.method === 'logging/setLevel' || msg?.method === 'resources/subscribe') {
      warnOnce(msg.method, `${msg.method} does not survive a daemon restart`);
    }

    if (!socket) {
      if (isRequest(msg)) fail(msg.id, RECONNECTING_MESSAGE);
      return;
    }
    if (isRequest(msg)) pending.add(msg.id);
    socket.write(`${line}\n`);
  };

  onLines(process.stdin, fromClient, () => {
    console.error('kb mcp-shim: client request exceeded the JSON-RPC line limit');
    socket?.destroy();
    exitOnce(1);
  });

  attachSocket(initialSocket);

  process.stdin.on('end', () => {
    stdinEnded = true;
    if (socket) socket.end();
    else exitOnce(0);
  });

  const onSignal = () => {
    stdinEnded = true;
    socket?.destroy();
    exitOnce(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, onSignal);
}

export async function runMcpShimCli(args) {
  const startedAt = Date.now();
  const socketPath = socketPathFrom(args);

  const liveness = await probeDaemonAlive(socketPath, PROBE_TIMEOUT_MS);
  if (liveness.state !== 'alive') {
    return serveInProcess(liveness.state, { startedAt, errorCode: liveness.errorCode });
  }

  // The real connect is bounded too. The liveness probe and this connection
  // are separate by design because the probe's synthetic initialize must
  // never become part of the client's session.
  const connection = await openSocket(socketPath, PROBE_TIMEOUT_MS);
  if (!connection.socket) {
    // The probe just proved the daemon alive; a connect failing this soon
    // after means it died in the gap above.
    return serveInProcess('unreachable', {
      startedAt,
      metricReason: 'connect_race',
      errorCode: connection.errorCode,
    });
  }

  // Resolve identity once, then send it ahead of every daemon connection.
  // This process is a child of the harness; the daemon is a child of launchd,
  // so the hello is the only way a retrieval logged on the connection can be
  // attributed at all. One `ps` walk per session, not per call or reconnect —
  // the ancestry of a live process cannot change.
  //
  // Not gated on a daemon version. An older daemon feeds this line straight
  // to the SDK's StdioServerTransport, whose ReadBuffer.readMessage rejects
  // it at JSONRPCMessageSchema.parse; processReadBuffer catches that, reports
  // it through onerror (a line in the daemon's own log) and keeps reading the
  // next message. Nothing is written back to the client and the connection
  // stays open — verified against @modelcontextprotocol/server 2.0.0 in
  // node_modules, pinned by tests/shim-hello.test.js.
  const identity = resolveHarnessAncestry();
  recordShimPath({
    path: 'daemon',
    reason: 'probe_alive',
    durationMs: Date.now() - startedAt,
  });
  const socket = connection.socket;
  socket.write(encodeHello(identity));

  relayThroughDaemon(socket, { socketPath, identity });
}
