// Thin client for the payments gateway. The transport is swappable so tests
// never touch the network.
let transport = async () => {
  throw new Error('no transport configured');
};

export function setTransport(fn) {
  transport = fn;
}

const ATTEMPTS = 3;

export async function fetchJson(path, { method = 'GET', body } = {}) {
  let lastError;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      return await transport({ method, path, body });
    } catch (err) {
      if (err.code !== 'ETIMEDOUT') throw err;
      lastError = err;
    }
  }
  throw lastError;
}

export async function sendOnce(path, { method = 'POST', body } = {}) {
  return transport({ method, path, body });
}
