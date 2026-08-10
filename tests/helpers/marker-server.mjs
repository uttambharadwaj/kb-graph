// A stand-in for src/mcp.js used by tests/mcp-supervisor.test.js: a real
// McpServer whose answers identify the process that gave them. MARKER comes
// from a module in the watched directory, so it is pinned per process the same
// way the real server's module graph is — a new value can only be reported by a
// process that started after the file changed.
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { existsSync } from 'fs';
import { pathToFileURL } from 'url';
import { z } from 'zod';

const { MARKER } = await import(pathToFileURL(process.env.KB_TEST_MARKER).href);
const text = (t) => ({ content: [{ type: 'text', text: t }] });

const server = new McpServer({ name: 'marker', version: '1.0.0' });

// The SDK answers requests from a process that was never initialized, so a
// swapped-in child cannot be asked whether the handshake reached it — it has to
// report that itself. `client` is unset unless initialize was replayed;
// `early` means a tool call arrived before notifications/initialized did.
let ready = false;
server.server.oninitialized = () => { ready = true; };

server.registerTool('whoami', { description: 'pid, marker, and what the handshake left behind', inputSchema: z.object({}) }, async () =>
  text(`${process.pid}:${MARKER}:${server.server.getClientVersion()?.name ?? 'none'}:${ready ? 'ready' : 'early'}`));

server.registerTool('slow', { description: 'blocks until the flag file appears', inputSchema: z.object({}) }, async () => {
  while (!existsSync(process.env.KB_TEST_FLAG)) await new Promise((r) => setTimeout(r, 10));
  return text(`done:${MARKER}`);
});

server.registerTool('boom', { description: 'dies mid-call without answering', inputSchema: z.object({}) }, async () => process.exit(7));

process.stdin.on('end', () => process.exit(0));
await server.connect(new StdioServerTransport());
