import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Point the KB at a throwaway dir BEFORE importing anything that opens the DB.
process.env.KB_DIR = mkdtempSync(join(tmpdir(), 'kb-canon-'));

const { canonicalEntityId, entityKey, addFact, queryFact, invalidateFact, mergeEntity } = await import('../src/facts.js');
const { canonicalizeEntities, auditCanonicalEntities } = await import('../src/cli/canonicalize-entities.js');
const { getDb } = await import('../src/db.js');
const { getToolDefinitions } = await import('../src/tools.js');


// Rows as they look when they were written before the separator fold shipped:
// straight into the tables, under whatever spelling the extractor produced.
function legacyFact(subject, predicate, object, { validFrom = '2026-01-01', source = 'legacy' } = {}) {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO entities (id, name) VALUES (?, ?)').run(subject, subject);
  db.prepare('INSERT OR IGNORE INTO entities (id, name) VALUES (?, ?)').run(object, object);
  db.prepare('INSERT INTO facts (id, subject, predicate, object, valid_from, source) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`f_${subject}_${predicate}_${object}_${Math.random().toString(36).slice(2)}`, subject, predicate, object, validFrom, source);
}

const silently = (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
};
const run = opts => silently(() => canonicalizeEntities(opts));
const objectsOf = name => queryFact(name, { direction: 'outgoing' }).map(f => f.object).sort();

describe('canonicalEntityId', () => {
  it('is idempotent on everything, including inputs that fold to nothing', () => {
    const corpus = [
      '', ' ', '   ', '.', '..', '...', '-', '_', '--__--', '/', '//', './', '.-_ /', '\\',
      '/..//_/.///_/..\\', '/?#:@\\', '*', 'Auth-Service', ' auth-service ', '--auth--service--',
      'c#', 'c++', '.net', 'node.js', 'gpt-4.1', 'pr #3583', '日本語', 'ÉLAN', 'a\tb', 'a\nb',
      `${'A'.repeat(2000)}-${'B'.repeat(2000)}`,
    ];
    for (const s of corpus) {
      const once = canonicalEntityId(s);
      assert.equal(canonicalEntityId(once), once, `not idempotent: ${JSON.stringify(s)}`);
    }
  });

  it('folds every separator run, case and apostrophes onto one id', () => {
    const spellings = [
      'billing api gateway', 'billing-api-gateway', 'billing_api_gateway',
      'Billing Api Gateway', 'billing--api__gateway', ' billing api gateway ',
      'billing.api.gateway', 'billing/api/gateway', 'BILLING   API   GATEWAY',
    ];
    for (const s of spellings) assert.equal(canonicalEntityId(s), 'billing_api_gateway', s);
  });

  // Over-merging silently corrupts the graph; leaving one concept split is the
  // status quo. Every pair here is one the fold must refuse.
  it('keeps entities apart that only an unsafe fold would merge', () => {
    const apart = [['c', 'c#'], ['c', 'c++'], ['f', 'f#'], ['..', '...'], ['-', '_'],
      ['日本語', '中文'], ['élan', 'elan'], ['gpt41', 'gpt-4-1'], ['profile', 'profiles'],
      ['pr_#3583', 'pr-3583']];
    for (const [a, b] of apart) {
      assert.notEqual(canonicalEntityId(a), canonicalEntityId(b), `${a} and ${b} must not merge`);
    }
  });

  it('never returns the empty string for a name that has characters', () => {
    for (const s of ['.', '..', '...', '-', '_', '/', '--__--', '*']) {
      assert.ok(canonicalEntityId(s).length > 0, JSON.stringify(s));
    }
  });
});

describe('write-then-read round trip', () => {
  it('finds a fact written under one spelling under every other spelling', () => {
    addFact('auth service', 'uses', 'postgres 16', { validFrom: '2026-02-01' });
    for (const spelling of ['auth-service', 'auth_service', 'Auth Service', 'AUTH-SERVICE', 'auth.service']) {
      const objects = objectsOf(spelling);
      assert.deepEqual(objects, ['postgres 16'], `missed under ${spelling}`);
    }
  });

  it('lands a second spelling on the existing entity instead of minting a sibling', () => {
    addFact('Job-Runner', 'runs_on', 'ecs', { validFrom: '2026-02-01' });
    addFact('job runner', 'owns', 'sqs queue', { validFrom: '2026-02-02' });
    assert.deepEqual(objectsOf('job_runner'), ['ecs', 'sqs queue']);
    const ids = getDb().prepare("SELECT id FROM entities WHERE id LIKE '%job%runner%'").all().map(r => r.id);
    assert.deepEqual(ids, ['job_runner']);
  });
});

describe('kb entity-merge', () => {
  // The hand tool the partial-answer message points people at. It rewrites the
  // facts of the entity it folds, which is exactly how one triple ends up with
  // two live rows — a state addFact refuses to write.
  it('collapses the duplicate live rows its own rewrite creates', () => {
    addFact('alpha thing', 'deploys_to', 'prod-west', { validFrom: '2026-01-01', source: 'earlier' });
    addFact('beta thing', 'deploys_to', 'prod-west', { validFrom: '2026-02-01', source: 'later' });

    const res = mergeEntity('beta thing', 'alpha thing');
    assert.equal(res.duplicates_collapsed, 1);

    const live = queryFact('alpha thing', { direction: 'outgoing' }).filter(f => f.current);
    assert.equal(live.length, 1);
    assert.equal(live[0].valid_from, '2026-01-01');
    assert.equal(live[0].source, 'earlier');
    assert.deepEqual(auditCanonicalEntities().duplicate_live_triples, []);
  });

  it('leaves a retired row alone when the live one now matches it', () => {
    addFact('gamma thing', 'status', 'shipped', { validFrom: '2026-01-01' });
    invalidateFact('gamma thing', 'status', 'shipped', { ended: '2026-02-01' });
    addFact('delta thing', 'status', 'shipped', { validFrom: '2026-03-01' });

    mergeEntity('delta thing', 'gamma thing');
    const rows = queryFact('gamma thing', { direction: 'outgoing' });
    assert.deepEqual(rows.map(r => r.current).sort(), [false, true]);
  });
});

describe('canonicalize-entities migration', () => {
  // Both halves of the change are needed and in this order. Canonicalising the
  // read makes every spelling agree, but it agrees on the canonical id only —
  // rows still stored under an older spelling become unreachable, so the code
  // alone trades two partial answers for one. The back-fill is what makes the
  // answer whole.
  it('back-fills a concept split across spellings so both queries return one set', () => {
    legacyFact('billing-api-gateway', 'hosts', 'mcp-server');
    legacyFact('billing-api-gateway', 'stores', 'facts-table');
    legacyFact('billing_api_gateway', 'runs_on', 'node');
    legacyFact('Billing Api Gateway', 'owned_by', 'nobody');

    const spellings = ['billing api gateway', 'billing-api-gateway', 'billing_api_gateway'];
    const answers = () => spellings.map(objectsOf);
    for (const a of answers()) assert.deepEqual(a, ['node'], 'reads disagree before the back-fill');

    run({ apply: true });

    for (const a of answers()) {
      assert.deepEqual(a, ['facts-table', 'mcp-server', 'nobody', 'node']);
    }
  });

  // The window between shipping the code and running the back-fill is exactly
  // when a query looks complete and is not, so it has to announce the rows it
  // cannot reach.
  it('announces the stranded rows while the back-fill has not run', async () => {
    legacyFact('stranded-probe', 'uses', 'unreachable-thing');
    addFact('stranded probe', 'uses', 'reachable-thing', { validFrom: '2026-05-01' });

    const factQuery = getToolDefinitions().find(t => t.name === 'kb_fact_query');
    const body = JSON.parse((await factQuery.handler({ entity: 'stranded-probe', direction: 'outgoing', limit: 50 })).content[0].text);
    assert.deepEqual(body.facts.map(f => f.object), ['reachable-thing']);
    assert.match(body.other_spellings, /stranded-probe \(1\)/);

    run({ apply: true });
    assert.deepEqual(objectsOf('stranded-probe'), ['reachable-thing', 'unreachable-thing']);
  });

  it('reports what it would do without writing anything', () => {
    legacyFact('dry-run-probe', 'uses', 'kept-as-is');
    const stored = () => getDb().prepare("SELECT COUNT(*) AS n FROM entities WHERE id = 'dry-run-probe'").get().n;
    assert.equal(stored(), 1);

    const plan = run({ apply: false });
    assert.ok(plan.entities_moved > 0, 'dry run found nothing to do');
    assert.equal(stored(), 1, 'dry run wrote to the database');

    run({ apply: true });
    assert.equal(stored(), 0);
    assert.deepEqual(objectsOf('dry_run_probe'), ['kept-as-is']);
  });

  it('is idempotent — a second run has nothing left to do', () => {
    legacyFact('idem-probe', 'uses', 'a-thing');
    const first = run({ apply: true });
    assert.ok(first.entities_moved > 0);

    const second = run({ apply: true });
    assert.deepEqual(second, {
      groups: 0, entities_moved: 0, fact_rows_rewritten: 0,
      duplicates_collapsed: 0, aliases_rewritten: 0, aliases_dropped: 0,
    });
  });

  // Re-running and seeing zero changes only proves the migration agrees with
  // itself. These read the stored spellings straight off the tables.
  it('leaves every stored id canonical, with no orphans and no duplicate live triples', () => {
    legacyFact('audit-probe.one', 'uses', 'Audit_Probe TWO');
    run({ apply: true });

    const audit = auditCanonicalEntities();
    for (const [check, rows] of Object.entries(audit)) {
      assert.deepEqual(rows, [], `${check}: ${JSON.stringify(rows.slice(0, 3))}`);
    }
    const ids = getDb().prepare("SELECT id FROM entities WHERE id LIKE 'audit%probe%'").all().map(r => r.id);
    assert.deepEqual(ids.sort(), ['audit_probe_one', 'audit_probe_two']);
  });

  it('collapses two spellings of one relationship into a single live row', () => {
    legacyFact('dup-probe', 'deploys_to', 'prod-cluster', { validFrom: '2026-03-02', source: 'later' });
    legacyFact('dup_probe', 'deploys_to', 'prod_cluster', { validFrom: '2026-03-01', source: 'earlier' });
    run({ apply: true });

    const live = queryFact('dup probe', { direction: 'outgoing' }).filter(f => f.current);
    assert.equal(live.length, 1);
    // The earlier row survives whole, so its date never travels without its source.
    assert.equal(live[0].valid_from, '2026-03-01');
    assert.equal(live[0].source, 'earlier');
  });

  // The dry-run count is computed by a different function than the collapse it
  // predicts, so any grouping rule the two do not share is a run that promised
  // one number and did something else. A predicate fold is such a rule.
  it('counts a collapse across two spellings of one predicate before it happens', () => {
    legacyFact('spelling-probe', 'merged_as', 'commit_beef111', { validFrom: '2026-03-02' });
    legacyFact('spelling_probe', 'merged_via', 'commit_beef111', { validFrom: '2026-03-01' });

    const predicted = run({ apply: false });
    assert.equal(predicted.duplicates_collapsed, 1, 'dry run did not see the duplicate the fold creates');

    const applied = run({ apply: true });
    assert.equal(applied.duplicates_collapsed, 1, 'apply collapsed a different number than the dry run promised');
    assert.equal(queryFact('spelling probe', { direction: 'outgoing' }).filter(f => f.current).length, 1);
  });

  it('keeps a retired row beside the live one it now matches', () => {
    legacyFact('retired-probe', 'status', 'shipped', { validFrom: '2026-01-01' });
    getDb().prepare("UPDATE facts SET valid_to = '2026-02-01' WHERE subject = 'retired-probe'").run();
    legacyFact('retired_probe', 'status', 'shipped', { validFrom: '2026-03-01' });
    run({ apply: true });

    const rows = queryFact('retired probe', { direction: 'outgoing' });
    assert.equal(rows.length, 2, 'history was deleted as a duplicate');
    assert.deepEqual(rows.map(r => r.current).sort(), [false, true]);
  });

  it('repoints an alias recorded before the fold, and drops one the fold makes redundant', () => {
    const db = getDb();
    legacyFact('web-app', 'runs', 'dashboard');
    db.prepare("INSERT OR REPLACE INTO entity_aliases (alias, canonical) VALUES ('old_frontend_service', 'web-app')").run();
    db.prepare("INSERT OR REPLACE INTO entity_aliases (alias, canonical) VALUES ('web_app', 'web-app')").run();

    // The rename still resolves before the migration: reads re-canonicalize the
    // stored target, so the back-fill is a cleanup and not a correctness gate.
    assert.equal(entityKey('old frontend service'), 'web_app');

    const res = run({ apply: true });
    assert.ok(res.aliases_rewritten >= 1 && res.aliases_dropped >= 1);
    assert.deepEqual(objectsOf('old-frontend-service'), ['dashboard']);
    assert.deepEqual(db.prepare("SELECT canonical FROM entity_aliases WHERE alias = 'old_frontend_service'").get(), { canonical: 'web_app' });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM entity_aliases WHERE alias = 'web_app'").get().n, 0);
  });
});

describe('kb_fact_query partial-answer reporting', () => {
  const factQuery = getToolDefinitions().find(t => t.name === 'kb_fact_query');
  const call = async args => JSON.parse((await factQuery.handler(args)).content[0].text);

  it('names the near-identical ids its answer does not include', async () => {
    addFact('api keys', 'stored_in', 'shard-a', { validFrom: '2026-04-01' });
    addFact('api key', 'stored_in', 'shard-b', { validFrom: '2026-04-02' });
    addFact('api_keys_v2', 'stored_in', 'shard-c', { validFrom: '2026-04-03' });
    addFact('api#keys', 'stored_in', 'shard-d', { validFrom: '2026-04-04' });

    const body = await call({ entity: 'api-keys', direction: 'outgoing', limit: 50 });
    assert.ok(body.other_spellings, 'a query missing a near-identical id said nothing about it');
    assert.match(body.other_spellings, /api_key \(1\)/);
    // '#' is not a separator, so this id is a real miss rather than a merge.
    assert.match(body.other_spellings, /api#keys \(1\)/);
    // The prefix match already reaches api_keys_v2, so it is not missing.
    assert.doesNotMatch(body.other_spellings, /api_keys_v2/);
    assert.deepEqual(body.facts.map(f => f.object).sort(), ['shard-a', 'shard-c']);
  });

  it('stays quiet when nothing is missing', async () => {
    addFact('lonely-entity', 'uses', 'nothing-else', { validFrom: '2026-04-01' });
    const body = await call({ entity: 'lonely entity', direction: 'outgoing', limit: 50 });
    assert.equal(body.other_spellings, undefined);
  });
});
