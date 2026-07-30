import { generateEmbedding, cosineSimilarity, bufferToEmbedding } from './embed.js';
import { getDb } from '../db.js';

// The score at or above which a note is a duplicate rather than a relative.
// Lives here because both the write path and kb_check_duplicate must use this
// one value: a check run at a different threshold than the write it precedes
// returns a verdict about a question nobody asked.
export const DUP_THRESHOLD = 0.85;

/**
 * The duplicate verdict, from an already-scored candidate list.
 *
 * Shared so that kb_check_duplicate and the write path cannot answer the same
 * question differently. The write path needs its candidates for related-links
 * as well, so it scores once and calls this — passing the list rather than the
 * text is what keeps it to a single embedding pass.
 */
export function duplicatesIn(similar, threshold = DUP_THRESHOLD) {
  return similar
    .filter((s) => s.score >= threshold)
    .map((s) => ({
      document_id: s.document_id,
      title: s.title,
      tags: s.tags,
      similarity: Math.round(s.score * 1000) / 1000,
    }));
}

// Brute-force cosine similarity — works for <2000 notes.
// If vault exceeds 2000 notes, consider sqlite-vss extension for ANN search.
export async function semanticSearch(query, { limit = 10, project, type, includeSuperseded = false } = {}) {
  const queryEmbedding = await generateEmbedding(query);

  let sql = `
    SELECT e.document_id, e.vault_path, e.chunk_text, e.embedding,
           d.title, d.doc_type, d.tags
    FROM embeddings e
    JOIN documents d ON d.id = e.document_id
  `;
  const conditions = [];
  const params = [];

  if (!includeSuperseded) conditions.push('d.superseded_at IS NULL');
  if (project) {
    sql += ' JOIN vault_files vf ON vf.document_id = e.document_id';
    conditions.push('vf.project = ?');
    params.push(project);
  }
  if (type) {
    conditions.push('d.doc_type = ?');
    params.push(type);
  }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');

  const rows = getDb().prepare(sql).all(...params);

  const scored = rows.map(row => {
    const embedding = bufferToEmbedding(row.embedding);
    const score = cosineSimilarity(queryEmbedding, embedding);
    return {
      document_id: row.document_id,
      vault_path: row.vault_path,
      title: row.title,
      type: row.doc_type,
      tags: row.tags,
      chunk_preview: row.chunk_text?.slice(0, 200),
      score,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// Score `content` against every embedded doc. One pass serves both dedup
// (score >= 0.85) and related-links (0.55 <= score < 0.85).
export async function similarDocs(content, { limit = 10, includeSuperseded = false } = {}) {
  const queryEmbedding = await generateEmbedding(content);

  // Dedup/related-links compare against LIVE notes only — a retired note is
  // not "existing current content", and a fresh note should not link to it.
  const supersededFilter = includeSuperseded ? '' : 'WHERE d.superseded_at IS NULL';
  const rows = getDb().prepare(`
    SELECT e.document_id, e.vault_path, e.embedding, d.title, d.tags
    FROM embeddings e
    JOIN documents d ON d.id = e.document_id
    ${supersededFilter}
  `).all();

  const scored = rows.map(row => ({
    document_id: row.document_id,
    vault_path: row.vault_path,
    title: row.title,
    tags: row.tags,
    score: cosineSimilarity(queryEmbedding, bufferToEmbedding(row.embedding)),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Whether `content` already exists in the KB.
 *
 * `content` must be the note body that will be written, because that is what
 * the write path embeds — a summary of the note scores against a different
 * point in the space and predicts nothing about the write that follows.
 */
export async function checkDuplicate(content, { threshold = DUP_THRESHOLD } = {}) {
  const matches = duplicatesIn(await similarDocs(content, { limit: 50 }), threshold);
  return {
    is_duplicate: matches.length > 0,
    matches: matches.slice(0, 5),
  };
}

export async function hybridSearch(query, { limit = 10, project, type, includeSuperseded = false } = {}) {
  const { searchDocuments } = await import('../db.js');

  let ftsResults, semanticResults;
  try {
    [ftsResults, semanticResults] = await Promise.all([
      Promise.resolve(searchDocuments(query, limit * 2, { includeSuperseded })),
      semanticSearch(query, { limit: limit * 2, project, type, includeSuperseded }),
    ]);
  } catch {
    // If semantic search fails (no embeddings, model error, etc.), fall back to FTS only
    ftsResults = searchDocuments(query, limit * 2, { includeSuperseded });
    semanticResults = [];
  }

  const seen = new Map();

  for (const r of ftsResults) {
    seen.set(r.id, { ...r, fts_rank: r.rank || 0, semantic_score: 0, source: 'fts' });
  }
  for (const r of semanticResults) {
    if (seen.has(r.document_id)) {
      seen.get(r.document_id).semantic_score = r.score;
      seen.get(r.document_id).source = 'both';
    } else {
      seen.set(r.document_id, { id: r.document_id, title: r.title, ...r, fts_rank: 0, source: 'semantic' });
    }
  }

  // Items found by both methods rank highest
  const merged = Array.from(seen.values());
  merged.sort((a, b) => {
    if (a.source === 'both' && b.source !== 'both') return -1;
    if (b.source === 'both' && a.source !== 'both') return 1;
    return (b.semantic_score || 0) - (a.semantic_score || 0);
  });

  return merged.slice(0, limit);
}
