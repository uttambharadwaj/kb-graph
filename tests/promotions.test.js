import './helpers/tmp-kb.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initSchema, getDb } from '../src/db.js';
import { SURFACE } from '../src/retrieval.js';
import { TIER } from '../src/tiers.js';
import {
  computePromotionDecisions, runPromotionsCli, PROMOTIONS_LOG_DIR, WOULD_PROMOTE_LOG,
} from '../src/cli/promotions.js';
import { TRIGGERS_LOG_DIR } from '../src/cli/trigger-hook.js';

function freshDb() {
  const db = new Database(':memory:');
  initSchema(db);
  return db;
}

function insertDoc(db, { title = 't', tier = TIER.INFERRED, superseded = false } = {}) {
  const id = db.prepare('INSERT INTO documents (title, content, doc_type) VALUES (?, ?, ?)').run(title, 'body', 'note').lastInsertRowid;
  db.prepare('UPDATE documents SET tier = ? WHERE id = ?').run(tier, id);
  if (superseded) db.prepare('UPDATE documents SET superseded_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  return id;
}

function insertRetrieval(db, {
  docId = null, surface, query = null, session = null, created_at = null, eventId = null, isTest = 0,
} = {}) {
  db.prepare(`
    INSERT INTO retrievals (doc_id, surface, query, session, created_at, event_id, is_test)
    VALUES (?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?)
  `).run(docId, surface, query, session, created_at, eventId, isTest);
}

// Push at t0, read (follows it) at t0 + 5min — well inside the 30min window.
function pushAndFollow(db, doc, { surface = SURFACE.HINT, session = 's1', eventId = 'e1' } = {}) {
  insertRetrieval(db, { docId: doc, surface, session, query: 'q', eventId, created_at: '2026-08-10 10:00:00' });
  insertRetrieval(db, { docId: doc, surface: SURFACE.READ, session, created_at: '2026-08-10 10:05:00' });
}

function resetLog() {
  rmSync(PROMOTIONS_LOG_DIR, { recursive: true, force: true });
}

beforeEach(() => {
  resetLog();
  rmSync(TRIGGERS_LOG_DIR, { recursive: true, force: true });
  mkdirSync(TRIGGERS_LOG_DIR, { recursive: true });
});

describe('candidate selection', () => {
  it('a followed hint event on an inferred, live doc becomes a new candidate', () => {
    const db = freshDb();
    const doc = insertDoc(db, { title: 'inferred note' });
    pushAndFollow(db, doc);

    const { candidates, skipped } = computePromotionDecisions(db);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].doc_id, doc);
    assert.strictEqual(candidates[0].title, 'inferred note');
    assert.strictEqual(candidates[0].current_tier, TIER.INFERRED);
    assert.strictEqual(candidates[0].would_become, TIER.OBSERVED);
  });

  it('an already-observed doc is not a candidate', () => {
    const db = freshDb();
    const doc = insertDoc(db, { tier: TIER.OBSERVED });
    pushAndFollow(db, doc);

    const { candidates } = computePromotionDecisions(db);
    assert.strictEqual(candidates.length, 0);
  });

  it('a hint push with no matching read yields no candidate', () => {
    const db = freshDb();
    const doc = insertDoc(db);
    insertRetrieval(db, { docId: doc, surface: SURFACE.HINT, session: 's1', query: 'q', eventId: 'e1', created_at: '2026-08-10 10:00:00' });
    // no follow-up read at all

    const { candidates } = computePromotionDecisions(db);
    assert.strictEqual(candidates.length, 0);
  });

  it('a superseded doc is not a candidate even when followed', () => {
    const db = freshDb();
    const doc = insertDoc(db, { superseded: true });
    pushAndFollow(db, doc);

    const { candidates } = computePromotionDecisions(db);
    assert.strictEqual(candidates.length, 0);
  });

  it('a followed briefing push never becomes a candidate — mechanical exposure is not reliance', () => {
    const db = freshDb();
    const doc = insertDoc(db);
    pushAndFollow(db, doc, { surface: SURFACE.BRIEFING });

    const { candidates } = computePromotionDecisions(db);
    assert.strictEqual(candidates.length, 0);
  });

  it('a followed trigger fire on an inferred doc becomes a candidate', () => {
    const db = freshDb();
    const doc = insertDoc(db, { title: 'triggered note' });
    writeFileSync(join(TRIGGERS_LOG_DIR, 'fires-2026-08-10.jsonl'), JSON.stringify({
      ts: '2026-08-10T10:00:00.000Z', session: 's1', cwd: '/tmp', command: 'echo hi',
      matched: [{ id: doc, hits: 2 }], emitted: true,
    }) + '\n');
    insertRetrieval(db, { docId: doc, surface: SURFACE.READ, session: 's1', created_at: '2026-08-10 10:05:00' });

    const { candidates } = computePromotionDecisions(db);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].doc_id, doc);
    assert.match(candidates[0].basis.event_id, /^trigger:/);
  });

  it('basis carries session, followed_at and a positive read_latency_s', () => {
    const db = freshDb();
    const doc = insertDoc(db);
    pushAndFollow(db, doc);

    const { candidates } = computePromotionDecisions(db);
    assert.strictEqual(candidates[0].basis.session, 's1');
    assert.strictEqual(candidates[0].basis.read_latency_s, 5 * 60);
    assert.strictEqual(candidates[0].basis.followed_at, '2026-08-10T10:05:00.000Z');
    assert.strictEqual(candidates[0].basis.event_id, 'id:e1');
  });
});

