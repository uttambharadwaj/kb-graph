// tmp-kb.js first: runTagsCli's alias path writes through the module-level
// getDb() handle, which opens the real DB unless KB_DIR is redirected first.
import './helpers/tmp-kb.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { initSchema, getDb } from '../src/db.js';
import { tagsReport, runTagsCli } from '../src/cli/tags-cli.js';

function seed(db) {
  const doc = db.prepare(`INSERT INTO documents (title, content, doc_type, tags) VALUES (?, ?, 'note', ?)`);
  doc.run('a', 'x', 'CDP, profile');        // CDP case variant + profile
  doc.run('b', 'y', 'cdp, profiles');       // cdp lowercase + profiles (plural of profile)
  doc.run('c', 'z', 'node, nodes');         // node/nodes: node is aliased below
  db.prepare('INSERT INTO tag_aliases (alias, canonical) VALUES (?, ?)').run('node', 'nodes');
}

describe('tagsReport', () => {
  let db;
  before(() => { db = new Database(':memory:'); initSchema(db); seed(db); });
  after(() => db.close());

  it('detects case variants (folded at query time)', () => {
    const r = tagsReport(db);
    const cdp = r.caseVariants.find(v => v.tag === 'cdp');
    assert.ok(cdp, 'cdp case variant detected');
    assert.deepStrictEqual([...cdp.variants].sort(), ['CDP', 'cdp']);
  });

  it('detects plural alias-candidate pair', () => {
    const r = tagsReport(db);
    assert.ok(r.candidates.some(c =>
      (c.a === 'profile' && c.b === 'profiles') || (c.a === 'profiles' && c.b === 'profile')));
  });

  it('excludes already-aliased tags from candidates', () => {
    const r = tagsReport(db);
    // 'node' is aliased -> excluded from candidate generation (else node/nodes would pair)
    assert.ok(!r.candidates.some(c => c.a === 'node' || c.b === 'node'));
    assert.ok(r.aliases.some(a => a.alias === 'node' && a.canonical === 'nodes'));
  });
});

describe('runTagsCli alias upsert', () => {
  it('upserts the alias lowercased through getDb()', () => {
    runTagsCli(['alias', 'K8S', 'Kubernetes']);
    const row = getDb().prepare('SELECT canonical FROM tag_aliases WHERE alias = ?').get('k8s');
    assert.strictEqual(row.canonical, 'kubernetes');
  });
});
