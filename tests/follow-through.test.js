import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initSchema } from '../src/db.js';
import { isTestSession, SURFACE } from '../src/retrieval.js';
import {
  followThroughReport, groupEvents, classify, clusterBootstrapCI, triggerEvents, readTriggerFires,
} from '../src/cli/follow-through.js';
import { TRIGGERS_LOG_DIR } from '../src/cli/trigger-hook.js';

function freshDb() {
  const db = new Database(':memory:');
  initSchema(db);
  return db;
}

function insertDoc(db, { title = 't' } = {}) {
  return db.prepare('INSERT INTO documents (title, content, doc_type) VALUES (?, ?, ?)').run(title, 'body', 'note').lastInsertRowid;
}

function insertRetrieval(db, {
  docId = null, surface, query = null, session = null, created_at = null, eventId = null, isTest = 0,
} = {}) {
  db.prepare(`
    INSERT INTO retrievals (doc_id, surface, query, session, created_at, event_id, is_test)
    VALUES (?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?)
  `).run(docId, surface, query, session, created_at, eventId, isTest);
}

describe('event reconstruction', () => {
  it('groups legacy (event_id NULL) rows sharing session/surface/timestamp into one event', () => {
    const doc1 = 1, doc2 = 2;
    const rows = [
      { doc_id: doc1, surface: SURFACE.HINT, session: 's1', created_at: '2026-08-01 10:00:00', event_id: null, is_test: 0 },
      { doc_id: doc2, surface: SURFACE.HINT, session: 's1', created_at: '2026-08-01 10:00:00', event_id: null, is_test: 0 },
      { doc_id: doc1, surface: SURFACE.HINT, session: 's1', created_at: '2026-08-01 10:05:00', event_id: null, is_test: 0 },
    ];
    const events = groupEvents(rows);
    assert.strictEqual(events.length, 2, 'two distinct timestamps -> two events');
    const first = events.find(e => e.createdAt === '2026-08-01 10:00:00');
    assert.strictEqual(first.docIds.size, 2);
  });

  it('groups rows sharing an event_id into one event even across different timestamps', () => {
    const rows = [
      { doc_id: 1, surface: SURFACE.BRIEFING, session: 's1', created_at: '2026-08-01 10:00:00', event_id: 'ev-1', is_test: 0 },
      { doc_id: 2, surface: SURFACE.BRIEFING, session: 's1', created_at: '2026-08-01 10:00:03', event_id: 'ev-1', is_test: 0 },
    ];
    const events = groupEvents(rows);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].docIds.size, 2);
    assert.strictEqual(events[0].createdAt, '2026-08-01 10:00:00', 'event time is the earliest row in the group');
  });

  it('a single-row surface (kb_read shape) collapses to one event per row under the same key', () => {
    const rows = [
      { doc_id: 1, surface: SURFACE.READ, session: 's1', created_at: '2026-08-01 10:00:00', event_id: null, is_test: 0 },
      { doc_id: 2, surface: SURFACE.READ, session: 's1', created_at: '2026-08-01 10:00:01', event_id: null, is_test: 0 },
    ];
    const events = groupEvents(rows);
    assert.strictEqual(events.length, 2);
  });
});

