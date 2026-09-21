import { once } from 'node:events';
import { createServer } from 'node:net';

const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const { port } = reservation.address();
reservation.close();
await once(reservation, 'close');

process.env.KB_PORT = String(port);
const { start } = await import('../../src/server.js');
const server = await start();
if (!server.listening) await once(server, 'listening');
process.send?.(server.address());

process.on('message', message => {
  if (message !== 'close') return;
  server.close(() => process.exit(0));
});
