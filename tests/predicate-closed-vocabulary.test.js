// Point the KB at a throwaway dir BEFORE anything opens the real DB.
import './helpers/tmp-kb.js';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

const { canonicalTriple, consolidate } = await import('../src/extract.js');
const {
  VOCABULARY, VOCABULARY_FILE, canonicalPredicate, inVocabulary,
  nearestPredicates, vocabularyRejection,
} = await import('../src/predicates.js');
const { addFact, entityKey } = await import('../src/facts.js');
const { getDb, MIGRATIONS } = await import('../src/db.js');
const { getToolDefinitions } = await import('../src/tools.js');
const { applyMigrations, pendingMigrations } = await import('../src/schema.js');

const tool = name => getToolDefinitions().find(t => t.name === name);
const replied = res => JSON.parse(res.content[0].text);

// The spelling the table actually holds, which is the only thing any of this is
// about. Reading it back through queryFact would re-canonicalise and hide the
// bug these tests exist to catch.
const storedPredicates = subject => getDb()
  .prepare('SELECT predicate FROM facts WHERE subject = ? ORDER BY predicate').pluck().all(entityKey(subject));

describe('the predicate fold', () => {
  // Every spelling on the left was produced by the extractor naming a
  // relationship the graph already had a word for. The right-hand side is the
  // one edge they all have to become.
  const FOLDS = [
    ['merged_into', 'merged_to'],
    ['merged_in', 'merged_to'],
    ['merged_at', 'merged_to'],
    ['merged_on', 'merged_to'],
    ['merged', 'merged_to'],
    ['merges', 'merged_to'],
    ['landed_on', 'merged_to'],
    ['landed_in', 'merged_to'],
    ['merged_as', 'merged_via'],
    ['merged_via_commit', 'merged_via'],
    ['shipped', 'shipped_via'],
    ['shipped_in', 'shipped_via'],
    ['shipped_as', 'shipped_via'],
    ['ships', 'shipped_via'],
    ['deployed_via', 'shipped_via'],
    ['deployed', 'deployed_to'],
    ['deploys_to', 'deployed_to'],
    ['deployed_in', 'deployed_to'],
    ['deployed_at', 'deployed_to'],
    ['deployed_as', 'deployed_to'],
    ['deployed_on', 'deployed_to'],
    ['shipped_to', 'deployed_to'],
    ['implemented_in', 'implements'],
    ['implemented_via', 'implements'],
    ['implemented_as', 'implements'],
    ['fixed_via', 'fixes'],
    ['fixed_with', 'fixes'],
    ['requires', 'depends_on'],
    ['needs', 'depends_on'],
    ['handles', 'supports'],
    ['missing', 'lacks'],
    ['supersedes', 'replaces'],
    ['is_a', 'is'],
    ['instance_of', 'is'],
    // Spelling variance that needs no list entry at all.
    ['MERGED INTO', 'merged_to'],
    ['merged-into', 'merged_to'],
    ['is_gated_by', 'gated_by'],
    ['causes', 'causes'],
    ['caused', 'causes'],
    ['cause', 'causes'],
  ];

  for (const [variant, canonical] of FOLDS) {
    it(`folds ${variant} onto ${canonical}`, () => {
      assert.strictEqual(canonicalPredicate(variant), canonical);
    });
  }

  // The other half of the guarantee, and the one whose failures are silent: a
  // fold that reaches a predicate the registry has taken no position on is not
  // canonicalisation, it is two different claims collapsed into one row that
  // still reads as a well-formed fact.
  const NOT_FOLDED = [
    // Neighbouring meanings inside the delivery family. What was built, what
    // stopped hurting, which branch, which commit, which environment — five
    // questions with five answers, and the census spelled them 400 ways.
    ['implements', 'fixes'],
    ['fixes', 'resolves'],
    ['merged_to', 'merged_via'],
    ['merged_via', 'shipped_via'],
    ['shipped_via', 'deployed_to'],
    // A trailing token's plural is part of the name, not an inflection.
    ['calls_over_http', 'calls_over_https'],
    // Neither is registered, so morphology alone must not merge them.
    ['missed', 'missing'],
    // Registered on one side only: `missing` folds to `lacks`, `missed` does not
    // follow it there.
    ['missed', 'lacks'],
    // Cardinality nouns are excluded from the inflection map on purpose — a
    // ticket that STATES a requirement is not the ticket's lifecycle state.
    ['states', 'state'],
    ['statuses', 'status'],
    // Close in English, different in a graph.
    ['contains', 'includes'],
    ['gates', 'gated_by'],
    ['causes', 'caused_by'],
  ];

  for (const [a, b] of NOT_FOLDED) {
    it(`keeps ${a} and ${b} apart`, () => {
      assert.notStrictEqual(canonicalPredicate(a), canonicalPredicate(b));
    });
  }
});

