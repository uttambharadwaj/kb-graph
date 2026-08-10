import './helpers/tmp-kb.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getDb } from '../src/db.js';
import { PUSH_SURFACES, SURFACES, logRetrieval, logRetrievalResults, resolveSessionId } from '../src/retrieval.js';
import { SESSION_MAP_DIR } from '../src/session-map.js';

function seedMap(pid, entry) {
  mkdirSync(SESSION_MAP_DIR, { recursive: true });
  writeFileSync(join(SESSION_MAP_DIR, `${pid}.json`), JSON.stringify(entry));
}

// The ancestry walk itself (ps-backed) is process-ancestry.test.js's job;
// these exercise the map fallback chain via the getAncestry override, so no
// test here depends on what process node:test actually happens to run under.
// No env-var case: a pid_start-verified map hit is the only non-hookInput
// source resolveSessionId trusts, so CLAUDE_CODE_SESSION_ID never enters the
// resolution at all — see the doc comment on resolveSessionId for why.
describe('resolveSessionId', () => {
  const ORIGINAL = process.env.CLAUDE_CODE_SESSION_ID;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = ORIGINAL;
  });

  it('prefers hook-supplied session_id over everything else', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'env-session';
    assert.strictEqual(resolveSessionId({ session_id: 'hook-session' }), 'hook-session');
  });

  it('is null when ancestry resolution finds no claude ancestor', () => {
    const getAncestry = () => ({ claudePid: null, pidStart: null });
    assert.strictEqual(resolveSessionId(null, { getAncestry }), null);
    assert.strictEqual(resolveSessionId({}, { getAncestry }), null);
  });

  it('uses the map entry when the resolved pid_start matches (the expected case)', () => {
    seedMap(5101, { pid: 5101, pid_start: 'START-A', session_id: 'mapped-session' });
    const getAncestry = () => ({ claudePid: 5101, pidStart: 'START-A' });
    assert.strictEqual(resolveSessionId(null, { getAncestry }), 'mapped-session');
  });

  it('ignores env entirely when the map already hit', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'env-session';
    seedMap(5102, { pid: 5102, pid_start: 'START-B', session_id: 'mapped-session' });
    const getAncestry = () => ({ claudePid: 5102, pidStart: 'START-B' });
    assert.strictEqual(resolveSessionId(null, { getAncestry }), 'mapped-session');
  });

  it('treats a pid_start mismatch (pid reuse) as a miss, never falling back to env', () => {
    seedMap(5103, { pid: 5103, pid_start: 'OLD-START', session_id: 'stale-session' });
    process.env.CLAUDE_CODE_SESSION_ID = 'stale-session'; // even if env agrees with the dead entry
    const getAncestry = () => ({ claudePid: 5103, pidStart: 'NEW-START' });
    assert.strictEqual(resolveSessionId(null, { getAncestry }), null);
  });

  it('never emits the env id on its own, with or without a map entry present', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'lonely-env-value';
    assert.strictEqual(resolveSessionId(null, { getAncestry: () => ({ claudePid: null, pidStart: null }) }), null);
    seedMap(5106, { pid: 5106, pid_start: 'START', session_id: 'lonely-env-value' });
    assert.strictEqual(
      resolveSessionId(null, { getAncestry: () => ({ claudePid: 5106, pidStart: 'DIFFERENT' }) }),
      null,
    );
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

  it('prefers an explicitly passed session over the default resolveSessionId() lookup', () => {
    const db = getDb();
    const [a, b] = makeDocs(db, 2);
    logRetrievalResults({ results: [{ id: a }], surface: 'hint', query: 'explicit', session: 'from-hook' });
    // No session override: falls through to the real resolveSessionId(), which
    // in this sandbox (KB_DIR is a throwaway tmp dir — see tmp-kb.js) has no
    // session-map entry to corroborate against, so it's null regardless of
    // whatever this test process's real ancestry happens to be.
    logRetrievalResults({ results: [{ id: b }], surface: 'hint', query: 'ambient' });
    const explicit = db.prepare("SELECT session FROM retrievals WHERE query = 'explicit'").get();
    const ambient = db.prepare("SELECT session FROM retrievals WHERE query = 'ambient'").get();
    assert.strictEqual(explicit.session, 'from-hook');
    assert.strictEqual(ambient.session, null);
  });
});
