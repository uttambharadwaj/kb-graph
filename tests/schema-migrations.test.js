import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS as KB_MIGRATIONS } from '../src/db.js';
import { MIGRATIONS as BUS_MIGRATIONS, closeBusDb, getBusDb } from '../src/bus/db.js';
import {
  applyMigrations,
  ensureSchemaReady,
  hasColumn,
  hasIndex,
  hasTable,
  isEmptyDatabase,
  pendingMigrations,
  SchemaOutOfDateError,
} from '../src/schema.js';

function current(migrations) {
  const db = new Database(':memory:');
  applyMigrations(db, migrations);
  return db;
}

function schemaOf(db) {
  return db.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
  ).all();
}

for (const [label, migrations] of [['knowledge base', KB_MIGRATIONS], ['bus', BUS_MIGRATIONS]]) {
  describe(`${label} migrations`, () => {
    it('declares strictly increasing versions', () => {
      const versions = migrations.map(m => m.version);
      assert.deepStrictEqual(versions, [...versions].sort((a, b) => a - b));
      assert.strictEqual(new Set(versions).size, versions.length);
    });

    it('leaves nothing pending on a database it just built', () => {
      const db = current(migrations);
      assert.deepStrictEqual(pendingMigrations(db, migrations), []);
    });

    it('is idempotent — a second pass runs nothing and changes nothing', () => {
      const db = current(migrations);
      const before = schemaOf(db);
      assert.deepStrictEqual(applyMigrations(db, migrations), []);
      assert.deepStrictEqual(schemaOf(db), before);
    });

    it('bootstraps an empty database on connect', () => {
      const db = new Database(':memory:');
      assert.ok(isEmptyDatabase(db));
      ensureSchemaReady(db, { migrations, label, path: ':memory:' });
      assert.deepStrictEqual(pendingMigrations(db, migrations), []);
    });
  });
}

describe('bootstrapping a fresh database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-bootstrap-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('runs only what the base migration did not already create', () => {
    const kb = new Database(':memory:');
    assert.deepStrictEqual(
      applyMigrations(kb, KB_MIGRATIONS).map(m => m.version),
      [1, 3, 4, 5, 6, 7, 8, 9, 11, 13],
      'the base tables already carry the vault_files summary columns, so 2 is skipped; '
      + '10 only deletes rows a fresh database does not have',
    );

    const bus = new Database(':memory:');
    assert.deepStrictEqual(
      applyMigrations(bus, BUS_MIGRATIONS).map(m => m.version),
      [1, 2],
      'the base tables already carry the v4 reader columns, so no rebuild is needed',
    );
  });

  it('is one transaction, so no other connection sees a half-built schema', () => {
    const file = join(dir, 'atomic.db');
    const writer = new Database(file);
    writer.pragma('journal_mode = WAL');

    // Reads the file from a second connection at the point where the first
    // migration has run but the bootstrap has not finished.
    const seenMidway = [];
    const migrations = [
      {
        version: 1,
        name: 'first',
        applied: db => hasTable(db, 'first_table'),
        up: db => db.exec('CREATE TABLE first_table (id INTEGER PRIMARY KEY)'),
      },
      {
        version: 2,
        name: 'second',
        applied: db => hasTable(db, 'second_table'),
        up: db => {
          const observer = new Database(file, { readonly: true });
          seenMidway.push(hasTable(observer, 'first_table'));
          observer.close();
          db.exec('CREATE TABLE second_table (id INTEGER PRIMARY KEY)');
        },
      },
    ];

    ensureSchemaReady(writer, { migrations, label: 'test', path: file });
    assert.deepStrictEqual(seenMidway, [false], 'a concurrent connection must see all of the schema or none');
    assert.ok(hasTable(writer, 'first_table') && hasTable(writer, 'second_table'));
  });
});

