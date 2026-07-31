import { getDb } from '../db.js';
import { SURFACE } from '../retrieval.js';

function pct(n, total) {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : 'n/a';
}

// A doc counts as "ever retrieved" if it appears with a non-null doc_id in
// retrievals under ANY surface (kb_read, kb_search, kb_context, briefing,
// hint) — coverage measures whether the read path has touched it at all,
// not specifically whether it was opened via kb_read.
const RETRIEVED_DOC_IDS = 'SELECT DISTINCT doc_id FROM retrievals WHERE doc_id IS NOT NULL';

export function retrievalReport(db = getDb()) {
  const coverage = db.prepare(`
    SELECT COUNT(*) AS total, COUNT(r.doc_id) AS retrieved
    FROM documents d
    LEFT JOIN (${RETRIEVED_DOC_IDS}) r ON r.doc_id = d.id
    WHERE d.superseded_at IS NULL
  `).get();

  const byType = db.prepare(`
    SELECT d.doc_type AS doc_type, COUNT(*) AS total, COUNT(r.doc_id) AS retrieved
    FROM documents d
    LEFT JOIN (${RETRIEVED_DOC_IDS}) r ON r.doc_id = d.id
    WHERE d.superseded_at IS NULL
    GROUP BY d.doc_type
    ORDER BY total DESC
  `).all();

  // Notes written in the last 90 days, and whether their first-ever
  // retrieval landed within 30 days of being written. A freshness check,
  // distinct from lifetime coverage above.
  const freshness = db.prepare(`
    SELECT
      COUNT(*) AS written,
      SUM(CASE WHEN r.first_retrieved_at IS NOT NULL
               AND julianday(r.first_retrieved_at) - julianday(d.created_at) <= 30
          THEN 1 ELSE 0 END) AS retrieved_within_30d
    FROM documents d
    LEFT JOIN (
      SELECT doc_id, MIN(created_at) AS first_retrieved_at
      FROM retrievals WHERE doc_id IS NOT NULL GROUP BY doc_id
    ) r ON r.doc_id = d.id
    WHERE d.superseded_at IS NULL
      AND d.created_at >= datetime('now', '-90 days')
  `).get();

  // A hint "follows through" when the same doc_id is kb_read in the same
  // session, after the hint fired. `session` is NULL on both sides whenever
  // it wasn't available at log time; SQL's NULL = NULL is never true, so two
  // NULL-session rows never falsely pair — an unresolvable hint reports as
  // unfollowed rather than as a false match.
  const followThrough = db.prepare(`
    SELECT
      COUNT(*) AS hints_emitted,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM retrievals r2
        WHERE r2.surface = '${SURFACE.READ}' AND r2.doc_id = h.doc_id
          AND r2.session = h.session AND r2.created_at > h.created_at
      ) THEN 1 ELSE 0 END) AS followed
    FROM retrievals h
    WHERE h.surface = '${SURFACE.HINT}'
  `).get();

  const missRate = db.prepare(`
    SELECT surface, COUNT(*) AS total, SUM(CASE WHEN doc_id IS NULL THEN 1 ELSE 0 END) AS misses
    FROM retrievals
    GROUP BY surface
    ORDER BY surface
  `).all();

  return { coverage, byType, freshness, followThrough, missRate };
}

export function runRetrievalReportCli() {
  const { coverage, byType, freshness, followThrough, missRate } = retrievalReport();

  console.log('Retrieval Report');
  console.log('================');
  console.log(`Coverage: ${coverage.retrieved}/${coverage.total} live notes ever retrieved (${pct(coverage.retrieved, coverage.total)})`);

  console.log('\nBy doc_type:');
  for (const t of byType) {
    // doc_type is nullable in the schema, so a row can group under NULL.
    console.log(`  ${(t.doc_type ?? '(none)').padEnd(12)} ${String(t.retrieved).padStart(4)}/${String(t.total).padEnd(4)} (${pct(t.retrieved, t.total)})`);
  }

  const retrievedWithin30d = freshness.retrieved_within_30d || 0;
  console.log(`\nFreshness: ${retrievedWithin30d}/${freshness.written} notes written in the last 90 days were retrieved within 30 days of writing (${pct(retrievedWithin30d, freshness.written)})`);

  const followed = followThrough.followed || 0;
  console.log(`\nHint follow-through: ${followed}/${followThrough.hints_emitted} hints led to a kb_read of the same doc in the same session (${pct(followed, followThrough.hints_emitted)})`);

  console.log('\nMiss rate per surface:');
  for (const s of missRate) {
    console.log(`  ${s.surface.padEnd(12)} ${String(s.misses).padStart(4)}/${String(s.total).padEnd(4)} misses (${pct(s.misses, s.total)})`);
  }
}