describe('the closed vocabulary', () => {
  it('holds every fold target, so no fold produces a row it then refuses', () => {
    // The trap this catches is silent and total: an alias onto an unlisted
    // predicate means every row that fold produces is rejected, and the only
    // symptom is a `skipped` list full of a predicate nobody wrote.
    const registry = JSON.parse(readFileSync(new URL('../src/predicates.json', import.meta.url), 'utf8'));
    for (const target of Object.values(registry.aliases)) {
      const landed = canonicalTriple({ subject: 'a', predicate: target, object: 'b' }).predicate;
      assert.ok(inVocabulary(landed), `alias target ${target} lands on ${landed}, which is not storable`);
    }
    for (const target of Object.values(registry.inverses)) {
      assert.ok(inVocabulary(target), `inverse target ${target} is not storable`);
    }
  });

  it('lists no predicate that canonicalisation would rewrite', () => {
    // A member that is not its own canonical form can never be stored, so
    // listing it advertises a slot that does not exist.
    for (const name of VOCABULARY) {
      assert.strictEqual(canonicalPredicate(name), name, `${name} is listed but folds to something else`);
    }
  });

  it('names candidates from the list, best first, and repeats itself', () => {
    const nearest = nearestPredicates('merged_somewhere');
    assert.ok(nearest.every(n => VOCABULARY.has(n)), `suggested something unlistable: ${nearest}`);
    assert.ok(
      nearest.includes('merged_to') || nearest.includes('merged_via'),
      `no merged_* candidate for merged_somewhere: ${nearest}`,
    );
    assert.deepStrictEqual(nearestPredicates('merged_somewhere'), nearest, 'suggestions reorder between calls');
  });

  it('reports one verdict for both write paths', () => {
    // Two per-surface copies of this test would drift, and the drift shows up as
    // one surface accepting what the other refuses.
    assert.strictEqual(vocabularyRejection('owns'), null);
    const rejection = vocabularyRejection('yeeted_into');
    assert.strictEqual(rejection.reason, 'predicate_not_in_vocabulary');
    assert.strictEqual(rejection.predicate, 'yeeted_into');
    assert.ok(rejection.vocabulary_file.includes('predicates.json'));
    assert.ok(rejection.nearest.length > 0);
  });
});

// Each of these calls the real caller, not the helper. A test that folds a
// string by calling canonicalPredicate directly still passes with the
// canonicaliser unwired from every write path in the codebase, which is the
// failure this whole change exists to prevent.
describe('every write path stores the folded predicate', () => {
  it('kb_fact_add — through the tool handler', async () => {
    const res = replied(await tool('kb_fact_add').handler({
      subject: 'pr #4001', predicate: 'merged_into', object: 'main',
    }));
    assert.strictEqual(res.predicate, 'merged_to', 'the reply named a spelling it did not store');
    assert.deepStrictEqual(storedPredicates('pr #4001'), ['merged_to']);
  });

  it('kb_extract consolidation — through consolidate', () => {
    consolidate(
      [{ subject: 'web-app', predicate: 'deploys_to', object: 'production' }],
      { source: 'test', observationDate: '2026-07-01' },
    );
    assert.deepStrictEqual(storedPredicates('web-app'), ['deployed_to']);
  });

  it('addFact — the storage primitive itself, for any caller yet to be written', () => {
    // Both production callers hand this a canonical predicate already. The fold
    // is here so that a third one cannot mint a new spelling by forgetting.
    addFact('pr #4002', 'merged_as', 'commit abc1234', { validFrom: '2026-07-01' });
    assert.deepStrictEqual(storedPredicates('pr #4002'), ['merged_via']);
  });
});

