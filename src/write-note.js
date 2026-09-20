// Shared note-writing path: dedup, frontmatter, related-links, index.
// Used by the kb_write MCP tool and the harvest pipeline so every note —
// human-triggered or automatic — enters the KB the same way, connected.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { randomUUID } from 'crypto';
import matter from 'gray-matter';
import { similarDocs, duplicatesIn, nearNeighborSignal, DUP_THRESHOLD } from './embeddings/search.js';
import { indexVaultFile } from './vault/indexer.js';
import { getVaultFile, getDb, getDocument } from './db.js';
import { splitTags } from './tags.js';
import { assertTier } from './tiers.js';
import { logWriteDecision } from './write-meter.js';
import { SURFACE, logRetrievalResults } from './retrieval.js';
import { resolveProcessStart } from './process-ancestry.js';

// Re-exported, not redeclared: kb_check_duplicate answers with this same value,
// and a second copy is the drift that made the pre-check disagree with the write.
export { DUP_THRESHOLD };
export const RELATED_MIN = 0.55;
export const RELATED_K = 3;
export const WRITE_SKIP_REASON = Object.freeze({
  DUPLICATE: 'duplicate_detected',
  DEDUPE_UNAVAILABLE: 'dedupe_unavailable',
});
const WRITE_LOCK_KEY = 'runtime:authored-write-lock';
const WRITE_LOCK_TIMEOUT_MS = 30_000;
let ownProcessStart;
let identityCache = null;

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

// The near-neighbour signal, back out of a write result. One picker, so the
// surfaces that report it — the MCP text response, the REST body — carry the
// fields the JSON surfaces carry rather than each assembling its own copy.
export function nearNeighborFields({ near_notes, next_step }) {
  return near_notes ? { near_notes, next_step } : {};
}

