// Regression: a fixture that imported src before setting KB_DIR once seeded
// the live ~/.knowledge-base and caused a ~1hr MCP outage.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = join(__dirname, 'fixtures', 'bad-import-order.fixture.js');

test('guard throws when a src module resolves KB_DIR before tmp-kb.js sets it, and never touches the real KB dir', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'kb-guard-fakehome-'));
  try {
    const childEnv = { ...process.env, HOME: fakeHome };
    delete childEnv.KB_DIR;
    delete childEnv.OBSIDIAN_VAULT_PATH;
    // Inheriting the parent's NODE_TEST_CONTEXT makes node --test think
    // this is a recursive call and skip running the fixture entirely.
    delete childEnv.NODE_TEST_CONTEXT;

    const result = spawnSync(process.execPath, ['--test', fixture], {
      env: childEnv,
      encoding: 'utf8',
    });

    assert.notStrictEqual(result.status, 0, 'child process must fail');
    assert.match(
      result.stderr + result.stdout,
      /test process resolved KB_DIR to the real ~\/\.knowledge-base/,
      'must fail with the guard error, not some other crash'
    );
    assert.strictEqual(
      existsSync(join(fakeHome, '.knowledge-base')),
      false,
      'the real (fake-HOME) KB dir must never be created'
    );
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
