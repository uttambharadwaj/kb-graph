import { createServer } from 'node:net';

/**
 * A daemon that decides immediately but is slow to answer — stands in for a
 * real `kb serve` whose compute is fast but whose response is delayed by
 * something else (event-loop backlog, network lag) long enough that a
 * client's own deadline fires first. Deliberately splits "decide" from
 * "answer": `buildResponse(op, payload)` runs SYNCHRONOUSLY as soon as the
 * request line is parsed — any write it makes (i.e. a compute core called
 * with commit: true, simulating the pre-fix daemon) happens now, before the
 * client's deadline — and only the already-computed response's bytes are
 * held back by `delayMs`. A helper that delayed the compute itself would
 * hide exactly the bug this file exists to catch: with commit: true, the
 * marker write happens whether or not anyone ever hears about it.
 */
export function startSlowDaemon(socketPath, { delayMs, buildResponse }) {
  const server = createServer((socket) => {
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const { op, payload } = JSON.parse(buffer.slice(0, newline));
      const response = buildResponse(op, payload);
      setTimeout(() => {
        // The client's own deadline has long since fired and destroyed its
        // end — writing to a torn-down socket must not throw here.
        try {
          socket.end(`${JSON.stringify(response)}\n`);
        } catch {
          // swallow — this is the discarded-response path the test exists to prove is safe
        }
      }, delayMs);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve({ close: () => new Promise((res) => server.close(res)) });
    });
  });
}
