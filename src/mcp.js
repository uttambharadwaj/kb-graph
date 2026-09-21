import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createKbServer } from './mcp-factory.js';
import { callIdentity } from './retrieval.js';

export async function start({ identity = null } = {}) {
  const wrapHandler = identity
    ? handler => (...args) => callIdentity.run(identity, () => handler(...args))
    : undefined;
  const server = createKbServer({ wrapHandler });

  // Nothing in the SDK reacts to stdin closing, so a disconnected direct or
  // fallback server would otherwise idle forever holding the database open.
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
