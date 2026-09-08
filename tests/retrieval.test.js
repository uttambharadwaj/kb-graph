import './helpers/tmp-kb.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { DEFAULT_BUSY_TIMEOUT_MS, getDb } from '../src/db.js';
import { PUSH_SURFACES, READ_SURFACES, SURFACE, SURFACES, callIdentity, isTestSession, logRetrieval, logRetrievalResults, resolveAgent, resolveSessionId } from '../src/retrieval.js';
import { AGENT } from '../src/process-ancestry.js';
import { SESSION_MAP_DIR } from '../src/session-map.js';
import { DB_PATH } from '../src/paths.js';

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
    const getAncestry = () => ({ harnessPid: null, pidStart: null });
    assert.strictEqual(resolveSessionId(null, { getAncestry }), null);
    assert.strictEqual(resolveSessionId({}, { getAncestry }), null);
  });

  it('uses the map entry when the resolved pid_start matches (the expected case)', () => {
    seedMap(5101, { pid: 5101, pid_start: 'START-A', session_id: 'mapped-session' });
    const getAncestry = () => ({ harnessPid: 5101, pidStart: 'START-A' });
    assert.strictEqual(resolveSessionId(null, { getAncestry }), 'mapped-session');
  });

  it('ignores env entirely when the map already hit', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'env-session';
    seedMap(5102, { pid: 5102, pid_start: 'START-B', session_id: 'mapped-session' });
    const getAncestry = () => ({ harnessPid: 5102, pidStart: 'START-B' });
    assert.strictEqual(resolveSessionId(null, { getAncestry }), 'mapped-session');
  });

  it('treats a pid_start mismatch (pid reuse) as a miss, never falling back to env', () => {
    seedMap(5103, { pid: 5103, pid_start: 'OLD-START', session_id: 'stale-session' });
    process.env.CLAUDE_CODE_SESSION_ID = 'stale-session'; // even if env agrees with the dead entry
    const getAncestry = () => ({ harnessPid: 5103, pidStart: 'NEW-START' });
    assert.strictEqual(resolveSessionId(null, { getAncestry }), null);
  });

  it('never emits the env id on its own, with or without a map entry present', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'lonely-env-value';
    assert.strictEqual(resolveSessionId(null, { getAncestry: () => ({ harnessPid: null, pidStart: null }) }), null);
    seedMap(5106, { pid: 5106, pid_start: 'START', session_id: 'lonely-env-value' });
    assert.strictEqual(
      resolveSessionId(null, { getAncestry: () => ({ harnessPid: 5106, pidStart: 'DIFFERENT' }) }),
      null,
    );
  });
});

