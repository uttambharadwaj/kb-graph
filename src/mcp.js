import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { registerBusResources } from './bus/resources.js';
import { restartOnSourceChange } from './restart-on-change.js';
import { getToolDefinitions } from './tools.js';

export async function start() {
  const server = new McpServer({
    name: 'knowledge-base',
    version: '1.0.0',
  });

  let inFlight = 0;
  const track = (handler) => async (...args) => {
    inFlight++;
    try {
      return await handler(...args);
    } finally {
      inFlight--;
    }
  };

  // Register all tools from shared definitions (already metered — see tools.js).
  for (const tool of getToolDefinitions()) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, track(tool.handler));
  }
  registerBusResources(server);

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
  start().catch((err) => {
    console.error('MCP server failed to start:', err);
    process.exit(1);
  });
}
