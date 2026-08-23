import './helpers/tmp-kb.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getDb } from '../src/db.js';
import { startDaemon } from '../src/daemon.js';
import { AGENT } from '../src/process-ancestry.js';
import { resolveAgent, resolveSessionId } from '../src/retrieval.js';
import { SESSION_MAP_DIR } from '../src/session-map.js';
import { encodeHello } from '../src/shim-hello.js';

// Drives the daemon's MCP socket with hand-written bytes rather than the SDK
// client, for the same reason mcp-wire-identity.test.js does: these cases are
// ABOUT chunk boundaries and about a line the SDK client would never send, so
// the test has to own exactly what goes on the wire and when.
const CASE_TIMEOUT_MS = 60_000;
const REQUEST_PROTOCOL_VERSION = '2025-06-18';

const scratchDirs = [];
const liveDaemons = new Set();
const liveClients = new Set();

after(async () => {
  for (const client of liveClients) client.destroy();
  liveClients.clear();
  for (const daemon of liveDaemons) await daemon.close().catch(() => {});
  liveDaemons.clear();
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function freshSocketPath() {
  const dir = mkdtempSync(join(tmpdir(), 'kb-ident-sock-'));
  scratchDirs.push(dir);
  return join(dir, 'd.sock');
}

async function startTestDaemon() {
  const socketPath = freshSocketPath();
  const daemon = await startDaemon({ socketPath, controlSocketPath: join(dirname(socketPath), 'ctl.sock') });
  liveDaemons.add(daemon);
  return daemon;
}

async function closeDaemon(daemon) {
  liveDaemons.delete(daemon);
  await daemon.close();
}

function withDeadline(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms); }),
  ]);
}

/**
 * A raw connection to the daemon's MCP socket. `write` puts exact bytes on the
 * wire (one call, one chunk) so a case can decide where the chunk boundaries
 * fall; `expect(id)` resolves with the response carrying that id.
 *
 * `responseOrder` records the ids in arrival order, which is what proves the
 * stream reaching the transport was neither reordered nor partially eaten.
 */
async function rawClient(socketPath) {
  const socket = connect(socketPath);
  liveClients.add(socket);
  socket.on('error', () => {});
  await withDeadline(
    new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    }),
    5_000,
    'the raw client to connect',
  );

  const waiters = new Map();
  const received = new Map();
  const responseOrder = [];
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id === undefined) continue;
      responseOrder.push(message.id);
      received.set(message.id, message);
      waiters.get(message.id)?.(message);
      waiters.delete(message.id);
    }
  });

  const expect = (id) => withDeadline(
    new Promise((resolve) => {
      if (received.has(id)) return resolve(received.get(id));
      waiters.set(id, resolve);
    }),
    15_000,
    `a response to request ${id}`,
  );

  const close = () => {
    liveClients.delete(socket);
    socket.destroy();
  };

  return { socket, write: (bytes) => socket.write(bytes), expect, responseOrder, close };
}

