import './helpers/tmp-kb.js'; // MUST be first — redirects the DB to a temp dir
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { getDb, insertDocument } from '../src/db.js';
import {
  compareHintProbeRows,
  HINT_PROBE_STATUS,
  hintProbe,
  runHintProbeCli,
} from '../src/cli/hint-probe.js';
import { SURFACE } from '../src/retrieval.js';

const COLLIDING_EXCERPT = 'z'.repeat(64);
const COLLIDING_DIGESTS = new Set([
  '9d216b76ca5753615378b6b66b12620e129c3246f78d126eb8706288cd1b631e',
  '2b5e0fec23c943b32acc4d14920bc93e2f2ca0b1144cd35421a8cc333f0c32c8',
]);

const recordPrompt = (query, docId = null) =>
  getDb().prepare('INSERT INTO retrievals (doc_id, surface, query, session) VALUES (?, ?, ?, ?)')
    .run(docId, SURFACE.HINT, query, 'probe-session');

const captureCli = args => {
  const lines = [];
  const originalLog = console.log;
  console.log = (...parts) => lines.push(parts.join(' '));
  try {
    runHintProbeCli(args);
  } finally {
    console.log = originalLog;
  }
  return lines.join('\n');
};

describe('hint-probe', () => {
  before(() => {
    insertDocument({
      title: 'Kraken deployment rollback procedure',
      content: 'How to roll back a kraken deployment when the canary fails.',
      doc_type: 'workflow',
      tags: 'kraken, deployment',
    });
    recordPrompt('how do I do a kraken deployment rollback when the canary fails');
    recordPrompt('ok great lets move on to the next thing then and wrap up here');
    // The same prompt twice: replaying it twice would double-count a single
    // question and quietly weight whatever the user happened to repeat.
    recordPrompt('ok great lets move on to the next thing then and wrap up here');
    recordPrompt(`${COLLIDING_EXCERPT} private suffix alpha`);
    recordPrompt(`${COLLIDING_EXCERPT} private suffix beta`);
    recordPrompt('  whitespace     is normalized in the visible excerpt  ');
  });

  it('replays each distinct prompt once and splits fired from declined', () => {
    const { total, fired, rows } = hintProbe();
    assert.strictEqual(total, 5, 'the repeated prompt is one case, but colliding excerpts remain distinct');
    assert.strictEqual(fired, 1);

    assert.match(rows.find(r => r.hits.length)?.prompt, /kraken deployment rollback/);
    assert.ok(rows.some(r => /lets move on/.test(r.prompt)));
    assert.ok(rows.some(r => r.prompt === 'whitespace is normalized in the visible excerpt'));
  });

  it('gives distinct full-query identities to prompts with the same excerpt', () => {
    const first = hintProbe().rows;
    const second = hintProbe().rows;
    const collisions = first.filter(r => r.prompt === COLLIDING_EXCERPT);
    assert.strictEqual(collisions.length, 2);
    assert.strictEqual(new Set(collisions.map(r => r.prompt_sha256)).size, 2);
    assert.ok(collisions.every(r => /^[0-9a-f]{64}$/.test(r.prompt_sha256)));
    assert.deepStrictEqual(new Set(collisions.map(r => r.prompt_sha256)), COLLIDING_DIGESTS);
    assert.deepStrictEqual(first.map(r => r.prompt_sha256), second.map(r => r.prompt_sha256));
    assert.deepStrictEqual(first.map(r => r.prompt), [
      'whitespace is normalized in the visible excerpt',
      'how do I do a kraken deployment rollback when the canary fails',
      'ok great lets move on to the next thing then and wrap up here',
      COLLIDING_EXCERPT,
      COLLIDING_EXCERPT,
    ]);
    assert.ok(collisions.every(r => !JSON.stringify(r).includes('private suffix')));
  });

  it('pairs reordered baseline and candidate rows by identity, not excerpt or position', () => {
    const [alpha, beta] = hintProbe().rows.filter(r => r.prompt === COLLIDING_EXCERPT);
    const removed = { prompt_sha256: 'e'.repeat(64), prompt: 'removed prompt', hits: [] };
    const candidate = [
      { prompt_sha256: 'f'.repeat(64), prompt: 'later added prompt', hits: [] },
      { ...beta, hits: [{ id: 999, title: 'Changed result' }] },
      alpha,
      { prompt_sha256: 'd'.repeat(64), prompt: 'earlier added prompt', hits: [] },
    ];

    const compared = compareHintProbeRows([alpha, beta, removed], candidate);
    assert.deepStrictEqual(compared.map(row => row.status), [
      HINT_PROBE_STATUS.UNCHANGED,
      HINT_PROBE_STATUS.CHANGED,
      HINT_PROBE_STATUS.REMOVED,
      HINT_PROBE_STATUS.ADDED,
      HINT_PROBE_STATUS.ADDED,
    ]);
    assert.deepStrictEqual(compared.slice(-2).map(row => row.prompt_sha256), ['d'.repeat(64), 'f'.repeat(64)]);
    const changed = compared.find(row => row.status === HINT_PROBE_STATUS.CHANGED);
    assert.strictEqual(changed.before.prompt_sha256, beta.prompt_sha256);
    assert.strictEqual(changed.after.hits[0].id, 999);
    assert.strictEqual(compared[0].before.prompt_sha256, alpha.prompt_sha256);
  });

  it('treats hit ordering as a ranking change and rejects duplicate identities', () => {
    const before = { prompt_sha256: 'a'.repeat(64), prompt: 'ranked', hits: [{ id: 1 }, { id: 2 }] };
    const after = { ...before, hits: [{ id: 2 }, { id: 1 }] };
    assert.strictEqual(compareHintProbeRows([before], [after])[0].status, HINT_PROBE_STATUS.CHANGED);
    assert.throws(
      () => compareHintProbeRows([{ prompt: 'missing identity', hits: [] }], [after]),
      /baseline row has invalid prompt_sha256/
    );
    assert.throws(
      () => compareHintProbeRows([before], [{ ...after, prompt_sha256: 'ABC123' }]),
      /candidate row has invalid prompt_sha256/
    );
    assert.throws(
      () => compareHintProbeRows([before, before], [after]),
      /baseline contains duplicate prompt identity/
    );
    assert.throws(
      () => compareHintProbeRows([before], [after, after]),
      /candidate contains duplicate prompt identity/
    );
  });

  it('names the notes a prompt fired on, so two runs diff meaningfully', () => {
    const hit = hintProbe().rows.find(r => r.hits.length);
    assert.match(hit.hits[0].title, /Kraken deployment rollback/);
    assert.ok(Number.isInteger(hit.hits[0].id));
  });

  it('writes no meter rows — an instrument that logs changes what it measures', () => {
    const count = () => getDb().prepare('SELECT COUNT(*) c FROM retrievals').get().c;
    const before = count();
    hintProbe();
    assert.strictEqual(count(), before);
  });

  it('can carry the scorer explanation without reimplementing it', () => {
    const hit = hintProbe(undefined, { explain: true }).rows.find(r => r.hits.length)?.hits[0];
    assert.ok(hit?.evidence?.families?.length >= 2, JSON.stringify(hit));
    assert.ok(hit.evidence.families.every(family => Array.isArray(family.sources)));
  });

  it('prints collision-safe machine-readable rows without full prompt text', () => {
    const output = captureCli(['--json', '--explain']);
    const report = JSON.parse(output);
    assert.strictEqual(report.rows.length, 5);
    assert.strictEqual(new Set(report.rows.map(row => row.prompt_sha256)).size, 5);
    assert.doesNotMatch(output, /private suffix/);
    assert.ok(compareHintProbeRows(report.rows, report.rows).every(
      row => row.status === HINT_PROBE_STATUS.UNCHANGED
    ));
  });

  it('keeps human output readable while distinguishing colliding excerpts', () => {
    const output = captureCli([]);
    assert.strictEqual(output, captureCli([]), 'human output order must be deterministic');
    const collisions = output.split('\n').filter(line => line.endsWith(COLLIDING_EXCERPT));
    assert.strictEqual(collisions.length, 2);
    assert.ok(collisions.every(line => /\[[0-9a-f]{12}\]/.test(line)));
    assert.strictEqual(new Set(collisions.map(line => line.match(/\[([0-9a-f]{12})\]/)[1])).size, 2);
  });
});
