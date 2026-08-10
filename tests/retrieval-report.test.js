import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { initSchema } from '../src/db.js';
import { retrievalReport } from '../src/cli/retrieval-report.js';
import { isKbNudge } from '../src/retrieval.js';

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

  // The channel someone opened the note on is not the question the metric
  // asks. Pinning it to one surface made it silently under-count as soon as
  // a second read channel existed.
  it('pairs a hint with a read on any read surface, not just the MCP one', () => {
    const db = freshDb();
    const doc = insertDoc(db);
    const now = new Date();
    const at = (secOffset) => new Date(now.getTime() + secOffset * 1000).toISOString();

    insertRetrieval(db, { docId: doc, surface: 'hint', session: 's1', created_at: at(0) });
    insertRetrieval(db, { docId: doc, surface: 'rest_read', session: 's1', created_at: at(10) });

    const { followThrough } = retrievalReport(db);
    assert.strictEqual(followThrough.followed, 1);
    db.close();
  });

  it('does not count a later search hit as following through — a hint asks to be opened', () => {
    const db = freshDb();
    const doc = insertDoc(db);
    const now = new Date();
    const at = (secOffset) => new Date(now.getTime() + secOffset * 1000).toISOString();

    insertRetrieval(db, { docId: doc, surface: 'hint', session: 's1', created_at: at(0) });
    insertRetrieval(db, { docId: doc, surface: 'kb_search', session: 's1', created_at: at(10) });

    const { followThrough } = retrievalReport(db);
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

describe('retrievalReport session coverage', () => {
  it('splits rows into push and pull and reports how many carry a session id', () => {
    const db = freshDb();
    const doc = insertDoc(db);
    insertRetrieval(db, { docId: doc, surface: 'briefing', session: 's1' });
    insertRetrieval(db, { docId: doc, surface: 'hint', session: null });
    insertRetrieval(db, { docId: doc, surface: 'kb_read', session: 's1' });
    insertRetrieval(db, { docId: doc, surface: 'rest_search', session: null });
    insertRetrieval(db, { docId: doc, surface: 'cli_search', session: null });

    const { sessionCoverage } = retrievalReport(db);
    assert.strictEqual(sessionCoverage.push, 2);
    assert.strictEqual(sessionCoverage.push_with_session, 1);
    assert.strictEqual(sessionCoverage.pull, 3);
    assert.strictEqual(sessionCoverage.pull_with_session, 1);
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

// The classifier's whole job is to separate "go and look in the KB" from
// talking about the KB, and the second is most of what this store contains —
// every rejection below is a real prompt the meter already holds.
describe('recognising a prompt that tells the agent to go and look', () => {
  const NUDGES = [
    'here. Look in KB there might be something in KB for this',
    'check the kb before you start on any of this',
    'search the knowledge base for prior art on this one',
    'is there anything in the KB about how this used to work',
    'consult kb first, I think we hit this before',
    'read the knowledge-base note on it and then decide',
    'run kb_search on this before you go reading files',
  ];

  const NOT_NUDGES = [
    "ok let's pin this in the kb and move to another topic",
    "or was it all silent fails on the kb that I wasn't seeing",
    'ok did we fix the hinting?',
    'check the dashboard now, I also did the deploy',
    'we should use the advisor that we have on tap, while we both make suggestions',
    'first thing, make sure all these gaps are properly tracked',
    'the kb has 2199 notes and the harvest ran clean last night',
  ];

  for (const prompt of NUDGES) {
    it(`fires: ${prompt.slice(0, 48)}`, () => assert.ok(isKbNudge(prompt), prompt));
  }
  for (const prompt of NOT_NUDGES) {
    it(`declines: ${prompt.slice(0, 48)}`, () => assert.ok(!isKbNudge(prompt), prompt));
  }
});

describe('what a nudge is worth: the prompt before it', () => {
  // One prompt is one event however many notes it surfaced, so a fired hint
  // that returned three notes must not read as three prompts.
  function session(db, name, turns) {
    const doc = insertDoc(db, { title: `${name}-doc` });
    turns.forEach(([query, fired], i) => {
      const at = `2026-08-03 10:0${i}:00`;
      if (fired) {
        insertRetrieval(db, { docId: doc, surface: 'hint', query, session: name, created_at: at });
        insertRetrieval(db, { docId: doc, surface: 'hint', query, session: name, created_at: at });
      } else {
        insertRetrieval(db, { docId: null, surface: 'hint', query, session: name, created_at: at });
      }
    });
  }

  it('attributes each nudge to what the hint did on the prompt before it', () => {
    const db = freshDb();
    session(db, 'a', [
      ['why is the nightly job not writing anything', false],
      ['check the kb, there might be something on that', false],
    ]);
    session(db, 'b', [
      ['how does the indexer work', true],
      ['look in the knowledge base for the rest', false],
    ]);
    session(db, 'c', [['search the kb for anything on this', false]]);

    const { askedToLook } = retrievalReport(db);
    assert.strictEqual(askedToLook.prompts, 5, 'a hint that surfaced two notes is still one prompt');
    assert.strictEqual(askedToLook.nudges, 3);
    assert.deepStrictEqual(askedToLook.after, { decline: 1, fire: 1, nothing: 1 });
    db.close();
  });

  it('does not carry the previous prompt across a session boundary', () => {
    const db = freshDb();
    session(db, 'a', [['some unrelated question about the build', true]]);
    session(db, 'b', [['check the kb on this one', false]]);

    const { askedToLook } = retrievalReport(db);
    assert.deepStrictEqual(askedToLook.after, { decline: 0, fire: 0, nothing: 1 });
    db.close();
  });
});
