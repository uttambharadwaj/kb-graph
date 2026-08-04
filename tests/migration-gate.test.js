import './helpers/tmp-kb.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { MIGRATIONS as KB_MIGRATIONS } from '../src/db.js';
import { MIGRATIONS as BUS_MIGRATIONS } from '../src/bus/db.js';
import { createMigrationGate, runMigrationCheck } from '../src/migration-gate.js';
import { seedDb as seed, shortOf as short } from './helpers/migrations.js';

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function temp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// A KB_DIR and bus home nothing else shares. Neither database exists until a
// test seeds it, which is the fresh-install case.
function install() {
  const dir = temp('kb-gate-');
  return {
    kb: join(dir, 'kb', 'kb.db'),
    bus: join(dir, 'bus', 'bus.db'),
    env: { KB_DIR: join(dir, 'kb'), KB_BUS_HOME: join(dir, 'bus'), KB_BUS_DB_PATH: '' },
  };
}

describe('migration check runner', () => {
  it('summarises a behind database on one line', () => {
    const { kb, bus, env } = install();
    const { applied, pending } = short(KB_MIGRATIONS);
    const missing = pending[0];
    seed(kb, applied);
    seed(bus, BUS_MIGRATIONS);

    const restore = { ...process.env };
    Object.assign(process.env, env);
    try {
      const { checked, summary } = runMigrationCheck();
      assert.strictEqual(checked, true);
      assert.ok(!summary.includes('\n'), `not one line: ${summary}`);
      assert.match(summary, new RegExp(`${missing.version}\\. ${missing.name}`));
    } finally {
      process.env = restore;
    }
  });

  // A gate that cannot run must not be the reason a session stops reloading:
  // the server's own fail-closed guard is what actually protects the database.
  it('fails open, loudly, when the check cannot run at all', () => {
    const said = [];
    const original = console.error;
    console.error = (...args) => said.push(args.join(' '));
    try {
      const result = runMigrationCheck(join(temp('kb-gate-gone-'), 'not-a-command.js'));
      assert.deepStrictEqual(result, { checked: false, summary: null });
    } finally {
      console.error = original;
    }
    assert.match(said.join('\n'), /pre-check did not run/);
  });
});

describe('migration gate', () => {
  // Fake targets and a counted runner: the point here is exactly how often the
  // subprocess is spawned, which a real check would hide.
  function harness(verdicts) {
    const dir = temp('kb-gate-memo-');
    const source = join(dir, 'db.js');
    const db = join(dir, 'kb.db');
    writeFileSync(source, 'export const MIGRATIONS = [];\n');
    writeFileSync(db, 'x');
    let runs = 0;
    const gate = createMigrationGate({
      targets: [{ label: 'test', source, db: () => db }],
      run: () => {
        runs += 1;
        return verdicts[Math.min(runs, verdicts.length) - 1];
      },
    });
    // mtime, not content: a same-size rewrite within the filesystem's timestamp
    // resolution is the case a naive fingerprint misses.
    const touch = (file, seconds) => utimesSync(file, seconds, seconds);
    return { gate, source, db, touch, runs: () => runs };
  }

  const clear = { checked: true, summary: null };
  const behind = { checked: true, summary: 'test  behind by 1: 9. late' };

  it('asks once, then not again while nothing has moved', () => {
    const { gate, runs } = harness([clear]);
    assert.strictEqual(gate(), null);
    assert.strictEqual(gate(), null);
    assert.strictEqual(runs(), 1);
  });

  it('does not ask again because the database was written to', () => {
    const { gate, db, touch, runs } = harness([clear]);
    assert.strictEqual(gate(), null);
    touch(db, 1);
    assert.strictEqual(gate(), null);
    assert.strictEqual(runs(), 1, 'rows being written cannot un-apply a migration');
  });

  it('asks again when the code that declares the migrations changes', () => {
    const { gate, source, touch, runs } = harness([clear, behind]);
    assert.strictEqual(gate(), null);
    touch(source, 1);
    assert.strictEqual(gate(), behind.summary);
    assert.strictEqual(runs(), 2);
  });

  it('holds a pending verdict until something moves', () => {
    const { gate, runs } = harness([behind]);
    assert.strictEqual(gate(), behind.summary);
    assert.strictEqual(gate(), behind.summary);
    assert.strictEqual(gate(), behind.summary);
    assert.strictEqual(runs(), 1);
  });

  it('re-asks after a pending verdict when the database moves', () => {
    const { gate, db, touch, runs } = harness([behind, clear]);
    assert.strictEqual(gate(), behind.summary);
    touch(db, 1);
    assert.strictEqual(gate(), null);
    assert.strictEqual(runs(), 2);
  });

  // A migration commits through the WAL and leaves the main file's mtime and
  // size untouched, so this is the signal that ends a held swap in practice.
  it('re-asks after a pending verdict when only the write-ahead log moves', () => {
    const { gate, db, runs } = harness([behind, clear]);
    assert.strictEqual(gate(), behind.summary);
    writeFileSync(`${db}-wal`, 'committed');
    assert.strictEqual(gate(), null);
    assert.strictEqual(runs(), 2);
  });

  it('does not cache a check that could not run', () => {
    const failed = { checked: false, summary: null };
    const { gate, runs } = harness([failed, failed, clear]);
    assert.strictEqual(gate(), null);
    assert.strictEqual(gate(), null);
    assert.strictEqual(gate(), null);
    assert.strictEqual(runs(), 3);
  });

  it('notices a database that appears where there was none', () => {
    const { gate, db, runs } = harness([behind, clear]);
    assert.strictEqual(gate(), behind.summary);
    rmSync(db);
    assert.strictEqual(gate(), null);
    assert.strictEqual(runs(), 2);
  });
});