// The meter logged the system's own subprocesses alongside real sessions, and
// nothing on a row said which was which. The repair has to be able to tell them
// apart from the rows alone, which is what these two cases pin down.
describe('purging meter rows the system logged for itself', () => {
  function seeded(rows) {
    const db = current(KB_MIGRATIONS);
    const stmt = db.prepare('INSERT INTO retrievals (surface, query, session) VALUES (?, ?, ?)');
    for (const row of rows) stmt.run(...row);
    return db;
  }

  const sessionsIn = db =>
    db.prepare('SELECT DISTINCT session FROM retrievals ORDER BY session').all().map(r => r.session);

  it('drops every row a subprocess session logged, on both push surfaces', () => {
    const db = seeded([
      ['hint', 'You are a Memory Extractor for an engineering knowledge base. Read a work…', 'sub-1'],
      ['briefing', null, 'sub-1'],
      ['briefing', null, 'sub-1'],
      ['hint', 'why is the harvest job not writing anything', 'human-1'],
      ['briefing', null, 'human-1'],
    ]);

    assert.deepStrictEqual(applyMigrations(db, KB_MIGRATIONS).map(m => m.version), [10]);
    assert.deepStrictEqual(sessionsIn(db), ['human-1']);
    assert.deepStrictEqual(applyMigrations(db, KB_MIGRATIONS), [], 'nothing left to purge on a second pass');
  });

  it('keeps a human session that pasted one of those prompts, because it has tools', () => {
    const db = seeded([
      ['hint', 'You are a knowledge base summarizer. Given a note, return ONLY valid JSON…', 'human-2'],
      ['briefing', null, 'human-2'],
      ['kb_read', null, 'human-2'],
    ]);

    assert.deepStrictEqual(applyMigrations(db, KB_MIGRATIONS), []);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM retrievals').get().c, 3);
  });

  // Every migration's `applied` is evaluated on connect, including against a
  // database old enough to predate the table this one reads.
  it('does not trip over a database too old to have the meter table', () => {
    const db = current(KB_MIGRATIONS);
    db.exec('DROP TABLE retrievals');
    assert.deepStrictEqual(pendingMigrations(db, KB_MIGRATIONS).map(m => m.version), [6]);
  });
});

describe('connecting to a database that is behind', () => {
  it('refuses instead of migrating, and names the command that would', () => {
    const db = current(KB_MIGRATIONS);
    db.exec('ALTER TABLE documents DROP COLUMN superseded_at');
    const before = schemaOf(db);

    assert.throws(
      () => ensureSchemaReady(db, { migrations: KB_MIGRATIONS, label: 'knowledge base', path: '/tmp/kb.db' }),
      err => {
        assert.ok(err instanceof SchemaOutOfDateError);
        assert.match(err.message, /kb migrate/);
        assert.match(err.message, /document supersession lifecycle/);
        assert.deepStrictEqual(err.pending, [3]);
        return true;
      },
    );
    assert.deepStrictEqual(schemaOf(db), before, 'a refused connection must not have touched the schema');
  });

  it('refuses a bus database whose reader table would be rebuilt', () => {
    const db = current(BUS_MIGRATIONS);
    db.exec('ALTER TABLE bus_readers DROP COLUMN capabilities_json');
    const rows = db.prepare('SELECT COUNT(*) c FROM bus_readers').get().c;

    assert.throws(
      () => ensureSchemaReady(db, { migrations: BUS_MIGRATIONS, label: 'message bus', path: '/tmp/bus.db' }),
      SchemaOutOfDateError,
    );
    assert.ok(!hasColumn(db, 'bus_readers', 'capabilities_json'));
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM bus_readers').get().c, rows);
  });

  it('getBusDb refuses a bus file that is behind, leaving its rows alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-bus-behind-'));
    const file = join(dir, 'bus.db');
    const previous = process.env.KB_BUS_DB_PATH;
    process.env.KB_BUS_DB_PATH = file;
    try {
      const seed = new Database(file);
      applyMigrations(seed, BUS_MIGRATIONS);
      seed.prepare('INSERT INTO bus_readers (reader, channel, last_seen_id) VALUES (?, ?, ?)')
        .run('me', 'ws:x', 4);
      seed.exec('ALTER TABLE bus_readers DROP COLUMN capabilities_json');
      seed.close();

      assert.throws(() => getBusDb(), SchemaOutOfDateError);

      const check = new Database(file, { readonly: true });
      assert.ok(!hasColumn(check, 'bus_readers', 'capabilities_json'), 'the refused connection must not have rebuilt the table');
      assert.strictEqual(check.prepare('SELECT last_seen_id FROM bus_readers').get().last_seen_id, 4);
      check.close();
    } finally {
      closeBusDb();
      if (previous === undefined) delete process.env.KB_BUS_DB_PATH;
      else process.env.KB_BUS_DB_PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a non-empty database is never treated as a fresh one', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
    assert.ok(!isEmptyDatabase(db));
    assert.throws(
      () => ensureSchemaReady(db, { migrations: KB_MIGRATIONS, label: 'knowledge base', path: '/tmp/kb.db' }),
      SchemaOutOfDateError,
    );
    assert.ok(!hasTable(db, 'documents'));
  });
});

