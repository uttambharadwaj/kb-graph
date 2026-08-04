// Retention for the five meter tables (retrievals, extractions, tool_calls,
// write_decisions, model_calls). None of them was ever pruned, and two of
// them (tool_calls, model_calls) are new enough that a retention window
// cannot yet be defended -- see `kb surface-report`'s METER GROWTH section,
// which is the measurement this module's prune command depends on.
//
// Deleting rows a report reads "over all time" would silently change what
// that report prints. Before any delete, every reader of these five tables
// was enumerated (see meter-retention design notes); PRUNABLE_TABLES is the
// subset where the readers' exact numbers survive a prune, by folding what
// would be deleted into meter_rollups first, in the same transaction as the
// delete (see pruneMeters below). PRUNE_EXCLUDED is the rest, with the reason
// stated for each: a compact day-bucketed rollup cannot reconstruct what
// their readers need, so pruning them would silently degrade those reports.
import { getDb } from './db.js';

export const METER_TABLES = ['retrievals', 'extractions', 'tool_calls', 'write_decisions', 'model_calls'];

// A reply this short is a refusal, an empty result or an error string, same
// definition surface-report.js's tool demand table uses for "empty" -- kept
// here (and re-exported) so the fold that freezes historical "empty" counts
// into meter_rollups can never drift from the live definition.
export const EMPTY_REPLY_CHARS = 80;

export const PRUNE_EXCLUDED = {
  retrievals:
    'retrieval-report (coverage, freshness, hint follow-through, "asked to look") and hint-probe both '
    + 'read raw query text and per-document history over all time -- a day-bucketed rollup cannot hold '
    + 'which document or which prompt was involved, so pruning would silently change or shrink those reports.',
  model_calls:
    "surface-report's MODEL CALLS section prints p50/p90 duration percentiles over all time -- percentiles "
    + 'need the full distribution, which a compact rollup cannot hold without keeping every row, so pruning '
    + 'would silently change those numbers.',
};

export const PRUNABLE_TABLES = METER_TABLES.filter(t => !(t in PRUNE_EXCLUDED));

// dbstat is a virtual table SQLite compiles in with SQLITE_ENABLE_DBSTAT_VTAB
// (true for this project's better-sqlite3 build); summing pgsize for a name
// gives that table's actual on-disk pages, not a share of the whole file
// estimated some other way. Returns null on a build without it rather than
// breaking the report -- same contract as the meters that log this table.
function estimateTableBytes(db, table) {
  try {
    return db.prepare('SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name = ?').get(table).bytes;
  } catch {
    return null;
  }
}

// Per meter table: row count, age of the oldest row, and rows/day over the
// trailing window -- the measurement a retention window has to be chosen
// from, not guessed at. julianday() on an empty table's MIN(created_at)
// returns NULL cleanly rather than throwing.
export function meterGrowth(db = getDb(), { trailingDays = 7 } = {}) {
  return METER_TABLES.map(table => {
    const { rows, oldestAgeDays } = db.prepare(`
      SELECT COUNT(*) AS rows, julianday('now') - julianday(MIN(created_at)) AS oldestAgeDays
      FROM ${table}
    `).get();
    const recent = db.prepare(
      `SELECT COUNT(*) AS n FROM ${table} WHERE created_at >= datetime('now', ?)`
    ).get(`-${trailingDays} days`).n;
    return {
      table,
      rows,
      oldestAgeDays,
      rowsPerDay: recent / trailingDays,
      bytes: estimateTableBytes(db, table),
      excludedReason: PRUNE_EXCLUDED[table] ?? null,
    };
  });
}

// One rollup row per (table_name, day, dim) bucket, accumulated across
// however many prune runs touch it -- ON CONFLICT adds into what is already
// there instead of replacing it, so a second prune over the same table folds
// in cleanly. `dim` is table_name-specific: the tool name for tool_calls,
// '__all__' or 'band:X.X' for write_decisions. duration_max uses SQLite's
// scalar max(a, b), not the aggregate, to stay the running maximum instead of
// being overwritten.
function upsertRollups(db, tableName, groups) {
  if (!groups.length) return;
  const stmt = db.prepare(`
    INSERT INTO meter_rollups
      (table_name, day, dim, n, failed, empty, duration_sum, duration_max, refused, no_neighbour, later_superseded)
    VALUES
      (@table_name, @day, @dim, @n, @failed, @empty, @duration_sum, @duration_max, @refused, @no_neighbour, @later_superseded)
    ON CONFLICT(table_name, day, dim) DO UPDATE SET
      n = n + excluded.n,
      failed = failed + excluded.failed,
      empty = empty + excluded.empty,
      duration_sum = duration_sum + excluded.duration_sum,
      duration_max = max(duration_max, excluded.duration_max),
      refused = refused + excluded.refused,
      no_neighbour = no_neighbour + excluded.no_neighbour,
      later_superseded = later_superseded + excluded.later_superseded
  `);
  for (const g of groups) {
    stmt.run({
      table_name: tableName, day: g.day, dim: g.dim,
      n: g.n ?? 0, failed: g.failed ?? 0, empty: g.empty ?? 0,
      duration_sum: g.duration_sum ?? 0, duration_max: g.duration_max ?? 0,
      refused: g.refused ?? 0, no_neighbour: g.no_neighbour ?? 0, later_superseded: g.later_superseded ?? 0,
    });
  }
}

