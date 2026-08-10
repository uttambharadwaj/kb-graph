import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp.js');

// Captured by hand-rolled JSON-RPC against public/main (v1 SDK, pre-migration)
// on a fresh temp KB, before any v2 change landed. This is the byte-for-byte
// contract the SDK bump must not move: v1 always sets listChanged: true on
// both capabilities once any tool/resource is registered (see
// node_modules/@modelcontextprotocol/sdk@1 server/mcp.js), which this server
// always does — so this is not a special case, it is what v1 -> v2 must
// reproduce with no protocol-era opt-in.
const REQUEST_PROTOCOL_VERSION = '2025-06-18';
const V1_BASELINE = {
  protocolVersion: '2025-06-18',
  capabilities: {
    tools: { listChanged: true },
    resources: { listChanged: true },
  },
  serverInfo: { name: 'knowledge-base', version: '1.0.0' },
};

// Hand-written JSON-RPC rather than the v2 SDK Client: a v2 client defaults to
// requesting a newer 2025-era protocolVersion than v1's LATEST_PROTOCOL_VERSION,
// which the server correctly echoes back — a difference in what the test asks
// for, not in what the server does. Sending the exact request the baseline was
// captured with is what actually proves the server's behavior didn't move.
function probe() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, KB_SUPERVISED: '1' },
    });

    let buf = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('timed out waiting for initialize response'));
    }, 10_000);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id === 1) {
          clearTimeout(timer);
          child.stdin.end();
          child.kill();
          resolve(msg.result);
          return;
        }
      }
    });
    child.on('error', reject);

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: REQUEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'wire-identity-test', version: '1.0.0' },
      },
    })}\n`);
  });
}

describe('mcp wire identity (v1 -> v2 SDK bump)', () => {
  it('produces the same initialize response as the v1 server', async () => {
    const result = await probe();
    assert.deepStrictEqual(result, V1_BASELINE, 'v2 server must speak byte-identical 2025-era protocol to v1');
  });
});
