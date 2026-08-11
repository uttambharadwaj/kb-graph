import { readFlagValue } from './flags.js';
import { connectDaemonClient } from '../daemon-client.js';
import { DAEMON_SOCKET_PATH, probeSocket, startDaemon } from '../daemon.js';

function socketPathFrom(args) {
  return readFlagValue(args, '--socket') || DAEMON_SOCKET_PATH;
}

/**
 * Exit 0 when a daemon answers MCP on the socket, 1 otherwise, so a supervisor
 * can use this as a health check. This is a real MCP round trip (initialize
 * plus tools/list), not a bare connect — it reports a daemon that holds the
 * socket but cannot serve as down.
 */
async function printStatus(socketPath) {
  const occupancy = await probeSocket(socketPath);
  if (occupancy !== 'live') {
    // A refused connect cannot tell a dead daemon from one that has stopped
    // accepting while it drains, so the message must not claim either.
    const detail = {
      absent: 'no socket',
      stale: 'not accepting connections — stopped, or draining a shutdown',
      occupied: 'something that is not a socket is in the way',
      unknown: 'socket present but unreachable',
    };
    console.log(`kb daemon: down (${detail[occupancy]}) — ${socketPath}`);
    process.exit(1);
  }

  let client;
  try {
    client = await connectDaemonClient(socketPath);
    const info = client.getServerVersion();
    const { tools } = await client.listTools();
    console.log(`kb daemon: up — ${socketPath} (${info?.name} ${info?.version}, ${tools.length} tools)`);
  } catch (err) {
    // Something holds the socket but does not speak MCP: neither up nor safe
    // to clear. Say so rather than reporting either.
    console.log(`kb daemon: listening but not answering MCP (${err.message}) — ${socketPath}`);
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
