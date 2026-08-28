import { canonicalEntityId } from '../../src/facts.js';
import { canonicalTriple } from '../../src/predicates.js';

export function corpusTripleKey(raw) {
  const triple = canonicalTriple(raw);
  return [
    canonicalEntityId(triple.subject),
    triple.predicate,
    canonicalEntityId(triple.object),
  ].join('|');
}

export function scoreExtractCorpus(corpus, predictions) {
  const byCase = new Map(predictions.map(prediction => [prediction.id, prediction.facts]));
  const cases = corpus.cases.map((fixture) => {
    const actual = new Set((byCase.get(fixture.id) || []).map(corpusTripleKey));
    const expected = fixture.expected.map(corpusTripleKey);
    const missing = expected.filter(key => !actual.has(key));
    return {
      id: fixture.id,
      matched: expected.length - missing.length,
      expected: expected.length,
      missing,
    };
  });
  const matched = cases.reduce((sum, fixture) => sum + fixture.matched, 0);
  const expected = cases.reduce((sum, fixture) => sum + fixture.expected, 0);
  return {
    matched,
    expected,
    recall: expected === 0 ? 1 : matched / expected,
    cases,
  };
}
