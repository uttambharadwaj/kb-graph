import { runMigrateLegacy, SOURCE_KEYS } from '../migrate-legacy.js';
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

export async function runMigrateLegacyCli(args) {
  const { dryRun, only, workspace } = parseMigrateLegacyArgs(args);
  if (!process.env.OBSIDIAN_VAULT_PATH) throw new UsageError('OBSIDIAN_VAULT_PATH not set');
  const r = await runMigrateLegacy({ dryRun, only, ...(workspace ? { workspace } : {}) });
  for (const m of r.missing) console.error(`missing root, skipped: ${m}`);
  console.log(`${dryRun ? 'Planned' : 'Written'} into ${process.env.OBSIDIAN_VAULT_PATH}`);
  console.log('source            total  written  duplicates');
  for (const [k, c] of Object.entries(r.counts)) {
    console.log(`${k.padEnd(18)}${String(c.total).padStart(5)}  ${String(dryRun ? c.total - c.duplicates : c.written).padStart(7)}  ${String(c.duplicates).padStart(10)}`);
  }
  if (dryRun) {
    for (const k of Object.keys(r.counts)) {
      const sample = r.notes.filter(n => n.sourceKey === k).slice(0, 3);
      for (const n of sample) console.log(`  ${k}: ${n.folder}/${n.filename}`);
    }
    console.log('(dry run — no files written)');
  } else {
    console.log('Next: kb vault reindex');
  }
}