describe('exclusion classification', () => {
  it('classifies NULL session as unattributable', () => {
    assert.strictEqual(classify({ session: null, isTest: false, surface: SURFACE.HINT, query: 'x' }), 'unattributable');
  });

  it('classifies is_test=1 as test', () => {
    assert.strictEqual(classify({ session: 'anything', isTest: true, surface: SURFACE.HINT, query: 'x' }), 'test');
  });

  it('classifies a historical is_test=0 row on a smoke-prefixed/literal session as test via isTestSession, not the flag', () => {
    // Decisions delta (PR #88 review): historical smoke rows were never
    // backfilled and carry is_test=0 forever — the literal/prefix list is
    // still load-bearing at read time for them.
    assert.strictEqual(classify({ session: 'smoke-test', isTest: false, surface: SURFACE.HINT, query: 'x' }), 'test');
    assert.strictEqual(classify({ session: 'smoke-9', isTest: false, surface: SURFACE.HINT, query: 'x' }), 'test');
    assert.strictEqual(isTestSession('smoke-test'), true, 'sanity: the shared function agrees');
  });

  it('classifies an envelope-contaminated hint query as envelope, but leaves the same query alone on another surface', () => {
    assert.strictEqual(classify({ session: 's1', isTest: false, surface: SURFACE.HINT, query: '<agent-message from="x">hi</agent-message>' }), 'envelope');
    assert.strictEqual(classify({ session: 's1', isTest: false, surface: SURFACE.HINT, query: '<task-notification>done</task-notification>' }), 'envelope');
    assert.strictEqual(classify({ session: 's1', isTest: false, surface: SURFACE.SEARCH, query: '<agent-message from="x">hi</agent-message>' }), null);
  });

  it('a normal event classifies as null (not excluded)', () => {
    assert.strictEqual(classify({ session: 's1', isTest: false, surface: SURFACE.HINT, query: 'how does the indexer work' }), null);
  });
});

describe('followThroughReport: hint surface', () => {
  it('excludes test and envelope rows from the denominator and counts them separately', () => {
    const db = freshDb();
    const doc = insertDoc(db);
    insertRetrieval(db, { docId: doc, surface: SURFACE.HINT, session: 'smoke-test', query: 'q', eventId: 'e1' });
    insertRetrieval(db, { docId: doc, surface: SURFACE.HINT, session: 's1', query: '<agent-message from="x">hi</agent-message>', eventId: 'e2' });
    insertRetrieval(db, { docId: doc, surface: SURFACE.HINT, session: 's2', query: 'how does the indexer work', eventId: 'e3' });

    const { hint } = followThroughReport(db);
    assert.strictEqual(hint.events, 3);
    assert.strictEqual(hint.excluded.test, 1);
    assert.strictEqual(hint.excluded.envelope, 1);
    assert.strictEqual(hint.fires, 1);
  });

  it('a null-session row is excluded as unattributable, not silently paired', () => {
    const db = freshDb();
    const doc = insertDoc(db);
    insertRetrieval(db, { docId: doc, surface: SURFACE.HINT, session: null, query: 'q', eventId: 'e1' });

    const { hint } = followThroughReport(db);
    assert.strictEqual(hint.excluded.unattributable, 1);
    assert.strictEqual(hint.fires, 0);
  });

  it('a null-doc row is a decline: excluded from the fire denominator, counted in decline rate', () => {
    const db = freshDb();
    const doc = insertDoc(db);
    insertRetrieval(db, { docId: null, surface: SURFACE.HINT, session: 's1', query: 'declined prompt', eventId: 'e1' });
    insertRetrieval(db, { docId: doc, surface: SURFACE.HINT, session: 's2', query: 'fired prompt', eventId: 'e2' });

    const { hint } = followThroughReport(db);
    assert.strictEqual(hint.fires, 1);
    assert.strictEqual(hint.declines, 1);
    assert.strictEqual(hint.declineRate, '50.0%');
  });

  it('follow-through fires if ANY doc from a multi-doc event was read, not just the first', () => {
    const db = freshDb();
    const docA = insertDoc(db, { title: 'a' });
    const docB = insertDoc(db, { title: 'b' });
    const docC = insertDoc(db, { title: 'c' });
    insertRetrieval(db, { docId: docA, surface: SURFACE.HINT, session: 's1', query: 'q', eventId: 'e1', created_at: '2026-08-01 10:00:00' });
    insertRetrieval(db, { docId: docB, surface: SURFACE.HINT, session: 's1', query: 'q', eventId: 'e1', created_at: '2026-08-01 10:00:00' });
    insertRetrieval(db, { docId: docC, surface: SURFACE.HINT, session: 's1', query: 'q', eventId: 'e1', created_at: '2026-08-01 10:00:00' });
    // Only the THIRD doc gets read.
    insertRetrieval(db, { docId: docC, surface: SURFACE.READ, session: 's1', created_at: '2026-08-01 10:05:00' });

    const { hint } = followThroughReport(db);
    assert.strictEqual(hint.followed30, 1);
  });

  it('does not count a read on an unrelated doc as follow-through', () => {
    const db = freshDb();
    const docA = insertDoc(db, { title: 'a' });
    const docOther = insertDoc(db, { title: 'other' });
    insertRetrieval(db, { docId: docA, surface: SURFACE.HINT, session: 's1', query: 'q', eventId: 'e1', created_at: '2026-08-01 10:00:00' });
    insertRetrieval(db, { docId: docOther, surface: SURFACE.READ, session: 's1', created_at: '2026-08-01 10:05:00' });

    const { hint } = followThroughReport(db);
    assert.strictEqual(hint.followed30, 0);
  });

  it('30-minute window: a read at exactly 30:00 counts, a read at 30:01 falls back to unbounded only', () => {
    const db = freshDb();
    const docEdge = insertDoc(db, { title: 'edge' });
    const docOver = insertDoc(db, { title: 'over' });
    insertRetrieval(db, { docId: docEdge, surface: SURFACE.HINT, session: 'edge', query: 'q', eventId: 'e1', created_at: '2026-08-01 10:00:00' });
    insertRetrieval(db, { docId: docEdge, surface: SURFACE.READ, session: 'edge', created_at: '2026-08-01 10:30:00' });

    insertRetrieval(db, { docId: docOver, surface: SURFACE.HINT, session: 'over', query: 'q', eventId: 'e2', created_at: '2026-08-01 10:00:00' });
    insertRetrieval(db, { docId: docOver, surface: SURFACE.READ, session: 'over', created_at: '2026-08-01 10:30:01' });

    const { hint } = followThroughReport(db);
    assert.strictEqual(hint.followed30, 1, 'exactly 30 minutes is inside the window');
    assert.strictEqual(hint.followedUnbounded, 2, 'both are followed unbounded');
  });

  it('does not follow through on a read that precedes the event', () => {
    const db = freshDb();
    const doc = insertDoc(db);
    insertRetrieval(db, { docId: doc, surface: SURFACE.READ, session: 's1', created_at: '2026-08-01 09:55:00' });
    insertRetrieval(db, { docId: doc, surface: SURFACE.HINT, session: 's1', query: 'q', eventId: 'e1', created_at: '2026-08-01 10:00:00' });

    const { hint } = followThroughReport(db);
    assert.strictEqual(hint.followed30, 0);
    assert.strictEqual(hint.followedUnbounded, 0);
  });

  it('--exclude-session drops an analyst session from the denominator entirely', () => {
    const db = freshDb();
    const doc = insertDoc(db);
    insertRetrieval(db, { docId: doc, surface: SURFACE.HINT, session: 'analyst-1', query: 'q', eventId: 'e1' });
    insertRetrieval(db, { docId: doc, surface: SURFACE.HINT, session: 's1', query: 'q', eventId: 'e2' });

    const { hint } = followThroughReport(db, { excludeSessions: ['analyst-1'] });
    assert.strictEqual(hint.events, 1);
  });
});

