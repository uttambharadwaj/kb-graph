import { hasColumn, hasTable } from './schema.js';

// Stable per-retrieval content identity. Prefer the vault index hash because it
// changes when the indexed note changes; fall back to the document timestamp for
// rows that are not backed by a vault file.
export function snapshotDocumentVersion(db, docId) {
  if (docId == null) return null;
  if (hasTable(db, 'vault_files') && hasColumn(db, 'vault_files', 'content_hash')) {
    const row = db.prepare(`
      SELECT content_hash
      FROM vault_files
      WHERE document_id = ? AND content_hash IS NOT NULL AND content_hash != ''
      ORDER BY indexed_at DESC, id DESC
      LIMIT 1
    `).get(docId);
    if (row?.content_hash) return row.content_hash;
  }
  if (hasTable(db, 'documents') && hasColumn(db, 'documents', 'updated_at')) {
    const row = db.prepare('SELECT updated_at FROM documents WHERE id = ?').get(docId);
    if (row?.updated_at) return row.updated_at;
  }
  return null;
}
