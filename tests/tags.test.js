// Must be first: insertDocument writes through the module-level getDb() handle,
// which opens the real DB path unless KB_DIR is redirected before src/db.js loads.
import './helpers/tmp-kb.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { initSchema, insertDocument, updateDocument, getDb } from '../src/db.js';
import { splitTags, normalizeTagString, getTagAliasMap, canonicalTag } from '../src/tags.js';

describe('splitTags / normalizeTagString', () => {
  it('lowercases, trims, dedupes, drops empties', () => {
    assert.deepStrictEqual(splitTags(' CDP, cdp , infra,, Infra '), ['cdp', 'infra']);
    assert.strictEqual(normalizeTagString('B, a ,B'), 'b, a');
    assert.deepStrictEqual(splitTags(''), []);
    assert.deepStrictEqual(splitTags(null), []);
  });
});

describe('tag_aliases', () => {
  let db;
  before(() => { db = new Database(':memory:'); initSchema(db); });
  after(() => db.close());

  it('table exists and aliases resolve', () => {
    db.prepare('INSERT INTO tag_aliases (alias, canonical) VALUES (?, ?)').run('db', 'database-layer');
    const map = getTagAliasMap(db);
    assert.strictEqual(canonicalTag('Db', map), 'database-layer');
    assert.strictEqual(canonicalTag('widget', map), 'widget');
    assert.strictEqual(canonicalTag(' WIDGET ', map), 'widget');
  });
});

describe('write-time tag normalization', () => {
  // insertDocument takes a single object and writes through getDb() (no db param),
  // returning { id, ... } — so we read back through the same shared handle.
  it('insertDocument stores normalized tags', () => {
    const { id } = insertDocument({ title: 't', content: 'c', doc_type: 'note', tags: ' CDP, Infra ,cdp' });
    const row = getDb().prepare('SELECT tags FROM documents WHERE id = ?').get(id);
    assert.strictEqual(row.tags, 'cdp, infra');
  });

  it('updateDocument stores normalized tags', () => {
    const { id } = insertDocument({ title: 't2', content: 'c2', doc_type: 'note', tags: 'infra' });
    updateDocument(id, { title: 't2', tags: ' Backend, AUTH ,backend, ' });
    const row = getDb().prepare('SELECT tags FROM documents WHERE id = ?').get(id);
    assert.strictEqual(row.tags, 'backend, auth');
  });
});