describe('followThroughReport: pull benchmark (kb_search)', () => {
  it('groups a search call\'s several result rows (no event_id, shared timestamp) into one event, and follow-through fires on any of them', () => {
    const db = freshDb();
    const docA = insertDoc(db, { title: 'a' });
    const docB = insertDoc(db, { title: 'b' });
    insertRetrieval(db, { docId: docA, surface: SURFACE.SEARCH, session: 's1', query: 'q', created_at: '2026-08-01 10:00:00' });
    insertRetrieval(db, { docId: docB, surface: SURFACE.SEARCH, session: 's1', query: 'q', created_at: '2026-08-01 10:00:00' });
    insertRetrieval(db, { docId: docB, surface: SURFACE.READ, session: 's1', created_at: '2026-08-01 10:02:00' });

    const { pullBenchmark } = followThroughReport(db);
    assert.strictEqual(pullBenchmark.events, 1, 'one search call, two result rows -> one event');
    assert.strictEqual(pullBenchmark.followed30, 1);
  });

  // The HIGH from the adversarial review: two DIFFERENT legacy (event_id
  // NULL) search calls landing in the same session in the same second used
  // to collapse into one event under (session, surface, created_at) alone —
  // 14/115 live events held 2-3 distinct query strings before this fix.
  // Folding query into the key separates them; write-path event_id (see
  // db.js's searchDocuments) is the real fix for rows written after it.
  it('two distinct same-second search calls (no event_id, different queries) reconstruct as two events, not one', () => {
    const db = freshDb();
    const docA = insertDoc(db, { title: 'a' });
    const docB = insertDoc(db, { title: 'b' });
    insertRetrieval(db, { docId: docA, surface: SURFACE.SEARCH, session: 's1', query: 'first query', created_at: '2026-08-01 10:00:00' });
    insertRetrieval(db, { docId: docB, surface: SURFACE.SEARCH, session: 's1', query: 'second query', created_at: '2026-08-01 10:00:00' });

    const { pullBenchmark } = followThroughReport(db);
    assert.strictEqual(pullBenchmark.events, 2, 'same second, different queries -> two calls, not one');
  });

  it('a search miss (doc_id NULL) is not counted as a fire', () => {
    const db = freshDb();
    insertRetrieval(db, { docId: null, surface: SURFACE.SEARCH, session: 's1', query: 'nothing found', created_at: '2026-08-01 10:00:00' });

    const { pullBenchmark } = followThroughReport(db);
    assert.strictEqual(pullBenchmark.fires, 0);
    assert.strictEqual(pullBenchmark.declines, 1);
  });
});

