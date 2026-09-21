import { hasColumn, hasTable } from './schema.js';
import { snapshotDocumentVersion } from './doc-version.js';

export const OUTCOME = Object.freeze({
  HELPED: 'helped',
  CORRECTED: 'corrected',
  STALE: 'stale',
});

export const HELPED_OUTCOME_ADJUSTMENT = 0.5;
export const CORRECTED_OUTCOME_ADJUSTMENT = -4;

// Outcome evidence is deliberately a tie-break, not a rank delta. SQLite FTS
// bm25 values are tiny while title/tag identity boosts move ranks in steps of
// 10/20; sorting only inside buckets lets attributed use decide near-equivalent
// candidates without letting one old success overpower a stronger lexical match.
export const FTS_OUTCOME_TIE_BUCKET = 1;
export const HINT_OUTCOME_TIE_BUCKET = 0.25;

const REQUIRED_OUTCOME_COLUMNS = ['doc_id', 'doc_version', 'outcome'];

export function retrievalOutcomesReadable(db) {
  return hasTable(db, 'retrieval_outcomes')
    && REQUIRED_OUTCOME_COLUMNS.every(column => hasColumn(db, 'retrieval_outcomes', column));
}

export function outcomeAdjustmentForDoc(db, doc) {
  try {
    if (!doc?.id || !retrievalOutcomesReadable(db)) return 0;
    const docVersion = doc.doc_version ?? doc.version ?? snapshotDocumentVersion(db, doc.id);
    if (!docVersion) return 0;
    const rows = db.prepare(`
      SELECT outcome, COUNT(*) AS count
      FROM retrieval_outcomes
      WHERE doc_id = ? AND doc_version = ?
      GROUP BY outcome
    `).all(doc.id, docVersion);
    const counts = new Map(rows.map(row => [row.outcome, row.count]));
    if ((counts.get(OUTCOME.CORRECTED) || 0) > 0) return CORRECTED_OUTCOME_ADJUSTMENT;
    if ((counts.get(OUTCOME.HELPED) || 0) > 0) return HELPED_OUTCOME_ADJUSTMENT;
    return 0;
  } catch {
    return 0;
  }
}

export function outcomeAdjustmentsForDocs(db, docs) {
  const adjustments = new Map(docs.map(doc => [doc.id, 0]));
  try {
    if (!docs.length || !retrievalOutcomesReadable(db)) return adjustments;
    const versioned = docs.filter(doc => doc?.id && doc.doc_version);
    if (!versioned.length) return adjustments;
    const where = versioned.map(() => '(doc_id = ? AND doc_version = ?)').join(' OR ');
    const rows = db.prepare(`
      SELECT doc_id, outcome, COUNT(*) AS count
      FROM retrieval_outcomes
      WHERE ${where}
      GROUP BY doc_id, outcome
    `).all(...versioned.flatMap(doc => [doc.id, doc.doc_version]));
    const outcomesByDoc = new Map();
    for (const row of rows) {
      if (!outcomesByDoc.has(row.doc_id)) outcomesByDoc.set(row.doc_id, new Map());
      outcomesByDoc.get(row.doc_id).set(row.outcome, row.count);
    }
    for (const doc of versioned) {
      const counts = outcomesByDoc.get(doc.id);
      if ((counts?.get(OUTCOME.CORRECTED) || 0) > 0) {
        adjustments.set(doc.id, CORRECTED_OUTCOME_ADJUSTMENT);
      } else if ((counts?.get(OUTCOME.HELPED) || 0) > 0) {
        adjustments.set(doc.id, HELPED_OUTCOME_ADJUSTMENT);
      }
    }
    return adjustments;
  } catch {
    return adjustments;
  }
}


export function outcomeSignalForDoc(db, doc) {
  const adjustment = outcomeAdjustmentForDoc(db, doc);
  return adjustment === 0 ? 0 : adjustment > 0 ? 1 : -1;
}

export function compareByOutcomeSignal(db, a, b) {
  return outcomeSignalForDoc(db, b) - outcomeSignalForDoc(db, a);
}
