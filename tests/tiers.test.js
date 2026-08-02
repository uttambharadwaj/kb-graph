// Epistemic tiers: what a note claims, what it had to show for the claim, and
// whether an agent reading it back can tell the difference.
import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import {
  TIER, TIERS, DEFAULT_TIER, REF_MAX_CHARS,
  assertTier, byScoreThenTier, coerceTier, referenceIn, resolveTier, SCORE_BUCKET, sourceFamily, tierForSource, tierLabel, tierRank,
} from '../src/tiers.js';
import { getToolDefinitions } from '../src/tools.js';
import { backfillTiers, getDb, getDocument, insertDocument, preferConfirmed, promoteDocumentTier, searchDocuments } from '../src/db.js';
import { hybridMergeOrder } from '../src/embeddings/search.js';
import { writeNote } from '../src/write-note.js';
import { indexVaultFile } from '../src/vault/indexer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'helpers', 'run-hook.mjs');
const SRC = join(HERE, '..', 'src');
const VAULT = process.env.OBSIDIAN_VAULT_PATH;

const call = async (name, args) => {
  const tool = getToolDefinitions().find(t => t.name === name);
  const res = await tool.handler(args);
  return { text: res.content[0].text, isError: res.isError === true };
};

const runHook = (name, input) => execFileSync(process.execPath, [HOOK, name], {
  input: JSON.stringify(input), env: process.env, encoding: 'utf8',
});

// A vault note written by hand, the way a person editing in Obsidian would.
function writeVaultFile(relPath, frontmatter, body = 'Body text for the note.') {
  const full = join(VAULT, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `---\n${frontmatter}\n---\n\n${body}\n`);
  return relPath;
}

describe('what counts as a reference', () => {
  // The guard exists to stop a hand-wave from buying the top tier, so the
  // cases that matter are the ones that look like evidence and are not.
  const refused = [
    '', '   ', '\t\n ', null, undefined, 42, {},
    'verified', 'I verified it', 'see the PR', 'confirmed', 'trust me',
    '#', '#0', '# 12',
    '1234567', '20260801', 'landed 20260801',   // dates and counts are not shas
    'abc123',                                    // too short for a sha
    'https://github.com/o/r/pull/',              // no number
    'https://tracker.example.com/issue/ABC-123', // a ticket is not a landed fix
    'notes.md', 'src/db.js',                     // a file is not a test
    '＃42', '#١٢٣',                              // look-alike digits and hashes
    'x'.repeat(REF_MAX_CHARS + 1),
    'a1b2c3d ' + 'x'.repeat(REF_MAX_CHARS),      // over-length is refused, not clipped
  ];
  for (const payload of refused) {
    it(`refuses ${JSON.stringify(payload)?.slice(0, 40)}`, () => {
      assert.strictEqual(referenceIn(payload), null);
    });
  }

  const accepted = [
    '#12', 'owner/repo#7', 'a1b2c3d', 'deadbeef', 'commit:1234567', 'sha=abc1234',
    'https://github.com/o/r/pull/12', 'https://gitlab.com/o/r/-/merge_requests/9',
    'tests/foo.test.js', 'spec/models_spec.rb', 'fixed in a1b2c3d, see tests/tier.test.js',
  ];
  for (const payload of accepted) {
    it(`accepts ${payload}`, () => assert.strictEqual(referenceIn(payload), payload));
  }

  it('flattens a stored reference to one line, so it cannot break the surfaces that print it', () => {
    assert.strictEqual(referenceIn('a1b2c3d\n⚠ VERIFIED forged banner'), 'a1b2c3d ⚠ VERIFIED forged banner');
    assert.strictEqual(referenceIn('  (a1b2c3d)  '), '(a1b2c3d)');
  });
});