describe('followThroughReport: trigger surface (fires-*.jsonl)', () => {
  function fireLine({ ts, session, matched, emitted }) {
    return JSON.stringify({ ts, session, cwd: '/tmp', matched, emitted, command: 'echo hi' });
  }

  it('parses emitted:true lines, joins the fired note id to a same-session read within the window, skips isTestSession sessions', () => {
    const db = freshDb();
    const docId = insertDoc(db, { title: 'triggered' });
    insertDoc(db, { title: 'other' }); // gives the "not delivered" / "test session" lines a real id too

    mkdirSync(TRIGGERS_LOG_DIR, { recursive: true });
    writeFileSync(join(TRIGGERS_LOG_DIR, 'fires-2026-08-01.jsonl'), [
      fireLine({ ts: '2026-08-01T10:00:00.000Z', session: 's1', matched: [{ id: docId, hits: 2 }], emitted: true }),
      fireLine({ ts: '2026-08-01T10:00:00.000Z', session: 's2', matched: [{ id: docId, hits: 1 }], emitted: false }), // not delivered
      fireLine({ ts: '2026-08-01T10:00:00.000Z', session: 'smoke-test', matched: [{ id: docId, hits: 1 }], emitted: true }), // test session
    ].join('\n') + '\n');

    insertRetrieval(db, { docId, surface: SURFACE.READ, session: 's1', created_at: '2026-08-01 10:05:00' });

    const events = triggerEvents([]);
    assert.strictEqual(events.length, 1, 'only the one emitted:true, non-test row becomes an event');
    assert.strictEqual(events[0].session, 's1');
    assert.ok(events[0].docIds.has(docId));

    const { trigger } = followThroughReport(db);
    assert.strictEqual(trigger.events, 1);
    assert.strictEqual(trigger.followed30, 1);
  });

  it('readTriggerFires tolerates a malformed line without throwing', () => {
    mkdirSync(TRIGGERS_LOG_DIR, { recursive: true });
    writeFileSync(join(TRIGGERS_LOG_DIR, 'fires-2026-08-02.jsonl'), 'not json\n' + fireLine({ ts: '2026-08-02T00:00:00.000Z', session: 's1', matched: [{ id: 1, hits: 1 }], emitted: true }) + '\n');
    const rows = readTriggerFires();
    assert.ok(rows.some(r => r.session === 's1'));
  });

  // Adversarial-review LOW: PR #87 (honest session identity) fixed
  // kb_read/rest_read's session logging on 2026-08-10 04:46 UTC. A trigger
  // fire from before that can join against a read logged under a now-stale
  // session id, so the report must say so rather than present the number as
  // clean.
  it('flags the trigger section when a fire predates the honest-session-id fix', () => {
    mkdirSync(TRIGGERS_LOG_DIR, { recursive: true });
    writeFileSync(join(TRIGGERS_LOG_DIR, 'fires-2026-08-03.jsonl'), fireLine({
      ts: '2026-08-03T00:00:00.000Z', session: 'pre-cutoff-session', matched: [{ id: 1, hits: 1 }], emitted: true,
    }) + '\n');

    const { trigger } = followThroughReport(freshDb());
    assert.ok(trigger.preCutoffCaveat, 'a pre-cutoff fire must produce a non-null caveat string');
  });

  it('does not flag the trigger section when every fire is after the cutoff', () => {
    // Earlier tests in this file share TRIGGERS_LOG_DIR (one KB_DIR per test
    // file, see tmp-kb.js) and left pre-cutoff fixtures behind; readTriggerFires
    // reads every fires-*.jsonl in the directory, so this test needs a clean
    // one to make a true claim about "no pre-cutoff fires anywhere".
    rmSync(TRIGGERS_LOG_DIR, { recursive: true, force: true });
    mkdirSync(TRIGGERS_LOG_DIR, { recursive: true });
    writeFileSync(join(TRIGGERS_LOG_DIR, 'fires-2026-08-11.jsonl'), fireLine({
      ts: '2026-08-11T00:00:00.000Z', session: 'post-cutoff-session', matched: [{ id: 1, hits: 1 }], emitted: true,
    }) + '\n');

    const { trigger } = followThroughReport(freshDb());
    assert.strictEqual(trigger.preCutoffCaveat, null);
  });
});

