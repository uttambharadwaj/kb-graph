import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createKbServer } from './mcp-factory.js';
import { restartOnSourceChange } from './restart-on-change.js';
import { readFlagValue } from './cli/flags.js';
import { AGENTS, resolveHarnessAncestry } from './process-ancestry.js';
import { callIdentity } from './retrieval.js';

export async function start({ agent = null } = {}) {
  let inFlight = 0;
  const explicitIdentity = agent ? { ...resolveHarnessAncestry(), agent } : null;
  const track = (handler) => async (...args) => {
    inFlight++;
    try {
      return explicitIdentity
        ? await callIdentity.run(explicitIdentity, () => handler(...args))
        : await handler(...args);
    } finally {
      inFlight--;
    }
  };

  const server = createKbServer({ wrapHandler: track });

  // Under a supervisor the parent owns reloading; watching here too would race
  // it into exiting out from under a connection the parent is keeping open.
  if (!process.env.KB_SUPERVISED) {
    restartOnSourceChange({ isBusy: () => inFlight > 0, onChange: () => process.exit(0) });
  }

  // Nothing in the SDK reacts to stdin closing, so a child whose supervisor was
  // killed outright would idle forever holding the database open.
  process.stdin.on('end', () => process.exit(0));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Allow direct execution
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^\//, ''));
if (isMain || process.argv[1]?.endsWith('mcp.js')) {
  const agent = readFlagValue(process.argv.slice(2), '--agent') ?? null;
  if (agent && !AGENTS.includes(agent)) {
    console.error(`MCP server failed to start: --agent must be one of: ${AGENTS.join(', ')}`);
    process.exit(1);
  }
  start({ agent }).catch((err) => {
    console.error('MCP server failed to start:', err);
    process.exit(1);
  });
}
