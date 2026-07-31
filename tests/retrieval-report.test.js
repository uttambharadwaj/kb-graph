import { describe, it } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { initSchema } from '../src/db.js';
import { retrievalReport } from '../src/cli/retrieval-report.js';

function freshDb() {
  const db = new Database(':memory:');
  initSchema(db);
  return db;
}

function insertDoc(db, { title = 't', doc_type = 'note', created_at = null, superseded = false } = {}) {
  const sql = superseded
    ? `INSERT INTO documents (title, content, doc_type, created_at, superseded_at) VALUES (?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)`
    : `INSERT INTO documents (title, content, doc_type, created_at) VALUES (?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`;
  return db.prepare(sql).run(title, 'body', doc_type, created_at).lastInsertRowid;
}

function insertRetrieval(db, { docId = null, surface, query = null, session = null, created_at = null } = {}) {
  db.prepare(
    'INSERT INTO retrievals (doc_id, surface, query, session, created_at) VALUES (?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))'
  ).run(docId, surface, query, session, created_at);
}

describe('retrievalReport coverage', () => {
  it('counts a live doc as retrieved from any surface, and excludes superseded docs from the denominator', () => {
    const db = freshDb();
    const read = insertDoc(db, { title: 'read' });
    insertDoc(db, { title: 'untouched' });
    insertDoc(db, { title: 'retired', superseded: true });
    insertRetrieval(db, { docId: read, surface: 'kb_read' });

    const { coverage } = retrievalReport(db);
    assert.strictEqual(coverage.total, 2);
    assert.strictEqual(coverage.retrieved, 1);
    db.close();
  });

  it('splits coverage by doc_type', () => {
    const db = freshDb();
    const a = insertDoc(db, { doc_type: 'fix' });
    insertDoc(db, { doc_type: 'fix' });
    insertDoc(db, { doc_type: 'idea' });
    insertRetrieval(db, { docId: a, surface: 'kb_search' });

    const { byType } = retrievalReport(db);
    const fix = byType.find(t => t.doc_type === 'fix');
    const idea = byType.find(t => t.doc_type === 'idea');
    assert.strictEqual(fix.total, 2);
    assert.strictEqual(fix.retrieved, 1);
    assert.strictEqual(idea.total, 1);
    assert.strictEqual(idea.retrieved, 0);
    db.close();
  });
});

describe('retrievalReport freshness', () => {
  it('counts a recent doc retrieved within 30 days of writing, and excludes one retrieved later or written outside the 90-day window', () => {
    const db = freshDb();
    const now = new Date();
    const daysAgo = (n) => new Date(now.getTime() - n * 86400000).toISOString();

    const fast = insertDoc(db, { created_at: daysAgo(10) });
    insertRetrieval(db, { docId: fast, surface: 'kb_read', created_at: daysAgo(5) }); // 5 days after writing

    const slow = insertDoc(db, { created_at: daysAgo(60) });
    insertRetrieval(db, { docId: slow, surface: 'kb_read', created_at: daysAgo(1) }); // ~59 days after writing

    insertDoc(db, { created_at: daysAgo(200) }); // outside the 90-day window entirely

    const { freshness } = retrievalReport(db);
    assert.strictEqual(freshness.written, 2); // fast + slow; the 200-day-old doc is excluded
    assert.strictEqual(freshness.retrieved_within_30d, 1); // only fast
    db.close();
  });
});

describe('retrievalReport hint follow-through', () => {
  it('pairs a hint with a later kb_read of the same doc in the same session', () => {
    const db = freshDb();
    const doc = insertDoc(db);
    const now = new Date();
    const at = (secOffset) => new Date(now.getTime() + secOffset * 1000).toISOString();

    insertRetrieval(db, { docId: doc, surface: 'hint', session: 's1', created_at: at(0) });
    insertRetrieval(db, { docId: doc, surface: 'kb_read', session: 's1', created_at: at(10) });

    const { followThrough } = retrievalReport(db);
    assert.strictEqual(followThrough.hints_emitted, 1);
    assert.strictEqual(followThrough.followed, 1);
    db.close();
  });

  it('does not pair a hint with a kb_read in a different session', () => {
    const db = freshDb();
    const doc = insertDoc(db);
    const now = new Date();
    const at = (secOffset) => new Date(now.getTime() + secOffset * 1000).toISOString();

    insertRetrieval(db, { docId: doc, surface: 'hint', session: 's1', created_at: at(0) });
    insertRetrieval(db, { docId: doc, surface: 'kb_read', session: 's2', created_at: at(10) });

    const { followThrough } = retrievalReport(db);
    assert.strictEqual(followThrough.hints_emitted, 1);
    assert.strictEqual(followThrough.followed, 0);
    db.close();
  });

  it('does not pair two rows that both have a null session', () => {
    const db = freshDb();
    const doc = insertDoc(db);
    const now = new Date();
    const at = (secOffset) => new Date(now.getTime() + secOffset * 1000).toISOString();

    insertRetrieval(db, { docId: doc, surface: 'hint', session: null, created_at: at(0) });
    insertRetrieval(db, { docId: doc, surface: 'kb_read', session: null, created_at: at(10) });

    const { followThrough } = retrievalReport(db);
    assert.strictEqual(followThrough.hints_emitted, 1);
    assert.strictEqual(followThrough.followed, 0);
    db.close();
  });

  it('does not pair a hint with an earlier kb_read — the read must follow the hint', () => {
    const db = freshDb();
    const doc = insertDoc(db);
    const now = new Date();
    const at = (secOffset) => new Date(now.getTime() + secOffset * 1000).toISOString();

    insertRetrieval(db, { docId: doc, surface: 'kb_read', session: 's1', created_at: at(0) });
    insertRetrieval(db, { docId: doc, surface: 'hint', session: 's1', created_at: at(10) });

    const { followThrough } = retrievalReport(db);
    assert.strictEqual(followThrough.hints_emitted, 1);
    assert.strictEqual(followThrough.followed, 0);
    db.close();
  });
});

describe('retrievalReport miss rate', () => {
  it('counts doc_id IS NULL rows per surface', () => {
    const db = freshDb();
    const doc = insertDoc(db);
    insertRetrieval(db, { docId: doc, surface: 'kb_search' });
    insertRetrieval(db, { docId: null, surface: 'kb_search' });
    insertRetrieval(db, { docId: null, surface: 'kb_search' });
    insertRetrieval(db, { docId: doc, surface: 'kb_context' });

    const { missRate } = retrievalReport(db);
    const search = missRate.find(s => s.surface === 'kb_search');
    const context = missRate.find(s => s.surface === 'kb_context');
    assert.strictEqual(search.total, 3);
    assert.strictEqual(search.misses, 2);
    assert.strictEqual(context.total, 1);
    assert.strictEqual(context.misses, 0);
    db.close();
  });
});
