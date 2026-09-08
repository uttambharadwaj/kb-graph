import { createHash } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { getDb, setMeta, supersedeDocument } from './db.js';
import { authoredBody } from './embeddings/embed.js';
import { FactReviewError, factReviewState, reviewFactGroup } from './fact-reviews.js';
import { entityKey } from './facts.js';
import { extractTranscriptText } from './harvest.js';
import { LOGS_DIR } from './paths.js';
import { canonicalPredicate } from './predicates.js';
import { HARVEST_SOURCE_PREFIX } from './tiers.js';
import { runClaudeJSON } from './claude-cli.js';
import { redactSecrets } from './capture/terminal.js';

export const RECONCILIATION_LOG_DIR = join(LOGS_DIR, 'reconciliation');
export const RECONCILIATION_LOG = join(RECONCILIATION_LOG_DIR, 'decisions.jsonl');
export const RECONCILE_REVIEWER = 'kb-reconcile';
export const DEFAULT_RECONCILE_LIMIT = 5;

const HARVEST_SESSION_ID = /^[A-Za-z0-9._-]{1,200}$/;
const EXCERPT_CHARS = 900;
const RELATION_CUES = [
  ' is ', ' was ', ' are ', ' were ', ' be ', ' been ', ' became ', ' becomes ',
  ' status', ' state', ' current', ' now ', ' uses ', ' supports ', ' owns ',
  ' merged', ' deployed', ' shipped', ' fixed', ' replaces', ' replaced',
  ' supersedes', ' superseded', ' changed', ' corrected', ' instead', ' no longer',
  ' retired', ' moved', ' migrated', ' from ', ' to ', ' in favor of',
];
const NEGATED_CHANGE = /\b(?:not|never|did not|didn'?t|no evidence|rejected|false|incorrect|wrong)\b/i;
const EXPLICIT_CHANGE_CUES = /\b(?:changed|corrected|moved|migrated|promoted|replaced|superseded|transitioned|went)\b/i;

const escapeLike = value => `%${String(value).replace(/([%_\\])/g, '\\$1')}%`;
const norm = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const hashJson = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted = values => [...values].sort((a, b) => String(a).localeCompare(String(b)));

function appendDecision(entry, logPath = RECONCILIATION_LOG) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function recordReconciliationSuccess(summary, { dryRun = false } = {}) {
  if (dryRun) return;
  const { decisions: _decisions, ...counts } = summary;
  setMeta('last_reconcile', JSON.stringify({ status: 'ok', ...counts }));
  setMeta('last_reconcile_error', '');
}

function recordReconciliationFailure(error, { dryRun = false } = {}) {
  if (dryRun) return;
  setMeta('last_reconcile_error', redactSecrets(error?.message || String(error)));
}

function harvestSources(db) {
  const out = new Map();
  for (const row of db.prepare('SELECT transcript_path FROM harvest_log').all()) {
    if (typeof row.transcript_path === 'string' && row.transcript_path.endsWith('.jsonl')) {
      out.set(basename(row.transcript_path, '.jsonl'), row.transcript_path);
    }
  }
  return out;
}

function resolveHarvestSource(source, paths) {
  if (!source) return { status: 'absent', supported: false, reason: 'source absent' };
  if (!source.startsWith(HARVEST_SOURCE_PREFIX)) {
    return { status: 'unsupported-source', supported: false, source, reason: 'only harvest sources are independently resolvable' };
  }
  const sessionId = source.slice(HARVEST_SOURCE_PREFIX.length);
  if (!HARVEST_SESSION_ID.test(sessionId)) {
    return { status: 'unmapped-source', supported: false, source, reason: 'invalid harvest session id' };
  }
  const transcriptPath = paths.get(sessionId);
  if (!transcriptPath) return { status: 'unmapped-source', supported: false, source, reason: 'harvest log has no transcript for source' };
  if (!existsSync(transcriptPath)) return { status: 'missing-source', supported: false, source, transcript_path: transcriptPath, reason: 'transcript file is missing' };
  return { status: 'resolved-source', supported: true, source, transcript_path: transcriptPath };
}

function readTranscript(path, cache) {
  if (cache.has(path)) return cache.get(path);
  const text = extractTranscriptText(readFileSync(path, 'utf8'));
  cache.set(path, text);
  return text;
}

function termVariants(value) {
  const raw = String(value ?? '').trim();
  const variants = [raw, raw.replaceAll('_', ' '), raw.replaceAll('-', ' ')];
  const parts = raw.split(/[^A-Za-z0-9]+/).filter(part => part.length >= 3);
  if (parts.length > 1) variants.push(parts.join(' '));
  return sorted(new Set(variants.map(norm).filter(Boolean)));
}

function containsCue(segment, cues) {
  const padded = ` ${segment} `;
  return cues.some(cue => padded.includes(cue.startsWith(' ') || cue.endsWith(' ') ? cue : ` ${cue} `));
}

function sentenceWindows(text) {
  return String(text ?? '')
    .replace(/\r/g, '')
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map(part => part.trim())
    .filter(Boolean)
    .flatMap((part, index, parts) => {
      const windows = [part];
      if (parts[index + 1]) windows.push(`${part}\n${parts[index + 1]}`);
      return windows;
    });
}

function explicitChangeExcerpt(text, { subject, object, predicate = 'status', oldObject = null } = {}) {
  const subjects = termVariants(subject);
  const newObjects = termVariants(object);
  const oldObjects = termVariants(oldObject);
  const predicateTerms = termVariants(predicate.replaceAll('_', ' '));
  for (const segment of sentenceWindows(text)) {
    for (const clause of segment.split(/[,;]|\s+and\s+/i).map(part => part.trim()).filter(Boolean)) {
      const lower = norm(clause);
      if (NEGATED_CHANGE.test(clause)) continue;
      if (!EXPLICIT_CHANGE_CUES.test(clause)) continue;
      if (!subjects.some(term => lower.includes(term))) continue;
      if (!predicateTerms.some(term => lower.includes(term))) continue;
      if (!oldObjects.some(term => lower.includes(term))) continue;
      if (!newObjects.some(term => lower.includes(term))) continue;
      const fromTo = oldObjects.some(oldTerm => newObjects.some(newTerm => {
        const oldAt = lower.indexOf(oldTerm);
        const newAt = lower.indexOf(newTerm);
        return oldAt !== -1 && newAt !== -1 && oldAt < newAt;
      }));
      if (!fromTo) continue;
      const excerpt = clause.length > EXCERPT_CHARS
        ? `${clause.slice(0, EXCERPT_CHARS - 1)}…`
        : clause;
      return { supported: true, excerpt: redactSecrets(excerpt), match: 'subject + predicate + old object + new object in one explicit change clause' };
    }
  }
  return { supported: false, reason: 'source lacks a bounded subject/predicate/old/new change clause' };
}

function sourceExcerpt(text, { subject, object, predicate = 'status', requireChange = false, oldObject = null } = {}) {
  if (requireChange) return explicitChangeExcerpt(text, { subject, object, predicate, oldObject });

  const subjects = termVariants(subject);
  const objects = termVariants(object);
  const predicateTerms = termVariants(predicate.replaceAll('_', ' '));
  for (const segment of sentenceWindows(text)) {
    const lower = norm(segment);
    if (!subjects.some(term => lower.includes(term))) continue;
    if (!objects.some(term => lower.includes(term))) continue;
    if (!containsCue(lower, RELATION_CUES) && !predicateTerms.some(term => lower.includes(term))) continue;
    const excerpt = segment.length > EXCERPT_CHARS
      ? `${segment.slice(0, EXCERPT_CHARS - 1)}…`
      : segment;
    return { supported: true, excerpt: redactSecrets(excerpt), match: 'subject + object + relation cue' };
  }
  return { supported: false, reason: 'source lacks a bounded subject/object/relation excerpt' };
}

function evidenceForAssertion(assertion, paths, cache, { requireChange = false, oldObject = null } = {}) {
  const resolved = resolveHarvestSource(assertion.source, paths);
  if (!resolved.supported) return resolved;
  let text;
  try {
    text = readTranscript(resolved.transcript_path, cache);
  } catch (error) {
    return { ...resolved, status: 'unreadable-source', supported: false, reason: error.code || error.message };
  }
  const excerpt = sourceExcerpt(text, {
    subject: assertion.subject_name ?? assertion.subject,
    object: assertion.object_name ?? assertion.object,
    oldObject,
    predicate: assertion.predicate,
    requireChange,
  });
  return { ...resolved, ...excerpt, supported: resolved.supported && excerpt.supported };
}

function currentFactsForGroup(db, subject, predicate) {
  const subjectId = entityKey(subject);
  const pred = canonicalPredicate(predicate);
  return db.prepare(`
    SELECT f.id, f.subject, s.name AS subject_name, f.predicate,
           f.object, o.name AS object_name, f.valid_from, f.source, f.created_at
    FROM facts f
    JOIN entities s ON s.id = f.subject
    JOIN entities o ON o.id = f.object
    WHERE f.subject = ? AND f.predicate = ? AND f.valid_to IS NULL
    ORDER BY f.id
  `).all(subjectId, pred);
}

function groupSnapshot(facts) {
  return {
    membership: sorted(facts.map(fact => fact.id)),
    hash: hashJson(facts.map(fact => ({ id: fact.id, object: fact.object, source: fact.source, valid_from: fact.valid_from }))),
  };
}

function sameReviewItems(a, b) {
  const clean = item => ({
    fact_id: item.fact_id,
    disposition: item.disposition,
    target_fact_id: item.target_fact_id ?? null,
    reason: item.reason ?? null,
  });
  return hashJson(a.map(clean).sort((x, y) => x.fact_id.localeCompare(y.fact_id)))
    === hashJson(b.map(clean).sort((x, y) => x.fact_id.localeCompare(y.fact_id)));
}

function factGroups(db, { predicate = 'status', subject = null } = {}) {
  const pred = canonicalPredicate(predicate);
  const subjectId = subject ? entityKey(subject) : null;
  const subjectFilter = subjectId ? 'AND subject = ?' : '';
  const params = subjectId ? [pred, subjectId, pred] : [pred, pred];
  const rows = db.prepare(`
    WITH contested AS (
      SELECT subject
      FROM facts
      WHERE predicate = ? AND valid_to IS NULL ${subjectFilter}
      GROUP BY subject
      HAVING COUNT(DISTINCT object) > 1
    )
    SELECT f.id, f.subject, s.name AS subject_name, f.predicate,
           f.object, o.name AS object_name, f.valid_from, f.source, f.created_at
    FROM facts f
    JOIN contested c ON c.subject = f.subject
    JOIN entities s ON s.id = f.subject
    JOIN entities o ON o.id = f.object
    WHERE f.predicate = ? AND f.valid_to IS NULL
    ORDER BY f.subject, f.id
  `).all(...params);
  const bySubject = new Map();
  for (const row of rows) {
    if (!bySubject.has(row.subject)) bySubject.set(row.subject, { subject: row.subject, subject_name: row.subject_name, predicate: pred, assertions: [] });
    bySubject.get(row.subject).assertions.push(row);
  }
  return [...bySubject.values()];
}

export function supersessionEvidenceCandidates(db = getDb(), { since = null, limit = DEFAULT_RECONCILE_LIMIT } = {}) {
  const like = value => escapeLike(value);
  let sql = `
    SELECT f.id AS retired_fact_id, f.subject, f.predicate, f.object AS old_object_id,
           f.valid_to, f.source AS retired_source,
           s.name AS subject_name, o.name AS old_object
    FROM facts f
    JOIN entities s ON f.subject = s.id
    JOIN entities o ON f.object = o.id
    WHERE f.valid_to IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM facts live
        WHERE live.subject = f.subject
          AND live.predicate = f.predicate
          AND live.object = f.object
          AND live.valid_to IS NULL
      )
  `;
  const params = [];
  if (since) { sql += ' AND f.valid_to >= ?'; params.push(since); }
  sql += ' ORDER BY f.valid_to DESC, f.id DESC';
  const retired = db.prepare(sql).all(...params);

  const currentFact = db.prepare(`
    SELECT f.id AS current_fact_id, f.object AS new_object_id, f.source AS current_source,
           f.valid_from, f.created_at, o.name AS new_object
    FROM facts f
    JOIN entities o ON f.object = o.id
    WHERE f.subject = ? AND f.predicate = ? AND f.valid_to IS NULL
      AND f.valid_from IS NOT NULL AND f.valid_from >= ?
    ORDER BY f.valid_from DESC, f.created_at DESC, f.id DESC
    LIMIT 1
  `);
  const staleNotes = db.prepare(`
    SELECT d.id, d.title, d.content, d.created_at, d.superseded_at, d.superseded_by, vf.content_hash,
           (CASE WHEN d.title LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END) AS title_hit
    FROM documents d
    LEFT JOIN vault_files vf ON vf.document_id = d.id
    WHERE d.doc_type != 'archive'
      AND (d.title LIKE ? ESCAPE '\\' OR d.tags LIKE ? ESCAPE '\\')
      AND d.content LIKE ? ESCAPE '\\'
    ORDER BY d.created_at ASC, d.id ASC
  `);
  const replacementNotes = db.prepare(`
    SELECT d.id, d.title, d.content, d.created_at, vf.content_hash
    FROM documents d
    LEFT JOIN vault_files vf ON vf.document_id = d.id
    WHERE d.superseded_at IS NULL AND d.doc_type != 'archive'
      AND d.id != ? AND d.created_at > ?
      AND (d.title LIKE ? ESCAPE '\\' OR d.tags LIKE ? ESCAPE '\\')
      AND d.content LIKE ? ESCAPE '\\'
    ORDER BY d.created_at DESC, d.id DESC
  `);
  const hasAuthored = (content, value) => authoredBody(content).toLowerCase().includes(String(value).toLowerCase());
  const out = [];
  const seen = new Set();

  for (const oldFact of retired) {
    if (out.length >= limit) break;
    const current = currentFact.get(oldFact.subject, oldFact.predicate, oldFact.valid_to);
    if (!current || norm(current.new_object) === norm(oldFact.old_object)) continue;
    const subjLike = like(oldFact.subject_name);
    for (const doc of staleNotes.all(subjLike, subjLike, subjLike, like(oldFact.old_object))) {
      if (out.length >= limit) break;
      if (seen.has(doc.id) || !hasAuthored(doc.content, oldFact.old_object)) continue;
      const replacement = replacementNotes
        .all(doc.id, doc.created_at, subjLike, subjLike, like(current.new_object))
        .find(note => hasAuthored(note.content, current.new_object));
      if (!replacement) continue;
      if (doc.superseded_at != null && doc.superseded_by !== replacement.id) continue;
      seen.add(doc.id);
      out.push({
        kind: 'note_supersession',
        note_id: doc.id,
        title: doc.title,
        suggested_replacement_id: replacement.id,
        replacement_title: replacement.title,
        subject: oldFact.subject,
        subject_name: oldFact.subject_name,
        predicate: oldFact.predicate,
        old_object: oldFact.old_object,
        new_object: current.new_object,
        retired_fact_id: oldFact.retired_fact_id,
        current_fact_id: current.current_fact_id,
        retired_source: oldFact.retired_source,
        current_source: current.current_source,
        retired_at: oldFact.valid_to,
        stale_snapshot: { id: doc.id, content_hash: doc.content_hash, title: doc.title, created_at: doc.created_at },
        replacement_snapshot: { id: replacement.id, content_hash: replacement.content_hash, title: replacement.title, created_at: replacement.created_at },
        reason: `Source-backed correction: ${oldFact.subject_name} ${oldFact.predicate.replaceAll('_', ' ')} changed from "${oldFact.old_object}" to "${current.new_object}".`,
        score: doc.title_hit ? 0.8 : 0.5,
      });
    }
  }
  return out;
}

async function defaultDecideFactGroup(candidate) {
  return runClaudeJSON(`You are reconciling a KB fact group from independent source excerpts. Return ONLY JSON {"items":[{"fact_id":"...","disposition":"current|synonym|superseded|rejected|abstain","target_fact_id":null,"reason":"..."}]}. Use current for the still-valid assertion. Use abstain unless the excerpts explicitly support the judgment.\n\n${JSON.stringify(candidate, null, 2)}`, { caller: 'reconcile-facts' });
}

async function defaultDecideSupersession(candidate) {
  return runClaudeJSON(`You are deciding whether an old KB note should be superseded by a newer note. Return ONLY JSON {"action":"supersede|abstain","reason":"..."}. Supersede only when the quoted source excerpts explicitly support the change from old value to new value.\n\n${JSON.stringify(candidate, null, 2)}`, { caller: 'reconcile-supersession' });
}

function normalizeDecisionItems(items, assertions) {
  if (!Array.isArray(items)) return [];
  return items.map(item => ({
      fact_id: item.fact_id,
      disposition: item.disposition,
      target_fact_id: item.target_fact_id ?? null,
      reason: item.reason ?? null,
  }));
}

function applyFactDecision(db, group, decisionItems, beforeSnapshot, { dryRun = false } = {}) {
  const live = currentFactsForGroup(db, group.subject_name, group.predicate);
  const nowSnapshot = groupSnapshot(live);
  if (nowSnapshot.hash !== beforeSnapshot.hash || hashJson(nowSnapshot.membership) !== hashJson(beforeSnapshot.membership)) {
    return { outcome: 'stale', reason: 'live fact group changed before apply', before: beforeSnapshot, after: nowSnapshot };
  }
  const latest = factReviewState(db, { subject: group.subject_name, predicate: group.predicate });
  if (latest.review_id && sameReviewItems(decisionItems, latest.items)) {
    return { outcome: 'already_applied', review_id: latest.review_id };
  }
  if (dryRun) return { outcome: 'would_apply' };
  try {
    const review = reviewFactGroup(db, {
      subject: group.subject_name,
      predicate: group.predicate,
      reviewer: RECONCILE_REVIEWER,
      note: 'Autonomous reconciliation from resolved harvest source excerpts.',
      items: decisionItems,
    });
    return { outcome: 'applied', review_id: review.id };
  } catch (error) {
    if (error instanceof FactReviewError && /no decision change/.test(error.message)) {
      const state = factReviewState(db, { subject: group.subject_name, predicate: group.predicate });
      return { outcome: 'already_applied', review_id: state.review_id };
    }
    return { outcome: 'abstained', reason: error.message };
  }
}

function documentSnapshot(db, id) {
  return db.prepare(`
    SELECT d.id, d.title, d.content, d.superseded_at, d.superseded_by, d.superseded_reason,
           vf.content_hash
    FROM documents d
    LEFT JOIN vault_files vf ON vf.document_id = d.id
    WHERE d.id = ?
  `).get(id);
}

function sameDocSnapshot(expected, actual) {
  if (!expected || !actual) return false;
  return expected.id === actual.id
    && expected.title === actual.title
    && expected.content === actual.content
    && expected.content_hash === actual.content_hash
    && expected.superseded_at === actual.superseded_at
    && expected.superseded_by === actual.superseded_by;
}

function applySupersessionDecision(db, candidate, decision, before, { dryRun = false } = {}) {
  return db.transaction(() => {
    const current = documentSnapshot(db, candidate.note_id);
    const replacement = documentSnapshot(db, candidate.suggested_replacement_id);
    if (current?.superseded_by === candidate.suggested_replacement_id) {
      return { outcome: 'already_applied', doc_id: candidate.note_id, replacement_id: candidate.suggested_replacement_id };
    }
    if (!sameDocSnapshot(before.stale, current) || !sameDocSnapshot(before.replacement, replacement)) {
      return { outcome: 'stale', reason: 'document snapshot changed before apply' };
    }
    if (decision?.action !== 'supersede') {
      return { outcome: 'abstained', reason: decision?.reason || 'model abstained' };
    }
    if (dryRun) return { outcome: 'would_apply' };
    const updated = supersedeDocument(candidate.note_id, {
      replacementId: candidate.suggested_replacement_id,
      reason: decision.reason || candidate.reason,
    });
    return { outcome: 'applied', doc_id: updated.id, replacement_id: updated.superseded_by };
  }).immediate();
}

async function reconcileFactGroup(db, group, paths, cache, options) {
  const beforeSnapshot = groupSnapshot(group.assertions);
  const evidence = group.assertions.map(assertion => ({
    fact_id: assertion.id,
    object: assertion.object_name,
    source: assertion.source,
    ...evidenceForAssertion(assertion, paths, cache),
  }));
  const unsupported = evidence.find(row => !row.supported);
  const base = { kind: 'fact_review', subject: group.subject_name, predicate: group.predicate, snapshot: beforeSnapshot, evidence };
  if (unsupported) return { ...base, outcome: 'abstained', reason: unsupported.reason };
  const distinctSources = new Set(group.assertions.map(assertion => assertion.source));
  if (distinctSources.size !== group.assertions.length) {
    return { ...base, outcome: 'abstained', reason: 'each competing assertion must come from a distinct harvest source' };
  }
  const rawDecision = await (options.decideFactGroup ?? defaultDecideFactGroup)({ ...base, assertions: group.assertions });
  const items = normalizeDecisionItems(rawDecision.items, group.assertions);
  const result = applyFactDecision(db, group, items, beforeSnapshot, options);
  return { ...base, ...result, items };
}

async function reconcileSupersession(db, candidate, paths, cache, options) {
  const oldEvidence = evidenceForAssertion({
    source: candidate.retired_source,
    subject_name: candidate.subject_name,
    predicate: candidate.predicate,
    object_name: candidate.old_object,
  }, paths, cache);
  const changeEvidence = evidenceForAssertion({
    source: candidate.current_source,
    subject_name: candidate.subject_name,
    predicate: candidate.predicate,
    object_name: candidate.new_object,
  }, paths, cache, { requireChange: true, oldObject: candidate.old_object });
  const before = {
    stale: documentSnapshot(db, candidate.note_id),
    replacement: documentSnapshot(db, candidate.suggested_replacement_id),
  };
  const base = { ...candidate, evidence: { old: oldEvidence, change: changeEvidence }, snapshot: before };
  if (!oldEvidence.supported || !changeEvidence.supported) {
    return { ...base, outcome: 'abstained', reason: oldEvidence.reason || changeEvidence.reason };
  }
  if (candidate.retired_source === candidate.current_source) {
    return { ...base, outcome: 'abstained', reason: 'old and replacement facts must come from distinct harvest sources' };
  }
  const decision = await (options.decideSupersession ?? defaultDecideSupersession)(base);
  const result = applySupersessionDecision(db, candidate, decision, before, options);
  return { ...base, ...result, decision };
}

export async function runReconciliation({
  db = getDb(),
  limit = DEFAULT_RECONCILE_LIMIT,
  predicate = 'status',
  subject = null,
  since = null,
  dryRun = false,
  logPath = RECONCILIATION_LOG,
  now = new Date().toISOString(),
  decideFactGroup,
  decideSupersession,
} = {}) {
  try {
    const max = Math.max(0, Number(limit) || 0);
    const paths = harvestSources(db);
    const cache = new Map();
    const decisions = [];
    const options = { dryRun, decideFactGroup, decideSupersession };

    for (const candidate of supersessionEvidenceCandidates(db, { since, limit: max })) {
      if (decisions.length >= max) break;
      const decision = await reconcileSupersession(db, candidate, paths, cache, options);
      decisions.push({ decided_at: now, ...decision });
      appendDecision(decisions.at(-1), logPath);
    }

    for (const group of factGroups(db, { predicate, subject })) {
      if (decisions.length >= max) break;
      const decision = await reconcileFactGroup(db, group, paths, cache, options);
      decisions.push({ decided_at: now, ...decision });
      appendDecision(decisions.at(-1), logPath);
    }

    const count = outcome => decisions.filter(decision => decision.outcome === outcome).length;
    const result = {
      candidates: decisions.length,
      applied: count('applied'),
      abstained: count('abstained'),
      stale: count('stale'),
      already_applied: count('already_applied'),
      would_apply: count('would_apply'),
      decisions,
    };
    recordReconciliationSuccess(result, { dryRun });
    return result;
  } catch (error) {
    recordReconciliationFailure(error, { dryRun });
    throw error;
  }
}

export function getReconciliationQueueSnapshot(db = getDb(), { limit = DEFAULT_RECONCILE_LIMIT, predicate = 'status', subject = null, since = null } = {}) {
  const max = Math.max(0, Number(limit) || 0);
  const notes = supersessionEvidenceCandidates(db, { since, limit: max });
  const remaining = Math.max(0, max - notes.length);
  return {
    note_supersession: notes,
    fact_review: factGroups(db, { predicate, subject }).slice(0, remaining),
  };
}
