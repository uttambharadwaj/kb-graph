import './helpers/tmp-kb.js'; // MUST be first — redirects the DB to a temp dir
import { describe, it } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { getDb, insertDocument, MIGRATIONS as KB_MIGRATIONS, supersedeDocument } from '../src/db.js';
import { applyMigrations, hasTable } from '../src/schema.js';
import { METER_TABLES, meterGrowth, PRUNABLE_TABLES, PRUNE_EXCLUDED, pruneMeters } from '../src/meters.js';
import { surfaceReport } from '../src/cli/surface-report.js';
import { runMetersPruneCli } from '../src/cli/meters-cli.js';
import { UsageError } from '../src/cli/flags.js';

function timestampDaysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function insertToolCall(db, { tool, ok = 1, durationMs = 100, resultChars = 500, createdAt }) {
  db.prepare(
    'INSERT INTO tool_calls (tool, ok, duration_ms, result_chars, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(tool, ok, durationMs, resultChars, createdAt);
}

function insertWriteDecision(db, { nearestId = null, nearestScore = null, threshold = 0.82, refused = 0, docId = null, createdAt }) {
  db.prepare(
    'INSERT INTO write_decisions (nearest_id, nearest_score, threshold, refused, doc_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(nearestId, nearestScore, threshold, refused, docId, createdAt);
}

// pruneMeters(table: 'tool_calls') deletes from the whole table, so a test
// asserting an exact deleted count needs a database no other test's rows can
// land in — this repo's tmp-kb.js gives one temp DB per *file*, not per test.
function freshDb() {
  const db = new Database(':memory:');
  applyMigrations(db, KB_MIGRATIONS);
  return db;
}

describe('migration 14 — meter_rollups', () => {
  it('exists on a database built from scratch', () => {
    assert.ok(hasTable(getDb(), 'meter_rollups'));
  });

  it('is what applying migration 14 to a pre-14 fixture adds, with the bucket columns prune folds into', () => {
    const fixture = new Database(':memory:');
    applyMigrations(fixture, KB_MIGRATIONS.filter(m => m.version < 14));
    assert.ok(!hasTable(fixture, 'meter_rollups'), 'fixture must not already have it');

    const ran = applyMigrations(fixture, KB_MIGRATIONS.filter(m => m.version <= 14));
    assert.deepStrictEqual(ran.map(m => m.version), [14]);
    assert.ok(hasTable(fixture, 'meter_rollups'));

    const columns = fixture.prepare('PRAGMA table_info(meter_rollups)').all().map(c => c.name).sort();
    assert.deepStrictEqual(columns, [
      'day', 'dim', 'duration_max', 'duration_sum', 'empty', 'failed',
      'id', 'later_superseded', 'n', 'no_neighbour', 'refused', 'table_name',
    ]);
    fixture.close();
  });
});

describe('meterGrowth — the measurement prune requires', () => {
  it('reports all five meter tables, with an exclusion reason on exactly the two prune refuses', () => {
    const rows = meterGrowth(getDb());
    assert.deepStrictEqual(rows.map(r => r.table), METER_TABLES);
    for (const r of rows) {
      if (r.table in PRUNE_EXCLUDED) assert.ok(r.excludedReason, `${r.table} should carry its exclusion reason`);
      else assert.strictEqual(r.excludedReason, null);
    }
  });

  it('reports zero rows and no age on an empty table without throwing', () => {
    // model_calls is never written anywhere in this file.
    const row = meterGrowth(getDb()).find(g => g.table === 'model_calls');
    assert.strictEqual(row.rows, 0);
    assert.strictEqual(row.oldestAgeDays, null);
    assert.strictEqual(row.rowsPerDay, 0);
  });
});

describe('kb meters prune — flag gate', () => {
  it('refuses to run without --keep-days', () => {
    assert.throws(() => runMetersPruneCli([]), UsageError);
  });

  it('refuses a non-integer --keep-days', () => {
    assert.throws(() => runMetersPruneCli(['--keep-days', 'soon']), UsageError);
    assert.throws(() => runMetersPruneCli(['--keep-days', '-1']), UsageError);
  });

  it('refuses an unknown table', () => {
    assert.throws(() => runMetersPruneCli(['--keep-days', '7', '--table', 'nope']), UsageError);
  });

  it('refuses a table with no preservable rollup, even named explicitly', () => {
    for (const table of Object.keys(PRUNE_EXCLUDED)) {
      assert.throws(
        () => runMetersPruneCli(['--keep-days', '7', '--table', table]),
        err => err instanceof UsageError && err.message.includes(table),
      );
    }
  });
});

describe('pruneMeters — dry run', () => {
  it('counts correctly and deletes nothing', () => {
    const db = freshDb();
    insertToolCall(db, { tool: 'kb_probe_dry', createdAt: timestampDaysAgo(30) });
    insertToolCall(db, { tool: 'kb_probe_dry', createdAt: timestampDaysAgo(1) });
    const before = db.prepare('SELECT COUNT(*) c FROM tool_calls').get().c;

    const [result] = pruneMeters(db, { keepDays: 10, table: 'tool_calls', dryRun: true });
    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(result.deleted, 0);
    assert.strictEqual(result.wouldDelete, 1);

    const after = db.prepare('SELECT COUNT(*) c FROM tool_calls').get().c;
    assert.strictEqual(after, before, 'dry run must not delete');
    db.close();
  });
});

describe('pruneMeters — deletes only older than N', () => {
  it('leaves the recent row, removes only the old one', () => {
    const db = freshDb();
    insertToolCall(db, { tool: 'kb_probe_cutoff', durationMs: 111, createdAt: timestampDaysAgo(30) });
    insertToolCall(db, { tool: 'kb_probe_cutoff', durationMs: 222, createdAt: timestampDaysAgo(1) });

    const [result] = pruneMeters(db, { keepDays: 10, table: 'tool_calls' });
    assert.strictEqual(result.deleted, 1);

    const remaining = db.prepare('SELECT duration_ms FROM tool_calls').all();
    assert.deepStrictEqual(remaining, [{ duration_ms: 222 }]);
    db.close();
  });
});

describe('pruneMeters — empty tables', () => {
  it('does not error on a table with nothing to prune', () => {
    const db = freshDb();
    assert.doesNotThrow(() => {
      const [result] = pruneMeters(db, { keepDays: 30, table: 'extractions' });
      assert.strictEqual(result.deleted, 0);
      assert.strictEqual(result.kept, 0);
    });
    db.close();
  });

  it('the default sweep runs cleanly with every prunable table empty', () => {
    const db = freshDb();
    assert.doesNotThrow(() => {
      const results = pruneMeters(db, { keepDays: 30 });
      assert.deepStrictEqual(results.map(r => r.table), PRUNABLE_TABLES);
      assert.ok(results.every(r => r.deleted === 0));
    });
    db.close();
  });
});

// The load-bearing test: prune must not change what surface-report prints for
// the tables it is allowed to touch. Seeds an old half and a recent half of
// both tool_calls and write_decisions (write_decisions with one band whose
// note later got superseded and one that did not), snapshots surfaceReport,
// prunes the old half, and asserts the snapshot is unchanged.
describe('rollup preserves surface-report numbers across a prune', () => {
  it('tool demand and write-decision numbers are identical before and after', () => {
    const db = getDb();

    insertToolCall(db, { tool: 'kb_probe_preserve', ok: 1, durationMs: 100, resultChars: 500, createdAt: timestampDaysAgo(30) });
    insertToolCall(db, { tool: 'kb_probe_preserve', ok: 0, durationMs: 900, resultChars: 10, createdAt: timestampDaysAgo(29) });
    insertToolCall(db, { tool: 'kb_probe_preserve', ok: 1, durationMs: 300, resultChars: 500, createdAt: timestampDaysAgo(1) });
    // A tool with ONLY old rows: after the prune it has zero raw rows left, so
    // it must still show up in the merged report, sourced entirely from the
    // rollup, and must not land in the "never called" list.
    insertToolCall(db, { tool: 'kb_probe_preserve_gone', ok: 1, durationMs: 50, resultChars: 500, createdAt: timestampDaysAgo(30) });

    const neighbour = insertDocument({ title: 'Preservation test: neighbour note', content: 'x', doc_type: 'lesson', tags: '' });
    const supersededDoc = insertDocument({ title: 'Preservation test: superseded accept', content: 'x', doc_type: 'lesson', tags: '' });
    const liveDoc = insertDocument({ title: 'Preservation test: live accept', content: 'x', doc_type: 'lesson', tags: '' });
    supersedeDocument(supersededDoc.id, { reason: 'preservation test fixture' });

    // Old accepted write, later superseded — band 0.7.
    insertWriteDecision(db, { nearestId: neighbour.id, nearestScore: 0.75, refused: 0, docId: supersededDoc.id, createdAt: timestampDaysAgo(30) });
    // Recent accepted write, same band, still live.
    insertWriteDecision(db, { nearestId: neighbour.id, nearestScore: 0.74, refused: 0, docId: liveDoc.id, createdAt: timestampDaysAgo(1) });
    // Old refusal.
    insertWriteDecision(db, { nearestId: neighbour.id, nearestScore: 0.95, refused: 1, docId: null, createdAt: timestampDaysAgo(30) });
    // Old accept with no neighbour at all.
    insertWriteDecision(db, { nearestId: null, nearestScore: null, refused: 0, docId: liveDoc.id, createdAt: timestampDaysAgo(30) });

    const before = surfaceReport(db);
    const results = pruneMeters(db, { keepDays: 10 }); // default sweep: tool_calls, write_decisions, extractions
    const after = surfaceReport(db);

    assert.deepStrictEqual(after.tool, before.tool, 'TOOL SURFACE must read identical before and after the prune');
    assert.deepStrictEqual(after.write, before.write, 'WRITE DECISIONS must read identical before and after the prune');

    // Sanity: the prune actually did something, so this is testing the fold,
    // not a no-op. tool_calls: 3 of the 4 rows above are older than 10 days
    // (ages 30, 29, 30). write_decisions: 3 of the 4 (ages 30, 30, 30).
    const toolResult = results.find(r => r.table === 'tool_calls');
    assert.strictEqual(toolResult.deleted, 3);
    const writeResult = results.find(r => r.table === 'write_decisions');
    assert.strictEqual(writeResult.deleted, 3);

    // And the specific numbers this test exists to pin down:
    const preserved = after.tool.rows.find(r => r.tool === 'kb_probe_preserve');
    assert.strictEqual(preserved.calls, 3);
    assert.strictEqual(preserved.failed, 1);
    assert.ok(!after.tool.never.includes('kb_probe_preserve_gone'), 'a tool with only rolled-up history is not "never called"');
    const gone = after.tool.rows.find(r => r.tool === 'kb_probe_preserve_gone');
    assert.strictEqual(gone.calls, 1, 'its one call now lives only in the rollup');

    const band07 = after.write.bands.find(b => Math.abs(b.band - 0.7) < 1e-9);
    assert.strictEqual(band07.n, 2);
    assert.strictEqual(band07.later_superseded, 1, 'only the row pointed at the superseded doc counts');
  });
});
