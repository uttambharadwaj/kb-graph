import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, extname, isAbsolute } from 'path';
import { createHash } from 'crypto';
import { parseVaultNote } from './parser.js';
import { normalizeTagString } from '../tags.js';
import { filterAliases } from '../hint-relevance.js';
import { filterTriggers, rebuildTriggerIndex } from '../trigger-relevance.js';
import {
  insertDocument, updateDocumentFull, getDb,
  getVaultFile, upsertVaultFile, deleteVaultFile, getAllVaultPaths,
} from '../db.js';

let indexQueue = Promise.resolve();

const IGNORE_DIRS = new Set(['.obsidian', '.trash', '.git', '_assets', '_system', 'node_modules', 'textgenerator']);
const IGNORE_FILES = new Set(['.DS_Store', 'Thumbs.db']);

export function scanVault(vaultPath) {
  const results = [];

  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') && IGNORE_DIRS.has(entry.name)) continue;
      if (IGNORE_DIRS.has(entry.name)) continue;

      const fullPath = join(dir, entry.name);
      let linkedStat = null;
      if (entry.isSymbolicLink()) {
        try {
          linkedStat = statSync(fullPath);
        } catch {
          continue;
        }
      }

      const isDir = entry.isDirectory() || linkedStat?.isDirectory();
      const isFile = entry.isFile() || linkedStat?.isFile();
      if (isDir) {
        walk(fullPath);
      } else if (isFile) {
        if (IGNORE_FILES.has(entry.name)) continue;
        if (entry.name.startsWith('.sync-conflict')) continue;
        if (extname(entry.name).toLowerCase() === '.md') {
          results.push(fullPath);
        }
      }
    }
  }

  walk(vaultPath);
  return results;
}

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export async function indexVault(vaultPath, { embeddings = false } = {}) {
  const queuedRun = indexQueue.then(
    () => _indexVault(vaultPath, { embeddings }),
    () => _indexVault(vaultPath, { embeddings }),
  );
  indexQueue = queuedRun.catch(() => {});
  return queuedRun;
}

// `deferTriggerIndex`: skip the per-file rebuildTriggerIndex() call even when
// this file's own triggers column changed, and report that fact on the
// result instead — for a caller doing K of these in a loop (triggers-backfill)
// that wants exactly one rebuild at the end, not K. Every other caller omits
// it and keeps today's behavior (rebuild inline, per changed file).
export async function indexVaultFile(vaultPath, vaultFilePath, { embeddings = false, deferTriggerIndex = false } = {}) {
  const queuedRun = indexQueue.then(
    () => _indexVaultFile(vaultPath, vaultFilePath, { embeddings, deferTriggerIndex }),
    () => _indexVaultFile(vaultPath, vaultFilePath, { embeddings, deferTriggerIndex }),
  );
  indexQueue = queuedRun.catch(() => {});
  return queuedRun;
}

async function _indexVaultFile(vaultPath, vaultFilePath, { embeddings = false, deferTriggerIndex = false } = {}) {
  const filePath = isAbsolute(vaultFilePath) ? vaultFilePath : join(vaultPath, vaultFilePath);
  const relPath = relative(vaultPath, filePath);
  if (relPath.startsWith('..') || isAbsolute(relPath)) {
    return { indexed: 0, skipped: 0, deleted: 0, embedded: 0, triggersChanged: false, errors: [`${vaultFilePath}: outside vault`], total: 1 };
  }

  if (extname(filePath).toLowerCase() !== '.md') {
    return { indexed: 0, skipped: 0, deleted: 0, embedded: 0, triggersChanged: false, errors: [`${relPath}: unsupported file type`], total: 1 };
  }

  const existing = getVaultFile(relPath);
  const content = readFileSync(filePath, 'utf-8');
  const hash = hashContent(content);
  if (existing?.content_hash === hash) {
    return { indexed: 0, skipped: 1, deleted: 0, embedded: 0, triggersChanged: false, errors: [], total: 1 };
  }

  const result = { indexed: 0, skipped: 0, deleted: 0, embedded: 0, triggersChanged: false, errors: [], total: 1 };
  const embeddingHelpers = embeddings ? await loadEmbeddingHelpers(result.errors) : false;
  const { embedded, triggersChanged } = await upsertVaultDocument({
    filePath,
    relPath,
    content,
    hash,
    embeddings: embeddingHelpers,
    errors: result.errors,
    deferTriggerIndex,
  });
  result.indexed = 1;
  result.embedded = embedded;
  result.triggersChanged = triggersChanged;
  return result;
}

async function _indexVault(vaultPath, { embeddings = false } = {}) {
  const files = scanVault(vaultPath);
  const existingPaths = new Map(getAllVaultPaths().map(r => [r.vault_path, r.content_hash]));
  const seenPaths = new Set();

  let indexed = 0;
  let skipped = 0;
  let deleted = 0;
  let embedded = 0;
  let errors = [];

  const embeddingHelpers = embeddings ? await loadEmbeddingHelpers(errors) : false;

  for (const filePath of files) {
    const relPath = relative(vaultPath, filePath);
    seenPaths.add(relPath);

    try {
      const content = readFileSync(filePath, 'utf-8');
      const hash = hashContent(content);

      // Skip if unchanged — but self-heal missing embeddings so a backfill
      // is just a reindex with embeddings enabled
      if (existingPaths.get(relPath) === hash) {
        if (embeddingHelpers) {
          embedded += await embedIfMissing(relPath, embeddingHelpers, errors);
        }
        skipped++;
        continue;
      }

      embedded += (await upsertVaultDocument({
        filePath,
        relPath,
        content,
        hash,
        embeddings: embeddingHelpers,
        errors,
      })).embedded;

      indexed++;
    } catch (err) {
      errors.push(`${relPath}: ${err.message}`);
    }
  }

  // Delete tracking entries for files that no longer exist in vault
  for (const [path] of existingPaths) {
    if (!seenPaths.has(path)) {
      deleteVaultFile(path);
      deleted++;
    }
  }

  return { indexed, skipped, deleted, embedded, errors, total: files.length };
}

