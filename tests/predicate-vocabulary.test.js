import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, mkdtempSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

// Point the KB at a throwaway dir BEFORE importing anything that opens the DB.
process.env.KB_DIR = mkdtempSync(join(tmpdir(), 'kb-vocab-'));

const { canonicalTriple, consolidate, EXTRACT_PROMPT } = await import('../src/extract.js');
const { queryFact } = await import('../src/facts.js');
const { getToolDefinitions } = await import('../src/tools.js');

const registry = JSON.parse(readFileSync(new URL('../src/predicates.json', import.meta.url), 'utf8'));
const edge = (subject, predicate, object) => {
  const c = canonicalTriple({ subject, predicate, object });
  return `${c.subject} -[${c.predicate}]-> ${c.object}`;
};
// One relationship, spelled every way three replays of one input produced, plus
// the spellings the same rule implies. All of them have to name one edge.
const convergesOn = (label, spellings) => it(label, () => {
  const edges = new Set(spellings.map(s => edge(...s)));
  assert.strictEqual(edges.size, 1, `${edges.size} edges for one relationship: ${[...edges].join('  |  ')}`);
});

// predicates.json is read once at import, so a per-install override needs its own
// process. Returns whatever `body` prints after RESULT.
function inOverrideInstall(config, body) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-vocab-override-'));
  writeFileSync(join(dir, 'predicates.json'), JSON.stringify(config));
  const url = JSON.stringify(new URL('../src/extract.js', import.meta.url).href);
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { canonicalTriple } = await import(${url});
    const edge = (s, p, o) => { const c = canonicalTriple({ subject: s, predicate: p, object: o });
      return c.subject + ' -[' + c.predicate + ']-> ' + c.object; };
    console.log('RESULT ' + JSON.stringify(${body}));
  `], { env: { ...process.env, KB_DIR: dir }, encoding: 'utf8' });
  const line = out.split('\n').find(l => l.startsWith('RESULT '));
  assert.ok(line, `subprocess printed no RESULT line:\n${out}`);
  return JSON.parse(line.slice('RESULT '.length));
}

describe('predicate vocabulary canonicalization', () => {
  // The reproduction. Replaying one identical input three times returned the
  // same stated relationship under a different predicate each run — not a
  // mirrored direction, which the inverses map already folds, but a different
  // word for the same edge. Every spelling below was emitted by a real run.
  describe('one relationship, one edge across replays', () => {
    convergesOn('a copula the extractor adds on some runs and not others', [
      ['wallet_ledger', 'source_of_truth_for', 'balances'],
      ['wallet_ledger', 'is_source_of_truth_for', 'balances'],
      ['wallet_ledger', 'IS Source Of Truth For', 'balances'],
    ]);

    convergesOn('the work item a change closes, either way round', [
      ['tkt-99', 'fixed_in', 'pr #48'],
      ['tkt-99', 'fixed_by', 'pr #48'],
      ['pr #48', 'fixes', 'tkt-99'],
    ]);

    convergesOn('the branch a change landed on', [
      ['pr #48', 'merged_to', 'main'],
      ['pr #48', 'merged_into', 'main'],
      ['pr #48', 'merges-into', 'main'],
      ['pr #48', 'Merged Into', 'main'],
    ]);

    convergesOn('the commit a change became', [
      ['pr #48', 'merged_via', 'commit 380c761'],
      ['pr #48', 'merged_as', 'commit 380c761'],
      ['pr #48', 'merged_via_commit', 'commit 380c761'],
    ]);

    convergesOn('an inflection of a registered predicate', [
      ['web-app', 'deployed_to', 'production'],
      ['web-app', 'deploys_to', 'production'],
      ['web-app', 'deploy-to', 'production'],
    ]);

    // A doubled consonant before -ed: ship keeps one p, shipped has two, and a
    // rule that strips only the -ed leaves them in different families.
    convergesOn('a verb that doubles its consonant before -ed', [
      ['tkt-99', 'shipped_via', 'commit 380c761'],
      ['tkt-99', 'ships_via', 'commit 380c761'],
      ['tkt-99', 'ship_via', 'commit 380c761'],
    ]);

    // Both spellings sit on one entity pair in a real graph.
    convergesOn('an apostrophe the extractor sometimes types and sometimes not', [
      ['my-app', "doesn't_send", 'profile_id'],
      ['my-app', 'doesnt_send', 'profile_id'],
    ]);

  });

  // The other half of the guarantee. A fold that reaches predicates the registry
  // has taken no position on is not canonicalization, it is data loss — and it is
  // invisible, because the surviving row still reads as a well-formed fact.
  describe('folds nothing the registry has not named', () => {
    it('keeps two unregistered predicates that merely share a stem', () => {
      assert.notStrictEqual(
        edge('upload_tool', 'missing', 'batch_route'),
        edge('upload_tool', 'missed', 'batch_route'),
      );
    });

    // The stem rule reads the leading verb only. A trailing token's plural is
    // part of the name, and https is not an inflection of http.
    it('does not fold a trailing token onto a registered predicate', () => {
      assert.notStrictEqual(
        edge('my-app', 'calls_over_https', 'auth-service'),
        edge('my-app', 'calls_over_http', 'auth-service'),
      );
    });

    it('leaves a predicate the registry never names', () => {
      assert.strictEqual(
        edge('nightly_job', 'generates', 'state_notes'),
        'nightly_job -[generates]-> state_notes',
      );
    });

    // The one fold whose error cannot be undone. An inflection of a lifecycle
    // noun is usually a verb meaning something else — every live `states` row in
    // a real graph is a document quoting a requirement — and single-valued
    // predicates retire on contradiction, so folding `states` onto `state` does
    // not merely mislabel the row, it deletes the ticket's real lifecycle value
    // to make room for it. The inverse map already refuses these for the same
    // reason.
    // Both spellings below name a single-valued predicate. `status` is the case
    // that keeps the rule honest: it sits in `preferred` as well, so it reaches
    // the inflection map by a second route and only the exclusion keeps it out.
    for (const inflection of ['states', 'statuses']) {
      it(`never folds ${inflection} onto a predicate that retires on contradiction`, () => {
        assert.strictEqual(
          edge('tkt-42', inflection, 'retries_must_be_bounded'),
          `tkt-42 -[${inflection}]-> retries_must_be_bounded`,
        );
      });
    }

    it('does not retire a lifecycle value when a ticket states something', () => {
      consolidate([{ subject: 'tkt-42', predicate: 'state', object: 'open' }], { observationDate: '2026-07-01' });
      const res = consolidate(
        [{ subject: 'tkt-42', predicate: 'states', object: 'retries_must_be_bounded' }],
        { observationDate: '2026-07-02' },
      );
      assert.deepStrictEqual(res.invalidated, [], 'retired the lifecycle state to store a quotation');
      const live = queryFact('tkt-42', { direction: 'outgoing' }).filter(r => r.current);
      assert.ok(live.some(r => r.predicate === 'state' && r.object === 'open'), `lost the real state: ${JSON.stringify(live)}`);
    });
  });

  // These maps are keyed by whatever the extractor emitted. A plain object
  // answers toString and constructor with a function, which normPred would then
  // hand back in place of the predicate — and addFact would store it.
  it('returns a predicate, not an inherited property, for a prototype key', () => {
    for (const key of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__']) {
      const { predicate } = canonicalTriple({ subject: 'a', predicate: key, object: 'b' });
      assert.strictEqual(typeof predicate, 'string', `${key} resolved to a ${typeof predicate}`);
    }
  });

  // The migration replays canonicalTriple over every stored row and folds those
  // it would store differently. A second pass that still changes something means
  // the migration never converges and rewrites the same rows on every run.
  it('is idempotent over every spelling it folds', () => {
    const spellings = [
      ...Object.keys(registry.aliases), ...Object.values(registry.aliases),
      ...Object.keys(registry.inverses), ...Object.values(registry.inverses),
      ...registry.preferred, ...registry.single_valued,
      'is_source_of_truth_for', 'deploys_to', 'blocked-by', 'MERGED INTO', "doesn't_send",
    ];
    for (const p of spellings) {
      const once = canonicalTriple({ subject: 'pr #48', predicate: p, object: 'tkt-99' });
      assert.deepStrictEqual(canonicalTriple(once), once, `${p} does not settle after one fold`);
    }
  });

  // The prompt asks for a vocabulary and the canonicaliser folds onto one. Two
  // hand-maintained copies of that list drift, and the drift is silent: the model
  // is asked for a predicate nothing folds, or folds onto one it was never told
  // to prefer.
  it('asks the model for exactly the vocabulary the registry names', () => {
    for (const predicate of registry.preferred) {
      assert.ok(EXTRACT_PROMPT.includes(predicate), `prompt never mentions ${predicate}`);
    }
  });

  // kb_extract and kb_fact_add write the same table. Canonicalising one and not
  // the other means the hand-written half of a debrief lands on a second edge —
  // and keeps landing there after every migration has folded the first.
  describe('cross-surface parity with kb_extract', () => {
    const tool = name => getToolDefinitions().find(t => t.name === name);
    const stored = res => JSON.parse(res.content[0].text);

    it('kb_fact_add stores the canonical triple, and says so', async () => {
      const res = stored(await tool('kb_fact_add').handler({
        subject: 'tkt-4821', predicate: 'fixed_in', object: 'pr #48',
      }));
      assert.strictEqual(res.subject, 'pr #48');
      assert.strictEqual(res.predicate, 'fixes');
      assert.strictEqual(res.object, 'tkt-4821');
    });

    it('kb_fact_invalidate can still name the row by the spelling that wrote it', async () => {
      await tool('kb_fact_add').handler({
        subject: 'tkt-4822', predicate: 'deploys_to', object: 'production',
      });
      const res = stored(await tool('kb_fact_invalidate').handler({
        subject: 'tkt-4822', predicate: 'deploys_to', object: 'production', ended: '2026-07-30',
      }));
      assert.strictEqual(res.invalidated, 1, 'the fact it just wrote became unreachable');
    });
  });

  describe('per-install overrides', () => {
    // An alias onto a predicate that is itself aliased needs two passes to
    // settle, so canonicalTriple would leave a half-folded predicate and the
    // migration would rewrite the row every run.
    it('refuses an alias chain rather than applying half of it', () => {
      assert.strictEqual(
        inOverrideInstall(
          { aliases: { landed_on: 'merged_into' } },
          `edge('pr #48', 'landed_on', 'main')`,
        ),
        'pr #48 -[landed_on]-> main',
      );
    });

    // Two registered names with one stem: nothing here can say which a third
    // inflected spelling meant, so neither claims it and both stay exact.
    it('folds no inflection when two registered names share a stem', () => {
      assert.deepStrictEqual(
        inOverrideInstall(
          { preferred: ['runs_on', 'run_on'] },
          `[edge('a', 'runs_on', 'b'), edge('a', 'run_on', 'b'), edge('a', 'running_on', 'b')]`,
        ),
        ['a -[runs_on]-> b', 'a -[run_on]-> b', 'a -[running_on]-> b'],
      );
    });

    it('folds an inflection of a predicate the install added', () => {
      assert.strictEqual(
        inOverrideInstall(
          { preferred: ['benchmarked_against'] },
          `edge('a', 'benchmarks-against', 'b')`,
        ),
        'a -[benchmarked_against]-> b',
      );
    });

    // A registered name ending in a double s: without the plural guard, bypass
    // stems to bypas while bypasses stems to bypass, and the pair never meets.
    it('folds an inflection of a name ending in a sibilant', () => {
      assert.strictEqual(
        inOverrideInstall({ preferred: ['bypass_on'] }, `edge('a', 'bypasses_on', 'b')`),
        'a -[bypass_on]-> b',
      );
    });

    // A verb whose -s and -ed forms both turn a consonant + y into -ies / -ied.
    // No built-in predicate is one, so only an install reaches these rules.
    it('folds a -y verb the install added, in either inflection', () => {
      assert.deepStrictEqual(
        inOverrideInstall(
          { preferred: ['verified_on'] },
          `[edge('a', 'verifies_on', 'b'), edge('a', 'verify_on', 'b'), edge('a', 'verified_on', 'b')]`,
        ),
        ['a -[verified_on]-> b', 'a -[verified_on]-> b', 'a -[verified_on]-> b'],
      );
    });
  });
});
