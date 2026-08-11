import { createServer } from 'node:net';

/**
 * A daemon that accepts a connection and never answers anything on it —
 * stands in for a real daemon whose event loop is blocked or whose accept
 * handler is stuck, the failure mode src/cli/mcp-shim.js's liveness probe
 * exists to catch. Reads and discards whatever arrives so the sender never
 * blocks on a full write buffer.
 */
export function startWedgedDaemon(socketPath) {
  const server = createServer((socket) => {
    socket.on('error', () => {});
    socket.resume();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve({ close: () => new Promise((res) => server.close(res)) });
    });
  });
}
