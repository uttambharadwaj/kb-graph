import { basename } from 'path';
import { searchDocuments } from './db.js';
import { canonicalEntityId } from './facts.js';
import { reviewedFactGroupStates } from './fact-reviews.js';

const ENTITY_LIMIT = 3;
const FACTS_PER_ENTITY = 12;
const FACT_ROW_LIMIT = ENTITY_LIMIT * FACTS_PER_ENTITY * 2;
const FACT_GROUP_LIMIT = 10;
const CANDIDATES_PER_GROUP = 4;
const DECISIONS_PER_GROUP = 8;
const MAX_CONTEXT_DOCS = 50;
const MAX_HISTORY_DOCS = 20;
const MAX_ENTITY_TERM_PARTS = 12;
const MAX_ENTITY_TERMS = 200;

// These are useful words in a question but not a useful entity match on their
// own. Without the guard, "what is the current status" can bind to an entity
// literally named status and return a confident-looking answer to an ambiguous
// question.
const GENERIC_ENTITIES = new Set([
  'current', 'evidence', 'fact', 'facts', 'history', 'knowledge', 'project',
  'application', 'component', 'repo', 'server', 'service', 'state', 'status',
  'system', 'tool', 'workstream',
]);

const groupKey = (subject, predicate) => `${subject}\0${predicate}`;

function entityTerms(queryId) {
  if (!queryId) return [];
  const parts = queryId.split('_').filter(Boolean);
  const terms = new Set([queryId]);
  for (let width = 1; width <= Math.min(parts.length, MAX_ENTITY_TERM_PARTS); width++) {
    for (let start = 0; start + width <= parts.length; start++) {
      terms.add(parts.slice(start, start + width).join('_'));
      if (terms.size >= MAX_ENTITY_TERMS) return [...terms];
    }
  }
  return [...terms];
}

function positiveLimit(limit, fallback = 15) {
  return Number.isInteger(limit) && limit > 0
    ? Math.min(limit, MAX_CONTEXT_DOCS)
    : fallback;
}