export function renderNearNeighbors(result) {
  const signal = nearNeighborFields(result);
  return signal.near_notes ? `\n${JSON.stringify(signal, null, 2)}` : '';
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

// Restate a note's tier in its own frontmatter. The vault file is the source of
// truth: a tier written only to the DB is undone by the next reindex.
export function setNoteTier(vaultPath, relPath, { tier, ref }) {
  const fullPath = join(vaultPath, relPath);
  const { data: fm, content: body } = matter(readFileSync(fullPath, 'utf-8'));
  const updated = { ...fm, tier, tier_ref: ref };
  if (!ref) delete updated.tier_ref;
  writeFileSync(fullPath, matter.stringify(body, updated));
}

function dedupeUnavailable() {
  return {
    skipped: true,
    reason: WRITE_SKIP_REASON.DEDUPE_UNAVAILABLE,
    retryable: true,
  };
}

function hasUnembeddedLiveDocuments() {
  return Boolean(getDb().prepare(`
    SELECT 1
    FROM documents d
    WHERE d.superseded_at IS NULL
      AND TRIM(COALESCE(d.content, '')) <> ''
      AND NOT EXISTS (
        SELECT 1 FROM embeddings e WHERE e.document_id = d.id
      )
    LIMIT 1
  `).get());
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function processIdentityIsAlive({ pid, pid_start: expectedStart } = {}) {
  if (pid === process.pid && expectedStart && expectedStart === ownProcessStart) return true;
  const cacheKey = `${pid}:${expectedStart ?? ''}`;
  if (identityCache?.key === cacheKey && Date.now() - identityCache.checkedAt < 1_000) {
    return identityCache.alive;
  }
  if (!processIsAlive(pid)) return false;
  const actualStart = expectedStart ? resolveProcessStart({ pid }) : null;
  const alive = !expectedStart || actualStart == null || actualStart === expectedStart;
  identityCache = { key: cacheKey, alive, checkedAt: Date.now() };
  return alive;
}

function releaseWriteLock(owner) {
  try {
    getDb().prepare('DELETE FROM meta WHERE key = ? AND value = ?').run(WRITE_LOCK_KEY, owner);
    return true;
  } catch {
    return false;
  }
}

function retryWriteLockRelease(owner, delay = 20) {
  const timer = setTimeout(() => {
    if (!releaseWriteLock(owner)) retryWriteLockRelease(owner, Math.min(delay * 2, 30_000));
  }, delay);
  timer.unref?.();
}

function tryAcquireWriteLock(owner) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO meta (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `);
  if (insert.run(WRITE_LOCK_KEY, owner).changes === 1) return true;

  const current = db.prepare('SELECT value FROM meta WHERE key = ?').get(WRITE_LOCK_KEY);
  if (!current) return false;
  try {
    if (processIdentityIsAlive(JSON.parse(current.value))) return false;
  } catch {
    // A malformed owner cannot represent a live lock holder.
  }

  return db.transaction(() => {
    const deleted = db.prepare(
      'DELETE FROM meta WHERE key = ? AND value = ?',
    ).run(WRITE_LOCK_KEY, current.value);
    return deleted.changes === 1 && insert.run(WRITE_LOCK_KEY, owner).changes === 1;
  })();
}

async function acquireWriteLock(owner) {
  const deadline = Date.now() + WRITE_LOCK_TIMEOUT_MS;
  let delay = 20;
  while (true) {
    if (tryAcquireWriteLock(owner)) return;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the authored-write lock');
    await new Promise(resolve => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 250);
  }
}

async function withWriteLock(run) {
  ownProcessStart ??= resolveProcessStart();
  const owner = JSON.stringify({
    token: randomUUID(),
    pid: process.pid,
    pid_start: ownProcessStart,
    acquired_at: new Date().toISOString(),
  });
  await acquireWriteLock(owner);
  try {
    return await run();
  } finally {
    if (!releaseWriteLock(owner)) retryWriteLockRelease(owner);
  }
}

async function writeNoteUnlocked(
  vaultPath,
  { title, content, type = 'capture', tags, project, source, tier, tier_ref, excludeId },
  { findSimilar = similarDocs, writeAttribution } = {},
) {
  // Refused loudly, before anything is written: a caller told its note was
  // saved has no reason to check what tier it actually landed on.
  const graded = assertTier({ tier, ref: tier_ref, provenance: source });
  const canProceedWithoutDedupe = excludeId != null && getDocument(excludeId) != null;

  // A successful similarity query over an incomplete corpus is not a valid
  // duplicate verdict. Explicit corrections may proceed because their target
  // is already known; routine creates wait for reindex to restore coverage.
  if (!canProceedWithoutDedupe && hasUnembeddedLiveDocuments()) return dedupeUnavailable();

  // One embedding pass drives both dedup and related-links. If the semantic
  // layer is down, say so — a silent skip reads as "no duplicates found".
  let similar = [];
  let warning = '';
  try {
    similar = await findSimilar(content, { limit: 10 });
  } catch (err) {
    if (!canProceedWithoutDedupe) return dedupeUnavailable();
    warning = ` [dedup/links skipped: ${err.message} — run 'kb vault reindex' to build embeddings]`;
  }

  // A replacement note (kb_write supersedes) is a near-dup of the note it
  // retires by design — exclude that target so it doesn't block the write.
  if (excludeId != null) similar = similar.filter(s => s.document_id !== excludeId);

  // similarDocs sorts by score, so the head is the closest thing already
  // stored. Recorded either way: a refusal was always visible in its own
  // result, and it is the accepts — the near misses that scored just under —
  // that say whether the threshold sits where it should.
  const nearest = similar[0] ?? null;
  const dups = duplicatesIn(similar);
  if (dups.length) {
    logWriteDecision({
      nearest,
      threshold: DUP_THRESHOLD,
      refused: true,
      ...writeAttribution,
    });
    // write_decisions (above) already durably records this refusal, but only
    // its single nearest match — retrievals is the analysis store `kb
    // rediscoveries` reads, so it gets its own row per match here. A caller
    // that ran kb_check_duplicate first and then hit this refusal logs the
    // same rediscovery twice; acceptable for now, analysis dedupes by note
    // id + time window.
    //
    // Session deliberately left to logRetrievalResults' own default. This used
    // to pass an explicit null, on the reasoning that a dedupe check has no
    // session threaded through it — but the sibling call site
    // (kb_check_duplicate, tools.js) never did, so ONE rediscovery event could
    // be written twice with two different session values. The ambient
    // resolution is the same answer at both sites, and under the daemon it is
    // now the connection's own (retrieval.js's callIdentity).
    const matches = dups.slice(0, 5);
    logRetrievalResults({
      results: matches.map(m => ({ id: m.document_id })),
      surface: SURFACE.REDISCOVERY,
      query: content.slice(0, 300),
      eventId: randomUUID(),
    });
    return { skipped: true, reason: WRITE_SKIP_REASON.DUPLICATE, matches };
  }
  const related = similar
    .filter(s => s.score >= RELATED_MIN && s.score < DUP_THRESHOLD)
    .slice(0, RELATED_K);

  const folder = FOLDER_MAP[type] || 'inbox';
  const destDir = join(vaultPath, folder);
  mkdirSync(destDir, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

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
  // Always stated, never implied: an untiered note reads as an unlabelled one.
  fm.push(`tier: ${graded.tier}`);
  if (graded.ref) fm.push(`tier_ref: ${JSON.stringify(graded.ref)}`);
  fm.push('status: active');
  fm.push('---');

  const body = fm.join('\n') + '\n\n' + content + renderRelatedSection(related);
  let relPath;
  for (let suffix = 1; ; suffix++) {
    const filename = `${date}-${slug}${suffix === 1 ? '' : `-${suffix}`}.md`;
    relPath = `${folder}/${filename}`;
    // Only an explicit supersede target may be updated in place. Exclusive
    // creation protects every other file, including unindexed/concurrent writes.
    const overwrite = excludeId != null && getVaultFile(relPath)?.document_id === excludeId;
    try {
      writeFileSync(join(destDir, filename), body, { flag: overwrite ? 'w' : 'wx' });
      break;
    } catch (err) {
      if (overwrite || err.code !== 'EEXIST') throw err;
    }
  }

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

  logWriteDecision({
    nearest,
    threshold: DUP_THRESHOLD,
    refused: false,
    docId,
    ...writeAttribution,
  });
  return {
    skipped: false,
    path: relPath,
    docId,
    tier: graded.tier,
    related: related.map(r => ({ id: r.document_id, title: r.title, score: Math.round(r.score * 100) / 100 })),
    // Computed for dedup and thrown away until now: an accepted note can still
    // land on ground a live note already holds, and only the caller can say
    // whether it agrees with that note or contradicts it.
    ...nearNeighborSignal(similar),
    status: indexStatus + warning,
  };
}

export function writeNote(vaultPath, note, options) {
  return withWriteLock(() => writeNoteUnlocked(vaultPath, note, options));
}