const rpc = (id, method, params) => `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
const notify = (method, params) => `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`;

const initializeLine = (id = 1, clientName = 'shim-identity-test') => rpc(id, 'initialize', {
  protocolVersion: REQUEST_PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: clientName, version: '1.0.0' },
});

const searchLine = (id, query) => rpc(id, 'tools/call', { name: 'kb_search', arguments: { query } });

/** Writes the session-map entry the hook side would have written for this harness pid. */
function seedSessionMap({ harnessPid, pidStart, sessionId, agent }) {
  mkdirSync(SESSION_MAP_DIR, { recursive: true });
  writeFileSync(
    join(SESSION_MAP_DIR, `${harnessPid}.json`),
    JSON.stringify({ pid: harnessPid, pid_start: pidStart, session_id: sessionId, agent, ts: new Date().toISOString() }),
  );
}

function retrievalRowsFor(query) {
  return getDb().prepare('SELECT session, agent, surface FROM retrievals WHERE query = ?').all(query);
}

function assertTagged(query, { session, agent }) {
  const rows = retrievalRowsFor(query);
  assert.ok(rows.length > 0, `no retrieval row was logged for query ${JSON.stringify(query)}`);
  for (const row of rows) {
    assert.strictEqual(row.surface, 'kb_search');
    assert.strictEqual(row.session, session, `session for ${JSON.stringify(query)}`);
    assert.strictEqual(row.agent, agent, `agent for ${JSON.stringify(query)}`);
  }
}

describe('daemon shim-hello intake', () => {
  it('serves a hello and the first JSON-RPC message delivered in one chunk', { timeout: CASE_TIMEOUT_MS }, async () => {
    const daemon = await startTestDaemon();
    const client = await rawClient(daemon.socketPath);
    try {
      // One write, one chunk: the hello line and the request share it, which
      // is exactly what a real shim produces and what an unshift bug eats.
      client.write(encodeHello({ harnessPid: 90101, pidStart: 'START-90101', agent: AGENT.CLAUDE }) + initializeLine(1));
      const init = await client.expect(1);
      assert.deepStrictEqual(init.result.serverInfo, { name: 'knowledge-base', version: '1.0.0' });
    } finally {
      client.close();
      await closeDaemon(daemon);
    }
  });

  it('serves a hello split across chunks, mid-line', { timeout: CASE_TIMEOUT_MS }, async () => {
    const daemon = await startTestDaemon();
    const client = await rawClient(daemon.socketPath);
    try {
      const hello = encodeHello({ harnessPid: 90102, pidStart: 'START-90102', agent: AGENT.CODEX });
      const split = Math.floor(hello.length / 2);
      client.write(hello.slice(0, split));
      await new Promise((resolve) => setTimeout(resolve, 25));
      // The tail of the hello, its newline, and the request all in the second
      // chunk — the boundary falls inside the identity line itself.
      client.write(hello.slice(split) + initializeLine(1));
      const init = await client.expect(1);
      assert.strictEqual(init.result.serverInfo.name, 'knowledge-base');
    } finally {
      client.close();
      await closeDaemon(daemon);
    }
  });

  it('delivers a burst of requests after the hello in order, none lost', { timeout: CASE_TIMEOUT_MS }, async () => {
    const daemon = await startTestDaemon();
    const client = await rawClient(daemon.socketPath);
    try {
      client.write(encodeHello({ harnessPid: 90103, pidStart: 'START-90103', agent: AGENT.CLAUDE }) + initializeLine(1));
      await client.expect(1);
      client.write(notify('notifications/initialized'));
      // Four requests in a single chunk: every one must be answered, and the
      // answers must come back in the order the requests went out.
      client.write([2, 3, 4, 5].map((id) => rpc(id, 'tools/list')).join(''));
      for (const id of [2, 3, 4, 5]) {
        const response = await client.expect(id);
        assert.ok(response.result.tools.some((tool) => tool.name === 'kb_search'), `request ${id} must be answered`);
      }
      assert.deepStrictEqual(client.responseOrder, [1, 2, 3, 4, 5]);
    } finally {
      client.close();
      await closeDaemon(daemon);
    }
  });

  it('serves a client that sends no hello at all (an older shim)', { timeout: CASE_TIMEOUT_MS }, async () => {
    const daemon = await startTestDaemon();
    const client = await rawClient(daemon.socketPath);
    const query = 'no-hello-older-shim';
    try {
      client.write(initializeLine(1));
      await client.expect(1);
      client.write(notify('notifications/initialized'));
      client.write(searchLine(2, query));
      const result = await client.expect(2);
      assert.ok(!result.result.isError, `kb_search failed: ${JSON.stringify(result.result.content)}`);
      // Today's behaviour, unchanged: with no hello the row falls back to the
      // serving PROCESS's own ancestry walk. In production that process is
      // launchd-parented and the fallback is NULL; under `node --test` it is a
      // descendant of whichever harness is running the suite, so the assertion
      // is against the fallback itself rather than against a hardcoded NULL —
      // what matters is that nothing from a hello leaked in.
      assertTagged(query, { session: resolveSessionId(), agent: resolveAgent() });
    } finally {
      client.close();
      await closeDaemon(daemon);
    }
  });

  // The intake defers attaching the transport until a hello decision is made,
  // so a client that connects and then says nothing has no handle at all. It
  // still has a socket, and a shutdown that skipped it would hang the daemon.
  it('shuts down cleanly with a connection that never sent a byte', { timeout: CASE_TIMEOUT_MS }, async () => {
    const daemon = await startTestDaemon();
    const client = await rawClient(daemon.socketPath);
    // Polled, not asserted outright: the client's connect() resolving and the
    // server's accept handler running are two separate events.
    await withDeadline(
      (async () => { while (daemon.connectionCount() === 0) await new Promise((r) => setTimeout(r, 10)); })(),
      5_000,
      'a silent connection to be tracked',
    );
    await withDeadline(closeDaemon(daemon), 15_000, 'the daemon to close past a silent connection');
    client.close();
  });

  it('hands an oversized first line to the transport untouched', { timeout: CASE_TIMEOUT_MS }, async () => {
    const daemon = await startTestDaemon();
    const client = await rawClient(daemon.socketPath);
    try {
      // A legitimate JSON-RPC line far past MAX_HELLO_LINE_BYTES: the intake
      // must give up on finding a hello and forward every byte, not truncate
      // at the bound or wait for a newline that is still coming.
      const line = initializeLine(1, 'x'.repeat(64 * 1024));
      assert.ok(line.length > 64 * 1024);
      client.write(line);
      const init = await client.expect(1);
      assert.strictEqual(init.result.serverInfo.name, 'knowledge-base');
    } finally {
      client.close();
      await closeDaemon(daemon);
    }
  });
});

describe('retrieval identity through the daemon', () => {
  it('tags an MCP retrieval with the session and agent the hello named', { timeout: CASE_TIMEOUT_MS }, async () => {
    const harnessPid = 90201;
    const pidStart = 'Sun Aug 23 09:14:02 2026';
    seedSessionMap({ harnessPid, pidStart, sessionId: 'sess-hello-codex', agent: AGENT.CODEX });

    const daemon = await startTestDaemon();
    const client = await rawClient(daemon.socketPath);
    const query = 'identity-through-daemon-single';
    try {
      client.write(encodeHello({ harnessPid, pidStart, agent: AGENT.CODEX }) + initializeLine(1));
      await client.expect(1);
      client.write(notify('notifications/initialized'));
      client.write(searchLine(2, query));
      const result = await client.expect(2);
      assert.ok(!result.result.isError, `kb_search failed: ${JSON.stringify(result.result.content)}`);

      assertTagged(query, { session: 'sess-hello-codex', agent: AGENT.CODEX });
    } finally {
      client.close();
      await closeDaemon(daemon);
    }
  });

  it('resolves the session to NULL when the hello\'s pid_start does not match the map entry', { timeout: CASE_TIMEOUT_MS }, async () => {
    const harnessPid = 90202;
    // The map entry was written by a process that has since died and had its
    // pid reused — resolveSessionId's whole reason for verifying pid_start.
    seedSessionMap({ harnessPid, pidStart: 'START-OLD', sessionId: 'sess-stale', agent: AGENT.CLAUDE });

    const daemon = await startTestDaemon();
    const client = await rawClient(daemon.socketPath);
    const query = 'identity-through-daemon-stale-pidstart';
    try {
      client.write(encodeHello({ harnessPid, pidStart: 'START-NEW', agent: AGENT.CLAUDE }) + initializeLine(1));
      await client.expect(1);
      client.write(notify('notifications/initialized'));
      client.write(searchLine(2, query));
      await client.expect(2);

      // Agent still lands: it comes off the hello itself, with nothing to go
      // stale. Only the session, which needs the map, degrades to NULL.
      assertTagged(query, { session: null, agent: AGENT.CLAUDE });
    } finally {
      client.close();
      await closeDaemon(daemon);
    }
  });

  it('keeps two concurrent connections from cross-stamping each other', { timeout: CASE_TIMEOUT_MS }, async () => {
    seedSessionMap({ harnessPid: 90301, pidStart: 'START-90301', sessionId: 'sess-conn-a', agent: AGENT.CLAUDE });
    seedSessionMap({ harnessPid: 90302, pidStart: 'START-90302', sessionId: 'sess-conn-b', agent: AGENT.CODEX });

    const daemon = await startTestDaemon();
    const a = await rawClient(daemon.socketPath);
    const b = await rawClient(daemon.socketPath);
    const queryA = 'identity-concurrent-connection-a';
    const queryB = 'identity-concurrent-connection-b';
    try {
      a.write(encodeHello({ harnessPid: 90301, pidStart: 'START-90301', agent: AGENT.CLAUDE }) + initializeLine(1));
      b.write(encodeHello({ harnessPid: 90302, pidStart: 'START-90302', agent: AGENT.CODEX }) + initializeLine(1));
      await Promise.all([a.expect(1), b.expect(1)]);
      a.write(notify('notifications/initialized'));
      b.write(notify('notifications/initialized'));

      // Both calls in flight before either is awaited: if the identity lived
      // on the process (or on one shared wrapper) instead of on the
      // connection, one of these would take the other's tag.
      a.write(searchLine(2, queryA));
      b.write(searchLine(2, queryB));
      await Promise.all([a.expect(2), b.expect(2)]);

      assertTagged(queryA, { session: 'sess-conn-a', agent: AGENT.CLAUDE });
      assertTagged(queryB, { session: 'sess-conn-b', agent: AGENT.CODEX });
    } finally {
      a.close();
      b.close();
      await closeDaemon(daemon);
    }
  });
});
