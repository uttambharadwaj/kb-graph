import './helpers/tmp-kb.js';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import corpus from './fixtures/hint-real-prompt-eval.json' with { type: 'json' };
import { getDb } from '../src/db.js';
import { relevantNotes } from '../src/hint-relevance.js';

const REQUIRED_CASES = new Set([
  'confirmed-review-process-nudge',
  'successful-cursor-policy-fire',
  'confirmed-local-harness-nudge',
  'natural-retrieval-rollout',
  'ordinary-approval-is-not-policy',
  'quoted-handoff-contamination',
  'quoted-natural-retrieval-is-not-a-request',
  'optional-kb-in-prototype-spec',
]);
const REQUIRED_KINDS = new Set([
  'nudge-after-decline',
  'successful-fire',
  'deliberate-silence-after-nudge',
  'contaminated-nudge-label',
]);

before(() => {
  const insert = getDb().prepare(
    'INSERT INTO documents (title, content, doc_type, tags) VALUES (?, ?, ?, ?)'
  );
  for (const note of corpus.documents) {
    insert.run(note.title, note.content, note.doc_type, note.tags);
  }
  for (let i = 0; i < 260; i++) {
    insert.run(
      `Unrelated reference ${i}`,
      `Background material zq${i}xj${i}kv with no evaluated subject.`,
      'note',
      'misc',
    );
  }
});

function evaluate() {
  const cases = corpus.cases.map((entry) => {
    const hits = relevantNotes(entry.prompt);
    const relevant = new Set(entry.relevant_titles);
    return {
      ...entry,
      hit_titles: hits.map(hit => hit.title),
      recalled: hits.some(hit => relevant.has(hit.title)),
      false_positives: hits.filter(hit => !relevant.has(hit.title)).map(hit => hit.title),
    };
  });
  const useful = cases.filter(entry => entry.relevant_titles.length > 0);
  const relevantHits = cases.reduce(
    (count, entry) => count + entry.hit_titles.filter(title => entry.relevant_titles.includes(title)).length,
    0,
  );
  const totalHits = cases.reduce((count, entry) => count + entry.hit_titles.length, 0);
  const answerless = cases.filter(entry => entry.relevant_titles.length === 0);
  return {
    cases,
    useful: useful.length,
    recalled: useful.filter(entry => entry.recalled).length,
    precision: totalHits === 0 ? 1 : relevantHits / totalHits,
    answerless: answerless.length,
    answerlessInterrupted: answerless.filter(entry => entry.hit_titles.length > 0).length,
  };
}

describe('scrubbed real-prompt hint evaluation', () => {
  it('keeps the audited positive and negative strata intact and redistributable', () => {
    const titles = new Set(corpus.documents.map(note => note.title));
    const ids = new Set(corpus.cases.map(entry => entry.id));
    const kinds = new Set(corpus.cases.map(entry => entry.kind));
    for (const id of REQUIRED_CASES) assert.ok(ids.has(id), `missing audited case: ${id}`);
    for (const kind of REQUIRED_KINDS) assert.ok(kinds.has(kind), `missing audit stratum: ${kind}`);
    for (const entry of corpus.cases) {
      for (const title of entry.relevant_titles) {
        assert.ok(titles.has(title), `${entry.id} references an unseeded note: ${title}`);
      }
      if (entry.primary_title) {
        assert.ok(entry.relevant_titles.includes(entry.primary_title), `${entry.id} has an ungraded primary`);
      }
    }
    const serialized = JSON.stringify(corpus);
    assert.doesNotMatch(serialized, /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
    assert.doesNotMatch(serialized, /\/Users\/|\/home\/|[A-Z]:\\/);
    assert.doesNotMatch(serialized, /\b(?:api[_-]?key|password|secret|token)\s*[:=]/i);
  });

  it('recalls every useful prompt without surfacing a negative-control note', (t) => {
    const result = evaluate();
    t.diagnostic(
      `precision ${(result.precision * 100).toFixed(0)}% — `
      + `useful recall ${result.recalled}/${result.useful} — `
      + `answerless interruptions ${result.answerlessInterrupted}/${result.answerless}`,
    );
    assert.equal(
      result.recalled,
      result.useful,
      JSON.stringify(result.cases, null, 2),
    );
    assert.equal(result.precision, 1, JSON.stringify(result.cases, null, 2));
    assert.equal(result.answerlessInterrupted, 0, JSON.stringify(result.cases, null, 2));
  });

  it('ranks current state and decisions before accumulated lessons', () => {
    const result = evaluate();
    for (const entry of result.cases.filter(item => item.primary_title)) {
      assert.equal(
        entry.hit_titles[0],
        entry.primary_title,
        `${entry.id}: ${entry.hit_titles.join(' | ')}`,
      );
    }
  });

  it('limits the curated recovery to the reviewed, unquoted phrase', () => {
    const expected = 'PR reviewer fanout is the current review checkpoint';
    assert.equal(
      relevantNotes('Fan out the per-PR reviewers now.')[0]?.title,
      expected,
    );
    assert.equal(
      relevantNotes("let's fan out the per-PR reviewers now, it's time")[0]?.title,
      expected,
    );
    for (const prompt of [
      'fan out the reviewers now',
      'fan out benchmark jobs while the reviewers wait',
      'fan out the per-issue reviewers now',
      'ask the per-PR reviewers to fan out now',
      "'fan out the per-PR reviewers now'",
      '`fan out the per-PR reviewers now`',
      'Regression test prompt: fan out the per-PR reviewers now. Assert that the hint fires.',
    ]) {
      assert.deepEqual(relevantNotes(prompt), [], prompt);
    }
  });
});
