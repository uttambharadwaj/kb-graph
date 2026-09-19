import { canonicalEntityId } from './facts.js';
import { canonicalPredicate } from './predicates.js';

export const FACT_REVIEW_POLICY = 'manual-review-v1';
export const FACT_REVIEW_DISPOSITIONS = Object.freeze([
  'current',
  'superseded',
  'synonym',
  'rejected',
  'abstain',
]);

const DISPOSITIONS = new Set(FACT_REVIEW_DISPOSITIONS);
const TARGETED = new Set(['superseded', 'synonym']);
const ITEM_KEYS = new Set(['fact_id', 'disposition', 'target_fact_id', 'reason']);
const MAX_ITEMS = 1000;
const MAX_REVIEWER_CHARS = 200;
const MAX_NOTE_CHARS = 4000;
const MAX_REASON_CHARS = 1000;
const MAX_GROUPS_PER_QUERY = 400;

const groupKey = (subject, predicate) => `${subject}\0${predicate}`;

export class FactReviewError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FactReviewError';
  }
}

const cleanRequired = (value, label, maxChars) => {
  const cleaned = typeof value === 'string' ? value.trim() : '';
  if (!cleaned) throw new FactReviewError(`${label} must not be empty`);
  if (cleaned.length > maxChars) {
    throw new FactReviewError(`${label} must be at most ${maxChars} characters`);
  }
  return cleaned;
};

const cleanOptional = (value, label, maxChars) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new FactReviewError(`${label} must be a string`);
  const cleaned = value.trim();
  if (cleaned.length > maxChars) {
    throw new FactReviewError(`${label} must be at most ${maxChars} characters`);
  }
  return cleaned || null;
};

const cleanOptionalId = (value, label) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new FactReviewError(`${label} must be a string`);
  return value.trim() || null;
};

function aliasMap(db) {
  return new Map(db.prepare('SELECT alias, canonical FROM entity_aliases').all()
    .map(row => [row.alias, canonicalEntityId(row.canonical)]));
}

function resolveStoredSubject(subject, aliases) {
  const canonical = canonicalEntityId(subject);
  return aliases.get(canonical) ?? canonical;
}

export function reviewSubjectId(db, subject) {
  return resolveStoredSubject(subject, aliasMap(db));
}

function liveFactsForGroup(db, subject, predicate) {
  return db.prepare(`
    SELECT
      f.id, f.subject, f.predicate, f.object, o.name AS object_name,
      f.valid_from, f.source, f.created_at AS recorded_at
    FROM facts f
    JOIN entities o ON o.id = f.object
    WHERE f.subject = ? AND f.predicate = ? AND f.valid_to IS NULL
    ORDER BY COALESCE(f.valid_from, ''), f.created_at, f.id
  `).all(subject, predicate);
}

function latestReviewForGroup(db, subject, predicate) {
  return db.prepare(`
    SELECT * FROM fact_reviews
    WHERE predicate = ?
      AND (
        subject = ?
        OR subject IN (SELECT alias FROM entity_aliases WHERE canonical = ?)
      )
    ORDER BY id DESC
    LIMIT 1
  `).get(predicate, subject, subject) ?? null;
}

const decisionShape = item => ({
  fact_id: item.fact_id,
  disposition: item.disposition,
  target_fact_id: item.target_fact_id ?? null,
  evidence_ref: item.evidence_ref ?? null,
  reason: item.reason ?? null,
});

