import './helpers/tmp-kb.js'; // MUST be first — redirects the DB to a temp dir
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { getDb, insertDocument } from '../src/db.js';
import { hintProbe } from '../src/cli/hint-probe.js';
import { SURFACE } from '../src/retrieval.js';

const recordPrompt = (query, docId = null) =>
  getDb().prepare('INSERT INTO retrievals (doc_id, surface, query, session) VALUES (?, ?, ?, ?)')
    .run(docId, SURFACE.HINT, query, 'probe-session');

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
  });

  it('replays each distinct prompt once and splits fired from declined', () => {
    const { total, fired, rows } = hintProbe();
    assert.strictEqual(total, 2, 'the repeated prompt is one case, not two');
    assert.strictEqual(fired, 1);

    const byOutcome = Object.fromEntries(rows.map(r => [r.hits.length > 0, r.prompt]));
    assert.match(byOutcome.true, /kraken deployment rollback/);
    assert.match(byOutcome.false, /lets move on/);
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
});