describe('an off-vocabulary predicate is refused where the caller can see it', () => {
  it('kb_extract reports it in skipped, with candidates, and writes nothing', () => {
    const res = consolidate([
      { subject: 'nightly_job', predicate: 'yeets', object: 'state_notes' },
      { subject: 'nightly_job', predicate: 'owns', object: 'state_notes' },
    ], { source: 'test', observationDate: '2026-07-02' });

    assert.strictEqual(res.added.length, 1, 'wrote a predicate the vocabulary does not hold');
    const skip = res.skipped.find(s => s.reason === 'predicate_not_in_vocabulary');
    assert.ok(skip, `no rejection in skipped: ${JSON.stringify(res.skipped)}`);
    assert.strictEqual(skip.predicate, 'yeets');
    assert.ok(skip.nearest.length > 0, 'refused without saying what would have worked');
    assert.ok(skip.vocabulary_file.includes('predicates.json'));
    // The attempted triple travels with the rejection, or the caller cannot tell
    // which of a hundred assertions was dropped.
    assert.strictEqual(skip.fact.subject, 'nightly_job');
    assert.deepStrictEqual(storedPredicates('nightly_job'), ['owns']);
  });

  it('never coerces onto the nearest candidate instead of reporting', () => {
    // Storing the closest guess is the tempting failure: it looks like a clean
    // extraction and puts an assertion nobody made into the graph.
    consolidate(
      [{ subject: 'coercion_probe', predicate: 'merged_somewhere', object: 'main' }],
      { source: 'test', observationDate: '2026-07-02' },
    );
    assert.deepStrictEqual(storedPredicates('coercion_probe'), []);
  });

  it('kb_fact_add errors, naming the file and the candidates, and writes nothing', async () => {
    const res = await tool('kb_fact_add').handler({
      subject: 'manual_probe', predicate: 'yeets', object: 'state_notes',
    });

    assert.strictEqual(res.isError, true, 'accepted a predicate outside the vocabulary');
    const message = res.content[0].text;
    assert.match(message, /not in the knowledge base's closed vocabulary/);
    assert.ok(message.includes('predicates.json'), `message does not say where the list lives: ${message}`);
    for (const candidate of nearestPredicates('yeets')) {
      assert.ok(message.includes(candidate), `message omits candidate ${candidate}`);
    }
    assert.deepStrictEqual(storedPredicates('manual_probe'), []);
  });

  it('refuses on the folded spelling, not the one that was typed', async () => {
    // `is_yeeted_into` folds to `yeeted_into` before the check. A message naming
    // the raw input would send someone to search the list for a string the
    // boundary never looked up.
    const res = await tool('kb_fact_add').handler({
      subject: 'manual_probe_2', predicate: 'is_yeeted_into', object: 'main',
    });
    assert.strictEqual(res.isError, true);
    assert.match(res.content[0].text, /"yeeted_into".*folded from "is_yeeted_into"/s);
  });

  it('accepts a mirrored spelling of a listed predicate, which only folds after the swap', async () => {
    // `blocks` is not in the vocabulary — it is an inverse source. Checking
    // before canonicalTriple would refuse a perfectly good fact.
    const res = replied(await tool('kb_fact_add').handler({
      subject: 'tkt-5001', predicate: 'blocks', object: 'tkt-5002',
    }));
    assert.strictEqual(res.predicate, 'blocked_by');
    assert.strictEqual(res.subject, 'tkt-5002');
  });
});
