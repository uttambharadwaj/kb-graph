import { once } from 'node:events';

const { start } = await import('../../src/server.js');
const server = await start({
  portOverride: 0,
});
if (!server.listening) await once(server, 'listening');
process.send?.(server.address());

process.on('message', message => {
  if (message !== 'close') return;
  server.close(() => process.exit(0));
});
