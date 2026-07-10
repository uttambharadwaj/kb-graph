// Shared note-writing path: dedup, frontmatter, related-links, index.
// Used by the kb_write MCP tool and the harvest pipeline so every note —
// human-triggered or automatic — enters the KB the same way, connected.
import { writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { similarDocs } from './embeddings/search.js';
import { indexVaultFile } from './vault/indexer.js';
import { getVaultFile, getDb } from './db.js';
import { splitTags } from './tags.js';

export const DUP_THRESHOLD = 0.85;
export const RELATED_MIN = 0.55;
export const RELATED_K = 3;

const FOLDER_MAP = {
  capture: 'inbox',
  research: 'research',
  idea: 'ideas',
  workflow: 'workflows',
  lesson: 'agents/lessons',
  fix: 'builds/fixes',
  decision: 'decisions',
  session: 'builds/sessions',
};

export function renderRelatedSection(related) {
  if (!related.length) return '';
  const lines = related.map(r =>
    `- [[${basename(r.vault_path || '', '.md')}]] — ${r.title} (${Math.round(r.score * 100) / 100})`
  );
  return `\n\n## Related\n${lines.join('\n')}`;
}

export function insertDocLinks(fromId, related, kind = 'related') {
  const db = getDb();
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO doc_links (from_id, to_id, score, kind) VALUES (?, ?, ?, ?)'
  );
  for (const r of related) {
    if (!r.document_id || r.document_id === fromId) continue;
    // Canonical direction (low id -> high id) so a pair is stored once.
    const [a, b] = fromId < r.document_id ? [fromId, r.document_id] : [r.document_id, fromId];
    stmt.run(a, b, Math.round(r.score * 1000) / 1000, kind);
  }
}

export function relatedForDoc(docId, { limit = 5 } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT l.to_id as id, l.score, d.title FROM doc_links l JOIN documents d ON d.id = l.to_id WHERE l.from_id = ?
    UNION
    SELECT l.from_id as id, l.score, d.title FROM doc_links l JOIN documents d ON d.id = l.from_id WHERE l.to_id = ?
    ORDER BY score DESC LIMIT ?
  `).all(docId, docId, limit);
}

export async function writeNote(vaultPath, { title, content, type = 'capture', tags, project, source }) {
  // One embedding pass drives both dedup and related-links. If the semantic
  // layer is down, say so — a silent skip reads as "no duplicates found".
  let similar = [];
  let warning = '';
  try {
    similar = await similarDocs(content, { limit: 10 });
  } catch (err) {
    warning = ` [dedup/links skipped: ${err.message} — run 'kb vault reindex' to build embeddings]`;
  }

  const dups = similar.filter(s => s.score >= DUP_THRESHOLD);
  if (dups.length) {
    return {
      skipped: true,
      reason: 'duplicate_detected',
      matches: dups.slice(0, 5).map(s => ({
        document_id: s.document_id,
        title: s.title,
        similarity: Math.round(s.score * 1000) / 1000,
      })),
    };
  }
  const related = similar
    .filter(s => s.score >= RELATED_MIN && s.score < DUP_THRESHOLD)
    .slice(0, RELATED_K);

  const folder = FOLDER_MAP[type] || 'inbox';
  const destDir = join(vaultPath, folder);
  mkdirSync(destDir, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const filename = `${date}-${slug}.md`;
  const relPath = `${folder}/${filename}`;

  const tagList = tags ? splitTags(tags) : [];
  const fm = [
    '---',
    // JSON.stringify escapes quotes/backslashes — a bare "${title}" breaks YAML when the title contains quotes
    `title: ${JSON.stringify(title)}`,
    `type: ${type}`,
    `created: "${date}"`,
    `updated: "${date}"`,
    `tags: [${tagList.join(', ')}]`,
  ];
  if (project) fm.push(`project: ${project.trim().toLowerCase()}`);
  if (source) fm.push(`source: ${JSON.stringify(source)}`);
  fm.push('status: active');
  fm.push('---');

  writeFileSync(join(destDir, filename), fm.join('\n') + '\n\n' + content + renderRelatedSection(related));

  let indexStatus = '';
  try {
    const result = await indexVaultFile(vaultPath, relPath, { embeddings: true });
    const warn = result.errors?.length ? `; index warnings: ${result.errors.join('; ')}` : '';
    indexStatus = `; indexed ${result.indexed} changed, ${result.skipped} unchanged${warn}`;
  } catch (error) {
    indexStatus = `; index failed: ${error.message}`;
  }

  const docId = getVaultFile(relPath)?.document_id || null;
  if (docId) insertDocLinks(docId, related);

  return {
    skipped: false,
    path: relPath,
    docId,
    related: related.map(r => ({ id: r.document_id, title: r.title, score: Math.round(r.score * 100) / 100 })),
    status: indexStatus + warning,
  };
}
