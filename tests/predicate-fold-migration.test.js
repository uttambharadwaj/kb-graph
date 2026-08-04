// Point the KB at a throwaway dir BEFORE anything opens the real DB.
import './helpers/tmp-kb.js';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

const { addFact } = await import('../src/facts.js');
const { getDb, MIGRATIONS } = await import('../src/db.js');
const { applyMigrations, pendingMigrations } = await import('../src/schema.js');
const { runMigrateCli } = await import('../src/cli/migrate.js');

// A fixture database, built and migrated in the test, never the live one.
function seededFixture(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-migration-12-'));
  const db = new Database(join(dir, 'kb.db'));
  applyMigrations(db, MIGRATIONS);
  const entity = db.prepare('INSERT OR IGNORE INTO entities (id, name) VALUES (?, ?)');
  const fact = db.prepare(
    'INSERT INTO facts (id, subject, predicate, object, valid_from, valid_to, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const [id, subject, predicate, object, validFrom, validTo] of rows) {
    entity.run(subject, subject);
    entity.run(object, object);
    fact.run(id, subject, predicate, object, validFrom, validTo ?? null, `src_${id}`);
  }
  return db;
}

const factRows = db => db.prepare(
  'SELECT id, subject, predicate, object, valid_from, valid_to, source FROM facts ORDER BY id'
).all();

