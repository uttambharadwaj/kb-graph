import { readFlagValue } from './flags.js';
import { connectDaemonClient } from '../daemon-client.js';
import { DAEMON_SOCKET_PATH, probeSocketDetailed, startDaemon } from '../daemon.js';
import { formatShimPathSummary, summarizeShimPaths } from '../shim-path-meter.js';
import { formatFallbackToolSummary, summarizeFallbackTools } from '../fallback-tool-meter.js';
import { formatExtractionSummary, summarizeExtractions } from '../extract-meter.js';
import { formatResidentProcessSummary, inspectResidentProcesses } from '../resident-census.js';
import {
  DEFAULT_RESTART_MARKER_REFRESH_MS,
  consumeDaemonRestart,
  markDaemonRestart,
  snapshotDaemonRestart,
} from '../daemon-restart.js';

const TRUE_VALUES = new Set(['1', 'true', 'yes']);

function socketPathFrom(args) {
  return readFlagValue(args, '--socket') || DAEMON_SOCKET_PATH;
}

function printDiagnostics() {
  console.log(formatResidentProcessSummary(inspectResidentProcesses()));
  console.log(formatShimPathSummary(summarizeShimPaths()));
  console.log(formatFallbackToolSummary(summarizeFallbackTools()));
  console.log(formatExtractionSummary(summarizeExtractions()));
}

/**
 * Exit 0 when a daemon answers MCP on the socket, 1 otherwise, so a supervisor
 * can use this as a health check. This is a real MCP round trip (initialize
 * plus tools/list), not a bare connect — it reports a daemon that holds the
 * socket but cannot serve as down.
 */
async function printStatus(socketPath) {
  const probe = await probeSocketDetailed(socketPath);
  const occupancy = probe.state;
  if (occupancy !== 'live') {
    // A refused connect cannot tell a dead daemon from one that has stopped
    // accepting while it drains, so the message must not claim either.
    const detail = {
      absent: 'no socket',
      stale: 'not accepting connections — stopped, or draining a shutdown',
      occupied: 'something that is not a socket is in the way',
      unknown: probe.reason === 'timeout'
        ? 'socket present but probe timed out'
        : `socket present but local probe failed${probe.errorCode ? ` (${probe.errorCode})` : ''}`,
    };
    console.log(`kb daemon: down (${detail[occupancy]}) — ${socketPath}`);
    printDiagnostics();
    process.exit(1);
  }

  let client;
  try {
    client = await connectDaemonClient(socketPath);
    const info = client.getServerVersion();
    const { tools } = await client.listTools();
    console.log(`kb daemon: up — ${socketPath} (${info?.name} ${info?.version}, ${tools.length} tools)`);
    printDiagnostics();
  } catch (err) {
    // Something holds the socket but does not speak MCP: neither up nor safe
    // to clear. Say so rather than reporting either.
    console.log(`kb daemon: listening but not answering MCP (${err.message}) — ${socketPath}`);
    printDiagnostics();
    process.exit(1);
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function startReplacementDaemon(
  socketPath,
  {
    start = path => startDaemon({ socketPath: path }),
    warn = message => console.error(message),
  } = {},
) {
  const markerSnapshot = snapshotDaemonRestart(socketPath);
  const daemon = await start(socketPath);
  if (markerSnapshot && !consumeDaemonRestart(markerSnapshot)) {
    warn('[kb serve] restart marker changed or could not be cleaned; preserving it for retry');
  }
  return daemon;
}

export function isManagedRestartEnvironment(env = process.env) {
  if (env.KB_SERVE_RESTART_ON_SIGNAL !== undefined) {
    return TRUE_VALUES.has(env.KB_SERVE_RESTART_ON_SIGNAL.toLowerCase());
  }
  const launchdService = env.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME !== '0';
  return Boolean(launchdService || env.INVOCATION_ID);
}

function markRestartSafely(markRestart, socketPath) {
  try {
    return markRestart(socketPath);
  } catch {
    return false;
  }
}

export function registerServeShutdown(
  daemon,
  socketPath,
  {
    signalSource = process,
    markRestart = markDaemonRestart,
    log = message => console.error(message),
    setExitCode = code => { process.exitCode = code; },
    managedRestart = isManagedRestartEnvironment(),
    refreshIntervalMs = DEFAULT_RESTART_MARKER_REFRESH_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = {},
) {
  let shuttingDown = false;
  const onSignal = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[kb serve] ${signal} — draining`);
    let refreshTimer = null;
    if (managedRestart && !markRestartSafely(markRestart, socketPath)) {
      log('[kb serve] could not mark the planned restart; new sessions will use the ordinary fallback deadline');
    }
    if (managedRestart) {
      refreshTimer = setIntervalFn(
        () => markRestartSafely(markRestart, socketPath),
        refreshIntervalMs,
      );
      refreshTimer.unref?.();
    }
    const finish = (code) => {
      if (refreshTimer) clearIntervalFn(refreshTimer);
      if (managedRestart && !markRestartSafely(markRestart, socketPath)) {
        log('[kb serve] could not refresh the restart marker after draining');
      }
      setExitCode(code);
    };
    daemon.close().then(
      // Do not force process.exit() here. The embedding runtime owns native
      // worker threads whose teardown races a forced V8 exit on macOS,
      // aborting with libc++ "mutex lock failed" after an otherwise-clean
      // drain. Once both sockets and every transport are closed, no JS
      // handles remain: setting the code lets Node unwind native resources
      // in their normal order and exit on its own.
      () => finish(0),
      (err) => {
        log(`[kb serve] shutdown failed: ${err.message}`);
        finish(1);
      },
    );
  };
  for (const signal of ['SIGTERM', 'SIGINT']) {
    signalSource.on(signal, () => onSignal(signal));
  }
}

export async function runServeCli(args) {
  const socketPath = socketPathFrom(args);
  if (args.includes('--status')) return printStatus(socketPath);

  const daemon = await startReplacementDaemon(socketPath);
  console.error(`[kb serve] listening on ${socketPath}`);
  registerServeShutdown(daemon, socketPath);
}
