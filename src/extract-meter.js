// Write-path telemetry for kb_extract: the read path has retrieval.js as its
// one chokepoint (see src/retrieval.js); this is the write-path twin. Every
// recall bug filed against the extractor described what went missing without
// any way to reproduce it, because nothing recorded what a call actually saw.
// One row per call -- success, dry run, or failure alike -- lets the next
// occurrence arrive with its data attached.
import { createHash } from 'crypto';
import { getDb } from './db.js';

// A hash, never the text: storing raw input here would make this a second
// uncontrolled copy of everything anyone has ever run through kb_extract. The
// hash plus the shape metrics below is enough to tell whether a reported call
// was anomalous.
export function hashInput(text) {
  return createHash('sha256').update(text).digest('hex');
}

// Never let telemetry break an extraction: insert failures are swallowed so
// the caller still gets its result (or its error), but logged loudly since a
// silent failure here means the meter quietly goes blind -- same contract as
// retrieval.js's logRetrieval.
export function logExtraction({
  inputHash, inputChars, chunkChars, emittedCount, skippedCount,
  chunkFailures, entityRejections, claimRejections, dateOverrides,
  duplicateSkips, acceptedSkipConflicts,
  attemptCount, modelDurationMs, consolidationDurationMs,
  dryRun, failed, fromPreview, durationMs, source = null,
}) {
  try {
    getDb().prepare(`
      INSERT INTO extractions
        (input_hash, input_chars, chunk_count, chunk_chars, emitted_count, skipped_count,
         chunk_failures, entity_rejections, claim_rejections, date_overrides,
         duplicate_skips, accepted_skip_conflicts,
         attempt_count, model_duration_ms, consolidation_duration_ms,
         dry_run, failed, from_preview, duration_ms, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      inputHash, inputChars, chunkChars.length, JSON.stringify(chunkChars),
      emittedCount, skippedCount, chunkFailures,
      entityRejections, claimRejections, dateOverrides,
      duplicateSkips, acceptedSkipConflicts,
      attemptCount, modelDurationMs, consolidationDurationMs,
      dryRun ? 1 : 0, failed ? 1 : 0,
      fromPreview ? 1 : 0, durationMs, source,
    );
  } catch (err) {
    console.error(`[KB] extraction log failed (input_hash=${inputHash}): ${err.message}`);
  }
}

export const EXTRACTION_SUMMARY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function summarizeExtractions({
  db = getDb(),
  now = new Date(),
  windowMs = EXTRACTION_SUMMARY_WINDOW_MS,
} = {}) {
  const cutoff = new Date(now.getTime() - windowMs).toISOString();
  return db.prepare(`
    SELECT COUNT(*) AS calls,
           COALESCE(SUM(emitted_count), 0) AS emitted,
           COALESCE(SUM(skipped_count), 0) AS skipped,
           COALESCE(SUM(entity_rejections), 0) AS entity_rejections,
           COALESCE(SUM(claim_rejections), 0) AS claim_rejections,
           COALESCE(SUM(date_overrides), 0) AS date_overrides,
           COALESCE(SUM(duplicate_skips), 0) AS duplicate_skips,
           COALESCE(SUM(accepted_skip_conflicts), 0) AS accepted_skip_conflicts,
           COALESCE(SUM(attempt_count), 0) AS attempts,
           COALESCE(MAX(model_duration_ms), 0) AS slowest_model_ms,
           COALESCE(MAX(consolidation_duration_ms), 0) AS slowest_consolidation_ms,
           COALESCE(SUM(chunk_failures), 0) AS chunk_failures,
           COALESCE(SUM(failed), 0) AS failed
    FROM extractions
    WHERE datetime(created_at) >= datetime(?)
  `).get(cutoff);
}

export function formatExtractionSummary(summary) {
  if (!summary?.calls) return 'extractions (last 24h): no observations';
  const classified = summary.entity_rejections + summary.claim_rejections + summary.date_overrides;
  const other = Math.max(0, summary.skipped - classified);
  const chunkFailures = `${summary.chunk_failures} chunk failure${summary.chunk_failures === 1 ? '' : 's'}`;
  const failedCalls = `${summary.failed} failed call${summary.failed === 1 ? '' : 's'}`;
  const duplicateSkips = `${summary.duplicate_skips} duplicate skip${summary.duplicate_skips === 1 ? '' : 's'}`;
  const dispositionConflicts = `${summary.accepted_skip_conflicts} accepted-and-skipped conflict${summary.accepted_skip_conflicts === 1 ? '' : 's'}`;
  return `extractions (last 24h): ${summary.calls} calls, ${summary.emitted} emitted, ${summary.skipped} skipped`
    + ` (entity ${summary.entity_rejections}, claim ${summary.claim_rejections}, date override ${summary.date_overrides}, other ${other})`
    + `, reconciled ${duplicateSkips} and ${dispositionConflicts}`
    + `, ${summary.attempts} model attempts, slowest phases model ${summary.slowest_model_ms}ms / consolidation ${summary.slowest_consolidation_ms}ms`
    + `, ${chunkFailures}, ${failedCalls}`;
}
