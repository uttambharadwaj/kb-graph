import { readFlagValue } from './flags.js';
import { connectDaemonClient } from '../daemon-client.js';
import { DAEMON_SOCKET_PATH, probeSocketDetailed, startDaemon } from '../daemon.js';
import { formatShimPathSummary, summarizeShimPaths } from '../shim-path-meter.js';
import { formatFallbackToolSummary, summarizeFallbackTools } from '../fallback-tool-meter.js';
import { formatExtractionSummary, summarizeExtractions } from '../extract-meter.js';
import { formatResidentProcessSummary, inspectResidentProcesses } from '../resident-census.js';

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

export async function runServeCli(args) {
  const socketPath = socketPathFrom(args);
  if (args.includes('--status')) return printStatus(socketPath);

  const daemon = await startDaemon({ socketPath });
  console.error(`[kb serve] listening on ${socketPath}`);

  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.error(`[kb serve] ${signal} — draining`);
      daemon.close().then(
        () => process.exit(0),
        (err) => {
          console.error(`[kb serve] shutdown failed: ${err.message}`);
          process.exit(1);
        },
      );
    });
  }
}
