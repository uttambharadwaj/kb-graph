import './helpers/tmp-kb.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/db.js';
import { formatExtractionSummary, summarizeExtractions } from '../src/extract-meter.js';

const insert = getDb().prepare(`
  INSERT INTO extractions
    (input_hash, input_chars, chunk_count, chunk_chars, emitted_count, skipped_count,
     chunk_failures, entity_rejections, claim_rejections, date_overrides,
     duplicate_skips, accepted_skip_conflicts,
     dry_run, failed, from_preview, duration_ms, source, created_at)
  VALUES (?, 10, 1, '[10]', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 5, 'test', ?)
`);

describe('extraction status summary', () => {
  it('reports the last 24h denominator and rejection categories', () => {
    insert.run('recent-a', 3, 4, 1, 1, 1, 1, 2, 3, 0, '2026-08-26 11:00:00');
    insert.run('recent-b', 2, 1, 0, 0, 1, 0, 4, 5, 1, '2026-08-26 10:00:00');
    insert.run('old', 99, 99, 99, 99, 99, 99, 99, 99, 1, '2026-08-24 10:00:00');

    const summary = summarizeExtractions({ now: new Date('2026-08-26T12:00:00.000Z') });
    assert.deepStrictEqual(summary, {
      calls: 2,
      emitted: 5,
      skipped: 5,
      entity_rejections: 1,
      claim_rejections: 2,
      date_overrides: 1,
      duplicate_skips: 6,
      accepted_skip_conflicts: 8,
      chunk_failures: 1,
      failed: 1,
    });
    assert.equal(
      formatExtractionSummary(summary),
      'extractions (last 24h): 2 calls, 5 emitted, 5 skipped (entity 1, claim 2, date override 1, other 1), reconciled 6 duplicate skips and 8 accepted-and-skipped conflicts, 1 chunk failure, 1 failed call',
    );
  });

  it('says when the window has no observations', () => {
    const summary = summarizeExtractions({ now: new Date('2026-09-01T12:00:00.000Z') });
    assert.equal(formatExtractionSummary(summary), 'extractions (last 24h): no observations');
  });
});
