// Point the KB at a throwaway dir BEFORE anything opens the real DB.
import './helpers/tmp-kb.js';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

const { MIGRATIONS, configureKnowledgeBaseConnection, getDb, upsertVaultFile } = await import('../src/db.js');
const { applyMigrations, pendingMigrations } = await import('../src/schema.js');
const { normalizeVaultPath } = await import('../src/vault/vault-path.js');
const { indexVault } = await import('../src/vault/indexer.js');
const { setNoteTier } = await import('../src/write-note.js');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

// A database a Windows indexer and a POSIX indexer have both written to,
// stopped just short of migration 32.
function sharedPlatformFixture() {
  const db = new Database(':memory:');
  configureKnowledgeBaseConnection(db);
  applyMigrations(db, MIGRATIONS.filter(m => m.version < 32));
  const doc = (title, source, extra = '') => Number(db.prepare(`
    INSERT INTO documents (title, content, source, doc_type${extra ? ', detached_at, detached_reason' : ''})
    VALUES (?, ?, ?, 'lesson'${extra ? ", '2026-10-01 00:00:00', 'vault_missing'" : ''})
  `).run(title, `${title} body`, source).lastInsertRowid);
  const file = (path, hash, documentId, missing = false) => db.prepare(`
    INSERT INTO vault_files (vault_path, content_hash, detached_content_hash, document_id, title, note_type, missing_at)
    VALUES (?, ?, ?, ?, 't', 'lesson', ?)
  `).run(
    path,
    missing ? 'detached' : hash,
    missing ? hash : null,
    documentId,
    missing ? '2026-10-01 00:00:00' : null,
  );

  // Indexed only on Windows.
  const lone = doc('Lone', 'vault:agents\\lessons\\lone.md');
  file('agents\\lessons\\lone.md', HASH_A, lone);
  db.prepare(`
    INSERT INTO embeddings (document_id, vault_path, chunk_index, chunk_text, embedding, dimensions)
    VALUES (?, 'agents\\lessons\\lone.md', 0, 'x', x'00', 1)
  `).run(lone);
  db.prepare(`
    INSERT INTO document_tombstones (document_id, vault_path, content_hash, detached_at, reason)
    VALUES (999, 'old\\gone.md', ?, '2026-01-01', 'detached_grace_expired')
  `).run(HASH_A);

  // Indexed on Windows, then written from WSL: two live documents for one file.
  const original = doc('Both live', 'vault:agents\\lessons\\both.md');
  file('agents\\lessons\\both.md', HASH_A, original);
  const duplicate = doc('Both live', 'vault:agents/lessons/both.md');
  file('agents/lessons/both.md', HASH_B, duplicate);

  // Reindexed from WSL after an edit: the Windows row was already detached.
  const stale = doc('Edited', 'vault:agents\\lessons\\edited.md', 'detached');
  file('agents\\lessons\\edited.md', HASH_A, stale, true);
  const current = doc('Edited', 'vault:agents/lessons/edited.md');
  file('agents/lessons/edited.md', HASH_B, current);

  return { db, ids: { lone, original, duplicate, stale, current } };
}

const pathOf = (db, documentId) =>
  db.prepare('SELECT vault_path FROM vault_files WHERE document_id = ?').get(documentId)?.vault_path;
const detachedAt = (db, documentId) =>
  db.prepare('SELECT detached_at FROM documents WHERE id = ?').get(documentId).detached_at;

describe('normalizeVaultPath', () => {
  it('stores Windows separators as /, and leaves POSIX paths alone', () => {
    assert.strictEqual(normalizeVaultPath('agents\\lessons\\note.md'), 'agents/lessons/note.md');
    assert.strictEqual(normalizeVaultPath('agents/lessons/note.md'), 'agents/lessons/note.md');
  });
});

