// One-time (re-runnable) backfill: connect every embedded doc to its
// neighbors. Writes doc_links edges, appends a "## Related" wikilink section
// to vault files that lack one, and records near-duplicate pairs (>= dup
// threshold) as kind 'near-dup' so synthesis can flag them for merging.
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getDb } from '../db.js';
import { bufferToEmbedding, cosineSimilarity } from '../embeddings/embed.js';
import {
  insertDocLinks, renderRelatedSection, RELATED_MIN, RELATED_K, DUP_THRESHOLD,
} from '../write-note.js';
import { indexVault } from '../vault/indexer.js';

export async function linkBackfill() {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) {
    console.error('Error: OBSIDIAN_VAULT_PATH not set');
    process.exit(1);
  }

  const rows = getDb().prepare(`
    SELECT e.document_id, e.vault_path, e.embedding, d.title
    FROM embeddings e JOIN documents d ON d.id = e.document_id
  `).all();
  const docs = rows.map(r => ({
    document_id: r.document_id,
    vault_path: r.vault_path,
    title: r.title,
    v: bufferToEmbedding(r.embedding),
  }));
  console.log(`Scoring ${docs.length} docs pairwise...`);

  // ponytail: O(n²) brute force — fine to ~2000 docs, ANN index beyond that.
  let edges = 0, nearDups = 0, filesUpdated = 0;
  for (const a of docs) {
    const related = [], dups = [];
    for (const b of docs) {
      if (b.document_id <= a.document_id) continue; // each pair once
      const s = cosineSimilarity(a.v, b.v);
      if (s >= DUP_THRESHOLD) dups.push({ ...b, score: s });
      else if (s >= RELATED_MIN) related.push({ ...b, score: s });
    }
    related.sort((x, y) => y.score - x.score);
    const top = related.slice(0, RELATED_K);
    insertDocLinks(a.document_id, top);
    insertDocLinks(a.document_id, dups, 'near-dup');
    edges += top.length;
    nearDups += dups.length;

    if (top.length && a.vault_path) {
      try {
        const fp = join(vaultPath, a.vault_path);
        const text = readFileSync(fp, 'utf-8');
        if (!text.includes('\n## Related\n')) {
          writeFileSync(fp, text.trimEnd() + renderRelatedSection(top) + '\n');
          filesUpdated++;
        }
      } catch { /* non-vault or unreadable file — DB edge still exists */ }
    }
  }

  const total = getDb().prepare('SELECT COUNT(*) c FROM doc_links').get().c;
  console.log(`Edges written: ${edges} related, ${nearDups} near-dup (${total} total in doc_links)`);
  console.log(`Vault files given a Related section: ${filesUpdated}`);

  console.log('Reindexing to fold file changes back in...');
  const res = await indexVault(vaultPath, { embeddings: true });
  console.log(`Done: ${res.indexed} indexed, ${res.skipped} unchanged, ${res.embedded} embedded`);
}
