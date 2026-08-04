import './helpers/tmp-kb.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

import { MIGRATIONS as KB_MIGRATIONS } from '../src/db.js';
import { seedDb, shortOf } from './helpers/migrations.js';

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
const strays = [];

afterEach(async () => {
  while (clients.length) await clients.pop().close().catch(() => {});
  while (strays.length) strays.pop().kill();
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

const BEHIND = shortOf(KB_MIGRATIONS);

const HANDSHAKE_ID = 0;
// For the one test that spawns the supervisor itself and so cannot use the SDK
// client: StdioClientTransport owns the process it starts, and its close() ends
// stdin and then force-kills a couple of seconds later — which is exactly the
// failure that test exists to catch.
const HANDSHAKE = JSON.stringify({
  jsonrpc: '2.0',
  id: HANDSHAKE_ID,
  method: 'initialize',
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'supervisor-test', version: '1.0.0' },
  },
});

// The supervisor asks whether the databases are behind before it swaps, so a
// harness needs an install of its own. Never the developer's: with theirs, the
// whole file would pass or fail on whether they had run `kb migrate` lately.
function install({ behind = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-supervisor-kb-'));
  dirs.push(dir);
  const db = join(dir, 'kb', 'kb.db');
  seedDb(db, behind ? BEHIND.applied : KB_MIGRATIONS);
  return {
    db,
    // KB_BUS_HOME points at a directory nothing creates: an absent database is
    // a fresh install, which the gate treats as current.
    env: { KB_DIR: join(dir, 'kb'), KB_BUS_HOME: join(dir, 'bus'), KB_BUS_DB_PATH: '' },
  };
}

function watched({ marker = 'one' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-supervisor-'));
  dirs.push(dir);
  // node --check only rejects broken ESM inside a type:module package, and the
  // marker has to import as ESM too.
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  const markerPath = join(dir, 'marker.js');
  const setMarker = (value) => writeFileSync(markerPath, `export const MARKER = ${JSON.stringify(value)};\n`);
  setMarker(marker);
  return { dir, markerPath, setMarker, flagPath: join(dir, 'flag') };
}

function supervisorEnv({ dir, markerPath, flagPath }, kb, recheckMs) {
  return {
    ...process.env,
    ...kb.env,
    KB_TEST_CHILD: CHILD,
    KB_TEST_WATCH_DIR: dir,
    KB_TEST_MARKER: markerPath,
    KB_TEST_FLAG: flagPath,
    ...(recheckMs ? { KB_TEST_RECHECK_MS: String(recheckMs) } : {}),
  };
}

async function harness({ marker = 'one', behind = false, recheckMs } = {}) {
  const tree = watched({ marker });
  const kb = install({ behind });

  const client = new Client({ name: 'supervisor-test', version: '1.0.0' });
  clients.push(client);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [FIXTURE],
    env: supervisorEnv(tree, kb, recheckMs),
    // Collected rather than ignored: the swap gate reports itself here, and the
    // park test spawns children that are meant to die, whose stack traces are
    // not test failures and should not reach the runner's output either.
    stderr: 'pipe',
  });
  await client.connect(transport);
  let noise = '';
  transport.stderr?.setEncoding('utf8');
  transport.stderr?.on('data', (chunk) => { noise += chunk; });

  const call = async (name, options) => {
    const res = await client.callTool({ name, arguments: {} }, undefined, options);
    return res.content[0].text;
  };
  // FSEvents replays the writes made just before the watcher registered, so the
  // setup above can trigger one swap. Let it pass before anything is measured.
  await settle(QUIET_MS);
  return {
    dir: tree.dir,
    db: kb.db,
    client,
    call,
    setMarker: tree.setMarker,
    stderr: () => noise,
    raiseFlag: () => writeFileSync(tree.flagPath, ''),
  };
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
    //
    // Kept up until the new child has answered something, because the window
    // opens on an fs event rather than on a clock this test controls: measured
    // at 33ms after the write typically, and 275ms under load, against a burst
    // that stops issuing at 200ms. A single fixed-length burst misses it
    // outright about one run in eight on a loaded machine, and then fails for
    // having nothing to measure rather than for anything the supervisor did.
    // Deliberately not `until`: its poll gap between attempts is a hole the
    // one-and-only swap can fall into, which is a fresh race, not this one.
    const marker = (answer) => answer.split(':')[1];
    const seen = [];
    const deadline = Date.now() + DEADLINE_MS;
    while (!seen.some(a => marker(a) === 'three')) {
      assert.ok(Date.now() < deadline, `timed out after ${DEADLINE_MS}ms waiting for the swap`);
      const burst = [];
      for (let i = 0; i < 20; i += 1) {
        burst.push(call('whoami'));
        await settle(10);
      }
      seen.push(...await Promise.all(burst));
    }

    // The first calls go out before the swap can have started, so both children
    // are represented and the collection genuinely spans the blackout.
    assert.ok(seen.some(a => marker(a) === 'one'), `nothing was served by the original child: ${seen}`);
    // `ready` on every one is the queue doing its job: nothing reaches a new
    // child until its replayed handshake has completed, so no call is ever
    // served by a half-initialized process.
    assert.ok(
      seen.every((a) => /^\d+:(one|three):supervisor-test:ready$/.test(a)),
      `unanswered or malformed: ${seen}`,
    );
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

  // The failure this gate exists for: new code carrying a migration is checked
  // out, the swap happens anyway, and the replacement refuses to open the
  // database — so every call fails until someone runs `kb migrate`. Held, the
  // old child goes on answering, which is what "no downtime" has to mean here.
  it('holds the swap while a database is behind, and keeps answering from the old child', async () => {
    // A re-check every 25ms rather than the usual second: whatever lets a held
    // swap slip through gets dozens of chances to do it during this test.
    const { call, setMarker, stderr } = await harness({ behind: true, recheckMs: 25 });
    const serving = await call('whoami');
    assert.match(serving, /^\d+:one:supervisor-test:ready$/);

    setMarker('two');
    // The hold announcing itself is the window opening — a fixed sleep here
    // would be measuring the machine, not the supervisor.
    await until(async () => stderr().includes('reload held'), 'the swap to be held');

    const said = stderr();
    const missing = BEHIND.pending[0];
    assert.match(said, new RegExp(`${missing.version}\\. ${missing.name}`), 'the pending migration is not named');
    assert.match(said, /kb migrate/, 'the remedy is not named');

    // Answers, not liveness: a process that is up but failing every call is the
    // outage this is meant to prevent.
    for (let i = 0; i < 8; i += 1) {
      assert.strictEqual(await call('whoami'), serving, 'the swap went through, or a new child answered');
      await settle(25);
    }
    assert.strictEqual(stderr().match(/reload held/g).length, 1, 'the same reason was announced more than once');
  });

  // The other half: a held swap has to finish on its own, or the operator has
  // traded an outage for a reload that needs a reconnect to collect.
  it('finishes the held swap once the database catches up, with nothing else to trigger it', async () => {
    const { call, db, setMarker, stderr } = await harness({ behind: true, recheckMs: 25 });
    const before = await call('whoami');

    setMarker('two');
    await until(async () => stderr().includes('reload held'), 'the swap to be held');

    // The operator migrates, and nothing touches the source tree afterwards.
    seedDb(db, KB_MIGRATIONS);

    const after = await until(async () => {
      const seen = await call('whoami');
      return seen.split(':')[1] === 'two' ? seen : null;
    }, 'the held swap to finish by itself');
    assert.notStrictEqual(after.split(':')[0], before.split(':')[0], 'the same process cannot be serving new code');
    assert.strictEqual(after.split(':').slice(1).join(':'), 'two:supervisor-test:ready');
  });

  // The gate is on the swap path, so it must be invisible to a reload that has
  // no migration in it — including a second one, which is where a verdict
  // cached too eagerly would show up.
  it('leaves an ordinary swap alone', async () => {
    const { call, setMarker, stderr } = await harness({ recheckMs: 25 });
    const first = await call('whoami');

    setMarker('two');
    const second = await until(async () => {
      const seen = await call('whoami');
      return seen.split(':')[1] === 'two' ? seen : null;
    }, 'the first swap');

    setMarker('three');
    const third = await until(async () => {
      const seen = await call('whoami');
      return seen.split(':')[1] === 'three' ? seen : null;
    }, 'the second swap');

    assert.strictEqual(new Set([first, second, third].map(a => a.split(':')[0])).size, 3, 'each swap must be a new process');
    assert.doesNotMatch(stderr(), /reload held/);
    assert.doesNotMatch(stderr(), /pre-check did not run/);
  });

  // Holding needs something to hold on to. Parked, there is no child, and a
  // supervisor that held anyway would sit with `child` null and no swap coming
  // — every call would land on nothing and take the session down for good.
  it('swaps rather than holds when there is no child left to keep', async () => {
    const { call, dir, setMarker, stderr } = await harness({ behind: true, recheckMs: 25 });
    assert.match(await call('whoami'), /^\d+:one:/);

    // A checkout that is both broken and behind: held, so the broken file is
    // never loaded and the running child never notices.
    writeFileSync(join(dir, 'marker.js'), "throw new Error('half-written');\nexport const MARKER = 'broken';\n");
    await until(async () => stderr().includes('reload held'), 'the swap to be held');
    assert.match(await call('whoami'), /^\d+:one:/, 'a held swap must leave the running child alone');

    // Now the child dies on its own account. Its replacements load the broken
    // file and die too, until the supervisor parks with no child at all.
    await assert.rejects(call('boom'), /exited mid-call/);
    await until(async () => {
      const failed = await call('whoami').then(() => null, (err) => err);
      return failed && /not running/.test(String(failed)) ? failed : null;
    }, 'calls to be refused while parked');

    // Repairing the tree brings the session back even though the database is
    // still behind — the replacement is better than the nothing it replaces.
    setMarker('five');
    await until(async () => (await call('whoami').catch(() => null))?.split(':')[1] === 'five', 'the session to come back');
  });

  // A held swap leaves a timer armed and a child running. Ending the client's
  // pipe has to take both down: a supervisor outliving its session would hold
  // the database open with nobody left to talk to it.
  it('shuts down cleanly while a swap is held', async () => {
    const tree = watched();
    const kb = install({ behind: true });
    const supervisor = spawn(process.execPath, [FIXTURE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: supervisorEnv(tree, kb, 25),
    });
    strays.push(supervisor);
    let noise = '';
    supervisor.stderr.setEncoding('utf8');
    supervisor.stderr.on('data', (chunk) => { noise += chunk; });
    let answered = '';
    supervisor.stdout.setEncoding('utf8');
    supervisor.stdout.on('data', (chunk) => { answered += chunk; });
    const exited = new Promise((resolve) => supervisor.on('exit', (code, signal) => resolve({ code, signal })));

    // A handshake rather than a sleep, because the supervisor arms its watcher
    // in the same synchronous pass that starts it reading stdin: an answer here
    // is proof the watch is live. The other tests get that edge from
    // client.connect. A fixed wait races the few hundred ms this process spends
    // importing, and a marker written before the watch exists is seen by
    // nothing at all — no swap, no hold, and nothing to say why.
    supervisor.stdin.write(`${HANDSHAKE}\n`);
    await until(async () => answered.includes('\n'), 'the supervisor to answer the handshake');
    assert.strictEqual(JSON.parse(answered.split('\n')[0]).id, HANDSHAKE_ID, 'that is not the handshake being answered');

    tree.setMarker('two');
    await until(async () => noise.includes('reload held'), 'the swap to be held');

    supervisor.stdin.end();
    assert.deepStrictEqual(
      await Promise.race([exited, settle(DEADLINE_MS).then(() => 'still running')]),
      { code: 0, signal: null },
    );
  });
});
