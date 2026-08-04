// What the newest meters have to say: which tools anyone actually calls,
// where the duplicate threshold really sits, which caller's model calls are
// slow or failing underneath them, and how fast each meter table itself is
// growing on a store nothing ever prunes.
//
// Deliberately not merged into `kb retrieval-report`. That one answers how
// much of the store has ever been read, which is a question about the notes;
// these are questions about the surfaces.
import { getDb } from '../db.js';
import { getToolDefinitions } from '../tools.js';
import { DUP_THRESHOLD } from '../embeddings/search.js';
import { EMPTY_REPLY_CHARS, meterGrowth, PRUNE_EXCLUDED } from '../meters.js';

const pct = (n, of) => (of ? `${Math.round((n / of) * 100)}%` : '—');

// tool_calls' per-tool aggregate reads GROUP BY tool over ALL TIME, so a
// pruned history has to come back through meter_rollups (folded there by
// src/meters.js's foldToolCalls, same grouping) to keep printing the same
// calls/failed/empty/avg/max it would have without the prune. avg_ms uses
// Math.trunc to match SQLite's CAST(... AS INTEGER), which truncates rather
// than rounds -- duration_ms is never negative, so trunc and floor agree.
function toolDemand(db) {
  const raw = db.prepare(`
    SELECT tool,
           COUNT(*) AS calls,
           SUM(ok = 0) AS failed,
           SUM(result_chars IS NOT NULL AND result_chars <= ?) AS empty,
           SUM(duration_ms) AS duration_sum,
           MAX(duration_ms) AS duration_max
    FROM tool_calls GROUP BY tool
  `).all(EMPTY_REPLY_CHARS);

  const rolled = db.prepare(`
    SELECT dim AS tool,
           SUM(n) AS calls, SUM(failed) AS failed, SUM(empty) AS empty,
           SUM(duration_sum) AS duration_sum, MAX(duration_max) AS duration_max
    FROM meter_rollups WHERE table_name = 'tool_calls' GROUP BY dim
  `).all();

  const byTool = new Map();
  for (const r of [...raw, ...rolled]) {
    const entry = byTool.get(r.tool) ?? { tool: r.tool, calls: 0, failed: 0, empty: 0, duration_sum: 0, duration_max: 0 };
    entry.calls += r.calls;
    entry.failed += r.failed;
    entry.empty += r.empty;
    entry.duration_sum += r.duration_sum;
    entry.duration_max = Math.max(entry.duration_max, r.duration_max);
    byTool.set(r.tool, entry);
  }
  const rows = [...byTool.values()]
    .map(e => ({
      tool: e.tool, calls: e.calls, failed: e.failed, empty: e.empty,
      avg_ms: e.calls ? Math.trunc(e.duration_sum / e.calls) : 0,
      max_ms: e.duration_max,
    }))
    .sort((a, b) => b.calls - a.calls);

  const called = new Set(rows.map(r => r.tool));
  const never = getToolDefinitions().map(t => t.name).filter(n => !called.has(n)).sort();
  return { rows, never };
}

// SQLite has no percentile aggregate, and a group-by-caller window function
// would need one query per caller anyway — pull the durations and rank them
// here instead.
//
// This reads model_calls over all time with nothing merged in from
// meter_rollups on purpose: p50/p90 need the full duration distribution,
// which a compact rollup cannot hold, so model_calls stays out of prune's
// reach entirely (see PRUNE_EXCLUDED in src/meters.js) rather than printing
// numbers a prune has quietly made wrong.
function percentile(sortedDurations, p) {
  if (!sortedDurations.length) return 0;
  return sortedDurations[Math.min(sortedDurations.length - 1, Math.floor(p * sortedDurations.length))];
}

