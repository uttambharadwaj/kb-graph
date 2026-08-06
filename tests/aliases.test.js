// Retrieval aliases: the gate that lets a note be found by a subject word its
// body uses but its title does not — without reopening the door that
// body-as-identity was measured to open (fire rate 49% -> 91%, almost all of
// it conversational filler; see hint-recall.test.js for that measurement).
//
// The live case this models is real: "how does the vault indexer work"
// declined against a store whose only note on the subject says "indexer" in
// its body alone. Every widening of what counts as identity failed the same
// way — body, summary, key topics are all ordinary working English — so the
// gate here admits single tokens, each vetted three ways: the note's own
// vocabulary, absent from its title and tags, and rare in the corpus.
import './helpers/tmp-kb.js';
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { getDb } from '../src/db.js';
import { relevantNotes, filterAliases } from '../src/hint-relevance.js';

// The #1282 shape: the subject word lives in the body, the title is about
// what the subject does. No prompt that names the subject can cover this
// title.
const NOTE = {
  title: 'Only the write path embeds a note',
  content: 'the vault indexer is what embeds a document after a write; insertDocument alone does not',
  tags: 'knowledge-base',
};

const CAP_BODY = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';
const singleton = (i) => `zq${i}xj${i}kv`;

before(() => {
  const insert = getDb().prepare('INSERT INTO documents (title, content, doc_type, tags) VALUES (?, ?, ?, ?)');
  insert.run(NOTE.title, NOTE.content, 'lesson', NOTE.tags);
  insert.run('Cap fixture', CAP_BODY, 'note', '');
  // A word the whole corpus uses is a working word however legitimately this
  // note also uses it — these rows give "pipeline" a frequency above the
  // ceiling.
  for (let i = 0; i < 60; i++) {
    getDb().prepare('INSERT INTO documents (title, content, doc_type, tags) VALUES (?, ?, ?, ?)')
      .run(`Pipeline report ${i}`, 'pipeline ran clean', 'note', 'ops');
  }
  // ...and "sweeper" a mid-band frequency: ~6% of the corpus, nowhere near
  // saturated, still too common to be the distinctive half of a match. The
  // live backfill's regressions ("gaps" at 3.3%, "cleanup" at 6.9%) sat
  // exactly in this band, under the query's 15% ceiling.
  for (let i = 0; i < 20; i++) {
    getDb().prepare('INSERT INTO documents (title, content, doc_type, tags) VALUES (?, ?, ?, ?)')
      .run(`Sweeper log ${i}`, 'sweeper collected rows', 'note', 'ops');
  }
  // A term found in exactly one document is dropped from the query as a
  // one-off identifier, so the subject words recur once in a filler BODY —
  // moving df without creating a second note that could be recalled instead.
  insert.run('Filler mention', 'the vault indexer came up in passing here', 'note', 'misc');
  for (let i = 0; i < 260; i++) insert.run(`Filler ${i}`, `unremarkable prose ${singleton(i)}`, 'note', 'misc');
});

describe('filterAliases', () => {
  it('keeps a token the note uses and the corpus does not overuse', () => {
    const kept = filterAliases(['vault indexer'], NOTE);
    assert.deepStrictEqual(kept.split(' ').sort(), ['indexer', 'vault']);
  });

  it('drops a proposed synonym the note never uses', () => {
    // The fabrication class: a model asked for search terms will helpfully
    // offer the word it would have used. If the note does not say it, an
    // alias saying it grounds a claim the note cannot support.
    assert.strictEqual(filterAliases(['vectorizer'], NOTE), '');
  });

  it('drops tokens already carried by title or tags', () => {
    assert.strictEqual(filterAliases(['write path', 'knowledge'], NOTE), '');
  });

  it('drops a token the corpus is saturated with, even when the note uses it', () => {
    const note = { title: 'Nightly run order', tags: 'ops', content: 'the pipeline replays each stage' };
    assert.strictEqual(filterAliases(['pipeline'], note), '');
  });

  it('drops a mid-band working word — the ceiling is stricter than the query\'s', () => {
    const note = { title: 'Nightly run order', tags: 'ops', content: 'the sweeper replays each stage' };
    assert.strictEqual(filterAliases(['sweeper'], note), '');
  });

  it('caps how many tokens survive, rarest first', () => {
    const kept = filterAliases(CAP_BODY.split(' '), { title: 'Cap fixture', tags: '', content: CAP_BODY });
    assert.strictEqual(kept.split(' ').length, 8);
  });

  it('tolerates a hand-written string and empty input', () => {
    assert.deepStrictEqual(filterAliases('vault indexer', NOTE).split(' ').sort(), ['indexer', 'vault']);
    assert.strictEqual(filterAliases(undefined, NOTE), '');
    assert.strictEqual(filterAliases([], NOTE), '');
  });
});

