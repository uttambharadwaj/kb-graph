import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, extname, isAbsolute } from 'path';
import { createHash } from 'crypto';
import { parseVaultNote } from './parser.js';
import { normalizeTagString } from '../tags.js';
import { normalizeVaultPath } from './vault-path.js';
import { filterAliases } from '../hint-relevance.js';
import { filterTriggers, rebuildTriggerIndex } from '../trigger-relevance.js';
import {
  insertDocument, updateDocumentFull, getDb,
  getVaultFile, upsertVaultFile, detachVaultFile, getAllVaultPaths, moveVaultFile, setMeta,
} from '../db.js';
import { LOGS_DIR } from '../paths.js';

let indexQueue = Promise.resolve();

export const VAULT_INDEX_RACE_LOG = join(LOGS_DIR, 'vault-index-races.jsonl');
export const VAULT_INDEX_SAFETY_LOG = join(LOGS_DIR, 'vault-index-safety.jsonl');
export const PRUNE_ABSOLUTE_LIMIT = 5;
export const PRUNE_FRACTION_LIMIT = 0.02;

export class VaultPruneRefusedError extends Error {
  constructor(safety) {
    super(
      `Vault reindex refused before document changes: ${safety.missingCount} of `
      + `${safety.existingCount} indexed paths are missing (${safety.reason}). `
      + `Review the vault selection, then rerun with --confirm-prune=${safety.missingCount} `
      + 'only if this exact cleanup is intentional.'
    );
    this.name = 'VaultPruneRefusedError';
    this.code = 'KB_VAULT_PRUNE_REFUSED';
    this.safety = safety;
  }
}

export function pruneLimit(existingCount) {
  return Math.max(PRUNE_ABSOLUTE_LIMIT, Math.floor(existingCount * PRUNE_FRACTION_LIMIT));
}

export function evaluatePruneSafety({
  existingCount,
  scannedCount,
  missingCount,
  confirmPrune = null,
}) {
  const limit = pruneLimit(existingCount);
  let reason = null;
  if (existingCount > 0 && scannedCount === 0) {
    reason = 'zero_markdown_files';
  } else if (missingCount > limit) {
    reason = 'blast_radius';
  }
  const confirmed = Number.isInteger(confirmPrune) && confirmPrune === missingCount;
  return {
    allowed: reason === null || confirmed,
    override: reason !== null && confirmed,
    reason,
    existingCount,
    scannedCount,
    missingCount,
    limit,
  };
}

function recordPruneSafety(event, safety) {
  const details = {
    ts: new Date().toISOString(),
    event,
    reason: safety.reason,
    existing_count: safety.existingCount,
    scanned_count: safety.scannedCount,
    missing_count: safety.missingCount,
    limit: safety.limit,
    pid: process.pid,
  };
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(VAULT_INDEX_SAFETY_LOG, `${JSON.stringify(details)}\n`);
  } catch {
    // Safety telemetry must not weaken the decision it reports.
  }
  try {
    setMeta('last_reindex_refusal', event === 'prune_refused' ? JSON.stringify(details) : '');
  } catch {
    // The append-only log remains the fallback signal if DB telemetry fails.
  }
}

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
  return results.sort();
}

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
}

function hashesMatch(stored, current) {
  return stored === current || (stored?.length === 16 && current.startsWith(stored));
}

function upgradeLegacyContentHash(vaultPath, storedHash, currentHash) {
  if (storedHash?.length !== 16 || !currentHash.startsWith(storedHash)) return;
  getDb().prepare(`
    UPDATE vault_files
    SET content_hash = ?, indexed_at = CURRENT_TIMESTAMP
    WHERE vault_path = ? AND content_hash = ?
  `).run(currentHash, vaultPath, storedHash);
}

