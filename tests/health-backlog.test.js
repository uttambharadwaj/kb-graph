// The briefing carried "202 notes missing summaries" unchanged for weeks. A
// line that is true every session is not read on the session it matters, so the
// backlog warnings now fire on growth only.
import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, getHealth, getMeta } from '../src/db.js';
import { addFact } from '../src/facts.js';
import { JOBS, staleAfterHours } from '../src/jobs.js';
import { runReconciliation } from '../src/reconciliation.js';

const summaryWarning = (health) => health.warnings.find(w => w.includes('summaries'));

function addUnsummarizedNotes(count) {
  const db = getDb();
  const insert = db.prepare(
    "INSERT INTO vault_files (vault_path, content_hash, title, note_type) VALUES (?, ?, ?, 'note')"
  );
  const from = db.prepare('SELECT COUNT(*) c FROM vault_files').get().c;
  for (let i = from; i < from + count; i++) insert.run(`notes/n${i}.md`, `hash-${i}`, `Note ${i}`);
}

describe('backlog warnings fire on growth, not on existence', () => {
  it('says nothing about a clean store', () => {
    assert.strictEqual(summaryWarning(getHealth({ recordBacklog: true })), undefined);
  });

  it('adopts an existing backlog silently the first time it sees one', () => {
    // No baseline recorded yet — the state every install is in on upgrade.
    getDb().prepare("DELETE FROM meta WHERE key = 'backlog_summaries'").run();
    addUnsummarizedNotes(120);
    assert.strictEqual(summaryWarning(getHealth({ recordBacklog: true })), undefined,
      'a backlog that predates the baseline is a standing decision, not a regression');
  });

  it('stays silent while the backlog holds steady', () => {
    assert.strictEqual(summaryWarning(getHealth({ recordBacklog: true })), undefined);
    assert.strictEqual(summaryWarning(getHealth({ recordBacklog: true })), undefined);
  });

  it('warns when the backlog grows, and says what the remedy costs and where it writes', () => {
    addUnsummarizedNotes(30);
    const warning = summaryWarning(getHealth({ recordBacklog: true }));
    assert.ok(warning, 'a growing backlog must be reported');
    assert.match(warning, /120 → 150/);
    assert.match(warning, /per note/, 'the warning must state the per-note cost');
    assert.match(warning, /vault/, 'the warning must say what the remedy writes to');
  });

  it('goes quiet again once the new level is the baseline', () => {
    assert.strictEqual(summaryWarning(getHealth({ recordBacklog: true })), undefined);
  });

  it('does not move the baseline for read-only callers', () => {
    const before = getMeta('backlog_summaries').value;
    addUnsummarizedNotes(40);
    assert.ok(summaryWarning(getHealth()), 'a read-only call still reports growth');
    assert.strictEqual(getMeta('backlog_summaries').value, before,
      'only a session boundary may re-baseline; otherwise the comparison measures how often health was polled');
  });
});

// A tolerance chosen independently of the cadence it watches will drift wider
// than it. The harvest's was 48h against a 24h period, so one dead night was
// indistinguishable from a night that worked and the briefing read OK through
// it — the exact failure the heartbeat exists to prevent.
describe('staleness tolerance is derived from the period', () => {
  // The promise is about loops where one missed run is a real event. A loop
  // that ticks every five minutes is not one of those: the 1h floor is
  // deliberate flap-damping, and reporting a single skipped tick would produce
  // a warning nobody reads — which is how the useful ones stop being read too.
  it('leaves one skipped run reportable for every loop slower than an hour', () => {
    const reportable = JOBS.filter(job => job.periodHours >= 1);
    assert.deepStrictEqual(reportable.map(j => j.name), ['harvest', 'synthesis', 'reconcile'],
      'a new slow loop must be considered here rather than inherit a default');
    for (const job of reportable) {
      const tolerance = staleAfterHours(job.periodHours);
      assert.ok(tolerance > job.periodHours, `${job.name}: tolerance must clear one normal period`);
      assert.ok(tolerance < job.periodHours * 2,
        `${job.name}: ${tolerance}h against a ${job.periodHours}h period hides a missed run`);
    }
  });

  it('damps a sub-hourly loop instead, so one skipped tick is not news', () => {
    const fast = JOBS.filter(job => job.periodHours < 1);
    assert.deepStrictEqual(fast.map(j => j.name), ['reindex']);
    assert.ok(staleAfterHours(fast[0].periodHours) >= 1);
  });

  // Slack absorbs a scheduler firing late — calendar jobs have been seen an
  // hour behind — without letting a 5-minute loop cry on one skipped tick.
  it('floors the slack at an hour and caps it at six', () => {
    assert.strictEqual(staleAfterHours(24), 30);
    assert.strictEqual(staleAfterHours(24 * 7), 174);
    assert.ok(Math.abs(staleAfterHours(5 / 60) - 1.083) < 0.01);
  });
});


describe('reconciliation heartbeat', () => {
  function clearReconciliationState() {
    getDb().exec(`
      DELETE FROM facts;
      DELETE FROM entity_aliases;
      DELETE FROM entities;
      DELETE FROM harvest_log;
      DELETE FROM meta WHERE key IN ('last_reconcile', 'last_reconcile_error');
    `);
  }

  function source(name, text) {
    const dir = mkdtempSync(join(tmpdir(), 'kb-health-reconcile-'));
    const path = join(dir, `${name}.jsonl`);
    writeFileSync(path, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n');
    getDb().prepare('INSERT INTO harvest_log (transcript_path, mtime, facts_added, notes_added) VALUES (?, ?, ?, ?)')
      .run(path, Date.now(), 1, 0);
    return `harvest:${name}`;
  }

  it('records a fresh heartbeat when scheduled reconciliation has nothing to do', async () => {
    clearReconciliationState();

    const result = await runReconciliation({ db: getDb(), limit: 1 });

    assert.strictEqual(result.candidates, 0);
    assert.ok(getMeta('last_reconcile'), 'no-op success still proves the scheduler ran');
    assert.strictEqual(getMeta('last_reconcile_error').value, '');
    assert.strictEqual(
      getHealth().warnings.find(w => w.includes('reconcile')),
      undefined,
      'fresh successful reconciliation should not stay health-stale'
    );
  });

  it('keeps the last reconciliation model failure visible in health', async () => {
    clearReconciliationState();
    addFact('Healthbot', 'status', 'green', {
      source: source('healthbot-green', 'Healthbot status is green after the first launch.'),
    });
    addFact('Healthbot', 'status', 'red', {
      source: source('healthbot-red', 'Healthbot status is red after the rollback.'),
    });

    await assert.rejects(
      () => runReconciliation({
        db: getDb(),
        limit: 1,
        decideFactGroup: async () => { throw new Error('model exploded for health'); },
      }),
      /model exploded for health/
    );

    assert.match(getMeta('last_reconcile_error').value, /model exploded for health/);
    assert.ok(
      getHealth().warnings.some(w => w.includes('reconcile last failed') && w.includes('model exploded for health')),
      'health should surface the reconciliation failure instead of only reporting stale age'
    );
  });
});
