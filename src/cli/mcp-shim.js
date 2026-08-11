// Per-session stdio shim: connects this process's stdio to the resident
// `kb serve` daemon over its unix socket and byte-forwards in both
// directions. No JSON-RPC parsing here — the daemon negotiates the protocol
// era per connection, and a transparent pipe is what lets server-initiated
// notifications flow through unmodified.
//
// If the daemon is unreachable at startup, this falls back to the existing
// in-process supervisor path (`kb mcp`) so a session never loses its KB
// tools because the daemon happens to be down. Once connected to the daemon,
// there is no fallback: a mid-session daemon death ends the connection, same
// as a stdio server dying today, and the client sees a closed transport.
import { connect } from 'net';
import { readFlagValue } from './flags.js';
import { DAEMON_SOCKET_PATH } from '../daemon.js';

function socketPathFrom(args) {
  return readFlagValue(args, '--socket') || DAEMON_SOCKET_PATH;
}

async function serveInProcess() {
  console.error('kb mcp-shim: daemon unreachable, serving in-process');
  const { superviseMcpServer } = await import('../mcp-supervisor.js');
  // Owns process.stdin/stdout and its own exit handling from here on, same
  // as running `kb mcp` directly.
  superviseMcpServer();
}

// Exits the process once anything queued on stdout has actually gone out —
// stdout is a pipe here, so process.exit() can otherwise cut off the last
// bytes the socket handed it.
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
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

export async function runMcpShimCli(args) {
  const socketPath = socketPathFrom(args);
  const socket = connect(socketPath);

  const connected = await new Promise((resolve) => {
    socket.once('connect', () => resolve(true));
    socket.once('error', () => resolve(false));
  });

  if (!connected) {
    socket.removeAllListeners();
    socket.destroy();
    return serveInProcess();
  }

  pipeThroughDaemon(socket);
}
