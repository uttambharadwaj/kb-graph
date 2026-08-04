import './helpers/tmp-kb.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

import { MIGRATIONS as KB_MIGRATIONS } from '../src/db.js';
import { MIGRATIONS as BUS_MIGRATIONS } from '../src/bus/db.js';
import { MIGRATION_TARGETS, migrationsFor } from '../src/migration-targets.js';
import { PENDING_EXIT } from '../src/schema.js';
import { seedDb as seed, shortOf as short } from './helpers/migrations.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KB_BIN = join(ROOT, 'bin', 'kb.js');

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

function check(env) {
  return spawnSync(process.execPath, [KB_BIN, 'migrate', '--check'], {
    encoding: 'utf8',
    env: { ...process.env, KB_SKIP_NODE_REEXEC: '1', ...env },
  });
}
describe('kb migrate --check', () => {
  // The whole point of the mode is an exit code a script can branch on, so it
  // has to differ from the ones every other outcome already uses: 0 success,
  // 2 a usage mistake, 1 anything that went wrong (see cli/flags.js).
  it('signals a behind database with an exit code nothing else produces', () => {
    assert.ok(![0, 1, 2].includes(PENDING_EXIT), `${PENDING_EXIT} already means something else`);
  });

  it('exits zero and says so when every database is current', () => {
    const { kb, bus, env } = install();
    seed(kb, KB_MIGRATIONS);
    seed(bus, BUS_MIGRATIONS);

    const done = check(env);
    assert.strictEqual(done.status, 0, done.stderr);
    assert.match(done.stdout, /up to date/);
  });

  it('exits with the pending code and names what is missing', () => {
    const { kb, bus, env } = install();
    const { applied, pending } = short(KB_MIGRATIONS);
    const missing = pending[0];
    seed(kb, applied);
    seed(bus, BUS_MIGRATIONS);

    const done = check(env);
    assert.strictEqual(done.status, PENDING_EXIT, done.stderr);
    // The version and the name both, because the remedy is to read the list.
    assert.match(done.stdout, new RegExp(`${missing.version}\\. ${missing.name}`));
    assert.match(done.stdout, /knowledge base/);
    assert.doesNotMatch(done.stdout, /message bus/, 'a current database must not be reported as behind');
  });

  it('reports every behind database, not just the first', () => {
    const { kb, bus, env } = install();
    seed(kb, short(KB_MIGRATIONS).applied);
    seed(bus, short(BUS_MIGRATIONS).applied);

    const done = check(env);
    assert.strictEqual(done.status, PENDING_EXIT, done.stderr);
    assert.match(done.stdout, /knowledge base/);
    assert.match(done.stdout, /message bus/);
  });

  // A fresh install is not behind, it is empty — `ensureSchemaReady` bootstraps
  // it on connect. A check that said otherwise would gate on the wrong thing
  // and hold a reload that was never going to fail.
  it('treats a database that does not exist yet as current, and does not create it', () => {
    const { kb, bus, env } = install();

    const done = check(env);
    assert.strictEqual(done.status, 0, done.stderr);
    assert.ok(!existsSync(kb), 'the check created the knowledge base database');
    assert.ok(!existsSync(bus), 'the check created the bus database');
  });

  it('treats an existing but empty database as current', () => {
    const { kb, bus, env } = install();
    mkdirSync(dirname(kb), { recursive: true });
    new Database(kb).close();
    seed(bus, BUS_MIGRATIONS);

    const done = check(env);
    assert.strictEqual(done.status, 0, done.stderr);
  });

  it('writes nothing to a database that is behind', () => {
    const { kb, bus, env } = install();
    seed(kb, short(KB_MIGRATIONS).applied);
    seed(bus, BUS_MIGRATIONS);
    const before = statSync(kb);

    assert.strictEqual(check(env).status, PENDING_EXIT);

    const after = statSync(kb);
    assert.strictEqual(after.mtimeMs, before.mtimeMs);
    assert.strictEqual(after.size, before.size);
    // And the migration is still pending afterwards: a check that had applied
    // it would leave an identical file size for a completely different reason.
    assert.strictEqual(check(env).status, PENDING_EXIT);
  });

  it('leaves `migrate` and `--dry-run` alone', () => {
    const { kb, bus, env } = install();
    seed(kb, short(KB_MIGRATIONS).applied);
    seed(bus, short(BUS_MIGRATIONS).applied);

    const preview = spawnSync(process.execPath, [KB_BIN, 'migrate', '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, KB_SKIP_NODE_REEXEC: '1', ...env },
    });
    assert.strictEqual(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /pending {2}\d+\./);
    assert.match(preview.stdout, /dry run/);
    assert.strictEqual(check(env).status, PENDING_EXIT, 'the preview applied something');

    const applied = spawnSync(process.execPath, [KB_BIN, 'migrate'], {
      encoding: 'utf8',
      env: { ...process.env, KB_SKIP_NODE_REEXEC: '1', ...env },
    });
    assert.strictEqual(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /applied/);
    assert.strictEqual(check(env).status, 0, 'migrate left something behind');
  });
});

describe('migration targets', () => {
  // The gate stats `source` and loads the list from it. If a target ever named
  // a file that does not define its migrations, the gate would fingerprint one
  // thing and check another, and hold — or fail to hold — for no visible reason.
  it('each target names the module that really defines its list', async () => {
    const loaded = [];
    for (const target of MIGRATION_TARGETS) {
      assert.ok(existsSync(target.source), `${target.label}: no such source ${target.source}`);
      const migrations = await migrationsFor(target);
      assert.ok(Array.isArray(migrations) && migrations.length > 0, `${target.label}: no migrations`);
      loaded.push(migrations);
    }
    // Identity, not shape: a source path that resolved to some other copy of
    // the module would still look like a valid list.
    assert.ok(loaded.includes(KB_MIGRATIONS), 'no target loads the knowledge base migrations');
    assert.ok(loaded.includes(BUS_MIGRATIONS), 'no target loads the bus migrations');
  });

  it('resolves a database path for every target', () => {
    for (const target of MIGRATION_TARGETS) {
      assert.ok(target.db().length > 0, `${target.label}: no database path`);
    }
  });
});
