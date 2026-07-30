import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { restartOnSourceChange } from '../src/restart-on-change.js';

const DEBOUNCE_MS = 20;
const IDLE_POLL_MS = 10;
const QUIET_MS = DEBOUNCE_MS * 10;

const watchers = [];
const dirs = [];

afterEach(() => {
  while (watchers.length) watchers.pop()?.close();
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waiting a fixed 200ms for FSEvents delivery plus a `node --check` fork is a
// race, not a wait — it failed twice on a loaded machine and passed on an
// immediate re-run of the same tree. Poll instead, so a busy machine takes
// longer rather than reporting a failure that carries no information.
const DEADLINE_MS = 5000;
async function until(condition, what) {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    if (condition()) return;
    await settle(IDLE_POLL_MS);
  }
  assert.fail(`timed out after ${DEADLINE_MS}ms waiting for ${what}`);
}

async function harness({ isBusy = () => false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-restart-'));
  dirs.push(dir);
  // node --check only rejects broken ESM inside a type:module package; without
  // this it accepts `export function half( {` and the syntax gate looks dead.
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');

  let exits = 0;
  watchers.push(
    restartOnSourceChange({
      isBusy,
      exit: () => { exits += 1; },
      dir,
      debounceMs: DEBOUNCE_MS,
      idlePollMs: IDLE_POLL_MS,
    }),
  );

  // FSEvents replays writes made just before watch() registered, so the setup
  // above lands in the callback. Drain it before anything is counted.
  await settle(QUIET_MS);
  exits = 0;
  return { dir, exited: () => exits };
}

describe('restart on source change', () => {
  it('exits when a source file changes', async () => {
    const { dir, exited } = await harness();
    writeFileSync(join(dir, 'seed.js'), 'export const seed = 2;\n');
    await until(() => exited() === 1, 'the watcher to exit on a source change');
  });

  it('ignores files that are not source', async () => {
    const { dir, exited } = await harness();
    writeFileSync(join(dir, 'notes.md'), 'const readme = 1;\n');
    await settle(QUIET_MS);
    assert.strictEqual(exited(), 0);
  });

  // predicates.json configures which predicates retire a prior fact. It is read
  // once at import like any module, so shipping a change to it without a restart
  // leaves every live server consolidating on the old cardinality rules.
  it('exits when predicates.json changes', async () => {
    const { dir, exited } = await harness();
    writeFileSync(join(dir, 'predicates.json'), '{"single_valued":["status"]}\n');
    await until(() => exited() === 1, 'the watcher to exit on a predicates.json change');
  });

  // `node --check` reads JSON as JS and rejects all of it, so the json branch
  // has to be its own gate — otherwise every json write looks half-written.
  it('keeps serving when json is caught half-written', async () => {
    const { dir, exited } = await harness();
    writeFileSync(join(dir, 'predicates.json'), '{"single_valued":[\n');
    await settle(QUIET_MS);
    assert.strictEqual(exited(), 0, 'truncated json must not exit into a broken config');
  });

  it('keeps serving when the tree is caught half-written', async () => {
    const { dir, exited } = await harness();
    writeFileSync(join(dir, 'seed.js'), 'export function half(  {\n');
    await settle(QUIET_MS);
    assert.strictEqual(exited(), 0, 'a syntax error must not exit into a broken tree');
  });

  it('restarts once the tree is repaired', async () => {
    const { dir, exited } = await harness();
    writeFileSync(join(dir, 'seed.js'), 'export function half(  {\n');
    await settle(QUIET_MS);
    writeFileSync(join(dir, 'seed.js'), 'export const seed = 3;\n');
    await until(() => exited() === 1, 'the watcher to exit once the tree parses again');
  });

  it('restarts after a source file is deleted', async () => {
    const { dir, exited } = await harness();
    writeFileSync(join(dir, 'gone.js'), 'export const gone = 1;\n');
    await until(() => exited() >= 1, 'the create to register before deleting');
    const beforeDelete = exited();

    unlinkSync(join(dir, 'gone.js'));
    await until(
      () => exited() === beforeDelete + 1,
      'a deleted file must not wedge the watcher waiting to parse it',
    );
  });

  it('waits for an in-flight tool call before exiting', async () => {
    let busy = true;
    const { dir, exited } = await harness({ isBusy: () => busy });
    writeFileSync(join(dir, 'seed.js'), 'export const seed = 4;\n');
    await settle(QUIET_MS);
    assert.strictEqual(exited(), 0, 'must not cut a running tool call short');

    busy = false;
    await until(() => exited() === 1, 'the exit to land once the tool call finishes');
  });
});