describe('migration 32 — portable vault path separators', () => {
  it('is pending on a database holding Windows-indexed paths, and previews the change', () => {
    const { db } = sharedPlatformFixture();
    const pending = pendingMigrations(db, MIGRATIONS);
    assert.deepStrictEqual(pending.map(m => m.version), [32]);
    assert.strictEqual(pending[0].preview(db), '2 vault paths rewritten to / separators, 2 duplicate rows merged');
  });

  it('rewrites every stored spelling and merges rows that become one path', () => {
    const { db, ids } = sharedPlatformFixture();
    assert.deepStrictEqual(applyMigrations(db, MIGRATIONS).map(m => m.version), [32]);
    assert.deepStrictEqual(pendingMigrations(db, MIGRATIONS), []);

    assert.strictEqual(pathOf(db, ids.lone), 'agents/lessons/lone.md');
    assert.strictEqual(
      db.prepare('SELECT vault_path FROM embeddings WHERE document_id = ?').get(ids.lone).vault_path,
      'agents/lessons/lone.md',
    );
    assert.strictEqual(
      db.prepare('SELECT vault_path FROM document_tombstones WHERE document_id = 999').get().vault_path,
      'old/gone.md',
    );

    // Both live: the older identity keeps the file; the duplicate detaches.
    assert.strictEqual(pathOf(db, ids.original), 'agents/lessons/both.md');
    assert.strictEqual(detachedAt(db, ids.original), null);
    assert.strictEqual(pathOf(db, ids.duplicate), undefined);
    assert.notStrictEqual(detachedAt(db, ids.duplicate), null);

    // One side already detached: the live row survives.
    assert.strictEqual(pathOf(db, ids.current), 'agents/lessons/edited.md');
    assert.strictEqual(detachedAt(db, ids.current), null);
    assert.strictEqual(pathOf(db, ids.stale), undefined);

    assert.strictEqual(
      db.prepare("SELECT COUNT(*) AS c FROM vault_files WHERE instr(vault_path, char(92)) > 0").get().c,
      0,
    );
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) AS c FROM documents WHERE instr(source, char(92)) > 0").get().c,
      0,
    );
  });

  it('makes a Windows-indexed note promotable from POSIX (#190)', () => {
    const { db, ids } = sharedPlatformFixture();
    const vault = mkdtempSync(join(tmpdir(), 'kb-vault-190-'));
    mkdirSync(join(vault, 'agents', 'lessons'), { recursive: true });
    const note = join(vault, 'agents', 'lessons', 'lone.md');
    writeFileSync(note, '---\ntitle: Lone\n---\nLone body\n');

    applyMigrations(db, MIGRATIONS);
    setNoteTier(vault, pathOf(db, ids.lone), { tier: 'verified', ref: 'checked' });
    assert.match(readFileSync(note, 'utf-8'), /tier: verified/);
  });

  it('refuses a new backslash path from a writer that predates the fix', () => {
    const { db, ids } = sharedPlatformFixture();
    applyMigrations(db, MIGRATIONS);
    assert.throws(
      () => db.prepare(`
        INSERT INTO vault_files (vault_path, content_hash, document_id) VALUES ('a\\b.md', ?, ?)
      `).run(HASH_A, ids.lone),
      /vault paths must use \/ separators/,
    );
    assert.throws(
      () => db.prepare('UPDATE vault_files SET vault_path = ? WHERE document_id = ?')
        .run('agents\\lessons\\lone.md', ids.lone),
      /vault paths must use \/ separators/,
    );
    assert.throws(
      () => db.prepare("UPDATE documents SET source = 'vault:a\\b.md' WHERE id = ?").run(ids.lone),
      /vault paths must use \/ separators/,
    );
    // Non-vault sources are not paths and are left alone.
    db.prepare("UPDATE documents SET source = 'web:C:\\notes' WHERE id = ?").run(ids.lone);
  });

  it('reports applied on a fresh database', () => {
    const db = new Database(':memory:');
    configureKnowledgeBaseConnection(db);
    applyMigrations(db, MIGRATIONS);
    assert.deepStrictEqual(pendingMigrations(db, MIGRATIONS), []);
  });
});

describe('vault indexing', () => {
  it('stores nested note paths with / separators', async () => {
    const vault = process.env.OBSIDIAN_VAULT_PATH;
    mkdirSync(join(vault, 'agents', 'lessons'), { recursive: true });
    writeFileSync(join(vault, 'agents', 'lessons', 'nested.md'), '---\ntitle: Nested\n---\nNested body\n');
    const result = await indexVault(vault);
    assert.deepStrictEqual(result.errors, []);
    assert.ok(getDb().prepare("SELECT 1 FROM vault_files WHERE vault_path = 'agents/lessons/nested.md'").get());
  });

  it('cannot store a Windows-spelled path through the DB boundary', () => {
    assert.throws(
      () => upsertVaultFile({ vault_path: 'agents\\lessons\\nested.md', content_hash: HASH_A, document_id: null }),
      /vault paths must use \/ separators/,
    );
  });
});
