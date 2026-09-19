import { MIGRATION_ACTION, runMigrateLegacy, SOURCE_KEYS } from '../migrate-legacy.js';
import { UsageError } from './flags.js';

export function parseMigrateLegacyArgs(args) {
  const dryRun = args.includes('--dry-run');
  const onlyFlag = args.find(a => a.startsWith('--only='));
  const only = onlyFlag ? onlyFlag.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean) : null;
  if (only) {
    if (!only.length) throw new UsageError(`--only needs at least one source; known: ${SOURCE_KEYS.join(', ')}`);
    for (const k of only) if (!SOURCE_KEYS.includes(k)) throw new UsageError(`unknown source "${k}"; known: ${SOURCE_KEYS.join(', ')}`);
  }
  const wsFlag = args.find(a => a.startsWith('--workspace='));
  const workspace = wsFlag ? wsFlag.slice('--workspace='.length) : undefined;
  if (wsFlag && !workspace) throw new UsageError('--workspace needs a path');
  return { dryRun, only, workspace };
}

function formatCountLine(source, counts) {
  const { total, written, replaced, skipped, duplicates, conflicts, unparseable } = counts;
  return `${source.padEnd(18)}${String(total).padStart(5)}`
    + `  ${String(written).padStart(5)}`
    + `  ${String(replaced).padStart(7)}`
    + `  ${String(skipped).padStart(4)}`
    + `  ${String(duplicates).padStart(10)}`
    + `  ${String(conflicts).padStart(9)}`
    + `  ${String(unparseable).padStart(11)}`;
}

export function migrationSummaryLines(result, { dryRun, vaultPath }) {
  const output = [
    `${dryRun ? 'Plan for' : 'Wrote into'} ${vaultPath}`,
    'source            total  write  replace  skip  duplicates  conflicts  unparseable',
  ];
  for (const [source, counts] of Object.entries(result.counts)) {
    output.push(formatCountLine(source, counts));
  }
  const errors = [];
  for (const action of result.actions) {
    if (action.action === MIGRATION_ACTION.REPLACE || action.action === MIGRATION_ACTION.COLLAPSE) {
      const removed = action.remove.length ? action.remove.join(', ') : action.out;
      output.push(`  ${action.action}: ${removed} -> ${action.out}`);
    }
    if (action.action === MIGRATION_ACTION.UNPARSEABLE) {
      errors.push(`unparseable: ${action.path}: ${action.text}`);
    }
    if (action.action === MIGRATION_ACTION.CONFLICT) {
      errors.push(`conflict: ${action.path}: refusing destructive cleanup of enriched output ${action.retained.join(', ')}`);
    }
  }
  const incomplete = errors.length > 0;
  if (dryRun) output.push('(dry run — no files or logs written)');
  if (incomplete) output.push('Migration incomplete: resolve reported records and rerun before reindexing.');
  else if (!dryRun) output.push('Next: kb vault reindex');
  return { output, errors };
}

export async function runMigrateLegacyCli(args, {
  env = process.env,
  error = console.error,
  log = console.log,
  run = runMigrateLegacy,
} = {}) {
  const { dryRun, only, workspace } = parseMigrateLegacyArgs(args);
  const vaultPath = env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) throw new UsageError('OBSIDIAN_VAULT_PATH not set');
  const result = await run({ dryRun, only, vaultPath, ...(workspace ? { workspace } : {}) });
  for (const missing of result.missing) error(`missing root, skipped: ${missing}`);
  const summary = migrationSummaryLines(result, { dryRun, vaultPath });
  for (const line of summary.output) log(line);
  for (const line of summary.errors) error(line);
  if (summary.errors.length) {
    throw new Error(`migration incomplete: ${summary.errors.length} unresolved record(s)`);
  }
}
