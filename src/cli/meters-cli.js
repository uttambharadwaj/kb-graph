// `kb meters prune` — the only place these five tables lose a row. No
// scheduler runs this; it stays an operator action until `kb surface-report`'s
// METER GROWTH section gives someone a rate worth defending a window against.
import { getDb } from '../db.js';
import { UsageError, readFlagValue } from './flags.js';
import { METER_TABLES, PRUNE_EXCLUDED, pruneMeters } from '../meters.js';

const PRUNE_USAGE = 'Usage: kb meters prune --keep-days <N> [--dry-run] [--table <name>]';

export function runMetersPruneCli(args) {
  const keepDaysRaw = readFlagValue(args, '--keep-days');
  if (keepDaysRaw === undefined) {
    throw new UsageError(
      'kb meters prune refuses to run without --keep-days. The two newest meter tables '
      + '(tool_calls, model_calls) are days old — there is no measured rate yet to defend a default '
      + 'window with. Run `kb surface-report` (METER GROWTH section) first, then pass the window you chose.',
      PRUNE_USAGE,
    );
  }
  const keepDays = Number(keepDaysRaw);
  if (!Number.isInteger(keepDays) || keepDays < 0) {
    throw new UsageError(`--keep-days must be a non-negative integer, got: ${keepDaysRaw}`, PRUNE_USAGE);
  }

  const table = readFlagValue(args, '--table');
  if (table !== undefined && !METER_TABLES.includes(table)) {
    throw new UsageError(`Unknown meter table: ${table}\nKnown tables: ${METER_TABLES.join(', ')}`, PRUNE_USAGE);
  }
  if (table !== undefined && PRUNE_EXCLUDED[table]) {
    throw new UsageError(`Refusing to prune ${table}: ${PRUNE_EXCLUDED[table]}`, PRUNE_USAGE);
  }

  const dryRun = args.includes('--dry-run');
  const db = getDb();
  const results = pruneMeters(db, { keepDays, table: table ?? null, dryRun });

  console.log(dryRun
    ? `Dry run — keep-days=${keepDays}${table ? `, table=${table}` : ''}. Nothing deleted.`
    : `keep-days=${keepDays}${table ? `, table=${table}` : ''}`);
  const width = Math.max(...results.map(r => r.table.length));
  for (const r of results) {
    const count = dryRun ? r.wouldDelete : r.deleted;
    console.log(`  ${r.table.padEnd(width)}  ${dryRun ? 'would delete' : 'deleted'} ${String(count).padStart(7)}, kept ${r.kept}`);
  }

  if (!table) {
    const skipped = Object.keys(PRUNE_EXCLUDED);
    if (skipped.length) {
      console.log('\nNot touched — no rollup shape preserves what reads them, so prune refuses them outright:');
      for (const t of skipped) console.log(`  ${t}: ${PRUNE_EXCLUDED[t]}`);
    }
  }
}