async function embedIfMissing(relPath, embeddings, errors) {
  const vf = getVaultFile(relPath);
  if (!vf?.document_id) return 0;
  const has = getDb().prepare('SELECT 1 FROM embeddings WHERE document_id = ? LIMIT 1').get(vf.document_id);
  if (has) return 0;
  const doc = getDb().prepare('SELECT content FROM documents WHERE id = ?').get(vf.document_id);
  if (!doc?.content?.trim()) return 0;   // same guard storeEmbedding applies, or this retries forever
  try {
    return await embeddings.storeEmbedding(vf.document_id, doc.content, relPath);
  } catch (embErr) {
    errors.push(`embedding ${relPath}: ${embErr.message}`);
    return 0;
  }
}

async function loadEmbeddingHelpers(errors) {
  try {
    const embedModule = await import('../embeddings/embed.js');
    return { storeEmbedding: embedModule.storeEmbedding };
  } catch (err) {
    errors.push(`embeddings init: ${err.message}`);
    return false;
  }
}

async function upsertVaultDocument({ filePath, relPath, content, hash, embeddings, errors, deferTriggerIndex = false }) {
  const parsed = parseVaultNote(content, relPath);
  const existing = getVaultFile(relPath);
  let docId;

  const fields = {
    title: parsed.title,
    content: parsed.body,
    tags: normalizeTagString(parsed.tags.join(',')),
    doc_type: parsed.type,
    source: `vault:${relPath}`,
    file_path: filePath,
    file_size: statSync(filePath).size,
    tier: parsed.tier,
    tier_ref: parsed.tier_ref,
  };

  if (existing && existing.document_id) {
    updateDocumentFull(existing.document_id, fields);
    docId = existing.document_id;
  } else {
    docId = insertDocument(fields).id;
  }
  // After the write, so the note's own words are in the index when the filter
  // asks for their frequency — and recomputed on every reindex, which re-vets
  // an alias the corpus has since grown too common.
  const aliases = filterAliases(parsed.frontmatter.aliases, {
    title: parsed.title,
    tags: parsed.tags.join(' '),
    content: parsed.body,
  });
  getDb().prepare('UPDATE documents SET aliases = ? WHERE id = ?').run(aliases || null, docId);
  // Same after-the-write timing as aliases, for the same reason (corpus df
  // needs the note's own words indexed first — not applicable to triggers'
  // code-span grounding, but keeping both writes adjacent avoids two
  // separate passes over parsed.frontmatter). Title/content only: tags are
  // not command text. NULL, never '', when nothing survives — rebuildTrigger
  // Index assumes every non-NULL triggers column is valid JSON.
  const priorTriggers = getDb().prepare('SELECT triggers FROM documents WHERE id = ?').get(docId)?.triggers ?? null;
  const vettedTriggers = filterTriggers(parsed.frontmatter.triggers, {
    title: parsed.title,
    content: parsed.body,
  }, { pinned: !!parsed.frontmatter.triggers_pinned }) || null;
  getDb().prepare('UPDATE documents SET triggers = ? WHERE id = ?').run(vettedTriggers, docId);
  const triggersChanged = vettedTriggers !== priorTriggers;
  // The index materializer does a full table scan — worth paying only when
  // this file's own column actually moved, not on every unrelated reindex.
  // A caller doing many of these in a loop (triggers-backfill) can defer and
  // consolidate into one rebuild at the end instead of K of them.
  if (triggersChanged && !deferTriggerIndex) {
    try {
      rebuildTriggerIndex();
    } catch (err) {
      // A materialization failure is a read-path problem: the column above
      // already holds the correct vetted value, only the hook's index
      // snapshot goes stale until the next successful rebuild. Must never
      // abort the note write that got us here.
      errors.push(`${relPath}: trigger index rebuild failed: ${err.message}`);
    }
  }
  // Frontmatter is hand-editable, so a claim it makes can fail the tier rules.
  // The DB clamps rather than throwing — one bad file must not sink a whole
  // reindex — so say what was lowered instead of lowering it silently.
  if (parsed.tier) {
    const stored = getDb().prepare('SELECT tier FROM documents WHERE id = ?').get(docId)?.tier;
    if (stored !== parsed.tier) {
      errors.push(`${relPath}: frontmatter claims tier "${parsed.tier}" — stored as "${stored}"`);
    }
  }

  upsertVaultFile({
    vault_path: relPath,
    content_hash: hash,
    document_id: docId,
    title: parsed.title,
    note_type: parsed.type,
    tags: normalizeTagString(parsed.tags.join(',')),
    project: parsed.project,
    status: parsed.status,
    source: parsed.source,
    confidence: parsed.confidence,
    summary: parsed.frontmatter.summary || null,
    key_topics: parsed.frontmatter.key_topics || null,
  });

  if (embeddings) {
    try {
      const embedded = await embeddings.storeEmbedding(docId, parsed.body, relPath);
      return { embedded, triggersChanged };
    } catch (embErr) {
      errors.push(`embedding ${relPath}: ${embErr.message}`);
    }
  }

  return { embedded: 0, triggersChanged };
}
