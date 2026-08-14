// Point the KB at a throwaway dir BEFORE anything opens the real DB.
import './helpers/tmp-kb.js';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

const { MIGRATIONS } = await import('../src/db.js');
const { applyMigrations, hasColumn, pendingMigrations } = await import('../src/schema.js');

// The live-database shape this migration exists for: extractions was created by
// migration 7 BEFORE from_preview was added to its CREATE TABLE, so the table
// exists, migration 7 reports applied, and the column is missing.
function preFromPreviewFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kb-migration-19-'));
  const db = new Database(join(dir, 'kb.db'));
  applyMigrations(db, MIGRATIONS.filter(m => m.version < 19));
  db.exec(`
    CREATE TABLE extractions_old AS SELECT id, input_hash, input_chars, chunk_count,
      chunk_chars, emitted_count, skipped_count, chunk_failures, dry_run, failed,
      duration_ms, source, created_at FROM extractions;
    DROP TABLE extractions;
    ALTER TABLE extractions_old RENAME TO extractions;
  `);
  return db;
}

describe('migration 19 — from_preview on extractions', () => {
  it('is pending on a database whose extractions table predates the column', () => {
    const db = preFromPreviewFixture();
    assert.ok(!hasColumn(db, 'extractions', 'from_preview'));
    assert.ok(pendingMigrations(db, MIGRATIONS).map(m => m.version).includes(19));
    db.close();
  });

  it('adds the column, after which the logging INSERT succeeds', () => {
    const db = preFromPreviewFixture();
    applyMigrations(db, MIGRATIONS);
    assert.ok(hasColumn(db, 'extractions', 'from_preview'));
    db.prepare(`
      INSERT INTO extractions (input_hash, input_chars, chunk_count, chunk_chars,
        emitted_count, skipped_count, chunk_failures, dry_run, failed, from_preview,
        duration_ms, source)
      VALUES ('h', 1, 1, '[1]', 0, 0, 0, 0, 0, 1, 5, 'test')
    `).run();
    assert.strictEqual(db.prepare('SELECT from_preview FROM extractions').get().from_preview, 1);
    db.close();
  });

  it('reports applied on a fresh database, where migration 7 creates the column itself', () => {
    const db = new Database(':memory:');
    applyMigrations(db, MIGRATIONS);
    assert.ok(!pendingMigrations(db, MIGRATIONS).length);
    db.close();
  });
});