describe('dedup across runs', () => {
  it('a doc already in the log is skipped on rerun, even when followed again by a new event', () => {
    const db = freshDb();
    const doc = insertDoc(db);
    pushAndFollow(db, doc, { session: 's1', eventId: 'e1' });

    const first = computePromotionDecisions(db);
    assert.strictEqual(first.candidates.length, 1);
    mkdirSync(PROMOTIONS_LOG_DIR, { recursive: true });
    writeFileSync(WOULD_PROMOTE_LOG, JSON.stringify(first.candidates[0]) + '\n');

    // A second, distinct followed event for the same doc.
    pushAndFollow(db, doc, { session: 's2', eventId: 'e2' });

    const second = computePromotionDecisions(db);
    assert.strictEqual(second.candidates.length, 0, 'doc_id already logged — no re-append');
    assert.strictEqual(second.skipped.length, 1);
    assert.strictEqual(second.skipped[0].doc_id, doc);
  });

  it('re-running the real CLI does not duplicate a line for the same doc', () => {
    // Exercises the actual entry point (runPromotionsCli -> getDb()), not the
    // exported computePromotionDecisions helper the tests above use directly.
    const db = getDb();
    db.exec('DELETE FROM retrievals; DELETE FROM documents;');
    const doc = insertDoc(db, { title: 'cli dedup note' });
    pushAndFollow(db, doc);

    const orig = console.log;
    console.log = () => {};
    try {
      runPromotionsCli([]);
      runPromotionsCli([]);
    } finally {
      console.log = orig;
    }

    const lines = readFileSync(WOULD_PROMOTE_LOG, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const forDoc = lines.filter(l => l.doc_id === doc);
    assert.strictEqual(forDoc.length, 1, 'one line ever, even after two runs');
  });
});

describe('jsonl log shape', () => {
  it('an appended line has exactly the documented fields', () => {
    const db = freshDb();
    const doc = insertDoc(db, { title: 'shaped note' });
    pushAndFollow(db, doc);

    const { candidates } = computePromotionDecisions(db);
    mkdirSync(PROMOTIONS_LOG_DIR, { recursive: true });
    writeFileSync(WOULD_PROMOTE_LOG, candidates.map(c => JSON.stringify(c)).join('\n') + '\n');

    const lines = readFileSync(WOULD_PROMOTE_LOG, 'utf-8').trim().split('\n');
    assert.strictEqual(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.deepStrictEqual(Object.keys(row).sort(), ['basis', 'current_tier', 'decided_at', 'doc_id', 'title', 'would_become'].sort());
    assert.deepStrictEqual(Object.keys(row.basis).sort(), ['event_id', 'followed_at', 'read_latency_s', 'session'].sort());
    assert.strictEqual(typeof row.decided_at, 'string');
    assert.ok(!Number.isNaN(Date.parse(row.decided_at)));
  });
});

describe('read-only on the DB', () => {
  it('running the CLI never mutates documents or retrievals', () => {
    const db = freshDb();
    const doc = insertDoc(db, { title: 'must stay inferred' });
    pushAndFollow(db, doc);

    const docsBefore = db.prepare('SELECT tier, superseded_at FROM documents WHERE id = ?').get(doc);
    const retrievalsCountBefore = db.prepare('SELECT COUNT(*) AS n FROM retrievals').get().n;
    const docsCountBefore = db.prepare('SELECT COUNT(*) AS n FROM documents').get().n;

    computePromotionDecisions(db); // the read-only half — no appendDecisions call

    const docsAfter = db.prepare('SELECT tier, superseded_at FROM documents WHERE id = ?').get(doc);
    const retrievalsCountAfter = db.prepare('SELECT COUNT(*) AS n FROM retrievals').get().n;
    const docsCountAfter = db.prepare('SELECT COUNT(*) AS n FROM documents').get().n;

    assert.deepStrictEqual(docsAfter, docsBefore, 'tier must not move — this is a dry run');
    assert.strictEqual(retrievalsCountAfter, retrievalsCountBefore, 'no retrieval row logged by the promotions read path');
    assert.strictEqual(docsCountAfter, docsCountBefore);
  });
});

describe('--json output and CLI wiring', () => {
  it('prints the documented top-level shape via the real CLI entry point', () => {
    const db = getDb();
    db.exec('DELETE FROM retrievals; DELETE FROM documents;');
    const doc = insertDoc(db, { title: 'json note' });
    pushAndFollow(db, doc);

    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try {
      runPromotionsCli(['--json']);
    } finally {
      console.log = orig;
    }

    assert.strictEqual(logs.length, 1, 'exactly one JSON blob printed');
    const payload = JSON.parse(logs[0]);
    assert.deepStrictEqual(Object.keys(payload).sort(), ['candidates', 'decisions', 'new', 'skippedAlreadyLogged'].sort());
    assert.strictEqual(payload.candidates, 1);
    assert.strictEqual(payload.new, 1);
    assert.strictEqual(payload.skippedAlreadyLogged, 0);
    assert.strictEqual(payload.decisions[0].doc_id, doc);
  });

  it('rejects an unknown --apply flag — applying stays impossible by construction', () => {
    // No --apply exists on this command; unrecognized flags are refused
    // before any work runs (flags.js's assertKnownFlags), which is what
    // makes "dry-run only" a property of the CLI surface, not a convention.
    assert.throws(() => runPromotionsCli(['--apply']), /Unknown flag: --apply/);
  });
});
