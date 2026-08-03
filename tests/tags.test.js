// Must be first: insertDocument writes through the module-level getDb() handle,
// which opens the real DB path unless KB_DIR is redirected before src/db.js loads.
import './helpers/tmp-kb.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { initSchema, insertDocument, updateDocument, updateDocumentFull, listDocuments, searchDocuments, tagCounts, identityBoost, getDb } from '../src/db.js';
import { splitTags, normalizeTagString, getTagAliasMap, canonicalTag, tagSpellings } from '../src/tags.js';

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

  it('updateDocumentFull stores normalized tags', () => {
    const { id } = insertDocument({ title: 't3', content: 'c3', doc_type: 'note', tags: 'infra' });
    updateDocumentFull(id, { title: 't3', content: 'c3', doc_type: 'note', tags: ' AUTH , auth,Sessions ' });
    const row = getDb().prepare('SELECT tags FROM documents WHERE id = ?').get(id);
    assert.strictEqual(row.tags, 'auth, sessions');
  });
});

describe('tag filtering matches whole tags', () => {
  // "auth" sits inside "oauth", so the substring filter this replaced returned
  // every oauth note to a caller who asked for auth.
  const ids = {};
  before(() => {
    ids.auth = insertDocument({ title: 'token refresh loop', content: 'shared body text', doc_type: 'lesson', tags: 'auth, infra' }).id;
    ids.oauth = insertDocument({ title: 'consent screen copy', content: 'shared body text', doc_type: 'lesson', tags: 'oauth, frontend' }).id;
    ids.both = insertDocument({ title: 'token refresh consent', content: 'shared body text', doc_type: 'lesson', tags: 'auth, oauth' }).id;
  });

  it('kb_list returns only notes carrying the tag', () => {
    const found = listDocuments({ tag: 'auth', limit: 50 }).map(d => d.id);
    assert.ok(found.includes(ids.auth) && found.includes(ids.both));
    assert.ok(!found.includes(ids.oauth), 'a note tagged "oauth" is not tagged "auth"');
  });

  it('kb_search returns only notes carrying the tag', () => {
    const found = searchDocuments('shared body text', 20, { tags: 'auth' }).map(d => d.id);
    assert.ok(found.includes(ids.auth));
    assert.ok(!found.includes(ids.oauth));
  });

  it('comma-separated tags are required together, in any order', () => {
    for (const spec of ['auth, oauth', 'oauth,auth']) {
      const found = listDocuments({ tag: spec, limit: 50 }).map(d => d.id);
      assert.deepStrictEqual(found, [ids.both], spec);
    }
  });

  it('the search rank boost is not awarded for a substring of a tag', () => {
    assert.strictEqual(identityBoost({ title: 'x', tags: 'auth' }, ['auth']), 10);
    assert.strictEqual(identityBoost({ title: 'x', tags: 'oauth' }, ['auth']), 0);
    assert.strictEqual(identityBoost({ title: 'auth notes', tags: 'auth, infra' }, ['auth', 'infra']), 40);
    assert.strictEqual(identityBoost({ title: null, tags: null }, ['auth']), 0);
  });

  it('an unknown tag returns nothing rather than everything', () => {
    assert.deepStrictEqual(listDocuments({ tag: 'nosuchtag', limit: 50 }), []);
  });

  it('no tag filter leaves the result set alone', () => {
    const all = listDocuments({ limit: 50 }).map(d => d.id);
    for (const id of Object.values(ids)) assert.ok(all.includes(id));
  });
});

describe('tag filtering follows aliases', () => {
  let id;
  before(() => {
    getDb().prepare('INSERT OR REPLACE INTO tag_aliases (alias, canonical) VALUES (?, ?)').run('next-js', 'nextjs');
    id = insertDocument({ title: 'app router migration', content: 'framework notes', doc_type: 'lesson', tags: 'next-js' }).id;
  });

  it('every spelling of a tag reaches the notes stored under any of them', () => {
    for (const spelling of ['next-js', 'nextjs']) {
      assert.deepStrictEqual(listDocuments({ tag: spelling, limit: 50 }).map(d => d.id), [id], spelling);
    }
  });

  it('tagSpellings returns the canonical form and its aliases', () => {
    const map = getTagAliasMap(getDb());
    assert.deepStrictEqual(tagSpellings('next-js', map).sort(), ['next-js', 'nextjs']);
    assert.deepStrictEqual(tagSpellings('widget', map), ['widget']);
    assert.deepStrictEqual(tagSpellings('widget', null), ['widget']);
  });
});

describe('tagCounts', () => {
  it('counts notes per tag, not per tag set', () => {
    // Two notes share one tag and differ in the other, so grouping on the
    // stored string reports two rows of 1 where the answer is one row of 2.
    insertDocument({ title: 'c1', content: 'x', doc_type: 'lesson', tags: 'shared-tag, only-here' });
    insertDocument({ title: 'c2', content: 'x', doc_type: 'lesson', tags: 'shared-tag, elsewhere' });
    const counts = new Map(tagCounts(200).map(t => [t.tag, t.count]));
    assert.strictEqual(counts.get('shared-tag'), 2);
    assert.strictEqual(counts.get('only-here'), 1);
  });

  it('folds aliases into the canonical tag', () => {
    insertDocument({ title: 'second framework note', content: 'x', doc_type: 'lesson', tags: 'nextjs' });
    const counts = new Map(tagCounts(50).map(t => [t.tag, t.count]));
    assert.strictEqual(counts.get('nextjs'), 2);
    assert.strictEqual(counts.get('next-js'), undefined);
  });
});
