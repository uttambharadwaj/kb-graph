// Per-session stdio shim: connects this process's stdio to the resident
// `kb serve` daemon over its unix socket and byte-forwards in both
// directions. No JSON-RPC parsing here — the daemon negotiates the protocol
// era per connection, and a transparent pipe is what lets server-initiated
// notifications flow through unmodified.
//
// If the daemon is unreachable or unresponsive at startup, this falls back
// to the existing in-process supervisor path (`kb mcp`) so a session never
// loses its KB tools because the daemon happens to be down. Once connected
// to the daemon, there is no fallback: a mid-session daemon death ends the
// connection, same as a stdio server dying today, and the client sees a
// closed transport.
import { connect } from 'net';
import { readFlagValue } from './flags.js';
import { DAEMON_SOCKET_PATH } from '../daemon.js';

const DEFAULT_PROBE_TIMEOUT_MS = 2000;
// Overridable so a test exercising a wedged daemon isn't stuck waiting out a
// real-world deadline. Exported so that override is checkable directly
// rather than by timing a real fallback against wall-clock, which is flaky
// under a loaded test runner.
export const PROBE_TIMEOUT_MS = Number(process.env.KB_SHIM_PROBE_TIMEOUT_MS) || DEFAULT_PROBE_TIMEOUT_MS;

function socketPathFrom(args) {
  return readFlagValue(args, '--socket') || DAEMON_SOCKET_PATH;
}

// Hand-rolled rather than the SDK client, same rationale as
// tests/mcp-wire-identity.test.js: this file must stay a dumb pipe with no
// client dependency, so the one request it ever originates is written by
// hand.
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
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(connected ? 'unresponsive' : 'unreachable'), timeoutMs);
    probe.once('connect', () => {
      connected = true;
      probe.write(probeInitializeLine());
    });
    // Liveness only — any bytes at all count. Parsing the response is the
    // real connection's job.
    probe.once('data', () => finish('alive'));
    probe.once('error', () => finish('unreachable'));
  });
}

const FALLBACK_REASONS = {
  unreachable: 'daemon unreachable',
  unresponsive: 'daemon unresponsive',
};

async function serveInProcess(reason) {
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

function pipeThroughDaemon(socket) {
  let stdinEnded = false;
  let exiting = false;

  const exitOnce = (code) => {
    if (exiting) return;
    exiting = true;
    exitAfterFlush(code);
  };

  // Default pipe behavior ends the destination when the source ends, which
  // is the half-close stdin EOF is supposed to produce here.
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);

  process.stdin.on('end', () => {
    stdinEnded = true;
  });

  // A close after we already saw stdin EOF is the clean end of the session.
  // A close we did not ask for is the daemon going away mid-session — that
  // is acceptable (matches what a client sees when any stdio server dies)
  // but must not be reported as success.
  socket.on('close', () => {
    if (!stdinEnded) console.error('kb mcp-shim: daemon connection closed unexpectedly');
    exitOnce(stdinEnded ? 0 : 1);
  });

  socket.on('error', (err) => {
    console.error(`kb mcp-shim: daemon connection error: ${err.message}`);
  });

  const onSignal = () => {
    socket.destroy();
    exitOnce(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, onSignal);
}

export async function runMcpShimCli(args) {
  const socketPath = socketPathFrom(args);

  const liveness = await probeDaemonAlive(socketPath, PROBE_TIMEOUT_MS);
  if (liveness !== 'alive') return serveInProcess(liveness);

  // Accepted residual: a daemon that wedges in the gap between the probe
  // above and this connect (a window measured in milliseconds) still hangs
  // the session. Closing it would mean giving the real pipe connection its
  // own first-response deadline, which needs buffering and replaying
  // whatever arrived before the deadline fired — exactly the stateful
  // parsing this file exists to avoid. The probe trades a residual race for
  // staying a dumb pipe.
  const socket = connect(socketPath);
  const connected = await new Promise((resolve) => {
    socket.once('connect', () => resolve(true));
    socket.once('error', () => resolve(false));
  });

  if (!connected) {
    // The probe just proved the daemon alive; a connect failing this soon
    // after means it died in the gap above.
    socket.removeAllListeners();
    socket.destroy();
    return serveInProcess('unreachable');
  }

  pipeThroughDaemon(socket);
}
