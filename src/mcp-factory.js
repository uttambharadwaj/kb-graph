// The one place an MCP server instance is built. Every surface — stdio
// (src/mcp.js), the resident daemon (src/daemon.js), HTTP (src/mcp-http.js) —
// comes through here, so a tool cannot reach one client and not another
// because a second registration loop was never updated.
import { McpServer } from '@modelcontextprotocol/server';
import { registerBusResources } from './bus/resources.js';
import { getHttpToolDefinitions, getToolDefinitions } from './tools.js';

const SERVER_VERSION = '1.0.0';

// Clients that auto-approve only read-annotated tools (Codex under
// approval_policy=never) deny every unannotated call. Writes stay unannotated
// so those clients still gate them.
const READ_ONLY_TOOLS = new Set([
  'kb_search', 'kb_search_smart', 'kb_context', 'kb_read', 'kb_list', 'kb_tunnels',
  'kb_fact_query', 'kb_fact_timeline', 'kb_check_duplicate', 'kb_supersede_candidates',
  'kb_wakeup', 'kb_vault_status', 'kb_safety_check', 'kb_classify', 'kb_extract',
  'bus_read', 'bus_status', 'bus_agents', 'bus_sessions', 'bus_deliveries',
]);

function toolAnnotations(name) {
  return READ_ONLY_TOOLS.has(name) ? { readOnlyHint: true, destructiveHint: false } : undefined;
}

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
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema, annotations: toolAnnotations(tool.name) },
      handler,
    );
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
