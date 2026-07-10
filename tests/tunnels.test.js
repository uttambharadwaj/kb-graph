import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { initSchema } from '../src/db.js';
import { tagNeighbors, tunnel, strongestTunnels, aliasCandidatePair } from '../src/tunnels.js';

function seed(db) {
  const doc = db.prepare(`INSERT INTO documents (title, content, doc_type, tags, created_at) VALUES (?, ?, 'note', ?, ?)`);
  // agent-a <-> pipeline bridge docs (2), plus singles
  doc.run('agent deploy broke pipeline', 'the flaky-store timeout hit the deploy job', 'agent-a, pipeline', '2026-07-01');
  doc.run('pipeline retries for agent runs', 'flaky-store again in retry path', 'agent-a, pipeline', '2026-07-02');
  doc.run('agent memory notes', 'agent-a internals', 'agent-a', '2026-07-03');
  doc.run('pipeline cache', 'cache sizing', 'pipeline', '2026-07-03');
  doc.run('storage design', 'flaky-store rework plan', 'storage', '2026-07-04');
  doc.run('CDP handshake', 'cdp session notes', 'CDP', '2026-07-04');           // case variant
  doc.run('cdp reconnect', 'reconnect logic', 'cdp, pipeline', '2026-07-05');
  const ent = db.prepare(`INSERT INTO entities (id, name) VALUES (?, ?)`);
  const fact = db.prepare(`INSERT INTO facts (id, subject, predicate, object) VALUES (?, ?, ?, ?)`);
  ent.run('flaky-store', 'flaky-store');
  ent.run('other', 'other-thing');   // 1 fact -> excluded from candidates
  ent.run('extra', 'extra-ent');     // mentioned nowhere -> never bridges
  ent.run('store', 'store');         // 2 facts; 'store' only occurs inside 'flaky-store' -> boundary must block it
  // fact counts: flaky-store 2, store 2, extra 3, other 1
  fact.run('f1', 'flaky-store', 'status', 'other');
  fact.run('f2', 'flaky-store', 'blocks', 'extra');
  fact.run('f3', 'store', 'status', 'extra');
  fact.run('f4', 'store', 'blocks', 'extra');
}

describe('tunnels', () => {
  let db;
  before(() => { db = new Database(':memory:'); initSchema(db); seed(db); });
  after(() => db.close());

  it('tagNeighbors ranks co-occurring tags', () => {
    const n = tagNeighbors(db, 'agent-a', { minCount: 1 });
    assert.strictEqual(n[0].tag, 'pipeline');
    assert.strictEqual(n[0].cooccur, 2);
    // N=7 tagged docs, nA=3, cooccur=2, totals(pipeline)=4:
    // lift = round2(2*7/(3*4)) = 1.17; score = round2(1.17 * log2(3)) = 1.85
    assert.strictEqual(n[0].lift, 1.17);
    assert.strictEqual(n[0].score, 1.85);
  });

  it('tunnel returns bridge docs newest-first and bridge entities with boundary-safe mentions', () => {
    const t = tunnel(db, 'agent-a', 'pipeline');
    assert.strictEqual(t.stats.overlap, 2);
    assert.strictEqual(t.bridge_docs[0].title, 'pipeline retries for agent runs');
    const names = t.bridge_entities.map(e => e.name);
    assert.ok(names.includes('flaky-store'));      // mentioned in both domains' docs
    assert.ok(!names.includes('other-thing'));     // only 1 fact -> not a candidate
    assert.ok(!names.includes('store'));           // candidate, but only occurs inside 'flaky-store' -> boundary-blocked
  });

  it('case-variant tags fold together at query time', () => {
    const t = tunnel(db, 'CDP', 'pipeline');
    assert.strictEqual(t.from, 'cdp');
    assert.strictEqual(t.stats.docs_from, 2);      // 'CDP' doc + 'cdp, pipeline' doc
  });

  it('tag aliases fold at query time', () => {
    db.prepare('INSERT INTO tag_aliases (alias, canonical) VALUES (?, ?)').run('storage', 'pipeline');
    const t = tunnel(db, 'agent-a', 'storage');
    assert.strictEqual(t.to, 'pipeline');
    db.prepare('DELETE FROM tag_aliases').run();
  });

  it('strongestTunnels excludes alias-candidate pairs', () => {
    assert.ok(aliasCandidatePair('profile', 'profiles'));
    assert.ok(aliasCandidatePair('ci', 'ci-cd'));
    assert.ok(!aliasCandidatePair('api', 'infra'));
    const pairs = strongestTunnels(db, { minCount: 2 });
    assert.ok(pairs.some(p => (p.from === 'agent-a' && p.to === 'pipeline') || (p.from === 'pipeline' && p.to === 'agent-a')));
  });

  it('entities bridge domains with zero shared tags; boundary matching holds', () => {
    const t = tunnel(db, 'agent-a', 'storage');
    assert.strictEqual(t.stats.overlap, 0);
    // 'flaky-store' appears in storage doc and agent-a docs -> bridges without shared tags
    assert.ok(t.bridge_entities.some(e => e.name === 'flaky-store'));
    // 'store' passes the includes() prefilter (inside 'flaky-store') but the boundary regex must reject it
    assert.ok(!t.bridge_entities.some(e => e.name === 'store'));
  });

  it('regex metacharacters in entity names are escaped, not wildcards', () => {
    // Own DB: extra docs would shift the pinned lift/score values in the shared fixture.
    const db2 = new Database(':memory:');
    initSchema(db2);
    const doc = db2.prepare(`INSERT INTO documents (title, content, doc_type, tags, created_at) VALUES (?, ?, 'note', ?, ?)`);
    doc.run('runtime upgrade', 'bumped node.js to the new major', 'runtime', '2026-07-01');
    doc.run('runtime decoy', 'nodeXjs is not a real mention', 'runtime', '2026-07-02');
    doc.run('build tooling', 'node.js build flags', 'tooling', '2026-07-03');
    db2.prepare(`INSERT INTO entities (id, name) VALUES (?, ?)`).run('node-js', 'node.js');
    db2.prepare(`INSERT INTO entities (id, name) VALUES (?, ?)`).run('flag-set', 'flag-set');
    const fact = db2.prepare(`INSERT INTO facts (id, subject, predicate, object) VALUES (?, ?, ?, ?)`);
    fact.run('g1', 'node-js', 'status', 'flag-set');
    fact.run('g2', 'node-js', 'blocks', 'flag-set');
    const t = tunnel(db2, 'runtime', 'tooling');
    const e = t.bridge_entities.find(x => x.name === 'node.js');
    assert.ok(e, 'node.js should bridge runtime <-> tooling');
    // decoy doc's 'nodeXjs' must not count — the dot is escaped, not a wildcard
    assert.strictEqual(e.mentions_from, 1);
    assert.strictEqual(e.mentions_to, 1);
    db2.close();
  });
});
