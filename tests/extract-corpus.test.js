import './helpers/tmp-kb.js'; // MUST be first — canonicalization imports src/paths.js
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { scoreExtractCorpus } from './helpers/extract-corpus.js';

const corpus = JSON.parse(readFileSync(
  new URL('./fixtures/extract-debrief-corpus.json', import.meta.url),
  'utf8',
));

const joined = (...parts) => parts.join('');
const FORBIDDEN_FIXTURE_IDENTIFIERS = [
  ['internal ticket prefix', new RegExp(`\\b${joined('p', 'f')}(?:-|_)?\\d+\\b`, 'i')],
  ['teammate name', new RegExp(`\\b(?:${[
    joined('ut', 'tam'), joined('cath', 'erine'), joined('za', 'ck'), joined('wil', 'ly'),
  ].join('|')})\\b`, 'i')],
  ['internal service name', new RegExp(`\\b(?:${[
    joined('ux', '-labs'), joined('vault', '-service'), joined('tf', '-browser'),
    joined('tet', 'ra'), joined('e', 'va'),
  ].join('|')})\\b`, 'i')],
];

const testDir = dirname(fileURLToPath(import.meta.url));
const thisFile = fileURLToPath(import.meta.url);
const publicFixtureFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return publicFixtureFiles(path);
  if (!/\.(?:js|json|md)$/.test(entry.name) || path === thisFile) return [];
  return [path];
});

describe('held-out extraction corpus', () => {
  it('contains ten debrief-shaped cases with expected triples', () => {
    assert.strictEqual(corpus.schema_version, 1);
    assert.strictEqual(corpus.cases.length, 10);
    assert.ok(corpus.cases.every(fixture => fixture.input.length >= 100));
    assert.ok(corpus.cases.every(fixture => fixture.expected.length > 0));
    assert.strictEqual(corpus.baseline.matched, 23);
    assert.strictEqual(corpus.baseline.expected, 29);
    assert.strictEqual(corpus.baseline.recall, 23 / 29);
  });

  it('contains no internal fixture identifiers', () => {
    const publicFixtures = publicFixtureFiles(testDir)
      .map(path => readFileSync(path, 'utf8'))
      .join('\n');
    for (const [label, pattern] of FORBIDDEN_FIXTURE_IDENTIFIERS) {
      assert.doesNotMatch(publicFixtures, pattern, `${label} leaked into a public extraction fixture`);
    }
  });

  it('scores exact canonical triples and reports per-case misses', () => {
    const fixture = {
      cases: [{
        id: 'one',
        expected: [
          { subject: 'PR #12', predicate: 'merged_as', object: 'Commit ABC123' },
          { subject: 'service-a', predicate: 'deployed_to', object: 'sandbox' },
        ],
      }],
    };
    const score = scoreExtractCorpus(fixture, [{
      id: 'one',
      facts: [{ subject: 'pr_#12', predicate: 'merged_via', object: 'commit abc123' }],
    }]);

    assert.strictEqual(score.matched, 1);
    assert.strictEqual(score.expected, 2);
    assert.strictEqual(score.recall, 0.5);
    assert.deepStrictEqual(score.cases[0].missing, ['service_a|deployed_to|sandbox']);
  });
});
