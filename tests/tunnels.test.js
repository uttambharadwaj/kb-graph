import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { initSchema } from '../src/db.js';
import { tagNeighbors, tunnel, strongestTunnels, aliasCandidatePair } from '../src/tunnels.js';

function seed(db) {
  const doc = db.prepare(`INSERT INTO documents (title, content, doc_type, tags, created_at) VALUES (?, ?, 'note', ?, ?)`);
  // 'widget' appended to every doc's content -> mentioned in every tagged doc (df == N),
  // so the TF-IDF strength drives it out even though it's a valid both-sides candidate.
  // agent-a <-> pipeline bridge docs (2), plus singles
  doc.run('agent deploy broke pipeline', 'the flaky-store timeout hit the deploy job widget', 'agent-a, pipeline', '2026-07-01');
  doc.run('pipeline retries for agent runs', 'flaky-store again in retry path widget', 'agent-a, pipeline', '2026-07-02');
  doc.run('agent memory notes', 'agent-a internals widget', 'agent-a', '2026-07-03');
  doc.run('pipeline cache', 'cache sizing widget', 'pipeline', '2026-07-03');
  doc.run('storage design', 'flaky-store rework plan widget', 'storage', '2026-07-04');
  doc.run('CDP handshake', 'cdp session notes widget', 'CDP', '2026-07-04');           // case variant
  doc.run('cdp reconnect', 'reconnect logic widget', 'cdp, pipeline', '2026-07-05');
  const ent = db.prepare(`INSERT INTO entities (id, name) VALUES (?, ?)`);
  const fact = db.prepare(`INSERT INTO facts (id, subject, predicate, object) VALUES (?, ?, ?, ?)`);
  ent.run('flaky-store', 'flaky-store');
  ent.run('other', 'other-thing');   // 1 fact -> excluded from candidates
  ent.run('extra', 'extra-ent');     // mentioned nowhere -> never bridges
  ent.run('store', 'store');         // 2 facts; 'store' only occurs inside 'flaky-store' -> boundary must block it
  ent.run('widget', 'widget');       // 2 facts; mentioned in every doc -> idf 0 -> excluded by strength
  // fact counts: flaky-store 2, store 2, widget 2, extra 5, other 1
  fact.run('f1', 'flaky-store', 'status', 'other');
  fact.run('f2', 'flaky-store', 'blocks', 'extra');
  fact.run('f3', 'store', 'status', 'extra');
  fact.run('f4', 'store', 'blocks', 'extra');
  fact.run('f5', 'widget', 'status', 'extra');
  fact.run('f6', 'widget', 'blocks', 'extra');
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

  it('corpus-common entity is downweighted out of bridge_entities', () => {
    const t = tunnel(db, 'agent-a', 'pipeline');
    const names = t.bridge_entities.map(e => e.name);
    // 'widget' qualifies as a candidate mentioned on both sides, but df == N (every tagged doc)
    // -> idf 0 -> strength 0 -> excluded. 'flaky-store' stays specific and bridges.
    assert.ok(!names.includes('widget'), 'corpus-common widget must be downweighted out');
    const fs = t.bridge_entities.find(e => e.name === 'flaky-store');
    assert.ok(fs, 'flaky-store should still bridge');
    assert.ok(fs.strength > 0, 'flaky-store keeps positive strength');
    // N=7 tagged docs, df=3 (d1,d2,d5), min(mentions_from=2, mentions_to=2)=2:
    // strength = round2(log2(1+2) * log2(7/3)) = round2(1.585 * 1.222) = 1.94
    assert.strictEqual(fs.doc_frequency, 3);
    assert.strictEqual(fs.mentions_from, 2);
    assert.strictEqual(fs.mentions_to, 2);
    assert.strictEqual(fs.strength, 1.94);
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
    // decoy is tagged (N=3) but doesn't regex-match, so df=2 < N -> idf > 0 -> still bridges
    assert.strictEqual(e.doc_frequency, 2);
    assert.ok(e.strength > 0, 'node.js keeps positive strength (df < N)');
    db2.close();
  });
});