// Per caller — not per model — because a caller is a code path someone can
// fix; the model behind it is just one of its parameters, and it already
// tags every row for whoever needs to slice by that instead.
function modelCallDemand(db) {
  const rows = db.prepare('SELECT caller, ok, duration_ms, prompt_chars, response_chars FROM model_calls').all();
  const byCaller = new Map();
  for (const r of rows) {
    if (!byCaller.has(r.caller)) byCaller.set(r.caller, []);
    byCaller.get(r.caller).push(r);
  }
  return [...byCaller.entries()].map(([caller, calls]) => {
    const durations = calls.map(c => c.duration_ms).sort((a, b) => a - b);
    return {
      caller,
      calls: calls.length,
      failed: calls.filter(c => !c.ok).length,
      p50: percentile(durations, 0.5),
      p90: percentile(durations, 0.9),
      // response_chars is null on a failed call — nothing came back to count.
      charsIn: calls.reduce((n, c) => n + c.prompt_chars, 0),
      charsOut: calls.reduce((n, c) => n + (c.response_chars || 0), 0),
    };
  }).sort((a, b) => b.calls - a.calls);
}

// The whole point of the table: the accepted writes, bucketed by how close
// they came to being refused. A threshold is only defensible if the notes
// just under it turned out to be worth keeping.
//
// Both totals and bands read write_decisions over all time, so both merge
// meter_rollups back in (folded by src/meters.js's foldWriteDecisions, same
// two groupings: '__all__' for totals, 'band:X.X' for the per-band rows) to
// keep printing the same numbers after a prune that it would have without
// one.
function writeDecisions(db) {
  const totalsRaw = db.prepare(
    'SELECT COUNT(*) AS n, SUM(refused) AS refused, SUM(nearest_score IS NULL) AS no_neighbour FROM write_decisions'
  ).get();
  const totalsRolled = db.prepare(`
    SELECT COALESCE(SUM(n), 0) AS n, COALESCE(SUM(refused), 0) AS refused, COALESCE(SUM(no_neighbour), 0) AS no_neighbour
    FROM meter_rollups WHERE table_name = 'write_decisions' AND dim = '__all__'
  `).get();
  const totals = {
    n: (totalsRaw.n || 0) + totalsRolled.n,
    refused: (totalsRaw.refused || 0) + totalsRolled.refused,
    no_neighbour: (totalsRaw.no_neighbour || 0) + totalsRolled.no_neighbour,
  };

  const bandsRaw = db.prepare(`
    SELECT CAST(nearest_score * 10 AS INTEGER) / 10.0 AS band,
           COUNT(*) AS n,
           SUM(d.superseded_at IS NOT NULL) AS later_superseded
    FROM write_decisions w LEFT JOIN documents d ON d.id = w.doc_id
    WHERE w.refused = 0 AND w.nearest_score IS NOT NULL
    GROUP BY band
  `).all();
  const bandsRolled = db.prepare(`
    SELECT CAST(SUBSTR(dim, 6) AS REAL) AS band, SUM(n) AS n, SUM(later_superseded) AS later_superseded
    FROM meter_rollups WHERE table_name = 'write_decisions' AND dim LIKE 'band:%'
    GROUP BY dim
  `).all();

  const byBand = new Map();
  for (const b of [...bandsRaw, ...bandsRolled]) {
    const entry = byBand.get(b.band) ?? { band: b.band, n: 0, later_superseded: 0 };
    entry.n += b.n;
    entry.later_superseded += b.later_superseded;
    byBand.set(b.band, entry);
  }
  const bands = [...byBand.values()].sort((a, b) => b.band - a.band);

  return { totals, bands };
}

// Structured data behind the printed report — the shape a preservation test
// snapshots before a prune and re-checks after one.
export function surfaceReport(db = getDb()) {
  return {
    tool: toolDemand(db),
    model: modelCallDemand(db),
    write: writeDecisions(db),
    growth: meterGrowth(db),
  };
}

function formatAge(days) {
  if (days == null) return 'no rows yet';
  if (days < 1) return `${Math.round(days * 24)}h ago`;
  return `${days.toFixed(1)}d ago`;
}