function planExactContentRenames(vaultPath, files, existingPaths, seenPaths) {
  const missingByHash = new Map();
  for (const row of existingPaths.values()) {
    if (
      seenPaths.has(row.vault_path)
      || row.missing_at != null
      || row.content_hash?.length !== 64
    ) continue;
    const matches = missingByHash.get(row.content_hash) || [];
    matches.push(row.vault_path);
    missingByHash.set(row.content_hash, matches);
  }
  if (missingByHash.size === 0) return { contentByPath: new Map(), renameFromByPath: new Map() };

  const contentByPath = new Map();
  const proposedByOldPath = new Map();
  for (const filePath of files) {
    const relPath = normalizeVaultPath(relative(vaultPath, filePath));
    if (existingPaths.has(relPath)) continue;
    try {
      const content = readFileSync(filePath, 'utf-8');
      const hash = hashContent(content);
      contentByPath.set(relPath, { content, hash });
      const candidates = new Set(missingByHash.get(hash) || []);
      if (candidates.size !== 1) continue;
      const [oldPath] = candidates;
      const proposed = proposedByOldPath.get(oldPath) || [];
      proposed.push(relPath);
      proposedByOldPath.set(oldPath, proposed);
    } catch {
      // The indexing pass below owns the user-visible read error.
    }
  }

  const renameFromByPath = new Map();
  for (const [oldPath, newPaths] of proposedByOldPath) {
    if (newPaths.length === 1) renameFromByPath.set(newPaths[0], oldPath);
  }
  return { contentByPath, renameFromByPath };
}

