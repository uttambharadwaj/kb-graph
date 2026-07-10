import Database from 'better-sqlite3';
import { statSync } from 'fs';
import { DB_PATH } from './paths.js';
import { normalizeTagString } from './tags.js';

let db = null;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 100');  // Checkpoint every 100 pages (~400KB) to prevent WAL bloat
    initSchema(db);

    // Periodic WAL checkpoint every 5 minutes to keep WAL file small
    setInterval(() => {
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch (e) {
        console.error('[KB] WAL checkpoint failed:', e.message);
      }
    }, 5 * 60 * 1000).unref();
  }
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT,
      doc_type TEXT NOT NULL,
      tags TEXT DEFAULT '',
      file_path TEXT,
      file_size INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      title, content, tags,
      content='documents',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, title, content, tags)
      VALUES (new.id, new.title, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, content, tags)
      VALUES('delete', old.id, old.title, old.content, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, content, tags)
      VALUES('delete', old.id, old.title, old.content, old.tags);
      INSERT INTO documents_fts(rowid, title, content, tags)
      VALUES (new.id, new.title, new.content, new.tags);
    END;

    CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_documents_type_created_at ON documents(doc_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source);

    -- Vault file tracking for incremental indexing
    CREATE TABLE IF NOT EXISTS vault_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vault_path TEXT NOT NULL UNIQUE,
      content_hash TEXT NOT NULL,
      document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
      title TEXT,
      note_type TEXT,
      tags TEXT DEFAULT '',
      project TEXT,
      status TEXT DEFAULT 'active',
      source TEXT,
      confidence TEXT,
      summary TEXT,
      key_topics TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_vault_files_hash ON vault_files(content_hash);
    CREATE INDEX IF NOT EXISTS idx_vault_files_type ON vault_files(note_type);
    CREATE INDEX IF NOT EXISTS idx_vault_files_project ON vault_files(project);
  `);

  // Migration: add summary and key_topics columns if missing
  const cols = db.prepare("PRAGMA table_info(vault_files)").all().map(c => c.name);
  if (!cols.includes('summary')) {
    db.prepare('ALTER TABLE vault_files ADD COLUMN summary TEXT').run();
  }
  if (!cols.includes('key_topics')) {
    db.prepare('ALTER TABLE vault_files ADD COLUMN key_topics TEXT').run();
  }

  db.exec(`

    -- Embeddings for semantic search (stored as Float32Array binary blobs)
    CREATE TABLE IF NOT EXISTS embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      vault_path TEXT,
      chunk_index INTEGER DEFAULT 0,
      chunk_text TEXT,
      embedding BLOB NOT NULL,
      dimensions INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_embeddings_doc ON embeddings(document_id);
    CREATE INDEX IF NOT EXISTS idx_embeddings_vault ON embeddings(vault_path);

    -- Doc-to-doc relatedness edges (embedding neighbors at write/backfill time)
    CREATE TABLE IF NOT EXISTS doc_links (
      from_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      to_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      score REAL NOT NULL,
      kind TEXT DEFAULT 'related',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(from_id, to_id, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_doc_links_from ON doc_links(from_id);
    CREATE INDEX IF NOT EXISTS idx_doc_links_to ON doc_links(to_id);

    -- Temporal fact graph (entities + relationship triples with validity windows)
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'unknown',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      valid_from TEXT,
      valid_to TEXT,
      source TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (subject) REFERENCES entities(id),
      FOREIGN KEY (object) REFERENCES entities(id)
    );

    CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject);
    CREATE INDEX IF NOT EXISTS idx_facts_object ON facts(object);
    CREATE INDEX IF NOT EXISTS idx_facts_predicate ON facts(predicate);
    CREATE INDEX IF NOT EXISTS idx_facts_valid ON facts(valid_from, valid_to);

    -- Alias -> canonical entity id (see facts.js)
    CREATE TABLE IF NOT EXISTS entity_aliases (
      alias TEXT PRIMARY KEY,
      canonical TEXT NOT NULL
    );

    -- Alias -> canonical tag (see tags.js)
    CREATE TABLE IF NOT EXISTS tag_aliases (
      alias TEXT PRIMARY KEY,
      canonical TEXT NOT NULL
    );
  `);

  db.exec(`
    -- Pipeline heartbeats and other scalar system state (key/value)
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Nightly transcript-harvest watermarks (core schema so health checks
    -- can read it before the first harvest ever runs)
    CREATE TABLE IF NOT EXISTS harvest_log (
      transcript_path TEXT PRIMARY KEY,
      mtime INTEGER NOT NULL,
      harvested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      facts_added INTEGER DEFAULT 0,
      notes_added INTEGER DEFAULT 0
    );
  `);

  // Migration: embeddings originally had no unique key, so INSERT OR REPLACE
  // never conflicted and every re-embed added a duplicate row. Dedupe (keep
  // newest) and enforce uniqueness so REPLACE works as intended.
  const hasUnique = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='index' AND name='uq_embeddings_doc_chunk'"
  ).get();
  if (!hasUnique) {
    db.exec(`
      DELETE FROM embeddings WHERE id NOT IN (
        SELECT MAX(id) FROM embeddings GROUP BY document_id, chunk_index
      );
      CREATE UNIQUE INDEX uq_embeddings_doc_chunk ON embeddings(document_id, chunk_index);
    `);
  }
}

export { initSchema, getDb };

export function insertDocument({ title, content, source, doc_type, tags, file_path, file_size }) {
  const normTags = normalizeTagString(tags);
  const stmt = getDb().prepare(`
    INSERT INTO documents (title, content, source, doc_type, tags, file_path, file_size)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(title, content, source || null, doc_type, normTags, file_path || null, file_size || 0);
  return {
    id: result.lastInsertRowid,
    title,
    content,
    source: source || null,
    doc_type,
    tags: normTags,
    file_path: file_path || null,
    file_size: file_size || 0,
  };
}

