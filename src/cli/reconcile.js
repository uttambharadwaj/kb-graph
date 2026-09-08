import { getDb } from '../db.js';
import { DEFAULT_RECONCILE_LIMIT, getReconciliationQueueSnapshot, runReconciliation } from '../reconciliation.js';
import { acceptFlags, readFlagValue, UsageError } from './flags.js';

const USAGE = 'Usage: kb reconcile [--dry-run] [--json] [--queue] [--limit <N>] [--predicate <name>] [--subject <name>] [--since <timestamp>]';

function parseLimit(value) {
  if (value == null) return DEFAULT_RECONCILE_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new UsageError(`--limit must be a non-negative integer\n${USAGE}`);
  return parsed;
}

export async function runReconcileCli(args = []) {
  if (!acceptFlags(args, {
    usage: USAGE,
    boolean: ['--dry-run', '--json', '--queue'],
    value: ['--limit', '--predicate', '--subject', '--since'],
  })) return null;
  const limit = parseLimit(readFlagValue(args, '--limit'));
  const options = {
    db: getDb(),
    limit,
    predicate: readFlagValue(args, '--predicate') || 'status',
    subject: readFlagValue(args, '--subject') || null,
    since: readFlagValue(args, '--since') || null,
    dryRun: args.includes('--dry-run'),
  };

  if (args.includes('--queue')) {
    const snapshot = getReconciliationQueueSnapshot(options.db, options);
    if (args.includes('--json')) return snapshot;
    console.log(`note supersession candidates: ${snapshot.note_supersession.length}`);
    console.log(`fact review candidates: ${snapshot.fact_review.length}`);
    return snapshot;
  }

  const result = await runReconciliation(options);
  if (args.includes('--json')) return result;
  console.log(`reconciliation: ${result.applied} applied, ${result.abstained} abstained, ${result.stale} stale, ${result.already_applied} already applied, ${result.would_apply} dry-run`);
  return result;
}