function sameDecisions(left, right) {
  const normalized = rows => rows.map(decisionShape)
    .sort((a, b) => a.fact_id.localeCompare(b.fact_id));
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

export function normalizeReviewItems(items, facts) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new FactReviewError('items must be a non-empty JSON array');
  }
  if (items.length > MAX_ITEMS) {
    throw new FactReviewError(`items must contain at most ${MAX_ITEMS} facts`);
  }

  const factsById = new Map(facts.map(fact => [fact.id, fact]));
  const seen = new Set();
  const duplicate = [];
  const unknown = [];
  for (const item of items) {
    const id = typeof item?.fact_id === 'string' ? item.fact_id.trim() : '';
    if (!id || !factsById.has(id)) unknown.push(id || '(missing fact_id)');
    if (seen.has(id)) duplicate.push(id);
    seen.add(id);
  }
  const missing = facts.filter(fact => !seen.has(fact.id)).map(fact => fact.id);
  if (duplicate.length || unknown.length || missing.length) {
    const parts = [];
    if (missing.length) parts.push(`missing: [${missing.join(', ')}]`);
    if (unknown.length) parts.push(`unknown: [${unknown.join(', ')}]`);
    if (duplicate.length) parts.push(`duplicate: [${duplicate.join(', ')}]`);
    throw new FactReviewError(`review must cover the live fact set exactly (${parts.join('; ')})`);
  }

  const normalized = items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new FactReviewError(`items[${index}] must be an object`);
    }
    const extra = Object.keys(item).filter(key => !ITEM_KEYS.has(key));
    if (extra.length) {
      throw new FactReviewError(`items[${index}] has unknown field(s): ${extra.join(', ')}`);
    }

    const factId = item.fact_id.trim();
    const disposition = typeof item.disposition === 'string' ? item.disposition.trim() : '';
    if (!DISPOSITIONS.has(disposition)) {
      throw new FactReviewError(
        `items[${index}].disposition must be one of: ${FACT_REVIEW_DISPOSITIONS.join(', ')}`
      );
    }

    // Fact ids include canonical object ids, whose database column is unbounded.
    // The CLI input has its own 1 MiB cap, so an arbitrary extra id-length cap
    // only makes a valid stored fact impossible to review.
    const targetFactId = cleanOptionalId(item.target_fact_id, `items[${index}].target_fact_id`);
    const reason = cleanOptional(item.reason, `items[${index}].reason`, MAX_REASON_CHARS);
    if (TARGETED.has(disposition) !== Boolean(targetFactId)) {
      throw new FactReviewError(
        `items[${index}] ${disposition} ${TARGETED.has(disposition) ? 'requires' : 'must not set'} target_fact_id`
      );
    }
    if (targetFactId === factId) {
      throw new FactReviewError(`items[${index}].target_fact_id must not point to itself`);
    }
    if ((disposition === 'rejected' || disposition === 'abstain') && !reason) {
      throw new FactReviewError(`items[${index}] ${disposition} requires a reason`);
    }

    const source = factsById.get(factId).source;
    if ((!source || !String(source).trim()) && disposition !== 'abstain') {
      throw new FactReviewError(
        `items[${index}] cannot be ${disposition}: fact ${factId} has no provenance source; use abstain`
      );
    }
    return {
      fact_id: factId,
      disposition,
      target_fact_id: targetFactId,
      evidence_ref: source && String(source).trim() ? String(source).trim() : null,
      reason,
    };
  });

  const byId = new Map(normalized.map(item => [item.fact_id, item]));
  for (const item of normalized) {
    if (!item.target_fact_id) continue;
    const target = byId.get(item.target_fact_id);
    if (!target || target.disposition !== 'current') {
      throw new FactReviewError(
        `${item.disposition} fact ${item.fact_id} must target a current fact in the same review`
      );
    }
  }

  // Database target triggers require the referenced current rows to exist
  // first; stable fact-id ordering keeps the resulting ledger deterministic.
  return normalized.sort((a, b) =>
    Number(b.disposition === 'current') - Number(a.disposition === 'current')
    || a.fact_id.localeCompare(b.fact_id));
}

export function reviewFactGroup(db, {
  subject,
  predicate,
  reviewer,
  items,
  note = null,
  policy = FACT_REVIEW_POLICY,
}) {
  const cleanedReviewer = cleanRequired(reviewer, 'reviewer', MAX_REVIEWER_CHARS);
  const cleanedNote = cleanOptional(note, 'note', MAX_NOTE_CHARS);
  const cleanedPolicy = cleanRequired(policy, 'policy', 100);

  return db.transaction(() => {
    const subjectId = reviewSubjectId(db, cleanRequired(subject, 'subject', 300));
    const predicateId = canonicalPredicate(cleanRequired(predicate, 'predicate', 200));
    const facts = liveFactsForGroup(db, subjectId, predicateId);
    if (!facts.length) {
      throw new FactReviewError(`no live facts found for ${subjectId} / ${predicateId}`);
    }

    const decisions = normalizeReviewItems(items, facts);
    const latest = latestReviewForGroup(db, subjectId, predicateId);
    if (latest) {
      const latestItems = db.prepare(
        'SELECT fact_id, disposition, target_fact_id, evidence_ref, reason FROM fact_review_items WHERE review_id = ?'
      ).all(latest.id);
      if (sameDecisions(decisions, latestItems)) {
        throw new FactReviewError(`no decision change since review #${latest.id}`);
      }
    }

    const inserted = db.prepare(`
      INSERT INTO fact_reviews (subject, predicate, reviewer, policy, fact_count, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(subjectId, predicateId, cleanedReviewer, cleanedPolicy, facts.length, cleanedNote);
    const reviewId = Number(inserted.lastInsertRowid);
    const putItem = db.prepare(`
      INSERT INTO fact_review_items
        (review_id, fact_id, disposition, target_fact_id, evidence_ref, reason)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const item of decisions) {
      putItem.run(
        reviewId,
        item.fact_id,
        item.disposition,
        item.target_fact_id,
        item.evidence_ref,
        item.reason,
      );
    }
    return {
      id: reviewId,
      subject: subjectId,
      predicate: predicateId,
      reviewer: cleanedReviewer,
      policy: cleanedPolicy,
      fact_count: facts.length,
      note: cleanedNote,
      items: decisions,
    };
  }).immediate();
}

