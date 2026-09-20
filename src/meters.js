// Retention for the five meter tables. Only extractions is currently
// prunable: every other table has a raw-history reader whose contract cannot
// survive aggregation. Historical meter_rollups remain readable by
// surface-report, but no new rollups are written because tool_calls and
// write_decisions now carry session attribution those buckets cannot retain.
import { getDb } from './db.js';

export const METER_TABLES = ['retrievals', 'extractions', 'tool_calls', 'write_decisions', 'model_calls'];

// A reply this short is a refusal, an empty result or an error string. Shared
// with surface-report so its raw and historical-rollup columns use the same
// definition.
export const EMPTY_REPLY_CHARS = 80;

export const PRUNE_EXCLUDED = {
  retrievals:
    'retrieval-report (coverage, freshness, hint follow-through, "asked to look") and hint-probe both '
    + 'read raw query text and per-document history over all time -- a day-bucketed rollup cannot hold '
    + 'which document or which prompt was involved, so pruning would silently change or shrink those reports.',
  tool_calls:
    'PF-4128 follow-through reporting joins raw tool calls to write decisions by session inside bounded time '
    + 'windows -- a day/tool rollup discards session and agent identity, so pruning would make attribution impossible.',
  write_decisions:
    'PF-4128 follow-through reporting needs each raw write decision with its session, agent, source, and timestamp '
    + '-- existing day/band rollups discard that identity and cannot reconstruct same-session attribution.',
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

// Delete extraction rows older than `keepDays`. Refuses every raw-history
// table outright, whether named explicitly or reached through the default
// sweep; there is no safe force mode.
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

    const deleted = db.prepare(`DELETE FROM ${t} WHERE created_at < ?`).run(cutoff).changes;
    return { table: t, deleted, wouldDelete: deleted, kept: total - deleted, dryRun: false };
  });
}