describe('isTestSession', () => {
  const cases = [
    ['smoke-test', true],
    ['smoke-2', true],
    ['smoke-compact-test', true],
    ['live-verify', true],
    ['smoke-anything-else', true],
    ['SMOKE-CAPS-TOO', true],
    ['test-run-42', true],
    ['test_underscore', true],
    ['fake-session-abc', true],
    ['sess-real-abc123', false],
    ['human-1', false],
    ['contest-planning', false, 'must not match "test" as a substring, only as the prefixed word'],
    [null, false],
    ['', false],
  ];

  it('matches the smoke/test/fake naming convention and the historical literals, and nothing else', () => {
    for (const [session, expected] of cases) {
      assert.strictEqual(isTestSession(session), expected, `isTestSession(${JSON.stringify(session)})`);
    }
  });

  it('does not match "test" or "fake" as a mid-string substring', () => {
    assert.strictEqual(isTestSession('a-testament-to-something'), false);
    assert.strictEqual(isTestSession('defaketh-session'), false);
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

  it('stores the given event id, and defaults it to NULL', () => {
    const db = getDb();
    logRetrieval({ surface: 'kb_read', session: 'sess-evt', eventId: 'evt-123', query: 'with-event' });
    logRetrieval({ surface: 'kb_read', session: 'sess-evt', query: 'without-event' });
    assert.strictEqual(
      db.prepare("SELECT event_id FROM retrievals WHERE query = 'with-event'").get().event_id,
      'evt-123',
    );
    assert.strictEqual(
      db.prepare("SELECT event_id FROM retrievals WHERE query = 'without-event'").get().event_id,
      null,
    );
  });

  it('computes is_test from the session id at write time', () => {
    const db = getDb();
    logRetrieval({ surface: 'kb_read', session: 'smoke-test', query: 'is-test-smoke' });
    logRetrieval({ surface: 'kb_read', session: 'sess-real-42', query: 'is-test-real' });
    logRetrieval({ surface: 'kb_read', session: null, query: 'is-test-null-session' });
    assert.strictEqual(db.prepare("SELECT is_test FROM retrievals WHERE query = 'is-test-smoke'").get().is_test, 1);
    assert.strictEqual(db.prepare("SELECT is_test FROM retrievals WHERE query = 'is-test-real'").get().is_test, 0);
    assert.strictEqual(db.prepare("SELECT is_test FROM retrievals WHERE query = 'is-test-null-session'").get().is_test, 0);
  });

  it('snapshots the document version when the retrieval schema has the column', () => {
    const db = getDb();
    const columns = db.prepare('PRAGMA table_info(retrievals)').all().map(c => c.name);
    if (!columns.includes('doc_version')) db.exec('ALTER TABLE retrievals ADD COLUMN doc_version TEXT');
    const docId = db.prepare(`INSERT INTO documents (title, content, doc_type) VALUES ('versioned', 'x', 'note')`).run().lastInsertRowid;
    db.prepare("INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type) VALUES ('versioned.md', 'hash-v1', ?, 'versioned', 'note')")
      .run(docId);

    logRetrieval({ docId, surface: 'kb_read', query: 'version snapshot', session: 'sess-version' });
    db.prepare('UPDATE vault_files SET content_hash = ? WHERE document_id = ?').run('hash-v2', docId);

    const row = db.prepare("SELECT doc_version FROM retrievals WHERE query = 'version snapshot'").get();
    assert.strictEqual(row.doc_version, 'hash-v1');
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
      'rest_read', 'rest_search', 'rest_search_smart', 'rest_context', 'cli_search', 'rediscovery',
    ]);
  });

  it('every push surface is a known surface', () => {
    for (const s of PUSH_SURFACES) assert.ok(SURFACES.includes(s), `${s} missing from SURFACES`);
  });

  it('rediscovery is a known surface but neither a push nor a read surface', () => {
    assert.ok(SURFACES.includes('rediscovery'));
    assert.ok(!PUSH_SURFACES.includes('rediscovery'));
    assert.ok(!READ_SURFACES.includes('rediscovery'));
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

  it('stamps the same event id on every row a single call produces, including a miss row', () => {
    const db = getDb();
    const ids = makeDocs(db, 3);
    logRetrievalResults({ results: ids.map(id => ({ id })), surface: 'hint', query: 'shared-event', eventId: 'evt-shared' });
    const rows = db.prepare("SELECT event_id FROM retrievals WHERE surface = 'hint' AND query = 'shared-event'").all();
    assert.deepStrictEqual(rows.map(r => r.event_id), ['evt-shared', 'evt-shared', 'evt-shared']);

    logRetrievalResults({ results: [], surface: 'hint', query: 'shared-event-miss', eventId: 'evt-miss' });
    const missRow = db.prepare("SELECT event_id FROM retrievals WHERE surface = 'hint' AND query = 'shared-event-miss'").get();
    assert.strictEqual(missRow.event_id, 'evt-miss');
  });
});

// hook-fastpath.test.js covers this at the compute-function level (a hint
// still prints when its log write is dropped); this is the narrower claim —
// the write itself fails fast rather than blocking out the connection's
// normal busy_timeout — isolated from everything else logRetrieval does.
describe('fastWrite: busy-tolerance for the CLI hook fallback path', () => {
  // A second, independent connection to the same file holding the sole
  // writer lock — the shape of "a long writer" the daemon or another hook
  // process would be in production. BEGIN IMMEDIATE claims it up front
  // rather than racing better-sqlite3's implicit lock acquisition.
  function withWriteLockHeld(fn) {
    const blocker = new Database(DB_PATH);
    blocker.pragma('journal_mode = WAL');
    blocker.exec('BEGIN IMMEDIATE');
    try {
      return fn();
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
  }

  it('drops the write instead of blocking the connection\'s default busy_timeout', () => {
    withWriteLockHeld(() => {
      const started = Date.now();
      logRetrieval({ surface: 'hint', query: 'fastwrite-busy-probe', fastWrite: true });
      const elapsed = Date.now() - started;
      // Comfortably above the ~100ms fast-write budget and comfortably below
      // the connection's normal 5000ms default — proves this took the short
      // path, not the long one, without pinning an exact number.
      assert.ok(elapsed < 1000, `expected the fast-write path to fail well under 1s, took ${elapsed}ms`);
    });
    const row = getDb().prepare("SELECT * FROM retrievals WHERE query = 'fastwrite-busy-probe'").get();
    assert.strictEqual(row, undefined, 'a busy fast write must be dropped silently, not eventually written');
  });

  it('still blocks for the default budget when fastWrite is not set (the daemon-path contract)', () => {
    // Not exercised end to end here (5s is too slow to pay in this suite) —
    // asserted structurally instead: the pragma this test reads back is the
    // one logRetrieval restores in its `finally`, so a regression that skips
    // the restore (or restores the wrong value) fails this without a 5s wait.
    logRetrieval({ surface: 'hint', query: 'fastwrite-default-probe', fastWrite: false });
    assert.strictEqual(getDb().pragma('busy_timeout', { simple: true }), DEFAULT_BUSY_TIMEOUT_MS);
  });

  it('restores the connection\'s default busy_timeout after a fast write, whether or not it was busy', () => {
    logRetrieval({ surface: 'hint', query: 'fastwrite-restore-probe', fastWrite: true });
    assert.strictEqual(getDb().pragma('busy_timeout', { simple: true }), DEFAULT_BUSY_TIMEOUT_MS);

    withWriteLockHeld(() => {
      logRetrieval({ surface: 'hint', query: 'fastwrite-restore-after-busy-probe', fastWrite: true });
    });
    assert.strictEqual(getDb().pragma('busy_timeout', { simple: true }), DEFAULT_BUSY_TIMEOUT_MS);
  });
});

// Which client a read came from. The session id has a map file behind it and
// can go stale; the agent cannot — it is read straight off the same ancestry
// walk, or handed in by a hook that already knows.
describe('resolveAgent', () => {
  it('names the agent the ancestry walk found', () => {
    assert.strictEqual(resolveAgent({ getAncestry: () => ({ harnessPid: 10, pidStart: 'S', agent: AGENT.CODEX }) }), AGENT.CODEX);
    assert.strictEqual(resolveAgent({ getAncestry: () => ({ harnessPid: 10, pidStart: 'S', agent: AGENT.CLAUDE }) }), AGENT.CLAUDE);
  });

  it('is null when the walk found no harness at all — never a default of claude', () => {
    assert.strictEqual(resolveAgent({ getAncestry: () => ({ harnessPid: null, pidStart: null, agent: null }) }), null);
  });
});

// The resident daemon is a launchd child: its own ancestry walk names launchd
// and nothing else, so every MCP-surface row it wrote came out session=NULL,
// agent=NULL. The identity arrives per connection instead (the shim's hello
// line) and is bound around each tool call through this store.
describe('callIdentity', () => {
  const identity = { harnessPid: 77001, pidStart: 'START-77001', agent: AGENT.CODEX };

  it('overrides the process ancestry for both the session and the agent', () => {
    seedMap(77001, { pid: 77001, pid_start: 'START-77001', session_id: 'sess-als-bound' });
    callIdentity.run(identity, () => {
      assert.strictEqual(resolveSessionId(), 'sess-als-bound');
      assert.strictEqual(resolveAgent(), AGENT.CODEX);
    });
  });

  it('still verifies pid_start against the map — a bound identity is not a bypass', () => {
    seedMap(77002, { pid: 77002, pid_start: 'START-OLD', session_id: 'sess-als-stale' });
    callIdentity.run({ harnessPid: 77002, pidStart: 'START-NEW', agent: AGENT.CLAUDE }, () => {
      assert.strictEqual(resolveSessionId(), null);
      assert.strictEqual(resolveAgent(), AGENT.CLAUDE);
    });
  });

  it('survives awaits inside the call — a handler resolves the same identity after I/O', async () => {
    seedMap(77003, { pid: 77003, pid_start: 'START-77003', session_id: 'sess-als-async' });
    await callIdentity.run({ harnessPid: 77003, pidStart: 'START-77003', agent: AGENT.CLAUDE }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.strictEqual(resolveSessionId(), 'sess-als-async');
      assert.strictEqual(resolveAgent(), AGENT.CLAUDE);
    });
  });

  it('does not leak outside the run — an unbound caller falls back to the process walk', () => {
    seedMap(77004, { pid: 77004, pid_start: 'START-77004', session_id: 'sess-als-leak' });
    callIdentity.run({ harnessPid: 77004, pidStart: 'START-77004', agent: AGENT.CODEX }, () => {
      assert.strictEqual(resolveSessionId(), 'sess-als-leak');
    });
    assert.notStrictEqual(resolveSessionId(), 'sess-als-leak');
  });

  it('stamps the bound identity onto a row logged with no explicit session or agent', () => {
    seedMap(77005, { pid: 77005, pid_start: 'START-77005', session_id: 'sess-als-logged' });
    callIdentity.run({ harnessPid: 77005, pidStart: 'START-77005', agent: AGENT.CODEX }, () => {
      logRetrievalResults({ results: [{ id: 1 }], surface: SURFACE.SEARCH, query: 'als-logged-query' });
    });
    const row = getDb().prepare('SELECT session, agent FROM retrievals WHERE query = ?').get('als-logged-query');
    assert.deepStrictEqual(row, { session: 'sess-als-logged', agent: AGENT.CODEX });
  });
});

describe('logRetrieval agent stamping', () => {
  const rowFor = (session) => getDb().prepare('SELECT agent FROM retrievals WHERE session = ?').get(session);

  it('stamps the agent the caller passed', () => {
    logRetrieval({ surface: SURFACE.BRIEFING, session: 'sess-agent-explicit-codex', agent: AGENT.CODEX });
    assert.strictEqual(rowFor('sess-agent-explicit-codex').agent, AGENT.CODEX);

    logRetrieval({ surface: SURFACE.BRIEFING, session: 'sess-agent-explicit-claude', agent: AGENT.CLAUDE });
    assert.strictEqual(rowFor('sess-agent-explicit-claude').agent, AGENT.CLAUDE);
  });

  it('carries the caller\'s agent through logRetrievalResults, on both the hit and the miss row', () => {
    logRetrievalResults({ results: [{ id: 1 }, { id: 2 }], surface: SURFACE.HINT, session: 'sess-agent-results', agent: AGENT.CODEX });
    const hits = getDb().prepare('SELECT agent FROM retrievals WHERE session = ?').all('sess-agent-results');
    assert.strictEqual(hits.length, 2);
    assert.ok(hits.every(r => r.agent === AGENT.CODEX));

    logRetrievalResults({ results: [], surface: SURFACE.HINT, session: 'sess-agent-results-miss', agent: AGENT.CODEX });
    assert.strictEqual(rowFor('sess-agent-results-miss').agent, AGENT.CODEX);
  });
});