function unadjudicatedState() {
  return {
    state: 'unadjudicated',
    projection: 'abstained',
    review_id: null,
    reviewed_at: null,
    reviewer: null,
    policy: null,
    note: null,
    current: null,
    items: [],
  };
}

function buildReviewState(facts, review, items) {
  if (!review) return unadjudicatedState();

  const liveIds = new Set(facts.map(fact => fact.id));
  const reviewedIds = new Set(items.map(item => item.fact_id));
  const added = facts.filter(fact => !reviewedIds.has(fact.id)).map(fact => fact.id);
  const removed = items.filter(item => !liveIds.has(item.fact_id)).map(item => item.fact_id);
  const incomplete = items.length !== review.fact_count;
  const base = {
    review_id: review.id,
    reviewed_at: review.reviewed_at,
    reviewer: review.reviewer,
    policy: review.policy,
    note: review.note,
    items: items.map(decisionShape),
  };

  if (added.length || removed.length || incomplete) {
    return {
      ...base,
      state: 'stale',
      projection: 'abstained',
      current: null,
      drift: { added, removed, incomplete_review: incomplete },
    };
  }

  if (items.some(item => item.disposition === 'abstain')) {
    return {
      ...base,
      state: 'adjudicated',
      projection: 'abstained',
      current: null,
    };
  }

  const byId = new Map(facts.map(fact => [fact.id, fact]));
  return {
    ...base,
    state: 'adjudicated',
    projection: 'available',
    current: items.filter(item => item.disposition === 'current').map(item => byId.get(item.fact_id)),
  };
}

export function factReviewStates(db, { predicate, currentFacts }) {
  const predicateId = canonicalPredicate(predicate);
  const factsBySubject = new Map();
  for (const fact of currentFacts) {
    if (!factsBySubject.has(fact.subject)) factsBySubject.set(fact.subject, []);
    factsBySubject.get(fact.subject).push(fact);
  }

  const aliases = aliasMap(db);
  const latestBySubject = new Map();
  for (const review of db.prepare(
    'SELECT * FROM fact_reviews WHERE predicate = ? ORDER BY id DESC'
  ).all(predicateId)) {
    const subject = resolveStoredSubject(review.subject, aliases);
    if (factsBySubject.has(subject) && !latestBySubject.has(subject)) latestBySubject.set(subject, review);
  }

  const itemsByReview = new Map();
  const reviewIds = [...latestBySubject.values()].map(review => review.id);
  if (reviewIds.length) {
    const placeholders = reviewIds.map(() => '?').join(', ');
    for (const item of db.prepare(`
      SELECT review_id, fact_id, disposition, target_fact_id, evidence_ref, reason
      FROM fact_review_items
      WHERE review_id IN (${placeholders})
      ORDER BY review_id, fact_id
    `).all(...reviewIds)) {
      if (!itemsByReview.has(item.review_id)) itemsByReview.set(item.review_id, []);
      itemsByReview.get(item.review_id).push(item);
    }
  }

  return new Map([...factsBySubject].map(([subject, facts]) => {
    const review = latestBySubject.get(subject) ?? null;
    const items = review ? itemsByReview.get(review.id) ?? [] : [];
    return [subject, buildReviewState(facts, review, items)];
  }));
}