describe('relevantNotes with aliases', () => {
  it('reaches a note only its aliases name, and only once they are set', () => {
    const prompt = 'how does the vault indexer work';
    assert.deepStrictEqual(relevantNotes(prompt), [], 'reachable before aliases — fixture no longer isolates them');
    getDb().prepare('UPDATE documents SET aliases = ? WHERE title = ?').run('vault indexer', NOTE.title);
    const hits = relevantNotes(prompt);
    assert.ok(hits.some(h => h.title === NOTE.title), `expected "${NOTE.title}", got: ${hits.map(h => h.title).join(', ') || '(decline)'}`);
  });

  it('still declines conversational filler when notes carry aliases', () => {
    const FILLER_PROMPTS = [
      'let us note that down somewhere and move on to another topic',
      'first thing, make sure all of these gaps are tracked properly',
      'do the backfill but like you said, how will you prove it',
    ];
    const fired = FILLER_PROMPTS
      .map(prompt => ({ prompt, hits: relevantNotes(prompt) }))
      .filter(r => r.hits.length > 0);
    assert.deepStrictEqual(fired.map(r => `${r.prompt} -> ${r.hits.map(h => h.title).join(', ')}`), []);
  });

  // The two shapes the full-corpus backfill actually produced, pinned from the
  // live probe diff (2026-08-06). These insert notes, so they run after every
  // assertion about the fixture as it stood.
  it('counts an alias that inflects a title token as the same evidence, not more', () => {
    getDb().prepare('INSERT INTO documents (title, content, doc_type, tags, aliases) VALUES (?, ?, ?, ?, ?)')
      .run('Relative windows clip backfills', 'a backfill derives its window from the target date', 'lesson', 'observability', 'backfill');
    // "backfills" (title) and "backfill" (alias) are covered by the same
    // prompt word: two tokens, one subject — one family, under the two-family
    // gate. Live, this exact shape put a LogsQL note under "do the backfill
    // but how will you prove it", and its siblings put an EC2 thread under
    // "thread"/"threads" and a review workflow under "review"/"reviewer".
    const hits = relevantNotes('do the backfill but like you said, how will you prove it');
    assert.deepStrictEqual(hits.map(h => h.title), []);
  });

  it('scores a family at its rarest spelling, which is the one the prompt named', () => {
    // "indexer" (alias, rare) folds into one family with the title's common
    // "index": counted once — but at the rare spelling's idf, which is what
    // carries the note over the bar. Fold to the common spelling instead and
    // the recovered live case (#1282) regresses to a decline.
    getDb().prepare('INSERT INTO documents (title, content, doc_type, tags, aliases) VALUES (?, ?, ?, ?, ?)')
      .run('The vault index path embeds every note', 'only the vault indexer generates embeddings', 'lesson', 'knowledge-base', 'indexer');
    const hits = relevantNotes('how does the vault indexer work');
    assert.ok(hits.some(h => h.title === 'The vault index path embeds every note'),
      `expected the aliased note, got: ${hits.map(h => h.title).join(', ') || '(decline)'}`);
  });
});

describe('aliases-backfill selection', () => {
  it('asks only notes whose frontmatter has never carried an aliases key', async () => {
    const { neverAsked } = await import('../src/cli/aliases-backfill.js');
    const { mkdtempSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = mkdtempSync(join(tmpdir(), 'alias-backfill-'));
    writeFileSync(join(dir, 'unasked.md'), '---\ntitle: A\n---\nbody');
    writeFileSync(join(dir, 'asked-empty.md'), '---\ntitle: B\naliases: []\n---\nbody');
    writeFileSync(join(dir, 'asked.md'), '---\ntitle: C\naliases: [indexer]\n---\nbody');
    assert.strictEqual(neverAsked(join(dir, 'unasked.md')), true);
    assert.strictEqual(neverAsked(join(dir, 'asked-empty.md')), false, 'an empty list still means "asked"');
    assert.strictEqual(neverAsked(join(dir, 'asked.md')), false);
    assert.strictEqual(neverAsked(join(dir, 'missing.md')), false);
  });
});
