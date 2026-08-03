import './helpers/tmp-kb.js'; // MUST be first — redirects the DB to a temp dir
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import {
  initSchema,
  getDb,
  insertDocument,
  getDocument,
  searchDocuments,
  listDocuments,
  supersedeDocument,
  supersedeCandidates,
} from '../src/db.js';
import { addFact, invalidateFact } from '../src/facts.js';
import { getToolDefinitions } from '../src/tools.js';

describe('supersession migration', () => {
  it('adds the three columns and is idempotent (run initSchema twice)', () => {
    const db = new Database(':memory:');
    initSchema(db);
    initSchema(db); // must not throw on a DB that already has the columns
    const cols = db.prepare('PRAGMA table_info(documents)').all().map(c => c.name);
    assert.ok(cols.includes('superseded_at'), 'superseded_at column missing');
    assert.ok(cols.includes('superseded_by'), 'superseded_by column missing');
    assert.ok(cols.includes('superseded_reason'), 'superseded_reason column missing');
    db.close();
  });
});

describe('supersedeDocument', () => {
  let target, replacement;
  before(() => {
    target = insertDocument({ title: 'SD target', content: 'sdterm one', doc_type: 'text', tags: '' }).id;
    replacement = insertDocument({ title: 'SD replacement', content: 'sdterm two', doc_type: 'text', tags: '' }).id;
  });

  it('returns null for an unknown id', () => {
    assert.strictEqual(supersedeDocument(999999, {}), null);
  });

  it('sets superseded_at/by/reason', () => {
    const row = supersedeDocument(target, { replacementId: replacement, reason: 'replaced' });
    assert.ok(row.superseded_at, 'superseded_at should be set');
    assert.strictEqual(row.superseded_by, replacement);
    assert.strictEqual(row.superseded_reason, 'replaced');
  });

  it('unsets all three fields', () => {
    const row = supersedeDocument(target, { unset: true });
    assert.strictEqual(row.superseded_at, null);
    assert.strictEqual(row.superseded_by, null);
    assert.strictEqual(row.superseded_reason, null);
  });

  it('rejects self-supersession', () => {
    assert.throws(() => supersedeDocument(target, { replacementId: target }), /itself/i);
  });

  it('errors on a dangling replacement id', () => {
    assert.throws(() => supersedeDocument(target, { replacementId: 888888 }), /not found/i);
  });
});

describe('recall filters exclude superseded', () => {
  let keepId, dropId;
  before(() => {
    keepId = insertDocument({ title: 'RCF keep', content: 'rcfterm alpha', doc_type: 'text', tags: 'rcftag' }).id;
    dropId = insertDocument({ title: 'RCF drop', content: 'rcfterm beta', doc_type: 'text', tags: 'rcftag' }).id;
    supersedeDocument(dropId, { reason: 'retired' });
  });

  it('searchDocuments hides it; includeSuperseded restores it', () => {
    const ids = searchDocuments('rcfterm').map(r => r.id);
    assert.ok(ids.includes(keepId), 'live doc should be found');
    assert.ok(!ids.includes(dropId), 'superseded doc must be absent from search');

    const all = searchDocuments('rcfterm', 20, { includeSuperseded: true }).map(r => r.id);
    assert.ok(all.includes(dropId), 'includeSuperseded:true must restore it');
  });

  it('listDocuments hides it; includeSuperseded restores it', () => {
    const ids = listDocuments({ tag: 'rcftag', limit: 100 }).map(r => r.id);
    assert.ok(ids.includes(keepId), 'live doc should be listed');
    assert.ok(!ids.includes(dropId), 'superseded doc must be absent from list');

    const all = listDocuments({ tag: 'rcftag', limit: 100, includeSuperseded: true }).map(r => r.id);
    assert.ok(all.includes(dropId), 'includeSuperseded:true must restore it');
  });

  it('getDocument still returns a superseded doc (path preserved)', () => {
    const doc = getDocument(dropId);
    assert.ok(doc, 'getDocument must still return the row');
    assert.ok(doc.superseded_at, 'the row carries superseded_at for the kb_read banner');
  });
});

