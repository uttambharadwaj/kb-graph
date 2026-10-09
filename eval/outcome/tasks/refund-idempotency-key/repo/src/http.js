// Thin client for the payments gateway. The transport is swappable so tests
// never touch the network.
let transport = async () => {
  throw new Error('no transport configured');
};

export function setTransport(fn) {
  transport = fn;
}

export async function request(path, { method = 'GET', body, headers = {} } = {}) {
  return transport({ method, path, body, headers });
}