describe('migrating forward from an older schema', () => {
  it('adds only the columns a partial upgrade is missing', () => {
    const db = current(KB_MIGRATIONS);
    db.exec('ALTER TABLE vault_files DROP COLUMN key_topics');
    assert.deepStrictEqual(pendingMigrations(db, KB_MIGRATIONS).map(m => m.version), [2]);

    applyMigrations(db, KB_MIGRATIONS);
    assert.ok(hasColumn(db, 'vault_files', 'summary'));
    assert.ok(hasColumn(db, 'vault_files', 'key_topics'));
  });

  // The vocab view arrived appended to migration 1's block, where `applied` is
  // already true on every deployed database — so it would have reached fresh
  // installs only, and the relevance path that reads it would fail everywhere
  // else. Its own migration is what makes it reach them.
  it('reaches a database that predates the full-text vocab view', () => {
    const db = current(KB_MIGRATIONS);
    db.exec('DROP TABLE documents_fts_vocab');
    assert.deepStrictEqual(pendingMigrations(db, KB_MIGRATIONS).map(m => m.version), [9]);

    db.prepare("INSERT INTO documents (title, content, doc_type) VALUES ('vault routing', 'credentials per run', 'note')").run();
    applyMigrations(db, KB_MIGRATIONS);

    assert.ok(hasTable(db, 'documents_fts_vocab'));
    // Readable, not merely present: the relevance path selects term/doc from it.
    const rows = db.prepare('SELECT term, doc FROM documents_fts_vocab WHERE term = ?').all('vault');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].doc, 1);
  });

  it('dedupes embeddings before the unique index it depends on', () => {
    const db = current(KB_MIGRATIONS);
    db.exec('DROP INDEX uq_embeddings_doc_chunk');
    db.prepare("INSERT INTO documents (title, content, doc_type) VALUES ('t', 'c', 'note')").run();
    const insert = db.prepare(
      'INSERT INTO embeddings (document_id, chunk_index, embedding, dimensions) VALUES (1, 0, ?, 3)'
    );
    insert.run(Buffer.from([1, 2, 3]));
    insert.run(Buffer.from([4, 5, 6]));

    applyMigrations(db, KB_MIGRATIONS);
    assert.ok(hasIndex(db, 'uq_embeddings_doc_chunk'));
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM embeddings').get().c, 1);
  });

  it('rebuilds bus readers while carrying their cursors forward', () => {
    const db = current(BUS_MIGRATIONS);
    db.prepare(
      'INSERT INTO bus_readers (reader, channel, last_seen_id, notify_cursor) VALUES (?, ?, ?, ?)'
    ).run('me', 'ws:x', 7, 3);
    for (const column of ['capabilities_json', 'last_hook_at']) {
      db.exec(`ALTER TABLE bus_readers DROP COLUMN ${column}`);
    }

    applyMigrations(db, BUS_MIGRATIONS);
    const row = db.prepare('SELECT * FROM bus_readers WHERE reader = ?').get('me');
    assert.strictEqual(row.last_seen_id, 7);
    assert.strictEqual(row.notify_cursor, 7, 'a lagging notify cursor catches up to last_seen_id');
    assert.strictEqual(row.capabilities_json, null);
  });
});