function formatBytes(bytes) {
  if (bytes == null) return 'unknown';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

export function runSurfaceReportCli() {
  const db = getDb();
  const { tool, model, write, growth } = surfaceReport(db);

  console.log('TOOL SURFACE');
  if (!tool.rows.length) {
    console.log('  No calls recorded yet — the meter starts with the next MCP session.');
  } else {
    const width = Math.max(...tool.rows.map(r => r.tool.length));
    console.log(`  ${'tool'.padEnd(width)}  calls  failed  empty   avg     max`);
    for (const r of tool.rows) {
      console.log(
        `  ${r.tool.padEnd(width)}  ${String(r.calls).padStart(5)}  ` +
        `${pct(r.failed, r.calls).padStart(6)}  ${pct(r.empty, r.calls).padStart(5)}  ` +
        `${`${r.avg_ms}ms`.padStart(6)}  ${`${r.max_ms}ms`.padStart(6)}`
      );
    }
  }
  // Named rather than counted: the argument for removing a tool is which one
  // it is, and a bare zero invites the reader to assume it is something else.
  if (tool.never.length) console.log(`\n  Never called (${tool.never.length}): ${tool.never.join(', ')}`);

  console.log('\nMODEL CALLS');
  if (!model.length) {
    console.log('  No calls recorded yet.');
  } else {
    const width = Math.max(...model.map(r => r.caller.length));
    console.log(`  ${'caller'.padEnd(width)}  calls  failed     p50     p90  chars in  chars out`);
    for (const r of model) {
      console.log(
        `  ${r.caller.padEnd(width)}  ${String(r.calls).padStart(5)}  ` +
        `${pct(r.failed, r.calls).padStart(6)}  ${`${r.p50}ms`.padStart(6)}  ${`${r.p90}ms`.padStart(6)}  ` +
        `${String(r.charsIn).padStart(8)}  ${String(r.charsOut).padStart(9)}`
      );
    }
  }

  console.log('\nWRITE DECISIONS');
  if (!write.totals.n) {
    console.log('  No writes recorded yet.');
  } else {
    console.log(`  ${write.totals.n} writes, ${write.totals.refused} refused as duplicates (threshold ${DUP_THRESHOLD}), ` +
      `${write.totals.no_neighbour} with no neighbour at all.`);
    if (write.bands.length) {
      console.log('  Accepted writes by how close they came to the threshold:');
      for (const b of write.bands) {
        const flag = b.band >= DUP_THRESHOLD - 0.1 ? '  <- just under' : '';
        console.log(
          `    ${b.band.toFixed(1)}  ${String(b.n).padStart(4)} notes, ` +
          `${b.later_superseded} later superseded${flag}`
        );
      }
      console.log('  A band whose notes were mostly superseded is one the threshold should have caught.');
    }
  }

  console.log('\nMETER GROWTH');
  console.log('  Estimated bytes: sum of dbstat pgsize for the table\'s own pages (exact page-count, not a share of the file).');
  const width = Math.max(...growth.map(g => g.table.length));
  console.log(`  ${'table'.padEnd(width)}      rows  oldest         rows/day (7d)  est. bytes`);
  for (const g of growth) {
    console.log(
      `  ${g.table.padEnd(width)}  ${String(g.rows).padStart(8)}  ${formatAge(g.oldestAgeDays).padStart(13)}  ` +
      `${g.rowsPerDay.toFixed(1).padStart(13)}  ${formatBytes(g.bytes).padStart(11)}`
    );
  }
  const excluded = Object.keys(PRUNE_EXCLUDED);
  if (excluded.length) {
    console.log(`\n  Not prunable (see \`kb meters prune --help\`): ${excluded.join(', ')}`);
  }
  console.log('  No default retention window: `kb meters prune --keep-days N` is an explicit operator decision, run once rates here justify one.');
}
