// `kb rediscoveries` — a listing over the rediscovery rows duplicate
// detection logs (kb_check_duplicate's is_duplicate verdict, kb_write's own
// dedupe refusal): each row is an agent re-deriving something the KB already
// had. No stats here, just the rows — `kb follow-through` / `kb
// retrieval-report` are where aggregate analysis lives.
import { getDb } from '../db.js';
import { UsageError, acceptFlags, readFlagValue } from './flags.js';
import { SURFACE } from '../retrieval.js';
import { AGENTS } from '../process-ancestry.js';

const DEFAULT_DAYS = 14;
const USAGE = 'Usage: kb rediscoveries [--days <N>] [--json]';

export function rediscoveries(db = getDb(), { days = DEFAULT_DAYS } = {}) {
  return db.prepare(`
    SELECT r.created_at AS ts, r.doc_id, d.title, r.query, r.agent
    FROM retrievals r
    LEFT JOIN documents d ON d.id = r.doc_id
    WHERE r.surface = ? AND r.created_at >= datetime('now', ?)
    ORDER BY r.created_at DESC
  `).all(SURFACE.REDISCOVERY, `-${days} days`);
}

// Rows written before the agent column existed carry NULL — counted apart
// from the named agents rather than assumed to be Claude's.
const UNKNOWN_AGENT = 'unknown';

// Every bucket, always, so the parts visibly sum to the total on the line above.
export function countByAgent(rows) {
  const counts = Object.fromEntries([...AGENTS, UNKNOWN_AGENT].map(a => [a, 0]));
  for (const row of rows) counts[AGENTS.includes(row.agent) ? row.agent : UNKNOWN_AGENT] += 1;
  return counts;
}

const QUERY_SNIPPET_LEN = 60;
const snippet = (q) => {
  if (!q) return '';
  return q.length > QUERY_SNIPPET_LEN ? `${q.slice(0, QUERY_SNIPPET_LEN)}…` : q;
};

export function runRediscoveriesCli(args = []) {
  if (!acceptFlags(args, { usage: USAGE, value: ['--days'], boolean: ['--json'] })) return;

  const daysRaw = readFlagValue(args, '--days');
  const days = daysRaw === undefined ? DEFAULT_DAYS : Number(daysRaw);
  if (!Number.isInteger(days) || days <= 0) {
    throw new UsageError(`--days must be a positive integer, got: ${daysRaw}`, USAGE);
  }

  const rows = rediscoveries(getDb(), { days });

  if (args.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(`Rediscoveries in the last ${days} day(s): ${rows.length}`);
  const byAgent = countByAgent(rows);
  console.log(`  by agent: ${Object.entries(byAgent).map(([agent, count]) => `${agent} ${count}`).join(', ')}`);
  for (const r of rows) {
    console.log(`  ${r.ts}  #${r.doc_id ?? '?'} ${r.title ?? '(unknown)'} [${r.agent ?? UNKNOWN_AGENT}] — ${snippet(r.query)}`);
  }
}
