// Client for the internal ledger service. The transport is swappable so tests
// never touch the network.
let transport = async () => {
  throw new Error('no transport configured');
};

export function setTransport(fn) {
  transport = fn;
}

export async function get(path) {
  return transport({ method: 'GET', path });
}