describe('embeddings recall filter (SQL level, no model)', () => {
  it('the semantic JOIN excludes a superseded doc', () => {
    const db = getDb();
    const liveId = insertDocument({ title: 'EMB live', content: 'embterm', doc_type: 'text', tags: '' }).id;
    const deadId = insertDocument({ title: 'EMB dead', content: 'embterm', doc_type: 'text', tags: '' }).id;
    const buf = Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer);
    const ins = db.prepare(
      'INSERT INTO embeddings (document_id, vault_path, chunk_index, chunk_text, embedding, dimensions) VALUES (?, ?, 0, ?, ?, 3)'
    );
    ins.run(liveId, 'live.md', 'x', buf);
    ins.run(deadId, 'dead.md', 'y', buf);
    supersedeDocument(deadId, { reason: 'retired' });

    // Mirror semanticSearch/similarDocs' JOIN + the superseded filter clause.
    const ids = db.prepare(`
      SELECT e.document_id FROM embeddings e
      JOIN documents d ON d.id = e.document_id
      WHERE d.superseded_at IS NULL
    `).all().map(r => r.document_id);
    assert.ok(ids.includes(liveId), 'live embedded doc should remain');
    assert.ok(!ids.includes(deadId), 'superseded embedded doc must be filtered out');
  });
});

describe('supersedeCandidates', () => {
  it('proposes a stale note and NEVER mutates superseded_at', () => {
    const db = getDb();

    // Fact graph: widgetX status was "beta", retired in favor of "GA".
    addFact('widgetX', 'status', 'beta', { validFrom: '2026-01-01' });
    invalidateFact('widgetX', 'status', 'beta', { ended: '2026-06-01' });
    addFact('widgetX', 'status', 'GA', { validFrom: '2026-06-01' });

    const staleNote = insertDocument({ title: 'widgetX overview', content: 'widgetX is in beta', doc_type: 'text', tags: 'widgetx' }).id;
    const newerNote = insertDocument({ title: 'widgetX overview updated', content: 'widgetX is now GA', doc_type: 'text', tags: 'widgetx' }).id;
    // Force deterministic ordering — CURRENT_TIMESTAMP is second-granular.
    db.prepare('UPDATE documents SET created_at = ? WHERE id = ?').run('2026-01-02 00:00:00', staleNote);
    db.prepare('UPDATE documents SET created_at = ? WHERE id = ?').run('2026-07-01 00:00:00', newerNote);

    const candidates = supersedeCandidates({ limit: 20 });
    const mine = candidates.find(c => c.note_id === staleNote);
    assert.ok(mine, 'the stale note should surface as a candidate');
    assert.strictEqual(mine.suggested_replacement_id, newerNote, 'the newer note is the suggested replacement');

    // The whole point: a proposal, never a mutation.
    assert.strictEqual(getDocument(staleNote).superseded_at, null, 'candidate detection must not write superseded_at');
  });
});

describe('kb_supersede names what the pointer resolved to', () => {
  const supersede = () => getToolDefinitions().find(t => t.name === 'kb_supersede');

  it('echoes the replacement title, so a wrong-but-existing id is visible', async () => {
    const stale = insertDocument({ title: 'the old reading', content: 'a', doc_type: 'lesson' });
    const unrelated = insertDocument({ title: 'something else entirely', content: 'b', doc_type: 'lesson' });

    const text = (await supersede().handler({ id: stale.id, replacement_id: unrelated.id })).content[0].text;
    // The incident this guards: an id guessed one ahead of the last write, which
    // existed and belonged to someone else. Only the title says so.
    assert.match(text, /something else entirely/);
    assert.match(text, new RegExp(`#${unrelated.id}`));
  });

  it('says nothing about a replacement when there is none', async () => {
    const orphan = insertDocument({ title: 'wrong, and nothing replaces it', content: 'c', doc_type: 'lesson' });
    const text = (await supersede().handler({ id: orphan.id, reason: 'measured and false' })).content[0].text;
    assert.match(text, /superseded/);
    assert.doesNotMatch(text, / by #/);
  });

  it('still refuses a replacement id that does not exist', async () => {
    const doc = insertDocument({ title: 'target', content: 'd', doc_type: 'lesson' });
    const result = await supersede().handler({ id: doc.id, replacement_id: 999999 });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /999999 not found/);
  });
});
