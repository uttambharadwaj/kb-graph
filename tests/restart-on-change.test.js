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
    await settle(QUIET_MS);
    assert.strictEqual(exited(), 1);
  });

  it('ignores files that are not javascript', async () => {
    const { dir, exited } = await harness();
    writeFileSync(join(dir, 'notes.md'), 'const readme = 1;\n');
    await settle(QUIET_MS);
    assert.strictEqual(exited(), 0);
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
    await settle(QUIET_MS);
    assert.strictEqual(exited(), 1);
  });

  it('restarts after a source file is deleted', async () => {
    const { dir, exited } = await harness();
    writeFileSync(join(dir, 'gone.js'), 'export const gone = 1;\n');
    await settle(QUIET_MS);
    const beforeDelete = exited();

    unlinkSync(join(dir, 'gone.js'));
    await settle(QUIET_MS);
    assert.strictEqual(
      exited(),
      beforeDelete + 1,
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
    await settle(IDLE_POLL_MS * 10);
    assert.strictEqual(exited(), 1);
  });
});