describe('migration 12 — folding rows already stored', () => {
  const migration = MIGRATIONS.find(m => m.version === 12);

  it('is pending on a database holding a stale spelling, and previews its size', () => {
    const db = seededFixture([
      ['f1', 'pr_1', 'merged_into', 'main', '2026-01-01'],
      ['f2', 'pr_2', 'deploys_to', 'production', '2026-01-02'],
      ['f3', 'pr_3', 'owns', 'thing', '2026-01-03'],
    ]);

    assert.deepStrictEqual(pendingMigrations(db, MIGRATIONS).map(m => m.version), [12]);
    assert.strictEqual(migration.preview(db), '2 rows fold onto 2 predicates, 0 duplicate rows merge');

    applyMigrations(db, MIGRATIONS);
    assert.deepStrictEqual(
      factRows(db).map(r => r.predicate),
      ['merged_to', 'deployed_to', 'owns'],
    );
    db.close();
  });

  it('merges rows that collide once folded, keeping the earliest whole', () => {
    const db = seededFixture([
      ['f2', 'pr_9', 'merged_as', 'commit_abc', '2026-03-01'],
      ['f1', 'pr_9', 'merged_via', 'commit_abc', '2026-01-01'],
      ['f3', 'pr_9', 'merged_via_commit', 'commit_abc', '2026-05-01'],
    ]);

    // Both stale rows are dropped rather than rewritten, so they count once, in
    // the merge column. The two numbers are disjoint on purpose: they add up to
    // the rows this will touch.
    assert.strictEqual(migration.preview(db), '0 rows fold onto 0 predicates, 2 duplicate rows merge');
    applyMigrations(db, MIGRATIONS);

    const rows = factRows(db);
    assert.strictEqual(rows.length, 1, `kept ${rows.length} rows for one relationship`);
    // The earliest survives WHOLE — its own valid_from and its own source. A
    // survivor wearing a later row's date cites a source that never saw it.
    assert.deepStrictEqual(
      { predicate: rows[0].predicate, valid_from: rows[0].valid_from, source: rows[0].source },
      { predicate: 'merged_via', valid_from: '2026-01-01', source: 'src_f1' },
    );
    db.close();
  });

  it('keeps a NULL valid_from as the earliest row', () => {
    const db = seededFixture([
      ['f2', 'pr_10', 'merged_as', 'commit_def', '2026-01-01'],
      ['f1', 'pr_10', 'merged_via', 'commit_def', null],
    ]);
    applyMigrations(db, MIGRATIONS);
    assert.deepStrictEqual(factRows(db).map(r => r.id), ['f1']);
    db.close();
  });

  it('folds a retired row without collapsing it into the live one', () => {
    // The same triple true, then not, then true again is a timeline. Merging it
    // deletes history rather than a duplicate, and history is what a temporal
    // graph is for.
    const db = seededFixture([
      ['f1', 'svc_a', 'deploys_to', 'staging', '2026-01-01', '2026-02-01'],
      ['f2', 'svc_a', 'deployed_to', 'staging', '2026-03-01'],
    ]);

    assert.strictEqual(migration.preview(db), '1 rows fold onto 1 predicates, 0 duplicate rows merge');
    applyMigrations(db, MIGRATIONS);

    const rows = factRows(db);
    assert.strictEqual(rows.length, 2);
    assert.ok(rows.every(r => r.predicate === 'deployed_to'));
    assert.strictEqual(rows[0].valid_to, '2026-02-01', 'retirement was lost');
    db.close();
  });

  it('leaves a duplicate the fold did not cause to the dedup that owns it', () => {
    // Two identical live rows, both already canonical. Claiming them here would
    // put work in `up` that `applied` cannot see, and the migration would report
    // itself pending on every connect for ever.
    const db = seededFixture([
      ['f1', 'svc_b', 'owns', 'thing', '2026-01-01'],
      ['f2', 'svc_b', 'owns', 'thing', '2026-02-01'],
    ]);
    assert.deepStrictEqual(pendingMigrations(db, MIGRATIONS).map(m => m.version), []);
    assert.strictEqual(factRows(db).length, 2);
    db.close();
  });

  it('settles after one run and does not rewrite the same rows again', () => {
    const db = seededFixture([
      ['f1', 'pr_11', 'landed_on', 'main', '2026-01-01'],
      ['f2', 'pr_12', 'is_gated_by', 'flag_x', '2026-01-02'],
      ['f3', 'pr_13', 'merged_as', 'commit_ghi', '2026-01-03'],
    ]);
    applyMigrations(db, MIGRATIONS);

    assert.deepStrictEqual(pendingMigrations(db, MIGRATIONS).map(m => m.version), []);
    assert.strictEqual(migration.preview(db), '0 rows fold onto 0 predicates, 0 duplicate rows merge');
    assert.deepStrictEqual(
      factRows(db).map(r => r.predicate),
      ['merged_to', 'gated_by', 'merged_via'],
    );
    db.close();
  });

  it('has nothing to say about a database with no facts table yet', () => {
    const db = new Database(join(mkdtempSync(join(tmpdir(), 'kb-empty-')), 'kb.db'));
    assert.strictEqual(migration.applied(db), true, 'a fresh database reports migration 12 pending');
    applyMigrations(db, MIGRATIONS);
    assert.deepStrictEqual(pendingMigrations(db, MIGRATIONS), []);
    db.close();
  });

  it('shows its counts through kb migrate --dry-run, and writes nothing', async () => {
    // The preview is only worth having if the command people actually run
    // prints it. This drives the real CLI against the redirected KB_DIR.
    getDb(); // build and migrate the test database before seeding behind its back
    addFact('dryrun_probe', 'owns', 'thing_a', { validFrom: '2026-01-01' });
    const raw = new Database(process.env.KB_DIR + '/kb.db');
    raw.prepare('INSERT OR IGNORE INTO entities (id, name) VALUES (?, ?)').run('dryrun_probe', 'dryrun_probe');
    raw.prepare('INSERT OR IGNORE INTO entities (id, name) VALUES (?, ?)').run('main', 'main');
    raw.prepare(
      'INSERT INTO facts (id, subject, predicate, object, valid_from) VALUES (?, ?, ?, ?, ?)'
    ).run('dryrun_1', 'dryrun_probe', 'landed_on', 'main', '2026-01-01');
    raw.close();

    // runMigrateCli walks every target, and the second one is the message bus —
    // whose default path is the real one in the user's home. Point it at a
    // throwaway file for the duration, or this test opens live storage.
    const previousBus = process.env.KB_BUS_DB_PATH;
    process.env.KB_BUS_DB_PATH = join(mkdtempSync(join(tmpdir(), 'kb-bus-')), 'bus.db');

    const lines = [];
    const realLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      await runMigrateCli(['--dry-run']);
    } finally {
      console.log = realLog;
      if (previousBus === undefined) delete process.env.KB_BUS_DB_PATH;
      else process.env.KB_BUS_DB_PATH = previousBus;
    }

    const out = lines.join('\n');
    assert.match(out, /pending {2}12\. fold stored predicates onto the closed vocabulary/);
    assert.match(out, /1 rows fold onto 1 predicates, 0 duplicate rows merge/);
    assert.match(out, /dry run — nothing written/);

    const after = new Database(process.env.KB_DIR + '/kb.db');
    const stored = after.prepare('SELECT predicate FROM facts WHERE id = ?').pluck().get('dryrun_1');
    after.close();
    assert.strictEqual(stored, 'landed_on', 'a dry run rewrote a row');
  });
});
