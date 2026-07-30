import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HELPERS = join(dirname(fileURLToPath(import.meta.url)), 'helpers');
const FIXTURE = join(HELPERS, 'supervisor-fixture.mjs');
const CHILD = join(HELPERS, 'marker-server.mjs');

const QUIET_MS = 200;
const POLL_MS = 25;
const DEADLINE_MS = 15000;

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Same shape as tests/restart-on-change.test.js: a fixed sleep long enough for
// an fs event plus a process spawn is a race, not a wait, so poll instead and
// let a loaded machine take longer rather than fail with no information.
async function until(condition, what) {
  const deadline = Date.now() + DEADLINE_MS;
  let last;
  while (Date.now() < deadline) {
    last = await condition();
    if (last) return last;
    await settle(POLL_MS);
  }
  assert.fail(`timed out after ${DEADLINE_MS}ms waiting for ${what}`);
}

const clients = [];
const dirs = [];

afterEach(async () => {
  while (clients.length) await clients.pop().close().catch(() => {});
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

async function harness({ marker = 'one' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-supervisor-'));
  dirs.push(dir);
  // node --check only rejects broken ESM inside a type:module package, and the
  // marker has to import as ESM too.
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  const markerPath = join(dir, 'marker.js');
  const flagPath = join(dir, 'flag');
  const setMarker = (value) => writeFileSync(markerPath, `export const MARKER = ${JSON.stringify(value)};\n`);
  setMarker(marker);

  const client = new Client({ name: 'supervisor-test', version: '1.0.0' });
  clients.push(client);
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [FIXTURE],
    env: { ...process.env, KB_TEST_CHILD: CHILD, KB_TEST_WATCH_DIR: dir, KB_TEST_MARKER: markerPath, KB_TEST_FLAG: flagPath },
    // The park test spawns children that are meant to die; their stack traces
    // are not test failures.
    stderr: 'ignore',
  }));

  const call = async (name, options) => {
    const res = await client.callTool({ name, arguments: {} }, undefined, options);
    return res.content[0].text;
  };
  // FSEvents replays the writes made just before the watcher registered, so the
  // setup above can trigger one swap. Let it pass before anything is measured.
  await settle(QUIET_MS);
  return { dir, client, call, setMarker, raiseFlag: () => writeFileSync(flagPath, '') };
}

describe('mcp supervisor', () => {
  // The headline invariant, and the whole reason this file exists: new code
  // reaches the session without the client reconnecting. Asserted through the
  // real SDK client, because a hand-rolled JSON-RPC peer would not prove the
  // replayed handshake satisfies a client's actual expectations.
  it('serves new code to the same client, with no reconnect', async () => {
    const { call, setMarker } = await harness();
    const before = await call('whoami');
    assert.match(before, /^\d+:one:supervisor-test:ready$/);

    setMarker('two');
    const after = await until(async () => {
      const seen = await call('whoami');
      return seen.startsWith(`${before.split(':')[0]}:`) ? null : seen;
    }, 'a different process to answer');
    // The replayed handshake is what the trailing fields prove: a child that
    // never got it still answers, but knows nothing about who it is talking to.
    assert.strictEqual(after.split(':').slice(1).join(':'), 'two:supervisor-test:ready');
  });

  // The watcher gates on in-flight calls, but the supervisor is what counts
  // them now — a swap that cut a running tool call short would lose the answer
  // with nothing to retry it.
  it('lets an in-flight call finish before swapping', async () => {
    const { call, setMarker, raiseFlag } = await harness();
    const slow = call('slow');
    await settle(QUIET_MS);

    setMarker('two');
    await settle(QUIET_MS);
    raiseFlag();
    assert.strictEqual(await slow, 'done:one', 'the original child must answer its own call');

    await until(async () => (await call('whoami')).split(':')[1] === 'two', 'the swap to happen afterwards');
  });

  // Traffic that lands between the decision to swap and the new child being
  // ready has no process to go to. Queued, it is answered late; dropped, the
  // client waits out its own 60s timeout for a reply that never comes.
  it('answers every call that arrives during a swap', async () => {
    const { call, setMarker } = await harness();
    setMarker('three');
    // A burst rather than one call: spread across the debounce, the kill and
    // the handshake replay, some of these are certain to land while there is no
    // process to send them to, which one well-timed call cannot guarantee.
    const answers = [];
    for (let i = 0; i < 20; i += 1) {
      answers.push(call('whoami'));
      await settle(10);
    }
    const seen = await Promise.all(answers);
    // `ready` on every one is the queue doing its job: nothing reaches a new
    // child until its replayed handshake has completed, so no call is ever
    // served by a half-initialized process.
    assert.ok(seen.every((a) => /^\d+:(one|three):supervisor-test:ready$/.test(a)), `unanswered or malformed: ${seen}`);
    assert.ok(seen.some((a) => a.split(':')[1] === 'three'), 'the burst must have straddled the swap');
  });

  // A cancelled request never gets a response, so an id left in the in-flight
  // set outlives the call itself: one Esc during a slow tool would wedge every
  // future reload, and nothing would ever say why.
  it('reloads again after a call was cancelled', async () => {
    const { call, setMarker } = await harness();
    await assert.rejects(call('slow', { timeout: 300 }), /timed out|timeout/i);

    setMarker('four');
    await until(async () => (await call('whoami')).split(':')[1] === 'four', 'a reload after the cancellation');
  });

  // A child that dies mid-call takes the answer with it. Its calls are never
  // re-sent to the replacement — a half-run write would run twice — so the only
  // honest outcome is an error the client sees now rather than at its timeout.
  it('errors a call whose child died, then serves the next one', async () => {
    const { call } = await harness();
    await assert.rejects(call('boom'), /exited mid-call/);
    await until(async () => (await call('whoami')).split(':')[1] === 'one', 'a replacement child to answer');
  });

  // The syntax gate does not catch a file that parses and then throws on
  // import, which is exactly what a half-finished checkout produces. Exiting
  // there would take the whole toolset away — the failure this supervisor
  // exists to prevent — so it parks instead and waits for the tree to be fixed.
  it('parks on a child that cannot start, and recovers when the source is fixed', async () => {
    const { call, setMarker, dir } = await harness();
    assert.match(await call('whoami'), /^\d+:one:/);

    writeFileSync(join(dir, 'marker.js'), "throw new Error('half-written');\nexport const MARKER = 'broken';\n");
    await until(async () => {
      const failed = await call('whoami').then(() => null, (err) => err);
      return failed && /not running/.test(String(failed)) ? failed : null;
    }, 'calls to be refused while parked');

    // Calls keep being refused until the watcher has seen the repair, so the
    // poll has to tolerate the refusal rather than treat it as the verdict.
    setMarker('five');
    await until(async () => (await call('whoami').catch(() => null))?.split(':')[1] === 'five', 'the session to come back by itself');
  });
});
