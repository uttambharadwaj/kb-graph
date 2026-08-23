import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PassThrough } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { AGENT } from '../src/process-ancestry.js';
import { HELLO_KEY, HELLO_VERSION, MAX_HELLO_LINE_BYTES, encodeHello, parseHelloLine } from '../src/shim-hello.js';

const stripNewline = (line) => {
  assert.ok(line.endsWith('\n'), 'a hello must be newline-terminated or the daemon never sees a complete line');
  return line.slice(0, -1);
};

const roundTrip = (ancestry) => parseHelloLine(stripNewline(encodeHello(ancestry)));

describe('shim hello encode/parse', () => {
  it('round-trips a full identity', () => {
    const ancestry = { harnessPid: 4242, pidStart: 'Sun Aug 23 09:14:02 2026', agent: AGENT.CODEX };
    assert.deepStrictEqual(roundTrip(ancestry), ancestry);
  });

  it('round-trips an all-null identity (no harness ancestor found)', () => {
    assert.deepStrictEqual(roundTrip({ harnessPid: null, pidStart: null, agent: null }), {
      harnessPid: null,
      pidStart: null,
      agent: null,
    });
  });

  it('encodes every field even when nothing is passed at all', () => {
    assert.deepStrictEqual(JSON.parse(stripNewline(encodeHello())), {
      [HELLO_KEY]: HELLO_VERSION,
      harnessPid: null,
      pidStart: null,
      agent: null,
    });
  });

  it('emits exactly one line', () => {
    const encoded = encodeHello({ harnessPid: 1, pidStart: 'START', agent: AGENT.CLAUDE });
    assert.strictEqual(encoded.split('\n').length, 2, `expected one line + terminator, got ${JSON.stringify(encoded)}`);
  });

  // Each of these is something the daemon can read off a socket. A hello that
  // parsed but carried junk would put a bad pid into a session-map lookup or
  // an unknown string into the agent column, which the reports bucket by name.
  it('degrades a malformed field to null rather than passing it through', () => {
    const line = JSON.stringify({
      [HELLO_KEY]: HELLO_VERSION,
      harnessPid: 'not-a-number',
      pidStart: 42,
      agent: 'gemini',
    });
    assert.deepStrictEqual(parseHelloLine(line), { harnessPid: null, pidStart: null, agent: null });
  });

  it('rejects a non-integer or non-positive pid', () => {
    for (const harnessPid of [0, -1, 4.5, Number.NaN]) {
      const line = JSON.stringify({ [HELLO_KEY]: HELLO_VERSION, harnessPid, pidStart: 'S', agent: null });
      assert.strictEqual(parseHelloLine(line).harnessPid, null, `pid ${harnessPid} must not survive parsing`);
    }
  });

  it('treats an empty pidStart as absent', () => {
    const line = JSON.stringify({ [HELLO_KEY]: HELLO_VERSION, harnessPid: 7, pidStart: '', agent: null });
    assert.strictEqual(parseHelloLine(line).pidStart, null);
  });

  it('is not a hello: garbage, non-objects, JSON-RPC, or a different version', () => {
    const notHellos = [
      '',
      'not json at all',
      '{',
      'null',
      '123',
      '"a string"',
      '[1,2,3]',
      JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }),
      JSON.stringify({ [HELLO_KEY]: HELLO_VERSION + 1, harnessPid: 1 }),
      JSON.stringify({ [HELLO_KEY]: '1', harnessPid: 1 }),
      JSON.stringify({ harnessPid: 1, pidStart: 'S', agent: 'codex' }),
    ];
    for (const line of notHellos) {
      assert.strictEqual(parseHelloLine(line), null, `must not parse as a hello: ${line.slice(0, 60)}`);
    }
  });

  it('bounds the pre-hello buffer well above a real hello', () => {
    const biggest = encodeHello({ harnessPid: 999999, pidStart: 'Sun Aug 23 09:14:02 2026', agent: AGENT.CLAUDE });
    assert.ok(biggest.length < MAX_HELLO_LINE_BYTES, 'a real hello must fit inside the bound with room to spare');
  });
});

// The compatibility direction step 2 cannot cover: a NEW shim dialing an OLD
// daemon, which feeds the hello straight into the SDK transport. Asserted
// against the SDK actually installed rather than read off its source, so an
// SDK bump that starts closing the connection (or answering the client) on a
// non-JSON-RPC line fails here instead of in a live session.
describe('an old daemon\'s SDK transport, fed a hello line', () => {
  it('skips it, reports it through onerror, and keeps serving the messages after it', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioServerTransport(stdin, stdout);
    const messages = [];
    const errors = [];
    let closed = false;
    transport.onmessage = (message) => messages.push(message);
    transport.onerror = (error) => errors.push(error);
    transport.onclose = () => { closed = true; };
    await transport.start();

    const request = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    stdin.write(encodeHello({ harnessPid: 4242, pidStart: 'START', agent: AGENT.CLAUDE }));
    stdin.write(`${JSON.stringify(request)}\n`);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(messages, [request], 'the JSON-RPC message after the hello must still arrive intact');
    assert.strictEqual(errors.length, 1, 'the hello is reported exactly once through onerror');
    assert.strictEqual(closed, false, 'a non-JSON-RPC line must not tear the connection down');
    assert.strictEqual(stdout.readableLength, 0, 'nothing is written back to the client for a hello line');

    await transport.close();
  });
});
