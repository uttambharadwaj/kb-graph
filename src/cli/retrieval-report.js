import { getDb } from '../db.js';
import { isKbNudge, PUSH_SURFACES, READ_SURFACES, SURFACE } from '../retrieval.js';

function pct(n, total) {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : 'n/a';
}

// Surface lists are constants, not input, but binding them keeps the SQL
// honest when one of them grows a value that needs quoting.
function placeholders(values) {
  return values.map(() => '?').join(', ');
}

// A doc counts as "ever retrieved" if it appears with a non-null doc_id under
// ANY surface — coverage measures whether the read path has touched it at
// all, not specifically whether someone opened it.
const RETRIEVED_DOC_IDS = 'SELECT DISTINCT doc_id FROM retrievals WHERE doc_id IS NOT NULL';

// Every prompt long enough to score leaves one row per note it surfaced, or a
// single null-doc row when it declined, so the prompt text is already here and
// the labelling applies to history instead of starting a denominator at zero.
// What each nudge is worth is the state of the prompt *before* it: told to look
// right after the hint declined is that decline graded by a person.
function askedToLook(db) {
  const events = db.prepare(`
    SELECT session, query, MIN(created_at) AS at, MAX(doc_id IS NOT NULL) AS fired
    FROM retrievals
    WHERE surface = ? AND query IS NOT NULL AND session IS NOT NULL
    GROUP BY session, query
    ORDER BY session, at
  `).all(SURFACE.HINT);

  const after = { decline: 0, fire: 0, nothing: 0 };
  let previous = null;
  for (const event of events) {
    if (previous && previous.session !== event.session) previous = null;
    if (isKbNudge(event.query)) {
      if (!previous) after.nothing++;
      else if (previous.fired) after.fire++;
      else after.decline++;
    }
    previous = event;
  }
  return { prompts: events.length, nudges: after.decline + after.fire + after.nothing, after };
}

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

  // A hint "follows through" when the same doc_id is opened in the same
  // session, after the hint fired — on any read surface, since which channel
  // the reader used is not the question. `session` is NULL on both sides
  // whenever it wasn't available at log time; SQL's NULL = NULL is never
  // true, so two NULL-session rows never falsely pair — an unresolvable hint
  // reports as unfollowed rather than as a false match.
  const followThrough = db.prepare(`
    SELECT
      COUNT(*) AS hints_emitted,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM retrievals r2
        WHERE r2.surface IN (${placeholders(READ_SURFACES)}) AND r2.doc_id = h.doc_id
          AND r2.session = h.session AND r2.created_at > h.created_at
      ) THEN 1 ELSE 0 END) AS followed
    FROM retrievals h
    WHERE h.surface = ?
  `).get(...READ_SURFACES, SURFACE.HINT);

  // Follow-through can only ever pair rows that carry a session id on both
  // sides, so the id coverage is the ceiling on what it can measure. Printed
  // rather than assumed: if it drops, follow-through falls with it for
  // reasons that have nothing to do with whether anyone read anything.
  const sessionCoverage = db.prepare(`
    SELECT
      SUM(is_push) AS push,
      SUM(is_push AND session IS NOT NULL) AS push_with_session,
      SUM(NOT is_push) AS pull,
      SUM(NOT is_push AND session IS NOT NULL) AS pull_with_session
    FROM (
      SELECT session, surface IN (${placeholders(PUSH_SURFACES)}) AS is_push FROM retrievals
    )
  `).get(...PUSH_SURFACES);

  const missRate = db.prepare(`
    SELECT surface, COUNT(*) AS total, SUM(CASE WHEN doc_id IS NULL THEN 1 ELSE 0 END) AS misses
    FROM retrievals
    GROUP BY surface
    ORDER BY surface
  `).all();

  return { coverage, byType, freshness, followThrough, missRate, sessionCoverage, askedToLook: askedToLook(db) };
}

export function runRetrievalReportCli() {
  const { coverage, byType, freshness, followThrough, missRate, sessionCoverage, askedToLook } = retrievalReport();

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
  console.log(`\nHint follow-through: ${followed}/${followThrough.hints_emitted} hints led to a read of the same doc in the same session (${pct(followed, followThrough.hints_emitted)})`);

  const { nudges, prompts, after } = askedToLook;
  console.log(`\nAsked to look: ${nudges}/${prompts} prompts told the agent to go and check the knowledge base (${pct(nudges, prompts)})`);
  if (nudges > 0) {
    console.log(`  ${after.decline} came straight after a prompt the hint declined — those declines are graded wrong by a person`);
    console.log(`  ${after.fire} after a prompt it fired on, ${after.nothing} opening a session`);
  }
  console.log('  Blind spot: prompts under 20 characters and slash commands never reach the meter, and a terse "check kb" is that shape');

  const push = sessionCoverage.push || 0;
  const pull = sessionCoverage.pull || 0;
  console.log(`\nPush (${PUSH_SURFACES.join('/')}) ${push} rows vs pull ${pull} rows — ${pct(push, push + pull)} of the read path is unasked-for`);
  console.log(`Session id present on ${pct(sessionCoverage.push_with_session || 0, push)} of push rows and ${pct(sessionCoverage.pull_with_session || 0, pull)} of pull rows — follow-through can only pair the overlap`);

  console.log('\nMiss rate per surface:');
  for (const s of missRate) {
    console.log(`  ${s.surface.padEnd(12)} ${String(s.misses).padStart(4)}/${String(s.total).padEnd(4)} misses (${pct(s.misses, s.total)})`);
  }
}
