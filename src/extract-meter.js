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
  chunkFailures, dryRun, failed, durationMs, source = null,
}) {
  try {
    getDb().prepare(`
      INSERT INTO extractions
        (input_hash, input_chars, chunk_count, chunk_chars, emitted_count, skipped_count, chunk_failures, dry_run, failed, duration_ms, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      inputHash, inputChars, chunkChars.length, JSON.stringify(chunkChars),
      emittedCount, skippedCount, chunkFailures, dryRun ? 1 : 0, failed ? 1 : 0,
      durationMs, source,
    );
  } catch (err) {
    console.error(`[KB] extraction log failed (input_hash=${inputHash}): ${err.message}`);
  }
}
