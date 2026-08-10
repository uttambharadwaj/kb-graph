import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp.js');

// Captured by hand-rolled JSON-RPC against public/main (v1 SDK, pre-migration)
// on a fresh temp KB, before any v2 change landed. This is the byte-for-byte
// contract the SDK bump must not move: v1's McpServer sets listChanged: true
// unconditionally on both capabilities once any tool/resource is registered,
// which this server always does — so this is not a special case, it is what
// v1 -> v2 must reproduce with no protocol-era opt-in.
const REQUEST_PROTOCOL_VERSION = '2025-06-18';
const V1_BASELINE = {
  protocolVersion: REQUEST_PROTOCOL_VERSION,
  capabilities: {
    tools: { listChanged: true },
    resources: { listChanged: true },
  },
  serverInfo: { name: 'knowledge-base', version: '1.0.0' },
};

// Captured against the migrated (v2) server. v1 emitted draft-07 JSON Schema
// for tool inputSchemas; v2's zod-to-JSON-Schema emitter always emits 2020-12
// instead. That dialect bump is inherent to the SDK's schema emitter, was
// reviewed and accepted as part of this migration, and is pinned here so any
// FUTURE drift on the most-hit tools/list entry is caught rather than waved
// through.
const KB_READ_TOOLS_LIST_ENTRY = {
  name: 'kb_read',
  description: 'Read a document in full, by ID — after kb_context or kb_search has told you which ID is worth the tokens. The response carries a `related` neighborhood, so this is also how you walk from one note to the ones it sits beside without running another search.',
  inputSchema: {
    type: 'object',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: {
      id: { type: 'number', description: 'Document ID' },
    },
    required: ['id'],
  },
};

// v1 rendered a raw zod issue array plus a "-32602" JSON-RPC-code-shaped
// prefix; v2 flattens it to one human-readable line. Same envelope (isError
// content block), same trigger, reviewed and accepted — this pins the
// envelope exactly and the message via a stable substring, so it catches an
// envelope regression without coupling the test to the SDK's exact zod prose.
const INVALID_ARG_MESSAGE_SUBSTRING = 'Invalid arguments for tool kb_read';

// Hand-written JSON-RPC rather than the v2 SDK Client: a v2 client defaults to
// requesting a newer 2025-era protocolVersion than v1's LATEST_PROTOCOL_VERSION,
// which the server correctly echoes back — a difference in what the test asks
// for, not in what the server does. Sending the exact request the baseline was
// captured with is what actually proves the server's behavior didn't move.
function probeInitialize() {
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

/**
 * Spawns src/mcp.js and drives a JSON-RPC session over its stdio: each call()
 * sends one request and resolves with its response. Same rationale as
 * probeInitialize() — exact request bytes under this test's control, not a
 * client's — extended to a full initialize/initialized/call sequence for the
 * tests below that need more than one round trip.
 */
function withServer(fn) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, KB_SUPERVISED: '1' },
    });

    const pending = new Map();
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      }
    });
    child.on('error', reject);

    let nextId = 1;
    const call = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      const timer = setTimeout(() => rej(new Error(`timed out waiting for a response to ${method}`)), 10_000);
      pending.set(id, (msg) => { clearTimeout(timer); res(msg); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    const notify = (method, params) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    };

    (async () => {
      await call('initialize', {
        protocolVersion: REQUEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'wire-identity-test', version: '1.0.0' },
      });
      notify('notifications/initialized');
      const result = await fn({ call, notify });
      resolve(result);
    })().catch(reject).finally(() => {
      child.stdin.end();
      child.kill();
    });
  });
}

describe('mcp wire identity (v1 -> v2 SDK bump)', () => {
  it('produces the same initialize response as the v1 server', async () => {
    const result = await probeInitialize();
    assert.deepStrictEqual(result, V1_BASELINE, 'v2 server must speak byte-identical 2025-era protocol to v1');
  });

  it('pins kb_read\'s tools/list entry, including the accepted draft-07 -> 2020-12 dialect bump', async () => {
    const entry = await withServer(async ({ call }) => {
      const list = await call('tools/list');
      return list.result.tools.find((t) => t.name === 'kb_read');
    });
    assert.deepStrictEqual(entry, KB_READ_TOOLS_LIST_ENTRY);
  });

  it('pins the v2 invalid-argument error envelope, message via stable substring', async () => {
    const response = await withServer(async ({ call }) => call('tools/call', { name: 'kb_read', arguments: { id: 'not-a-number' } }));
    assert.strictEqual(response.jsonrpc, '2.0');
    assert.deepStrictEqual(Object.keys(response.result), ['content', 'isError']);
    assert.strictEqual(response.result.isError, true);
    assert.strictEqual(response.result.content.length, 1);
    assert.strictEqual(response.result.content[0].type, 'text');
    assert.ok(
      response.result.content[0].text.includes(INVALID_ARG_MESSAGE_SUBSTRING),
      `expected error text to include "${INVALID_ARG_MESSAGE_SUBSTRING}", got: ${response.result.content[0].text}`,
    );
  });
});