// Tool reads start with display-shaped facts, not database rows with ids. Load
// the complete live membership for only the reviewed outgoing groups in one
// bounded batch so a page or direction filter can never make a review appear
// fresh. Unreviewed groups are intentionally absent: callers can preserve their
// old response shape instead of learning a new empty wrapper everywhere.
export function reviewedFactGroupStates(db, { groups }) {
  if (!Array.isArray(groups) || groups.length === 0) return [];

  const aliases = aliasMap(db);
  const requested = new Map();
  for (const group of groups) {
    const subject = resolveStoredSubject(group.subject, aliases);
    const predicate = canonicalPredicate(group.predicate);
    requested.set(groupKey(subject, predicate), { subject, predicate });
  }

  const predicates = [...new Set([...requested.values()].map(group => group.predicate))];
  const latestByGroup = new Map();
  for (let from = 0; from < predicates.length; from += MAX_GROUPS_PER_QUERY) {
    const chunk = predicates.slice(from, from + MAX_GROUPS_PER_QUERY);
    const placeholders = chunk.map(() => '?').join(', ');
    for (const review of db.prepare(`
      SELECT * FROM fact_reviews
      WHERE predicate IN (${placeholders})
      ORDER BY id DESC
    `).all(...chunk)) {
      const subject = resolveStoredSubject(review.subject, aliases);
      const key = groupKey(subject, review.predicate);
      if (requested.has(key) && !latestByGroup.has(key)) latestByGroup.set(key, review);
    }
  }
  if (!latestByGroup.size) return [];

  const factsByGroup = new Map([...latestByGroup].map(([key]) => [key, []]));
  const reviewedGroups = [...latestByGroup].map(([key]) => requested.get(key));
  for (let from = 0; from < reviewedGroups.length; from += MAX_GROUPS_PER_QUERY) {
    const chunk = reviewedGroups.slice(from, from + MAX_GROUPS_PER_QUERY);
    const conditions = chunk.map(() => '(f.subject = ? AND f.predicate = ?)').join(' OR ');
    const params = chunk.flatMap(group => [group.subject, group.predicate]);
    for (const fact of db.prepare(`
      SELECT
        f.id, f.subject, f.predicate, f.object, o.name AS object_name,
        f.valid_from, f.source, f.created_at AS recorded_at
      FROM facts f
      JOIN entities o ON o.id = f.object
      WHERE f.valid_to IS NULL AND (${conditions})
      ORDER BY COALESCE(f.valid_from, ''), f.created_at, f.id
    `).all(...params)) {
      factsByGroup.get(groupKey(fact.subject, fact.predicate))?.push(fact);
    }
  }

  const itemsByReview = new Map();
  const reviewIds = [...latestByGroup.values()].map(review => review.id);
  for (let from = 0; from < reviewIds.length; from += MAX_GROUPS_PER_QUERY) {
    const chunk = reviewIds.slice(from, from + MAX_GROUPS_PER_QUERY);
    const placeholders = chunk.map(() => '?').join(', ');
    for (const item of db.prepare(`
      SELECT review_id, fact_id, disposition, target_fact_id, evidence_ref, reason
      FROM fact_review_items
      WHERE review_id IN (${placeholders})
      ORDER BY review_id, fact_id
    `).all(...chunk)) {
      if (!itemsByReview.has(item.review_id)) itemsByReview.set(item.review_id, []);
      itemsByReview.get(item.review_id).push(item);
    }
  }

  return [...requested].flatMap(([key, group]) => {
    const review = latestByGroup.get(key);
    if (!review) return [];
    const items = itemsByReview.get(review.id) ?? [];
    return [{
      ...group,
      ...buildReviewState(factsByGroup.get(key) ?? [], review, items),
    }];
  });
}

export function factReviewState(db, { subject, predicate }) {
  const subjectId = reviewSubjectId(db, subject);
  const predicateId = canonicalPredicate(predicate);
  const facts = liveFactsForGroup(db, subjectId, predicateId);
  const review = latestReviewForGroup(db, subjectId, predicateId);
  const items = review ? db.prepare(`
    SELECT review_id, fact_id, disposition, target_fact_id, evidence_ref, reason
    FROM fact_review_items
    WHERE review_id = ?
    ORDER BY fact_id
  `).all(review.id) : [];
  return buildReviewState(facts, review, items);
}