function rowsById(db, ids) {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT
      d.id, d.title, d.doc_type, d.tags AS document_tags, d.tier,
      d.tier_ref, d.source AS document_source, d.created_at, d.updated_at,
      d.superseded_at, d.superseded_by, d.superseded_reason,
      vf.note_type, vf.tags AS vault_tags, vf.project,
      vf.source AS vault_source, vf.summary, vf.key_topics
    FROM documents d
    LEFT JOIN vault_files vf ON vf.document_id = d.id
    WHERE d.id IN (${placeholders})
  `).all(...ids);
  return new Map(rows.map(row => [row.id, row]));
}

function briefing(row, fallback = null) {
  return {
    id: row.id,
    title: row.title,
    type: row.note_type || row.doc_type,
    tier: row.tier,
    tier_ref: row.tier_ref || null,
    tags: row.vault_tags || row.document_tags,
    project: row.project || null,
    source: row.vault_source || row.document_source || null,
    summary: row.summary || fallback?.snippet?.replace(/<\/?mark>/g, '').slice(0, 200) || null,
    key_topics: row.key_topics || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.superseded_at ? {
      superseded_at: row.superseded_at,
      superseded_by: row.superseded_by,
      superseded_reason: row.superseded_reason,
    } : {}),
  };
}

function orderedBriefings(db, results) {
  const byId = rowsById(db, results.map(result => result.id));
  return results.flatMap(result => {
    const row = byId.get(result.id);
    return row ? [briefing(row, result)] : [];
  });
}

function matchesFilters(doc, { project, type }) {
  return (!project || doc.project === project) && (!type || doc.type === type);
}

function currentDocuments(db, { query, limit, project, type }) {
  const results = searchDocuments(query, limit);
  const documents = orderedBriefings(db, results);

  // Preserve kb_context's existing project/type behavior: a filter is also a
  // request for recent documents in that slice, even when FTS did not rank them.
  if (project || type) {
    let sql = `
      SELECT d.id
      FROM vault_files vf
      JOIN documents d ON d.id = vf.document_id
      WHERE d.superseded_at IS NULL
    `;
    const params = [];
    if (project) { sql += ' AND vf.project = ?'; params.push(project); }
    if (type) { sql += ' AND vf.note_type = ?'; params.push(type); }
    sql += ' ORDER BY vf.indexed_at DESC LIMIT ?';
    params.push(limit);

    const seen = new Set(documents.map(doc => doc.id));
    const extraIds = db.prepare(sql).all(...params).map(row => row.id).filter(id => !seen.has(id));
    const extraRows = rowsById(db, extraIds);
    for (const id of extraIds) {
      const row = extraRows.get(id);
      if (row) documents.push(briefing(row));
    }
  }
  return documents.slice(0, limit);
}

function supersededDocuments(db, { query, limit, project, type, current }) {
  const searchLimit = Math.min(Math.max(limit * 3, 15), MAX_CONTEXT_DOCS);
  const searched = searchDocuments(query, searchLimit, { includeSuperseded: true });
  const ids = searched.map(row => row.id);

  // Direct replacements are relevant history even when enough live search hits
  // fill the FTS page before the old note appears.
  if (current.length) {
    const placeholders = current.map(() => '?').join(', ');
    ids.push(...db.prepare(
      `SELECT id FROM documents WHERE superseded_by IN (${placeholders})`
    ).all(...current.map(doc => doc.id)).map(row => row.id));
  }

  const uniqueIds = [...new Set(ids)];
  const byId = rowsById(db, uniqueIds);
  const fallback = new Map(searched.map(row => [row.id, row]));
  return uniqueIds.flatMap(id => {
    const row = byId.get(id);
    if (!row?.superseded_at) return [];
    const doc = briefing(row, fallback.get(id));
    return matchesFilters(doc, { project, type }) ? [doc] : [];
  }).slice(0, Math.min(limit, MAX_HISTORY_DOCS));
}

function matchedEntities(db, query) {
  const queryId = canonicalEntityId(query);
  const terms = entityTerms(queryId);
  if (!terms.length) return [];
  const termSet = new Set(terms);
  const aliases = new Map();
  for (const row of db.prepare('SELECT alias, canonical FROM entity_aliases').all()) {
    const canonical = canonicalEntityId(row.canonical);
    if (!aliases.has(canonical)) aliases.set(canonical, []);
    aliases.get(canonical).push(canonicalEntityId(row.alias));
  }

  const placeholders = terms.map(() => '?').join(', ');
  const directlyMatched = db.prepare(
    `SELECT id, name FROM entities WHERE id IN (${placeholders})`
  ).all(...terms);
  const aliasCanonicals = [...aliases].flatMap(([canonical, values]) =>
    values.some(alias => alias && !GENERIC_ENTITIES.has(alias)
      && termSet.has(alias)) ? [canonical] : []);
  let aliasMatched = [];
  if (aliasCanonicals.length) {
    const aliasPlaceholders = aliasCanonicals.map(() => '?').join(', ');
    aliasMatched = db.prepare(
      `SELECT id, name FROM entities WHERE id IN (${aliasPlaceholders})`
    ).all(...aliasCanonicals);
  }

  const candidates = [...new Map(
    [...directlyMatched, ...aliasMatched].map(row => [row.id, row])
  ).values()]
    .flatMap(row => {
      const ids = [row.id, ...(aliases.get(row.id) || [])];
      const matchedBy = ids.find(id => {
        if (!id || GENERIC_ENTITIES.has(id)) return false;
        return termSet.has(id);
      });
      if (!matchedBy) return [];
      const parts = matchedBy.split('_').filter(Boolean).length;
      return [{
        ...row,
        matched_by: matchedBy,
        score: Number(queryId === matchedBy) * 10_000
          + parts * 1_000
          + matchedBy.length * 10,
      }];
    }).sort((a, b) => b.score - a.score)
    .slice(0, ENTITY_LIMIT * 3);
  if (!candidates.length) return [];

  const candidateIds = candidates.map(row => row.id);
  const candidatePlaceholders = candidateIds.map(() => '?').join(', ');
  const counts = new Map(db.prepare(`
    WITH counts AS (
      SELECT subject AS id, COUNT(*) AS outgoing_count, 0 AS incoming_count
      FROM facts WHERE subject IN (${candidatePlaceholders}) GROUP BY subject
      UNION ALL
      SELECT object AS id, 0 AS outgoing_count, COUNT(*) AS incoming_count
      FROM facts WHERE object IN (${candidatePlaceholders}) GROUP BY object
    )
    SELECT id, SUM(outgoing_count) AS outgoing_count,
      SUM(incoming_count) AS incoming_count
    FROM counts GROUP BY id
  `).all(...candidateIds, ...candidateIds).map(row => [row.id, row]));

  return candidates.map(row => ({
    ...row,
    outgoing_count: counts.get(row.id)?.outgoing_count || 0,
    incoming_count: counts.get(row.id)?.incoming_count || 0,
    score: row.score + Number((counts.get(row.id)?.outgoing_count || 0) > 0) * 5,
  })).sort((a, b) => b.score - a.score || b.outgoing_count - a.outgoing_count)
    .slice(0, ENTITY_LIMIT)
    .map(({ score, ...row }) => row);
}

function evidenceResolver(db) {
  const harvest = new Map();
  for (const row of db.prepare('SELECT transcript_path FROM harvest_log').all()) {
    if (row.transcript_path) harvest.set(basename(row.transcript_path, '.jsonl'), row.transcript_path);
  }
  return source => {
    if (!source) return { status: 'absent' };
    if (!source.startsWith('harvest:')) return { status: 'referenced' };
    const path = harvest.get(source.slice('harvest:'.length));
    if (!path) return { status: 'unmapped' };
    return { status: 'harvested' };
  };
}

function factRows(db, entities) {
  if (!entities.length) return [];
  const ids = entities.map(entity => entity.id);
  const placeholders = ids.map(() => '?').join(', ');
  return db.prepare(`
    SELECT
      f.id AS fact_id, f.subject AS subject_id, s.name AS subject,
      f.predicate, f.object AS object_id, o.name AS object,
      f.valid_from, f.valid_to, f.source, f.created_at AS recorded_at
    FROM facts f
    JOIN entities s ON s.id = f.subject
    JOIN entities o ON o.id = f.object
    WHERE f.subject IN (${placeholders}) OR f.object IN (${placeholders})
    ORDER BY (f.subject IN (${placeholders})) DESC,
      (f.valid_to IS NULL) DESC,
      COALESCE(f.valid_from, '') DESC, f.created_at DESC, f.id DESC
    LIMIT ?
  `).all(...ids, ...ids, ...ids, FACT_ROW_LIMIT);
}

function displayedFact(row, entityId, resolveEvidence) {
  return {
    entity: entityId,
    direction: row.subject_id === entityId ? 'outgoing' : 'incoming',
    fact_id: row.fact_id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    current: row.valid_to === null,
    source: row.source,
    evidence: resolveEvidence(row.source),
    recorded_at: row.recorded_at,
  };
}

function factLayers(db, entities) {
  const rows = factRows(db, entities);
  const resolveEvidence = evidenceResolver(db);
  const entityIds = new Set(entities.map(entity => entity.id));
  const byEntity = new Map(entities.map(entity => [entity.id, []]));
  for (const row of rows) {
    if (byEntity.has(row.subject_id)) byEntity.get(row.subject_id).push(row);
    if (row.object_id !== row.subject_id && byEntity.has(row.object_id)) byEntity.get(row.object_id).push(row);
  }

  const allOutgoingGroups = [...new Map(rows.filter(row => entityIds.has(row.subject_id)).map(row => [
    groupKey(row.subject_id, row.predicate),
    { subject: row.subject_id, predicate: row.predicate },
  ])).values()];
  const allReviews = reviewedFactGroupStates(db, { groups: allOutgoingGroups });
  const allReviewsByGroup = new Map(allReviews.map(review => [
    groupKey(review.subject, review.predicate), review,
  ]));
  const outgoingGroups = allOutgoingGroups.map((group, index) => {
    const review = allReviewsByGroup.get(groupKey(group.subject, group.predicate));
    const priority = review?.state === 'adjudicated' && review.projection === 'available'
      ? 0
      : review ? 1 : 2;
    return { ...group, index, priority };
  }).sort((left, right) => left.priority - right.priority || left.index - right.index)
    .slice(0, FACT_GROUP_LIMIT)
    .map(({ index, priority, ...group }) => group);
  const outgoingGroupKeys = new Set(outgoingGroups.map(group => groupKey(group.subject, group.predicate)));
  const reviews = allReviews.filter(review => outgoingGroupKeys.has(groupKey(review.subject, review.predicate)));
  const reviewsByGroup = new Map(reviews.map(review => [groupKey(review.subject, review.predicate), review]));

  const currentState = [];
  for (const review of reviews) {
    if (review.state !== 'adjudicated' || review.projection !== 'available') continue;
    const items = new Map(review.items.map(item => [item.fact_id, item]));
    currentState.push({
      subject: review.subject,
      predicate: review.predicate,
      review_id: review.review_id,
      reviewed_at: review.reviewed_at,
      reviewer: review.reviewer,
      policy: review.policy,
      facts: review.current.slice(0, DECISIONS_PER_GROUP).map(fact => ({
        fact_id: fact.id,
        object: fact.object_name,
        evidence_ref: items.get(fact.id)?.evidence_ref || fact.source || null,
      })),
      ...(review.current.length > DECISIONS_PER_GROUP ? {
        partial: `showing ${DECISIONS_PER_GROUP} of ${review.current.length} projected facts`,
      } : {}),
    });
  }

  const unresolved = [];
  const liveOutgoing = new Map();
  for (const row of rows.filter(row => row.valid_to === null)) {
    const key = groupKey(row.subject_id, row.predicate);
    if (!outgoingGroupKeys.has(key)) continue;
    if (!liveOutgoing.has(key)) liveOutgoing.set(key, []);
    liveOutgoing.get(key).push(row);
  }
  const unresolvedGroups = new Map(liveOutgoing);
  for (const review of reviews) {
    const key = groupKey(review.subject, review.predicate);
    if (!unresolvedGroups.has(key)) unresolvedGroups.set(key, []);
  }
  for (const [key, candidates] of unresolvedGroups) {
    const review = reviewsByGroup.get(key);
    if (review?.state === 'adjudicated' && review.projection === 'available') continue;
    const [subject, predicate] = key.split('\0');
    unresolved.push({
      subject,
      predicate,
      state: review?.state || 'unadjudicated',
      projection: review?.projection || 'abstained',
      review_id: review?.review_id || null,
      reviewed_at: review?.reviewed_at || null,
      reviewer: review?.reviewer || null,
      policy: review?.policy || null,
      review_note: review?.note || null,
      decisions: review?.items.slice(0, DECISIONS_PER_GROUP) || [],
      ...(review?.items.length > DECISIONS_PER_GROUP ? {
        decision_partial: `showing ${DECISIONS_PER_GROUP} of ${review.items.length} review decisions`,
      } : {}),
      ...(review?.drift ? { drift: review.drift } : {}),
      candidates: candidates.slice(0, CANDIDATES_PER_GROUP).map(row => ({
        fact_id: row.fact_id,
        object: row.object,
        source: row.source,
        evidence: resolveEvidence(row.source),
        valid_from: row.valid_from,
        recorded_at: row.recorded_at,
      })),
      ...(candidates.length > CANDIDATES_PER_GROUP ? {
        partial: `showing ${CANDIDATES_PER_GROUP} of ${candidates.length} live candidates`,
      } : {}),
    });
  }

  const liveEvidence = [];
  const retiredHistory = [];
  for (const entity of entities) {
    const visible = byEntity.get(entity.id).slice(0, FACTS_PER_ENTITY);
    for (const row of visible) {
      const fact = displayedFact(row, entity.id, resolveEvidence);
      if (fact.current) liveEvidence.push(fact);
      else retiredHistory.push(fact);
    }
  }
  return { currentState, liveEvidence, retiredHistory, unresolved };
}

/**
 * One deep read interface over notes, fact evidence, reviewed projections and
 * superseded history. The packet never promotes raw fact recency into current
 * state: only a fresh complete review appears under current_state.facts.
 */
export function buildContextPacket(db, { query, limit, project, type }) {
  const boundedLimit = positiveLimit(limit);
  const documents = currentDocuments(db, {
    query, limit: boundedLimit, project, type,
  });
  const entities = matchedEntities(db, query);
  const facts = factLayers(db, entities);
  const superseded = supersededDocuments(db, {
    query, limit: boundedLimit, project, type, current: documents,
  });

  return {
    query,
    limits: {
      documents: boundedLimit,
      entities: ENTITY_LIMIT,
      fact_rows: FACT_ROW_LIMIT,
      fact_groups: FACT_GROUP_LIMIT,
      candidates_per_group: CANDIDATES_PER_GROUP,
      decisions_per_group: DECISIONS_PER_GROUP,
    },
    documents,
    matched_entities: entities,
    current_state: {
      notes: documents.filter(doc => doc.type === 'state'),
      facts: facts.currentState,
    },
    evidence: {
      facts: facts.liveEvidence,
    },
    history: {
      superseded_notes: superseded,
      facts: facts.retiredHistory,
    },
    unresolved: {
      fact_groups: facts.unresolved,
    },
  };
}
