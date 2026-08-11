// The one place an MCP server instance is built. Every surface — stdio
// (src/mcp.js), the resident daemon (src/daemon.js), HTTP (src/mcp-http.js) —
// comes through here, so a tool cannot reach one client and not another
// because a second registration loop was never updated.
import { McpServer } from '@modelcontextprotocol/server';
import { registerBusResources } from './bus/resources.js';
import { getHttpToolDefinitions, getToolDefinitions } from './tools.js';

const SERVER_VERSION = '1.0.0';

// `tools` is a thunk, not an array: getToolDefinitions() builds fresh metered
// handlers per call, and the daemon builds one instance per connection.
export function createKbServer({
  name = 'knowledge-base',
  tools = getToolDefinitions,
  busResources = true,
  wrapHandler,
} = {}) {
  const server = new McpServer({ name, version: SERVER_VERSION });

  for (const tool of tools()) {
    const handler = wrapHandler ? wrapHandler(tool.handler) : tool.handler;
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, handler);
  }
  if (busResources) registerBusResources(server);

  return server;
}

// HTTP is a narrower surface: no admin-only tools, no bus resources, and it
// announces itself under its own name that remote clients already match on.
export function createHttpKbServer() {
  return createKbServer({
    name: 'knowledge-base-brain',
    tools: getHttpToolDefinitions,
    busResources: false,
  });
}