export function updateDocument(id, { title, tags }) {
  const stmt = getDb().prepare(`
    UPDATE documents SET title = ?, tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `);
  return stmt.run(title, normalizeTagString(tags), id);
}

export function deleteDocument(id) {
  const doc = getDb().prepare('SELECT file_path FROM documents WHERE id = ?').get(id);
  getDb().prepare('DELETE FROM documents WHERE id = ?').run(id);
  return doc ? doc.file_path : null;
}

// Common English stop words to filter from search queries
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
  'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than', 'too',
  'very', 'just', 'because', 'if', 'when', 'where', 'how', 'what',
  'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'i', 'me',
  'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her',
  'it', 'its', 'they', 'them', 'their', 'about', 'up',
]);

export function searchDocuments(query, limit = 20, { tags } = {}) {
  // Build optional tag filter clause
  const tagFilter = tags ? 'AND d.tags LIKE ?' : '';
  const tagParam = tags ? `%${tags}%` : null;

  // Strip punctuation, split into terms, remove stop words
  const terms = query
    .replace(/['"]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map(t => t.toLowerCase())
    .filter(t => !STOP_WORDS.has(t) && t.length > 1);

  if (terms.length === 0) {
    // All terms were stop words — fall back to original terms
    const fallback = query.replace(/['"]/g, '').split(/\s+/).filter(Boolean);
    if (fallback.length === 0) return [];
    const sanitized = fallback.map(term => `"${term}"`).join(' OR ');
    const stmt = getDb().prepare(`
      SELECT d.id, d.title,
        snippet(documents_fts, 1, '<mark>', '</mark>', '...', 30) as snippet,
        d.doc_type, d.tags, d.file_size, d.created_at,
        bm25(documents_fts, 10.0, 1.0, 5.0) as rank
      FROM documents_fts f
      JOIN documents d ON d.id = f.rowid
      WHERE documents_fts MATCH ?
      ${tagFilter}
      ORDER BY rank
      LIMIT ?
    `);
    const params = tagParam ? [sanitized, tagParam, limit] : [sanitized, limit];
    return stmt.all(...params);
  }

  // Build FTS5 query: AND-first for precision, OR fallback for recall
  // Title-boosted ranking via bm25() weights: title=10x, content=1x, tags=5x
  const andQuery = terms.map(term => `"${term}" *`).join(' AND ');
  const orQuery = terms.map(term => `"${term}" *`).join(' OR ');

  const stmt = getDb().prepare(`
    SELECT d.id, d.title,
      snippet(documents_fts, 1, '<mark>', '</mark>', '...', 30) as snippet,
      d.doc_type, d.tags, d.file_size, d.created_at,
      bm25(documents_fts, 10.0, 1.0, 5.0) as rank
    FROM documents_fts f
    JOIN documents d ON d.id = f.rowid
    WHERE documents_fts MATCH ?
    ${tagFilter}
    ORDER BY rank
    LIMIT ?
  `);

  // Try AND first for precision; fall back to OR if no results
  const params = tagParam ? [andQuery, tagParam, limit] : [andQuery, limit];
  let results = stmt.all(...params);
  if (results.length === 0 && terms.length > 1) {
    const orParams = tagParam ? [orQuery, tagParam, limit] : [orQuery, limit];
    results = stmt.all(...orParams);
  }

  // If OR gives too many low-quality results, re-rank: boost docs matching more terms
  if (terms.length > 1 && results.length > 0) {
    for (const r of results) {
      const titleLower = (r.title || '').toLowerCase();
      const tagsLower = (r.tags || '').toLowerCase();
      let termBoost = 0;
      for (const term of terms) {
        if (titleLower.includes(term)) termBoost += 20;  // title match is very strong
        if (tagsLower.includes(term)) termBoost += 10;   // tag match is strong
      }
      // rank is negative (lower = better in bm25), so subtract boost to improve ranking
      r.rank = r.rank - termBoost;
    }
    results.sort((a, b) => a.rank - b.rank);
  }

  return results;
}

export function listDocuments({ type, tag, limit = 50, offset = 0 } = {}) {
  let sql = 'SELECT id, title, doc_type, tags, file_size, source, created_at, updated_at FROM documents';
  const conditions = [];
  const params = [];

  if (type) {
    conditions.push('doc_type = ?');
    params.push(type);
  }
  if (tag) {
    conditions.push("tags LIKE '%' || ? || '%'");
    params.push(tag);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return getDb().prepare(sql).all(...params);
}

export function getDocument(id) {
  return getDb().prepare('SELECT * FROM documents WHERE id = ?').get(id) || null;
}

export function getStats() {
  const count = getDb().prepare('SELECT COUNT(*) as count FROM documents').get().count;
  const totalSize = getDb().prepare('SELECT COALESCE(SUM(file_size), 0) as total FROM documents').get().total;
  let dbFileSize = 0;
  try {
    dbFileSize = statSync(DB_PATH).size;
  } catch {
    // DB file may not exist yet
  }
  return { count, totalSize, dbFileSize };
}

export function getDocumentCount() {
  return getDb().prepare('SELECT COUNT(*) as count FROM documents').get().count;
}

export function updateDocumentFull(id, { title, content, tags, doc_type, source, file_path, file_size }) {
  const stmt = getDb().prepare(`
    UPDATE documents SET title = ?, content = ?, tags = ?, doc_type = ?, source = ?, file_path = ?, file_size = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `);
  return stmt.run(title, content, tags, doc_type, source, file_path, file_size, id);
}

export function getVaultFile(vaultPath) {
  return getDb().prepare('SELECT * FROM vault_files WHERE vault_path = ?').get(vaultPath);
}

export function upsertVaultFile({ vault_path, content_hash, document_id, title, note_type, tags, project, status, source, confidence, summary, key_topics }) {
  const stmt = getDb().prepare(`
    INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type, tags, project, status, source, confidence, summary, key_topics, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(vault_path) DO UPDATE SET
      content_hash = excluded.content_hash,
      document_id = excluded.document_id,
      title = excluded.title,
      note_type = excluded.note_type,
      tags = excluded.tags,
      project = excluded.project,
      status = excluded.status,
      source = excluded.source,
      confidence = excluded.confidence,
      summary = excluded.summary,
      key_topics = excluded.key_topics,
      indexed_at = CURRENT_TIMESTAMP
  `);
  return stmt.run(vault_path, content_hash, document_id, title, note_type, tags || '', project, status, source, confidence, summary || null, key_topics ? JSON.stringify(key_topics) : null);
}

export function deleteVaultFile(vaultPath) {
  const vf = getDb().prepare('SELECT document_id FROM vault_files WHERE vault_path = ?').get(vaultPath);
  if (vf && vf.document_id) {
    getDb().prepare('DELETE FROM documents WHERE id = ?').run(vf.document_id);
  }
  getDb().prepare('DELETE FROM vault_files WHERE vault_path = ?').run(vaultPath);
}

export function getAllVaultPaths() {
  return getDb().prepare('SELECT vault_path, content_hash FROM vault_files').all();
}

export function setMeta(key, value) {
  getDb().prepare(
    'INSERT INTO meta (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP'
  ).run(key, String(value));
}

export function getMeta(key) {
  return getDb().prepare('SELECT value, updated_at FROM meta WHERE key = ?').get(key) || null;
}

// One health snapshot for wakeup/status: derived-layer coverage plus job
// heartbeats, with a warning string per stale/failed component. The KB's
// worst historical failure mode is silent degradation — this is the alarm.
export function getHealth() {
  const db = getDb();
  const docs = db.prepare('SELECT COUNT(*) c FROM documents').get().c;
  const embedded = db.prepare('SELECT COUNT(DISTINCT document_id) c FROM embeddings').get().c;
  const vaultFiles = db.prepare('SELECT COUNT(*) c FROM vault_files').get().c;
  const summarized = db.prepare(
    "SELECT COUNT(*) c FROM vault_files WHERE summary IS NOT NULL AND summary != ''"
  ).get().c;

  const ageHours = (row) => row ? (Date.now() - new Date(row.updated_at + 'Z').getTime()) / 3600000 : null;
  const reindex = getMeta('last_reindex');
  const harvestRow = db.prepare(
    "SELECT MAX(harvested_at) t FROM harvest_log"
  ).get();
  const harvestAge = harvestRow?.t ? (Date.now() - new Date(harvestRow.t + 'Z').getTime()) / 3600000 : null;
  const synthesis = getMeta('last_synthesis');

  const warnings = [];
  if (docs - embedded > 25) warnings.push(`${docs - embedded} docs missing embeddings — run 'kb vault reindex'`);
  if (vaultFiles - summarized > 50) warnings.push(`${vaultFiles - summarized} notes missing summaries — run 'kb summarize'`);
  const reindexAge = ageHours(reindex);
  if (reindexAge === null || reindexAge > 1) warnings.push(`reindex heartbeat ${reindexAge === null ? 'never recorded' : Math.round(reindexAge) + 'h old'} — check com.kb.reindex launchd job`);
  if (harvestAge === null || harvestAge > 48) warnings.push(`harvest ${harvestAge === null ? 'never ran' : Math.round(harvestAge) + 'h ago'} — check com.kb.harvest launchd job`);
  const synthAge = ageHours(synthesis);
  if (synthAge === null || synthAge > 192) warnings.push(`synthesis ${synthAge === null ? 'never recorded' : Math.round(synthAge / 24) + 'd ago'} — check com.kb.synthesis launchd job`);

  return {
    embeddings: `${embedded}/${docs}`,
    summaries: `${summarized}/${vaultFiles}`,
    last_reindex: reindex?.updated_at || null,
    last_harvest: harvestRow?.t || null,
    last_synthesis: synthesis?.updated_at || null,
    ok: warnings.length === 0,
    warnings,
  };
}