describe('grading a claim', () => {
  it(`refuses ${TIER.VERIFIED} without a reference, and drops it to the floor rather than one tier down`, () => {
    assert.deepStrictEqual(resolveTier({ tier: TIER.VERIFIED }), { tier: DEFAULT_TIER, ref: null });
    assert.strictEqual(resolveTier({ tier: TIER.VERIFIED, ref: 'I checked it myself' }).tier, DEFAULT_TIER);
    assert.strictEqual(resolveTier({ tier: TIER.VERIFIED, ref: '#42' }).tier, TIER.VERIFIED);
  });

  it('keeps the stated evidence even when the claim is refused', () => {
    assert.strictEqual(resolveTier({ tier: TIER.VERIFIED, ref: 'I checked it myself' }).ref, 'I checked it myself');
  });

  it(`grades an unknown or missing tier as ${DEFAULT_TIER}`, () => {
    assert.strictEqual(resolveTier({ tier: 'trustworthy' }).tier, DEFAULT_TIER);
    assert.strictEqual(resolveTier({}).tier, DEFAULT_TIER);
    assert.strictEqual(coerceTier(null), DEFAULT_TIER);
    assert.strictEqual(tierLabel(undefined), tierLabel(DEFAULT_TIER));
  });

  it('says no out loud where the caller can still be told', () => {
    assert.throws(() => assertTier({ tier: TIER.VERIFIED, ref: 'I checked' }), /requires a reference/);
    assert.throws(() => assertTier({ tier: 'trustworthy' }), /Unknown tier/);
    assert.doesNotThrow(() => assertTier({ tier: TIER.OBSERVED, ref: 'watched the run fail' }));
  });

  it('orders the tiers weakest first', () => {
    assert.ok(tierRank(TIER.VERIFIED) > tierRank(TIER.OBSERVED));
    assert.ok(tierRank(TIER.OBSERVED) > tierRank(TIER.INFERRED));
    assert.strictEqual(DEFAULT_TIER, TIERS[0]);
  });
});

