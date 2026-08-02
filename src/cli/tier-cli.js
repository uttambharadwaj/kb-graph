// `kb tier` — the standing of what is stored, and the backfill that derives it
// from provenance for notes written before tiers existed. Dry by default.
import { backfillTiers, getDb } from '../db.js';
import { TIER_MEANING, tierLabel } from '../tiers.js';

export function runTierCli(args) {
  const apply = args.includes('--apply');

  const counts = getDb().prepare(
    'SELECT tier, COUNT(*) c FROM documents WHERE superseded_at IS NULL GROUP BY tier ORDER BY c DESC'
  ).all();
  console.log('Live notes by tier:');
  for (const row of counts) console.log(`  ${tierLabel(row.tier).padEnd(12)} ${row.c}  — ${TIER_MEANING[row.tier]}`);

  const plan = backfillTiers({ apply });
  console.log(`\nProvenance families across all ${plan.total} notes (the tier each one proves on its own):`);
  for (const f of plan.families) {
    console.log(`  ${f.family.padEnd(10)} ${String(f.count).padStart(5)} -> ${f.tier}${f.raised ? `  (${f.raised} to raise)` : ''}`);
  }

  if (!plan.raised) {
    console.log('\nNothing to raise: every note is already at or above the tier its provenance proves.');
    return;
  }
  console.log(apply
    ? `\nRaised ${plan.raised} notes.`
    : `\n${plan.raised} notes would be raised. Re-run with --apply to write.`);
}