// Mirrors surface-report.js's toolDemand() grouping exactly (day added) so
// the merged raw+rollup read reconstructs the same avg/max it would have
// printed had the row never been pruned.
function foldToolCalls(db, cutoff) {
  const groups = db.prepare(`
    SELECT date(created_at) AS day, tool AS dim,
           COUNT(*) AS n,
           SUM(ok = 0) AS failed,
           SUM(result_chars IS NOT NULL AND result_chars <= ?) AS empty,
           SUM(duration_ms) AS duration_sum,
           MAX(duration_ms) AS duration_max
    FROM tool_calls WHERE created_at < ?
    GROUP BY day, tool
  `).all(EMPTY_REPLY_CHARS, cutoff);
  upsertRollups(db, 'tool_calls', groups);
}

// write_decisions has two independent readers-in-one (surface-report's
// totals and its bands), so it folds into two dim shapes: '__all__' carries
// every row's totals, 'band:X.X' carries the accepted-with-score rows'
// per-band breakdown. later_superseded is documents.superseded_at as of THIS
// moment -- a note that supersedes after its row is pruned cannot retroactively
// update a rolled-up band the way a still-raw row would (see README).
function foldWriteDecisions(db, cutoff) {
  const totals = db.prepare(`
    SELECT date(created_at) AS day, '__all__' AS dim,
           COUNT(*) AS n, SUM(refused) AS refused, SUM(nearest_score IS NULL) AS no_neighbour
    FROM write_decisions WHERE created_at < ?
    GROUP BY day
  `).all(cutoff);

  const bands = db.prepare(`
    SELECT date(w.created_at) AS day,
           CAST(w.nearest_score * 10 AS INTEGER) / 10.0 AS band,
           COUNT(*) AS n,
           SUM(d.superseded_at IS NOT NULL) AS later_superseded
    FROM write_decisions w LEFT JOIN documents d ON d.id = w.doc_id
    WHERE w.created_at < ? AND w.refused = 0 AND w.nearest_score IS NOT NULL
    GROUP BY day, band
  `).all(cutoff).map(b => ({ day: b.day, dim: `band:${b.band.toFixed(1)}`, n: b.n, later_superseded: b.later_superseded }));

  upsertRollups(db, 'write_decisions', [...totals, ...bands]);
}

// extractions has no reader anywhere in the codebase today (grepped, none
// found) -- nothing to preserve, so it prunes with a plain delete.
const FOLDERS = { tool_calls: foldToolCalls, write_decisions: foldWriteDecisions };

// Delete rows older than `keepDays`, folding what would be lost into
// meter_rollups first (same transaction) for every table whose readers need
// that. Refuses PRUNE_EXCLUDED tables outright, whether they were named
// explicitly or reached through the default (no --table) sweep -- there is no
// rollup shape that preserves what reads them, so there is no safe "force".
export function pruneMeters(db = getDb(), { keepDays, table = null, dryRun = false } = {}) {
  if (!Number.isInteger(keepDays) || keepDays < 0) {
    throw new Error(`keepDays must be a non-negative integer, got: ${keepDays}`);
  }
  const targets = table ? [table] : PRUNABLE_TABLES;
  for (const t of targets) {
    if (!METER_TABLES.includes(t)) throw new Error(`Unknown meter table: ${t}`);
    if (PRUNE_EXCLUDED[t]) throw new Error(`Refusing to prune ${t}: ${PRUNE_EXCLUDED[t]}`);
  }

  const cutoff = db.prepare("SELECT datetime('now', ?) AS c").get(`-${keepDays} days`).c;

  return targets.map(t => {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    const wouldDelete = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE created_at < ?`).get(cutoff).n;
    if (dryRun) return { table: t, deleted: 0, wouldDelete, kept: total - wouldDelete, dryRun: true };

    const deleted = db.transaction(() => {
      FOLDERS[t]?.(db, cutoff);
      return db.prepare(`DELETE FROM ${t} WHERE created_at < ?`).run(cutoff).changes;
    })();
    return { table: t, deleted, wouldDelete: deleted, kept: total - deleted, dryRun: false };
  });
}
