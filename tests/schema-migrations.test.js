import './helpers/tmp-kb.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  configureKnowledgeBaseConnection,
  MIGRATIONS as KB_MIGRATIONS,
} from '../src/db.js';
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
  configureKnowledgeBaseConnection(db);
  applyMigrations(db, migrations);
  return db;
}

function schemaOf(db) {
  return db.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
  ).all();
}

describe('knowledge base migrations', () => {
  it('declares strictly increasing versions', () => {
    const versions = KB_MIGRATIONS.map(m => m.version);
    assert.deepStrictEqual(versions, [...versions].sort((a, b) => a - b));
    assert.strictEqual(new Set(versions).size, versions.length);
  });

  it('leaves nothing pending on a database it just built', () => {
    const db = current(KB_MIGRATIONS);
    assert.deepStrictEqual(pendingMigrations(db, KB_MIGRATIONS), []);
  });

  it('is idempotent — a second pass runs nothing and changes nothing', () => {
    const db = current(KB_MIGRATIONS);
    const before = schemaOf(db);
    assert.deepStrictEqual(applyMigrations(db, KB_MIGRATIONS), []);
    assert.deepStrictEqual(schemaOf(db), before);
  });

  it('bootstraps an empty database on connect', () => {
    const db = new Database(':memory:');
    assert.ok(isEmptyDatabase(db));
    ensureSchemaReady(db, {
      migrations: KB_MIGRATIONS,
      label: 'knowledge base',
      path: ':memory:',
    });
    assert.deepStrictEqual(pendingMigrations(db, KB_MIGRATIONS), []);
  });
});

describe('bootstrapping a fresh database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-bootstrap-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('runs only what the base migration did not already create', () => {
    const kb = new Database(':memory:');
    assert.deepStrictEqual(
      applyMigrations(kb, KB_MIGRATIONS).map(m => m.version),
      [1, 3, 4, 5, 6, 7, 8, 9, 11, 13, 14, 15, 16, 17, 20, 24, 25, 26, 27, 28, 30, 31, 32],
      'the base tables already carry the vault_files summary columns, so 2 is skipped; '
      + '10 only deletes rows a fresh database does not have',
    );
  });

  it('adds model phase timing columns without losing existing calls', () => {
    const kb = new Database(':memory:');
    applyMigrations(kb, KB_MIGRATIONS.filter(migration => migration.version <= 26));
    kb.prepare(`
      INSERT INTO model_calls (
        caller, model, ok, duration_ms, prompt_chars, response_chars
      ) VALUES ('extract', 'test-model', 1, 42, 10, 20)
    `).run();
    const before = kb.prepare('SELECT * FROM model_calls').get();

    applyMigrations(kb, KB_MIGRATIONS);

    const row = kb.prepare(`
      SELECT
        id, caller, model, ok, duration_ms, error, prompt_chars,
        response_chars, created_at, response_ready_ms, shutdown_tail_ms
      FROM model_calls
    `).get();
    assert.deepStrictEqual(row, {
      ...before,
      response_ready_ms: null,
      shutdown_tail_ms: null,
    });
    assert.equal(kb.prepare('SELECT COUNT(*) AS count FROM model_calls').get().count, 1);
  });

  it('adds transcript parser versions without rewriting existing harvest watermarks', () => {
    const kb = new Database(':memory:');
    applyMigrations(kb, KB_MIGRATIONS.filter(migration => migration.version <= 27));
    kb.prepare(`
      INSERT INTO harvest_log (transcript_path, mtime, facts_added, notes_added)
      VALUES ('/tmp/legacy-cursor.jsonl', 1234, NULL, 0)
    `).run();
    const before = kb.prepare('SELECT * FROM harvest_log').get();

    applyMigrations(kb, KB_MIGRATIONS);

    const row = kb.prepare('SELECT * FROM harvest_log').get();
    assert.deepStrictEqual(row, { ...before, parser_version: null });
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
    // 17 and 20 add columns to the same table 6 creates, so dropping it
    // leaves all three pending — 6 to rebuild the table, then the columns.
    assert.deepStrictEqual(pendingMigrations(db, KB_MIGRATIONS).map(m => m.version), [6, 17, 20, 26]);
  });
});

