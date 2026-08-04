// What the two newest meters have to say: which tools anyone actually calls,
// and where the duplicate threshold really sits.
//
// Deliberately not merged into `kb retrieval-report`. That one answers how
// much of the store has ever been read, which is a question about the notes;
// these are questions about the surfaces.
import { getDb } from '../db.js';
import { getToolDefinitions } from '../tools.js';
import { DUP_THRESHOLD } from '../embeddings/search.js';

// A reply this short is a refusal, an empty result or an error string — not an
// answer. Only a floor: it separates "returned nothing" from "returned
// something", which is as much as a length can honestly say.
const EMPTY_REPLY_CHARS = 80;

const pct = (n, of) => (of ? `${Math.round((n / of) * 100)}%` : '—');

function toolDemand(db) {
  const rows = db.prepare(`
    SELECT tool,
           COUNT(*) AS calls,
           SUM(ok = 0) AS failed,
           SUM(result_chars IS NOT NULL AND result_chars <= ?) AS empty,
           CAST(AVG(duration_ms) AS INTEGER) AS avg_ms,
           MAX(duration_ms) AS max_ms
    FROM tool_calls GROUP BY tool ORDER BY calls DESC
  `).all(EMPTY_REPLY_CHARS);

  const called = new Set(rows.map(r => r.tool));
  const never = getToolDefinitions().map(t => t.name).filter(n => !called.has(n)).sort();
  return { rows, never };
}

// The whole point of the table: the accepted writes, bucketed by how close
// they came to being refused. A threshold is only defensible if the notes
// just under it turned out to be worth keeping.
function writeDecisions(db) {
  const totals = db.prepare(
    'SELECT COUNT(*) AS n, SUM(refused) AS refused, SUM(nearest_score IS NULL) AS no_neighbour FROM write_decisions'
  ).get();
  const bands = db.prepare(`
    SELECT CAST(nearest_score * 10 AS INTEGER) / 10.0 AS band,
           COUNT(*) AS n,
           SUM(d.superseded_at IS NOT NULL) AS later_superseded
    FROM write_decisions w LEFT JOIN documents d ON d.id = w.doc_id
    WHERE w.refused = 0 AND w.nearest_score IS NOT NULL
    GROUP BY band ORDER BY band DESC
  `).all();
  return { totals, bands };
}

export function runSurfaceReportCli() {
  const db = getDb();
  const { rows, never } = toolDemand(db);

  console.log('TOOL SURFACE');
  if (!rows.length) {
    console.log('  No calls recorded yet — the meter starts with the next MCP session.');
  } else {
    const width = Math.max(...rows.map(r => r.tool.length));
    console.log(`  ${'tool'.padEnd(width)}  calls  failed  empty   avg     max`);
    for (const r of rows) {
      console.log(
        `  ${r.tool.padEnd(width)}  ${String(r.calls).padStart(5)}  ` +
        `${pct(r.failed, r.calls).padStart(6)}  ${pct(r.empty, r.calls).padStart(5)}  ` +
        `${`${r.avg_ms}ms`.padStart(6)}  ${`${r.max_ms}ms`.padStart(6)}`
      );
    }
  }
  // Named rather than counted: the argument for removing a tool is which one
  // it is, and a bare zero invites the reader to assume it is something else.
  if (never.length) console.log(`\n  Never called (${never.length}): ${never.join(', ')}`);

  const { totals, bands } = writeDecisions(db);
  console.log('\nWRITE DECISIONS');
  if (!totals.n) {
    console.log('  No writes recorded yet.');
    return;
  }
  console.log(`  ${totals.n} writes, ${totals.refused} refused as duplicates (threshold ${DUP_THRESHOLD}), ` +
    `${totals.no_neighbour} with no neighbour at all.`);
  if (bands.length) {
    console.log('  Accepted writes by how close they came to the threshold:');
    for (const b of bands) {
      const flag = b.band >= DUP_THRESHOLD - 0.1 ? '  <- just under' : '';
      console.log(
        `    ${b.band.toFixed(1)}  ${String(b.n).padStart(4)} notes, ` +
        `${b.later_superseded} later superseded${flag}`
      );
    }
    console.log('  A band whose notes were mostly superseded is one the threshold should have caught.');
  }
}
