import './helpers/tmp-kb.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { getDb } from '../src/db.js';
import { SURFACES, logRetrieval, resolveSessionId } from '../src/retrieval.js';

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

  it('SURFACES lists exactly the five instrumented read-path chokepoints', () => {
    assert.deepStrictEqual(SURFACES, ['kb_read', 'kb_search', 'kb_context', 'briefing', 'hint']);
  });
});