describe('event identity and test-session flag on retrievals (migration 17)', () => {
  it('adds event_id and is_test, leaving pre-existing rows NULL/0', () => {
    const db = current(KB_MIGRATIONS);
    db.exec('DROP TABLE IF EXISTS retrievals');
    db.exec(`
      CREATE TABLE retrievals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id INTEGER,
        surface TEXT NOT NULL,
        query TEXT,
        session TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.prepare("INSERT INTO retrievals (surface, session) VALUES ('hint', 'sess-pre-migration')").run();

    // 20 rides along for the same reason: the hand-built table above predates
    // its column too.
    assert.deepStrictEqual(applyMigrations(db, KB_MIGRATIONS).map(m => m.version), [17, 20, 26]);

    assert.ok(hasColumn(db, 'retrievals', 'event_id'));
    assert.ok(hasColumn(db, 'retrievals', 'is_test'));
    const row = db.prepare('SELECT event_id, is_test FROM retrievals').get();
    assert.strictEqual(row.event_id, null, 'a pre-existing row gets no reconstructed event id');
    assert.strictEqual(row.is_test, 0, 'a pre-existing row is not retroactively classified as a smoke session');
  });

  it('is idempotent-guarded — reports nothing pending once both columns exist', () => {
    const db = current(KB_MIGRATIONS);
    assert.deepStrictEqual(pendingMigrations(db, KB_MIGRATIONS), []);
    assert.deepStrictEqual(applyMigrations(db, KB_MIGRATIONS), []);
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

  it('adds transcript harvest chunk checkpoints', () => {
    const db = current(KB_MIGRATIONS);
    db.exec('DROP TABLE harvest_chunk_log');
    assert.deepStrictEqual(pendingMigrations(db, KB_MIGRATIONS).map(m => m.version), [25]);

    applyMigrations(db, KB_MIGRATIONS);

    assert.ok(hasTable(db, 'harvest_chunk_log'));
    assert.ok(hasIndex(db, 'uq_harvest_chunk_log_content'));
  });

  it('adds retrieval outcome feedback by document version', () => {
    const db = current(KB_MIGRATIONS);
    db.exec('DROP TABLE retrieval_outcomes');
    db.exec('DROP INDEX IF EXISTS uq_retrieval_outcomes_evidence');
    db.exec('ALTER TABLE retrievals DROP COLUMN doc_version');
    assert.deepStrictEqual(pendingMigrations(db, KB_MIGRATIONS).map(m => m.version), [26]);

    applyMigrations(db, KB_MIGRATIONS);

    assert.ok(hasColumn(db, 'retrievals', 'doc_version'));
    assert.ok(hasTable(db, 'retrieval_outcomes'));
    assert.ok(hasIndex(db, 'uq_retrieval_outcomes_evidence'));
    assert.ok(hasIndex(db, 'idx_retrieval_outcomes_doc_version'));
  });

  it('adds nullable attribution without inventing it for historical meter rows', () => {
    const db = new Database(':memory:');
    applyMigrations(db, KB_MIGRATIONS.filter(migration => migration.version <= 28));
    db.exec(`
      DROP INDEX idx_write_decisions_session_created;
      DROP INDEX idx_tool_calls_session_created;
      ALTER TABLE write_decisions DROP COLUMN source;
      ALTER TABLE write_decisions DROP COLUMN agent;
      ALTER TABLE write_decisions DROP COLUMN session;
      ALTER TABLE tool_calls DROP COLUMN agent;
    `);
    db.prepare(`
      INSERT INTO tool_calls (tool, ok, duration_ms, session)
      VALUES ('kb_legacy', 1, 10, 'legacy-session')
    `).run();
    db.prepare(`
      INSERT INTO write_decisions (threshold, refused)
      VALUES (0.82, 0)
    `).run();

    assert.deepStrictEqual(
      applyMigrations(db, KB_MIGRATIONS).map(migration => migration.version),
      [29, 30, 31, 32],
    );

    assert.deepStrictEqual(
      db.prepare('SELECT session, agent, source FROM write_decisions').get(),
      { session: null, agent: null, source: null },
    );
    assert.deepStrictEqual(
      db.prepare('SELECT session, agent FROM tool_calls').get(),
      { session: 'legacy-session', agent: null },
    );
    assert.ok(hasIndex(db, 'idx_write_decisions_session_created'));
    assert.ok(hasIndex(db, 'idx_tool_calls_session_created'));
  });

  it('adds reversible detachment without rewriting document identity or attribution', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrations(db, KB_MIGRATIONS.filter(migration => migration.version <= 29));
    const docId = Number(db.prepare(`
      INSERT INTO documents (title, content, source, doc_type, tier)
      VALUES ('Stable identity', 'historical attribution stays linked', 'vault:state/stable.md', 'state', 'verified')
    `).run().lastInsertRowid);
    db.prepare(`
      INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type)
      VALUES ('state/stable.md', '0123456789abcdef', ?, 'Stable identity', 'state')
    `).run(docId);
    db.prepare(`
      INSERT INTO retrievals (doc_id, surface, session)
      VALUES (?, 'kb_read', 'migration-proof')
    `).run(docId);
    db.prepare(`
      INSERT INTO write_decisions (threshold, refused, doc_id)
      VALUES (0.85, 0, ?)
    `).run(docId);
    const before = db.prepare(
      'SELECT id, tier, created_at, superseded_at, superseded_by FROM documents WHERE id = ?'
    ).get(docId);

    assert.deepStrictEqual(applyMigrations(db, KB_MIGRATIONS).map(m => m.version), [30, 31, 32]);
    assert.ok(hasColumn(db, 'documents', 'detached_at'));
    assert.ok(hasColumn(db, 'vault_files', 'missing_at'));
    assert.ok(hasColumn(db, 'vault_files', 'detached_content_hash'));
    assert.ok(hasTable(db, 'document_tombstones'));
    assert.ok(hasIndex(db, 'idx_documents_attached_current'));
    assert.ok(hasTable(db, 'identity_repair_runs'));
    assert.ok(hasTable(db, 'identity_repair_ledger'));
    assert.deepStrictEqual(
      db.prepare(
        'SELECT id, tier, created_at, superseded_at, superseded_by FROM documents WHERE id = ?'
      ).get(docId),
      before,
    );
    assert.strictEqual(db.prepare('SELECT doc_id FROM retrievals').get().doc_id, docId);
    assert.strictEqual(db.prepare('SELECT doc_id FROM write_decisions').get().doc_id, docId);
  });

  it('rolls back every detachment schema change when migration 30 is interrupted', () => {
    const db = current(KB_MIGRATIONS.filter(migration => migration.version < 30));
    db.exec('CREATE TABLE idx_documents_attached_current (synthetic_collision INTEGER)');

    assert.throws(
      () => applyMigrations(
        db,
        KB_MIGRATIONS.filter(migration => migration.version === 30),
      ),
      /already a table/,
    );
    assert.strictEqual(hasColumn(db, 'documents', 'detached_at'), false);
    assert.strictEqual(hasColumn(db, 'vault_files', 'missing_at'), false);
    assert.strictEqual(hasColumn(db, 'vault_files', 'detached_content_hash'), false);
    assert.strictEqual(hasTable(db, 'document_tombstones'), false);
    assert.ok(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'documents_au'"
    ).get());
  });

  it('rolls back the identity repair ledger when migration 31 is interrupted', () => {
    const db = current(KB_MIGRATIONS.filter(migration => migration.version < 31));
    db.exec('CREATE TABLE identity_repair_ledger (synthetic_collision INTEGER)');

    assert.throws(
      () => applyMigrations(
        db,
        KB_MIGRATIONS.filter(migration => migration.version === 31),
      ),
      /no such column: run_id/,
    );
    assert.strictEqual(hasTable(db, 'identity_repair_runs'), false);
    assert.strictEqual(hasIndex(db, 'idx_identity_repair_ledger_pending_undo'), false);
  });

  it('removes detached rows from FTS and blocks old-client hard deletion', () => {
    const db = current(KB_MIGRATIONS);
    db.pragma('foreign_keys = ON');
    const docId = Number(db.prepare(`
      INSERT INTO documents (title, content, source, doc_type)
      VALUES ('Detach sentinel', 'phrase only the attached index should find', 'vault:state/detach.md', 'state')
    `).run().lastInsertRowid);
    db.prepare(`
      INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type)
      VALUES ('state/detach.md', 'abcdef0123456789', ?, 'Detach sentinel', 'state')
    `).run(docId);
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM documents_fts WHERE documents_fts MATCH 'sentinel'").get().count,
      1,
    );

    db.prepare(`
      UPDATE documents
      SET detached_at = CURRENT_TIMESTAMP, detached_reason = 'vault_missing'
      WHERE id = ?
    `).run(docId);
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM documents_fts WHERE documents_fts MATCH 'sentinel'").get().count,
      0,
    );
    db.prepare('UPDATE documents SET detached_at = NULL, detached_reason = NULL WHERE id = ?').run(docId);
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM documents_fts WHERE documents_fts MATCH 'sentinel'").get().count,
      1,
    );
    db.prepare(`
      INSERT INTO document_tombstones (
        document_id, vault_path, content_hash, detached_at, reason
      ) VALUES (?, 'state/detach.md', 'abcdef0123456789', '2000-01-01T00:00:00.000Z', 'detached_grace_expired')
    `).run(docId);
    assert.throws(
      () => db.prepare('DELETE FROM documents WHERE id = ?').run(docId),
      /audited tombstone/,
    );
    db.prepare('DELETE FROM vault_files WHERE document_id = ?').run(docId);
    assert.throws(
      () => db.prepare('DELETE FROM documents WHERE id = ?').run(docId),
      /audited tombstone/,
      'removing the mutable vault row first must not bypass the tombstone gate',
    );
    assert.ok(db.prepare('SELECT 1 FROM documents WHERE id = ?').get(docId));
  });

  it('fails old vault writers closed after migration 30', () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-old-writer-'));
    const file = join(root, 'kb.db');
    const currentClient = new Database(file);
    configureKnowledgeBaseConnection(currentClient);
    applyMigrations(currentClient, KB_MIGRATIONS);
    const docId = Number(currentClient.prepare(`
      INSERT INTO documents (title, content, source, doc_type)
      VALUES ('Old writer sentinel', 'body', 'vault:state/old.md', 'state')
    `).run().lastInsertRowid);
    currentClient.prepare(`
      INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type)
      VALUES ('state/old.md', ?, ?, 'Old writer sentinel', 'state')
    `).run('a'.repeat(64), docId);
    currentClient.prepare(`
      INSERT INTO embeddings (
        document_id, chunk_index, chunk_text, embedding, dimensions
      ) VALUES (?, 0, 'body', X'00000000', 1)
    `).run(docId);
    currentClient.prepare(`
      UPDATE documents
      SET detached_at = CURRENT_TIMESTAMP, detached_reason = 'vault_missing'
      WHERE id = ?
    `).run(docId);
    currentClient.prepare(`
      UPDATE vault_files
      SET detached_content_hash = content_hash,
          content_hash = 'detached',
          missing_at = CURRENT_TIMESTAMP
      WHERE document_id = ?
    `).run(docId);
    currentClient.close();

    const oldClient = new Database(file);
    try {
      assert.strictEqual(
        oldClient.prepare('SELECT content_hash FROM vault_files WHERE document_id = ?').get(docId).content_hash,
        'detached',
        'an old indexer cannot silently take its unchanged-hash skip path',
      );
      assert.throws(
        () => oldClient.prepare('DELETE FROM embeddings WHERE document_id = ?').run(docId),
        /no such function: kb_writer_schema_version/,
      );
      assert.strictEqual(
        oldClient.prepare('SELECT COUNT(*) AS count FROM embeddings WHERE document_id = ?').get(docId).count,
        1,
      );
      assert.throws(
        () => oldClient.prepare(
          "UPDATE documents SET content = 'old client partial write' WHERE id = ?"
        ).run(docId),
        /no such function: kb_writer_schema_version/,
      );
      assert.throws(
        () => oldClient.prepare(
          "UPDATE vault_files SET content_hash = '0123456789abcdef' WHERE document_id = ?"
        ).run(docId),
        /no such function: kb_writer_schema_version/,
      );
      assert.throws(
        () => oldClient.prepare('DELETE FROM vault_files WHERE document_id = ?').run(docId),
        /no such function: kb_writer_schema_version/,
      );
      assert.strictEqual(
        oldClient.prepare('SELECT content FROM documents WHERE id = ?').get(docId).content,
        'body',
      );
    } finally {
      oldClient.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

});