describe('the unattended sweep', () => {
  it('may not write anything above the floor, whatever it asks for', () => {
    for (const tier of [TIER.OBSERVED, TIER.VERIFIED]) {
      assert.throws(
        () => assertTier({ tier, ref: '#42', provenance: 'harvest:0b3d-session' }),
        /unattended sweep/,
        `a sweep must not be able to claim ${tier}`,
      );
    }
  });

  it('is recognised whatever the casing or padding of its source', () => {
    for (const provenance of ['harvest:x', 'HARVEST:X', '  harvest:x  ']) {
      assert.throws(() => assertTier({ tier: TIER.OBSERVED, provenance }), /unattended sweep/);
    }
  });

  it('cannot slip a tier past writeNote', async () => {
    await assert.rejects(
      writeNote(VAULT, { title: 'Swept conclusion', content: 'From a transcript.', source: 'harvest:abc', tier: TIER.OBSERVED }),
      /unattended sweep/,
    );
  });

  it('lands its notes at the floor when it asks for nothing', async () => {
    const res = await writeNote(VAULT, { title: 'A conclusion drawn from a transcript', content: 'Swept overnight.', source: 'harvest:def' });
    assert.strictEqual(res.skipped, false, JSON.stringify(res));
    assert.strictEqual(res.tier, DEFAULT_TIER);
    assert.match(readFileSync(join(VAULT, res.path), 'utf8'), new RegExp(`^tier: ${DEFAULT_TIER}$`, 'm'));
    assert.strictEqual(getDocument(res.docId).tier, DEFAULT_TIER);
  });

  it('builds its source from the prefix the ceiling recognises, and never names a tier', () => {
    const src = readFileSync(join(SRC, 'harvest.js'), 'utf8');
    assert.match(src, /HARVEST_SOURCE_PREFIX.*from '\.\/tiers\.js'/, 'the prefix must come from the module that gates on it');
    assert.match(src, /const source = `\$\{HARVEST_SOURCE_PREFIX\}/);
    const writeCall = src.slice(src.indexOf('await writeNote('), src.indexOf('if (!res.skipped) written++'));
    assert.ok(writeCall.length > 0, 'failed to locate the harvest writeNote call');
    assert.doesNotMatch(writeCall, /tier/, 'the sweep must not pass a tier at all');
  });
});

describe('kb_write', () => {
  it(`writes ${DEFAULT_TIER} when the caller says nothing`, async () => {
    const res = await call('kb_write', { title: 'An untiered claim about caching', content: 'Reasoned, not run.', type: 'lesson' });
    assert.strictEqual(res.isError, false, res.text);
    assert.match(res.text, new RegExp(`as ${DEFAULT_TIER}`));
  });

  it(`refuses ${TIER.VERIFIED} without a reference instead of quietly downgrading it`, async () => {
    const res = await call('kb_write', {
      title: 'A claim asserted as proven', content: 'No evidence attached.', type: 'lesson',
      tier: TIER.VERIFIED, tier_ref: 'I am confident about this',
    });
    assert.strictEqual(res.isError, true, res.text);
    assert.match(res.text, /requires a reference/);
    assert.strictEqual(getDb().prepare('SELECT COUNT(*) c FROM documents WHERE title = ?').get('A claim asserted as proven').c, 0);
  });

  it(`records ${TIER.VERIFIED} with its reference, in the file as well as the index`, async () => {
    const res = await call('kb_write', {
      title: 'A fix that landed for the retry loop', content: 'Fixed and covered.', type: 'fix',
      tier: TIER.VERIFIED, tier_ref: 'tests/retry.test.js',
    });
    assert.strictEqual(res.isError, false, res.text);
    const doc = getDb().prepare('SELECT * FROM documents WHERE title = ?').get('A fix that landed for the retry loop');
    assert.strictEqual(doc.tier, TIER.VERIFIED);
    assert.strictEqual(doc.tier_ref, 'tests/retry.test.js');
    const vf = getDb().prepare('SELECT vault_path FROM vault_files WHERE document_id = ?').get(doc.id);
    assert.match(readFileSync(join(VAULT, vf.vault_path), 'utf8'), /^tier: verified$/m);
  });
});

describe('the index does not trust the file', () => {
  it(`clamps a hand-edited ${TIER.VERIFIED} claim that shows nothing, and says it did`, async () => {
    const rel = writeVaultFile('inbox/hand-edited-claim.md', 'title: "Hand edited claim"\ntype: lesson\ntier: verified');
    const result = await indexVaultFile(VAULT, rel);
    const doc = getDb().prepare("SELECT * FROM documents WHERE source = ?").get(`vault:${rel}`);
    assert.strictEqual(doc.tier, DEFAULT_TIER, 'an unsupported claim in frontmatter must not be taken at face value');
    assert.ok(result.errors.some(e => e.includes('claims tier "verified"')), `expected a warning, got ${JSON.stringify(result.errors)}`);
  });

  it('accepts a hand-edited claim that does show something', async () => {
    const rel = writeVaultFile('inbox/hand-edited-with-ref.md', 'title: "Hand edited with ref"\ntype: lesson\ntier: verified\ntier_ref: "#31"');
    const result = await indexVaultFile(VAULT, rel);
    const doc = getDb().prepare('SELECT * FROM documents WHERE source = ?').get(`vault:${rel}`);
    assert.strictEqual(doc.tier, TIER.VERIFIED);
    assert.strictEqual(doc.tier_ref, '#31');
    assert.deepStrictEqual(result.errors, []);
  });

  it('re-reads the tier from the file on every pass, so the file stays the source of truth', async () => {
    const rel = writeVaultFile('inbox/retiered.md', 'title: "Retiered note"\ntype: lesson\ntier: observed');
    await indexVaultFile(VAULT, rel);
    const id = getDb().prepare('SELECT id FROM documents WHERE source = ?').get(`vault:${rel}`).id;
    assert.strictEqual(getDocument(id).tier, TIER.OBSERVED);

    writeVaultFile('inbox/retiered.md', 'title: "Retiered note"\ntype: lesson', 'Body text for the note. Edited.');
    await indexVaultFile(VAULT, rel);
    assert.strictEqual(getDocument(id).tier, DEFAULT_TIER, 'dropping the claim from the file must drop it from the index');
  });
});

describe('kb_promote', () => {
  const promote = (args) => call('kb_promote', args);

  it('raises a tier and records what confirmed it', async () => {
    const doc = insertDocument({ title: 'A guess about the queue', content: 'Guessed.', doc_type: 'lesson' });
    assert.strictEqual(doc.tier, DEFAULT_TIER);

    const res = await promote({ id: doc.id, tier: TIER.VERIFIED, confirmed_by: 'fixed in a1b2c3d' });
    assert.strictEqual(res.isError, false, res.text);

    const after = getDocument(doc.id);
    assert.strictEqual(after.tier, TIER.VERIFIED);
    assert.strictEqual(after.tier_ref, 'fixed in a1b2c3d');
    assert.ok(after.tier_at, 'the moment of confirmation must be recorded');
    assert.match(res.text, /a1b2c3d/);
  });

  it('will not confirm without saying what did the confirming', async () => {
    const doc = insertDocument({ title: 'An unconfirmed guess', content: 'Guessed.', doc_type: 'lesson' });
    for (const confirmed_by of ['', '   ']) {
      const res = await promote({ id: doc.id, tier: TIER.OBSERVED, confirmed_by });
      assert.strictEqual(res.isError, true);
      assert.match(res.text, /must record what confirmed/);
    }
    assert.strictEqual(getDocument(doc.id).tier, DEFAULT_TIER);
  });

  it(`will not reach ${TIER.VERIFIED} on prose alone`, async () => {
    const doc = insertDocument({ title: 'A claim promoted on a hunch', content: 'Guessed.', doc_type: 'lesson' });
    const res = await promote({ id: doc.id, tier: TIER.VERIFIED, confirmed_by: 'I am sure this is right now' });
    assert.strictEqual(res.isError, true);
    assert.match(res.text, /requires a reference/);
    assert.strictEqual(getDocument(doc.id).tier, DEFAULT_TIER);
  });

  it('only ever goes up', async () => {
    const doc = insertDocument({ title: 'Already observed behaviour', content: 'Seen.', doc_type: 'lesson', tier: TIER.OBSERVED });
    const down = await promote({ id: doc.id, tier: DEFAULT_TIER, confirmed_by: 'on reflection, unsure' });
    assert.strictEqual(down.isError, true);
    assert.match(down.text, /only raises/);
    const same = await promote({ id: doc.id, tier: TIER.OBSERVED, confirmed_by: 'saw it again' });
    assert.strictEqual(same.isError, true);
    assert.strictEqual(getDocument(doc.id).tier, TIER.OBSERVED);
  });

  // The ceiling is about who is speaking at write time. A note the sweep wrote
  // is the most likely thing a later session confirms, so promotion must reach it.
  it('can confirm a note the unattended sweep wrote', async () => {
    const written = await writeNote(VAULT, { title: 'A swept claim later proven true', content: 'Swept.', source: 'harvest:ghi' });
    assert.strictEqual(written.skipped, false, JSON.stringify(written));
    const res = await promote({ id: written.docId, tier: TIER.VERIFIED, confirmed_by: '#42' });
    assert.strictEqual(res.isError, false, res.text);
    assert.strictEqual(getDocument(written.docId).tier, TIER.VERIFIED);
  });

  it('writes the tier into the note file, so the next reindex does not undo it', async () => {
    const written = await writeNote(VAULT, { title: 'A promotion that must survive a reindex', content: 'Body.' });
    assert.strictEqual(written.skipped, false, JSON.stringify(written));
    await promote({ id: written.docId, tier: TIER.VERIFIED, confirmed_by: 'tests/survives.test.js' });
    assert.match(readFileSync(join(VAULT, written.path), 'utf8'), /^tier: verified$/m);

    await indexVaultFile(VAULT, written.path);
    assert.strictEqual(getDocument(written.docId).tier, TIER.VERIFIED);
  });

  it('reports an unknown note rather than inventing one', async () => {
    const res = await promote({ id: 987654, tier: TIER.OBSERVED, confirmed_by: 'saw it' });
    assert.strictEqual(res.isError, true);
    assert.match(res.text, /not found/);
  });
});

describe('reading a note back', () => {
  it('leads kb_read with the tier, ahead of the note itself', async () => {
    const doc = insertDocument({ title: 'A note read back', content: 'Body.', doc_type: 'lesson' });
    const res = await call('kb_read', { id: doc.id });
    assert.match(res.text.split('\n')[0], /⚠ INFERRED/);
    assert.match(res.text, /verify before acting on it/i);
  });

  it('shows the evidence on a confirmed note', async () => {
    const doc = insertDocument({ title: 'A confirmed note read back', content: 'Body.', doc_type: 'fix', tier: TIER.VERIFIED, tier_ref: '#77' });
    const res = await call('kb_read', { id: doc.id });
    assert.match(res.text.split('\n')[0], /VERIFIED \[#77\]/);
  });

  it('keeps the superseded banner above the tier banner', async () => {
    const doc = insertDocument({ title: 'A retired note read back', content: 'Body.', doc_type: 'lesson' });
    getDb().prepare("UPDATE documents SET superseded_at = '2026-01-01' WHERE id = ?").run(doc.id);
    const res = await call('kb_read', { id: doc.id });
    const [first, second] = res.text.split('\n');
    assert.match(first, /SUPERSEDED/);
    assert.match(second, /INFERRED/);
  });

  it('carries the tier through kb_search and kb_context', async () => {
    insertDocument({ title: 'Kestrel migration checklist', content: 'kestrel migration checklist steps', doc_type: 'lesson', tier: TIER.OBSERVED });
    const search = await call('kb_search', { query: 'kestrel migration checklist', limit: 5 });
    assert.match(search.text, /"tier": "observed"/);
    const context = await call('kb_context', { query: 'kestrel migration checklist', limit: 5 });
    assert.match(context.text, /"tier": "observed"/);
  });

  it('marks the tier on every hint line', () => {
    insertDocument({ title: 'Pelican deployment runbook', content: 'pelican deployment runbook rollout', doc_type: 'lesson' });
    const out = runHook('prompt-hint', { session_id: 'sess-tier-hint', prompt: 'pelican deployment runbook rollout steps' });
    assert.match(out, /Pelican deployment runbook/);
    assert.match(out, /⚠ inferred/);
  });

  it('states the standing of the store in the briefing', () => {
    const out = runHook('wakeup-hook', { session_id: 'sess-tier-briefing' });
    assert.match(out, /standing: .*⚠ inferred \d+/);
  });
});

describe('search prefers what was confirmed', () => {
  it('puts a confirmed note above an inferred one that scores the same', async () => {
    // Same title and body, so bm25 scores them identically and only the tier
    // can separate them. The inferred one is inserted first, so insertion order
    // would put it on top if nothing preferred the confirmed one.
    const title = 'Grackle throughput ceiling';
    const body = 'grackle throughput ceiling under sustained load';
    const low = insertDocument({ title, content: body, doc_type: 'lesson' });
    const high = insertDocument({ title, content: body, doc_type: 'lesson', tier: TIER.VERIFIED, tier_ref: '#9' });

    const results = searchDocuments('grackle throughput ceiling', 10);
    const ids = results.map(r => r.id);
    assert.ok(ids.includes(low.id) && ids.includes(high.id), 'both notes must match');
    assert.ok(ids.indexOf(high.id) < ids.indexOf(low.id), 'the confirmed note must rank first');
    assert.strictEqual(results[ids.indexOf(high.id)].rank, results[ids.indexOf(low.id)].rank, 'the two must be scored equally for this to be a tie-break');
  });

  it('does not let the tier outrank relevance', () => {
    // Both must match every term, or the AND-first query drops the weaker one
    // and the assertion passes without the ranking ever being exercised.
    const terms = 'marmot hibernation telemetry sampling';
    insertDocument({ title: 'Marmot hibernation telemetry sampling', content: `${terms}. ${terms}.`, doc_type: 'lesson' });
    insertDocument({
      title: 'Unrelated note', doc_type: 'lesson', tier: TIER.VERIFIED, tier_ref: '#8',
      content: `A long note about unrelated matters that happens to mention ${terms} exactly once, among a great many other words that have nothing to do with it.`,
    });

    const results = searchDocuments(terms, 10);
    assert.strictEqual(results.length, 2, 'both notes must match, or this proves nothing');
    assert.strictEqual(results[0].title, 'Marmot hibernation telemetry sampling');
  });
});

describe('backfilling tiers from provenance', () => {
  // One document per provenance family, each linked to a vault_files row —
  // which is where a note's own source lives; documents.source holds the
  // indexer's vault path and says nothing about where the knowledge came from.
  function seed(vaultPath, source) {
    const doc = insertDocument({ title: `Seeded ${vaultPath}`, content: 'Body.', doc_type: 'lesson', source: `vault:${vaultPath}` });
    getDb().prepare(
      'INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type, source) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(vaultPath, `hash-${vaultPath}`, doc.id, `Seeded ${vaultPath}`, 'lesson', source);
    return doc.id;
  }

  it('sorts each provenance into its family', () => {
    assert.strictEqual(sourceFamily('harvest:0b3d-4f'), 'harvest');
    assert.strictEqual(sourceFamily('manual'), 'manual');
    assert.strictEqual(sourceFamily('web'), 'web');
    assert.strictEqual(sourceFamily('https://example.com/post'), 'web');
    assert.strictEqual(sourceFamily('session 2026-07-30, notes'), 'session');
    assert.strictEqual(sourceFamily('feedback_something.md'), 'file');
    assert.strictEqual(sourceFamily(null), 'none');
    assert.strictEqual(sourceFamily('   '), 'none');
    assert.strictEqual(sourceFamily('some-new-pipeline:v2'), 'other');
  });

  it('maps every family, including one it has never seen, to the floor', () => {
    for (const source of ['harvest:x', 'manual', 'web', 'https://example.com/a', 'session 2026-01-01', 'a.md', null, 'some-new-pipeline:v2']) {
      assert.strictEqual(tierForSource(source), DEFAULT_TIER, `${source} must not be assumed observed`);
    }
  });

  it('counts the store by family and raises nothing that is already at its tier', () => {
    seed('backfill/from-harvest.md', 'harvest:aaa');
    seed('backfill/from-harvest-2.md', 'harvest:bbb');
    seed('backfill/from-manual.md', 'manual');
    seed('backfill/from-nothing.md', null);
    seed('backfill/from-elsewhere.md', 'some-new-pipeline:v2');

    const plan = backfillTiers({ apply: false });
    const byFamily = Object.fromEntries(plan.families.map(f => [f.family, f]));
    assert.ok(byFamily.harvest.count >= 2);
    assert.ok(byFamily.manual.count >= 1);
    assert.ok(byFamily.other.count >= 1);
    for (const f of plan.families) assert.strictEqual(f.tier, DEFAULT_TIER);
    assert.strictEqual(plan.raised, 0, 'nothing is below the tier its provenance proves');
    assert.strictEqual(plan.applied, false);
  });

  it('never lowers a note that earned its tier', () => {
    const id = seed('backfill/promoted-from-harvest.md', 'harvest:ccc');
    promoteDocumentTier(id, { tier: TIER.VERIFIED, confirmedBy: 'tests/backfill.test.js' });
    backfillTiers({ apply: true });
    assert.strictEqual(getDocument(id).tier, TIER.VERIFIED, 'a re-run of the backfill must not undo a confirmation');
  });
});

describe('the schema itself refuses an invalid tier', () => {
  it('rejects a tier outside the vocabulary at the database level', () => {
    assert.throws(
      () => getDb().prepare("INSERT INTO documents (title, content, doc_type, tier) VALUES ('x', 'y', 'note', 'trustworthy')").run(),
      /CHECK constraint failed/,
    );
  });

  it('gives every row a tier, with no unlabelled state', () => {
    const nulls = getDb().prepare('SELECT COUNT(*) c FROM documents WHERE tier IS NULL').get().c;
    assert.strictEqual(nulls, 0);
  });
});

// Ranking preference: every retrieval surface must break a near-tie the same
// way. Written after the two semantic surfaces disagreed with kb_search and
// with each other — one compared raw scores, which put the preference out of
// reach for anything the scorer had actually separated.
describe('a near-tie prefers what was confirmed, on every surface', () => {
  const bySemantic = (a, b) => byScoreThenTier(a, b, r => r.score, SCORE_BUCKET);

  it('prefers the confirmed note when scores differ by less than the bucket', () => {
    // The confirmed note scores LOWER here on purpose: if it scored higher,
    // sorting by raw score alone would give the same answer and this would
    // pass with the tie-break deleted.
    const ordered = [
      { score: 0.8129, tier: TIER.INFERRED },
      { score: 0.8123, tier: TIER.VERIFIED },
    ].sort(bySemantic);
    assert.strictEqual(ordered[0].tier, TIER.VERIFIED);
  });

  it('does not let tier outrank a materially better match', () => {
    const ordered = [
      { score: 0.95, tier: TIER.INFERRED },
      { score: 0.80, tier: TIER.VERIFIED },
    ].sort(bySemantic);
    assert.strictEqual(ordered[0].score, 0.95, 'standing breaks ties, it does not overrule relevance');
  });

  it('stays a valid ordering under every combination', () => {
    const rows = [];
    for (const score of [0, 0.8, 0.804, 0.805, 0.806, 0.81, 0.999, 1]) {
      for (const tier of TIERS) rows.push({ score, tier });
    }
    for (const a of rows) {
      for (const b of rows) {
        // Not strictEqual: a tie gives 0 and -0, which Object.is separates.
        assert.ok(
          Math.sign(bySemantic(a, b)) === -Math.sign(bySemantic(b, a)),
          'comparator must be antisymmetric',
        );
        for (const c of rows) {
          if (bySemantic(a, b) <= 0 && bySemantic(b, c) <= 0) {
            assert.ok(bySemantic(a, c) <= 0, 'comparator must be transitive');
          }
        }
      }
    }
  });

  it('orders bm25 rank the same way, lower being better', () => {
    const ordered = preferConfirmed([
      { rank: -11.4, tier: TIER.INFERRED },
      { rank: -11.3, tier: TIER.VERIFIED },
    ]);
    assert.strictEqual(ordered[0].tier, TIER.VERIFIED, 'kb_search buckets ranks the same way');
  });

  it('keeps a clearly better bm25 rank ahead of a confirmed note', () => {
    const ordered = preferConfirmed([
      { rank: -11.0, tier: TIER.VERIFIED },
      { rank: -25.0, tier: TIER.INFERRED },
    ]);
    assert.strictEqual(ordered[0].rank, -25.0);
  });
});

// The FTS-only cohort. These rows are merged carrying a bm25 rank and a
// placeholder semantic score of 0, so ranking them on the semantic scale put
// every one of them in the same bucket and handed the ordering to tier alone.
// A large relevance gap then lost to standing — and worst in the fallback,
// where a semantic failure makes every row FTS-only.
describe('hybrid merge ranks each group on the scale it actually carries', () => {
  const ftsOnly = () => [
    { title: 'best match', fts_rank: -28.4, tier: TIER.INFERRED, semantic_score: 0, source: 'fts' },
    { title: 'second', fts_rank: -25.1, tier: TIER.INFERRED, semantic_score: 0, source: 'fts' },
    { title: 'third', fts_rank: -19.0, tier: TIER.OBSERVED, semantic_score: 0, source: 'fts' },
    { title: 'barely matched', fts_rank: -12.2, tier: TIER.VERIFIED, semantic_score: 0, source: 'fts' },
  ];

  it('does not let standing overrule a large bm25 gap', () => {
    const ordered = ftsOnly().sort(hybridMergeOrder).map(r => r.title);
    assert.deepStrictEqual(ordered, ['best match', 'second', 'third', 'barely matched']);
  });

  it('still prefers the confirmed note inside one bm25 bucket', () => {
    const ordered = [
      { title: 'unconfirmed', fts_rank: -20.4, tier: TIER.INFERRED, source: 'fts' },
      { title: 'confirmed', fts_rank: -20.3, tier: TIER.VERIFIED, source: 'fts' },
    ].sort(hybridMergeOrder);
    assert.strictEqual(ordered[0].title, 'confirmed');
  });

  it('keeps rows found by both methods ahead of either alone', () => {
    const ordered = [
      { title: 'fts only', fts_rank: -30, tier: TIER.VERIFIED, semantic_score: 0, source: 'fts' },
      { title: 'semantic only', semantic_score: 0.9, tier: TIER.INFERRED, source: 'semantic' },
      { title: 'both', semantic_score: 0.5, tier: TIER.INFERRED, source: 'both' },
    ].sort(hybridMergeOrder);
    assert.deepStrictEqual(ordered.map(r => r.title), ['both', 'semantic only', 'fts only']);
  });

  it('stays a valid ordering across mixed groups', () => {
    const rows = [];
    for (const source of ['both', 'semantic', 'fts']) {
      for (const tier of TIERS) {
        for (const n of [0, 0.5, 0.9]) {
          rows.push({ source, tier, semantic_score: source === 'fts' ? 0 : n, fts_rank: -30 * n });
        }
      }
    }
    for (const a of rows) {
      for (const b of rows) {
        assert.ok(
          Math.sign(hybridMergeOrder(a, b)) === -Math.sign(hybridMergeOrder(b, a)),
          'comparator must be antisymmetric',
        );
        for (const c of rows) {
          if (hybridMergeOrder(a, b) <= 0 && hybridMergeOrder(b, c) <= 0) {
            assert.ok(hybridMergeOrder(a, c) <= 0, 'comparator must be transitive');
          }
        }
      }
    }
  });
});