describe('cluster-bootstrap CI reproducibility', () => {
  it('the same seed produces the same interval on repeated calls', () => {
    const fireEvents = [
      { session: 'a', followed30: true }, { session: 'a', followed30: false }, { session: 'a', followed30: true },
      { session: 'b', followed30: false }, { session: 'b', followed30: false },
      { session: 'c', followed30: true },
    ];
    const first = clusterBootstrapCI(fireEvents, { seed: 42, iterations: 500 });
    const second = clusterBootstrapCI(fireEvents, { seed: 42, iterations: 500 });
    assert.deepStrictEqual(first, second);
  });

  it('a different seed is free to produce a different interval', () => {
    const fireEvents = [
      { session: 'a', followed30: true }, { session: 'a', followed30: false },
      { session: 'b', followed30: false }, { session: 'b', followed30: true },
      { session: 'c', followed30: false }, { session: 'd', followed30: true },
    ];
    const seed42 = clusterBootstrapCI(fireEvents, { seed: 42, iterations: 500 });
    const seed7 = clusterBootstrapCI(fireEvents, { seed: 7, iterations: 500 });
    // Not asserting inequality (a different seed COULD coincide) — just that
    // both are well-formed and reproducible on their own.
    assert.ok(seed42.lo <= seed42.hi);
    assert.ok(seed7.lo <= seed7.hi);
  });

  it('returns null when there are no fire events (nothing to resample)', () => {
    assert.strictEqual(clusterBootstrapCI([]), null);
  });
});

describe('--json output shape', () => {
  it('the report is plain-data JSON-serializable with the documented top-level keys', () => {
    const db = freshDb();
    const doc = insertDoc(db);
    insertRetrieval(db, { docId: doc, surface: SURFACE.HINT, session: 's1', query: 'q', eventId: 'e1' });

    const report = followThroughReport(db);
    const roundTripped = JSON.parse(JSON.stringify(report));
    assert.deepStrictEqual(Object.keys(roundTripped).sort(), ['briefing', 'hint', 'pullBenchmark', 'trigger', 'uncertainty', 'windowNote'].sort());
    assert.ok(!('fireEvents' in roundTripped.hint), 'internal working set must not leak into the report');
    for (const surface of [roundTripped.hint, roundTripped.briefing, roundTripped.pullBenchmark]) {
      assert.ok('events' in surface && 'excluded' in surface && 'followed30' in surface && 'followedUnbounded' in surface);
    }
    assert.strictEqual(typeof roundTripped.windowNote, 'string');
    assert.ok('preCutoffCaveat' in roundTripped.trigger);
  });
});
