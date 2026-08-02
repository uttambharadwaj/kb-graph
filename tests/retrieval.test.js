import './helpers/tmp-kb.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { getDb } from '../src/db.js';
import { PUSH_SURFACES, SURFACES, logRetrieval, logRetrievalResults, resolveSessionId } from '../src/retrieval.js';

describe('resolveSessionId', () => {
  const ORIGINAL = process.env.CLAUDE_CODE_SESSION_ID;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = ORIGINAL;
  });

  it('prefers hook-supplied session_id over the env var', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'env-session';
    assert.strictEqual(resolveSessionId({ session_id: 'hook-session' }), 'hook-session');
  });

  it('falls back to the env var when no hook input is given', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'env-session';
    assert.strictEqual(resolveSessionId(), 'env-session');
    assert.strictEqual(resolveSessionId(null), 'env-session');
  });

  it('is null when neither source has a session id', () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    assert.strictEqual(resolveSessionId(), null);
    assert.strictEqual(resolveSessionId({}), null);
  });
});

describe('logRetrieval', () => {
  it('writes a row with the given surface, doc id, query and session', () => {
    const db = getDb();
    const docId = db.prepare(`INSERT INTO documents (title, content, doc_type) VALUES ('t', 'x', 'note')`).run().lastInsertRowid;
    logRetrieval({ docId, surface: 'kb_read', query: null, session: 'sess-1' });
    const row = db.prepare('SELECT * FROM retrievals WHERE surface = ? AND doc_id = ?').get('kb_read', docId);
    assert.ok(row);
    assert.strictEqual(row.session, 'sess-1');
    assert.ok(row.created_at);
  });

  it('writes a miss row (doc_id NULL) when passed no docId', () => {
    const db = getDb();
    logRetrieval({ surface: 'kb_search', query: 'nothing matches this' });
    const row = db.prepare('SELECT * FROM retrievals WHERE surface = ? AND query = ?').get('kb_search', 'nothing matches this');
    assert.ok(row);
    assert.strictEqual(row.doc_id, null);
  });

  it('swallows an unknown surface instead of throwing', () => {
    assert.doesNotThrow(() => logRetrieval({ docId: 1, surface: 'not_a_real_surface' }));
  });

  it('SURFACES lists exactly the instrumented read-path chokepoints', () => {
    assert.deepStrictEqual(SURFACES, [
      'kb_read', 'kb_search', 'kb_search_smart', 'kb_context', 'kb_tunnels', 'briefing', 'hint',
      'rest_read', 'rest_search', 'rest_search_smart', 'rest_context', 'cli_search',
    ]);
  });

  it('every push surface is a known surface', () => {
    for (const s of PUSH_SURFACES) assert.ok(SURFACES.includes(s), `${s} missing from SURFACES`);
  });
});

describe('logRetrievalResults', () => {
  const countFor = (db, surface) => db.prepare(
    'SELECT COUNT(*) c FROM retrievals WHERE surface = ?'
  ).get(surface).c;
  const makeDocs = (db, n) => Array.from({ length: n }, (_, i) =>
    db.prepare(`INSERT INTO documents (title, content, doc_type) VALUES (?, 'x', 'note')`)
      .run(`results-doc-${i}-${Math.random()}`).lastInsertRowid);

  // Silence, not just an absent row: logRetrieval would reject a null surface
  // anyway, so without the early return every internal lookup would print a
  // retrieval-log failure and the real ones would be lost in it.
  it('logs nothing and says nothing without a surface, so internal lookups stay out of the meter', () => {
    const db = getDb();
    const results = makeDocs(db, 2).map(id => ({ id }));
    const before = db.prepare('SELECT COUNT(*) c FROM retrievals').get().c;
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      logRetrievalResults({ results, surface: null, query: 'q' });
      logRetrievalResults({ results });
    } finally {
      console.error = original;
    }
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM retrievals').get().c, before);
    assert.deepStrictEqual(errors, []);
  });

  it('logs one row per result, carrying the query onto each', () => {
    const db = getDb();
    const ids = makeDocs(db, 3);
    const before = countFor(db, 'cli_search');
    logRetrievalResults({ results: ids.map(id => ({ id })), surface: 'cli_search', query: 'three' });
    assert.strictEqual(countFor(db, 'cli_search'), before + 3);
    const rows = db.prepare("SELECT * FROM retrievals WHERE surface = 'cli_search' AND query = 'three'").all();
    assert.deepStrictEqual(rows.map(r => r.doc_id), ids);
  });

  it('logs a single miss row for an empty result set', () => {
    const db = getDb();
    logRetrievalResults({ results: [], surface: 'rest_search', query: 'nothing at all' });
    const rows = db.prepare("SELECT * FROM retrievals WHERE surface = 'rest_search' AND query = 'nothing at all'").all();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].doc_id, null);
  });

  it('prefers an explicitly passed session over the ambient one', () => {
    const db = getDb();
    const [a, b] = makeDocs(db, 2);
    process.env.CLAUDE_CODE_SESSION_ID = 'ambient';
    try {
      logRetrievalResults({ results: [{ id: a }], surface: 'hint', query: 'explicit', session: 'from-hook' });
      logRetrievalResults({ results: [{ id: b }], surface: 'hint', query: 'ambient' });
      const explicit = db.prepare("SELECT session FROM retrievals WHERE query = 'explicit'").get();
      const ambient = db.prepare("SELECT session FROM retrievals WHERE query = 'ambient'").get();
      assert.strictEqual(explicit.session, 'from-hook');
      assert.strictEqual(ambient.session, 'ambient');
    } finally {
      delete process.env.CLAUDE_CODE_SESSION_ID;
    }
  });
});
