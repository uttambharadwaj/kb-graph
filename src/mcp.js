import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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

  // Register all tools from shared definitions
  for (const tool of getToolDefinitions()) {
    server.tool(tool.name, tool.description, tool.schema, track(tool.handler));
  }
  registerBusResources(server);

  restartOnSourceChange({ isBusy: () => inFlight > 0 });

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