export async function indexVault(vaultPath, { embeddings = false, confirmPrune = null } = {}) {
  const queuedRun = indexQueue.then(
    () => _indexVault(vaultPath, { embeddings, confirmPrune }),
    () => _indexVault(vaultPath, { embeddings, confirmPrune }),
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
  const relPath = normalizeVaultPath(relative(vaultPath, filePath));
  if (relPath.startsWith('..') || isAbsolute(relPath)) {
    return { indexed: 0, skipped: 0, deleted: 0, embedded: 0, triggersChanged: false, errors: [`${vaultFilePath}: outside vault`], total: 1 };
  }

  if (extname(filePath).toLowerCase() !== '.md') {
    return { indexed: 0, skipped: 0, deleted: 0, embedded: 0, triggersChanged: false, errors: [`${relPath}: unsupported file type`], total: 1 };
  }

  const existing = getVaultFile(relPath);
  const content = readFileSync(filePath, 'utf-8');
  const hash = hashContent(content);
  if (!existing?.missing_at && hashesMatch(existing?.content_hash, hash)) {
    upgradeLegacyContentHash(relPath, existing.content_hash, hash);
    return { indexed: 0, skipped: 1, deleted: 0, embedded: 0, triggersChanged: false, errors: [], total: 1 };
  }

  const result = { indexed: 0, skipped: 0, deleted: 0, embedded: 0, triggersChanged: false, errors: [], total: 1 };
  const embeddingHelpers = embeddings ? await loadEmbeddingHelpers(result.errors) : false;
  const { embedded, triggersChanged } = await upsertVaultDocument({
    vaultPath,
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

async function _indexVault(vaultPath, { embeddings = false, confirmPrune = null } = {}) {
  // Snapshot the derived index before the source-of-truth files. A write that
  // lands after this point is absent from existingPaths and cannot be pruned
  // by this run. The final on-disk check below closes the remaining same-path
  // recreation window across separate KB processes, whose module-local queues
  // cannot serialize one another.
  const existingPaths = new Map(getAllVaultPaths().map(row => [row.vault_path, row]));
  const files = scanVault(vaultPath);
  const seenPaths = new Set(files.map(filePath => normalizeVaultPath(relative(vaultPath, filePath))));
  let existingCount = 0;
  let missingCount = 0;
  for (const row of existingPaths.values()) {
    if (row.missing_at != null) continue;
    existingCount++;
    if (!seenPaths.has(row.vault_path)) missingCount += 1;
  }
  const safety = evaluatePruneSafety({
    existingCount,
    scannedCount: files.length,
    missingCount,
    confirmPrune,
  });
  if (!safety.allowed) {
    recordPruneSafety('prune_refused', safety);
    throw new VaultPruneRefusedError(safety);
  }
  if (safety.override) recordPruneSafety('prune_override', safety);

  let indexed = 0;
  let skipped = 0;
  let deleted = 0;
  let embedded = 0;
  let errors = [];
  const preservedPaths = new Set();

  const embeddingHelpers = embeddings ? await loadEmbeddingHelpers(errors) : false;
  const renamePlan = planExactContentRenames(vaultPath, files, existingPaths, seenPaths);

  for (const filePath of files) {
    const relPath = normalizeVaultPath(relative(vaultPath, filePath));

    try {
      const cached = renamePlan.contentByPath.get(relPath);
      const content = cached?.content ?? readFileSync(filePath, 'utf-8');
      const hash = cached?.hash ?? hashContent(content);
      const existing = existingPaths.get(relPath);

      // Skip if unchanged — but self-heal missing embeddings so a backfill
      // is just a reindex with embeddings enabled
      if (
        existing
        && existing.missing_at == null
        && existing.detached_at == null
        && hashesMatch(existing.content_hash, hash)
      ) {
        upgradeLegacyContentHash(relPath, existing.content_hash, hash);
        if (embeddingHelpers) {
          embedded += await embedIfMissing(relPath, embeddingHelpers, errors);
        }
        skipped++;
        continue;
      }

      embedded += (await upsertVaultDocument({
        vaultPath,
        filePath,
        relPath,
        content,
        hash,
        embeddings: embeddingHelpers,
        errors,
        deferTriggerIndex: true,
        renameFrom: renamePlan.renameFromByPath.get(relPath) || null,
      })).embedded;

      indexed++;
    } catch (err) {
      const renameFrom = renamePlan.renameFromByPath.get(relPath);
      if (renameFrom) preservedPaths.add(renameFrom);
      errors.push(`${relPath}: ${err.message}`);
    }
  }

  const pruned = pruneMissingVaultFiles(vaultPath, existingPaths, seenPaths, preservedPaths);
  deleted += pruned.deleted;
  try {
    rebuildTriggerIndex();
  } catch (err) {
    errors.push(`trigger index rebuild after reindex failed: ${err.message}`);
  }
  if (embeddingHelpers) {
    embedded += await embedMissingNonVaultDocuments(embeddingHelpers, errors);
  }
  try {
    setMeta('last_reindex_refusal', '');
  } catch {
    // Health telemetry cannot turn a completed index into a reported failure.
  }

  return {
    indexed,
    skipped,
    deleted,
    detached: deleted,
    preserved: pruned.preserved,
    embedded,
    errors,
    total: files.length,
  };
}

function recordPreservedWrite(vaultPath) {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(VAULT_INDEX_RACE_LOG, `${JSON.stringify({
      ts: new Date().toISOString(),
      event: 'delete_skipped_file_present',
      vault_path: vaultPath,
      pid: process.pid,
    })}\n`);
  } catch {
    // Race telemetry cannot be allowed to turn a safe reindex into a failure.
  }
}

export function pruneMissingVaultFiles(vaultPath, existingPaths, seenPaths, preservedPaths = new Set()) {
  let deleted = 0;
  let preserved = 0;

  for (const [path, row] of existingPaths) {
    if (seenPaths.has(path) || preservedPaths.has(path) || row?.missing_at != null) continue;

    // The scan is a point-in-time view. A separate MCP/CLI process can write
    // and index a note after its directory has already been walked. Disk is
    // authoritative, so defer deletion when a valid source file now exists;
    // the next full pass will index it if this one did not.
    let current = null;
    try {
      current = statSync(join(vaultPath, path), { throwIfNoEntry: false });
    } catch {
      // A broken link or unreadable path is not a live vault note.
    }
    if (current?.isFile() && extname(path).toLowerCase() === '.md') {
      preserved++;
      recordPreservedWrite(path);
      continue;
    }

    if (detachVaultFile(path)) deleted++;
  }

  return { deleted, detached: deleted, preserved };
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

async function embedMissingNonVaultDocuments(embeddings, errors) {
  const missing = getDb().prepare(`
    SELECT d.id, d.content
    FROM documents d
    WHERE d.superseded_at IS NULL
      AND d.detached_at IS NULL
      AND NOT EXISTS (
      SELECT 1 FROM embeddings e WHERE e.document_id = d.id
    )
      AND NOT EXISTS (
        SELECT 1 FROM vault_files vf WHERE vf.document_id = d.id
      )
      AND TRIM(COALESCE(d.content, '')) <> ''
  `).all();
  let embedded = 0;
  for (const doc of missing) {
    try {
      embedded += await embeddings.storeEmbedding(doc.id, doc.content);
    } catch (embErr) {
      errors.push(`embedding document #${doc.id}: ${embErr.message}`);
    }
  }
  return embedded;
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

async function upsertVaultDocument({
  vaultPath,
  filePath,
  relPath,
  content,
  hash,
  embeddings,
  errors,
  deferTriggerIndex = false,
  renameFrom = null,
}) {
  const parsed = parseVaultNote(content, relPath);
  let existing = getVaultFile(relPath);
  const existingAtRead = existing;
  const detachedAtRead = existingAtRead?.missing_at != null;
  let preserveTier = existing?.missing_at != null;
  let reattached = existing?.missing_at != null;
  let renameCandidate = null;
  if (!existing && renameFrom) {
    let oldPathPresent = false;
    try {
      oldPathPresent = statSync(join(vaultPath, renameFrom), { throwIfNoEntry: false })?.isFile() === true;
    } catch {
      // An unreadable or broken old path is not a live competing source.
    }
    const source = oldPathPresent ? null : getVaultFile(renameFrom);
    if (source && hashesMatch(source.content_hash, hash)) {
      renameCandidate = {
        fromVaultPath: renameFrom,
        toVaultPath: relPath,
        contentHash: source.content_hash,
      };
    }
  }
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

  let triggersChanged = false;
  getDb().transaction(() => {
    const current = getVaultFile(relPath);
    if (
      existingAtRead
      && !detachedAtRead
      && (
        !current
        || current.document_id !== existingAtRead.document_id
        || current.missing_at != null
      )
    ) {
      throw new Error('vault row detached during index; retry against a fresh scan');
    }
    existing = current;
    preserveTier = detachedAtRead || existing?.missing_at != null;
    reattached = existing?.missing_at != null;
    if (!existing && renameCandidate) {
      moveVaultFile(renameCandidate);
      existing = getVaultFile(relPath);
      preserveTier = Boolean(existing);
      reattached = Boolean(existing);
    }
    if (existing && existing.document_id) {
      const previous = getDb().prepare('SELECT content FROM documents WHERE id = ?').get(existing.document_id);
      if (previous?.content !== fields.content) {
        // The old vector describes content that no longer exists. Remove it
        // before updating the document so a failed re-embed leaves an explicit,
        // retryable corpus gap instead of a stale false-negative.
        getDb().prepare('DELETE FROM embeddings WHERE document_id = ?').run(existing.document_id);
      }
      updateDocumentFull(existing.document_id, fields, { preserveTier });
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
    const pinnedTriggers = !!parsed.frontmatter.triggers_pinned;
    const vettedTriggers = filterTriggers(parsed.frontmatter.triggers, {
      title: parsed.title,
      content: parsed.body,
    }, {
      pinned: pinnedTriggers,
      block: pinnedTriggers && parsed.frontmatter.triggers_block === true,
    }) || null;
    getDb().prepare('UPDATE documents SET triggers = ? WHERE id = ?').run(vettedTriggers, docId);
    triggersChanged = vettedTriggers !== priorTriggers;

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
  }).immediate();

  // The index materializer does a full table scan — worth paying only when
  // this file's own column actually moved, not on every unrelated reindex.
  // A caller doing many of these in a loop (triggers-backfill) can defer and
  // consolidate into one rebuild at the end instead of K of them.
  if ((triggersChanged || reattached) && !deferTriggerIndex) {
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
