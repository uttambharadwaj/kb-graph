import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { DUP_THRESHOLD, duplicatesIn } from '../src/embeddings/search.js';
import { DUP_THRESHOLD as WRITE_THRESHOLD } from '../src/write-note.js';
import { embeddableBody } from '../src/vault/indexer.js';
import { getToolDefinitions } from '../src/tools.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => readFileSync(join(SRC, rel), 'utf8');

const scored = (...pairs) => pairs.map(([document_id, score], i) => ({
  document_id, score, title: `note ${document_id}`, tags: `t${i}`,
}));

describe('duplicate verdict is one decision', () => {
  // The bug this file exists for: kb_check_duplicate was documented as the
  // pre-check for kb_write while answering at a different threshold, so a
  // caller who followed the instructions exactly still wrote duplicates.
  it('kb_check_duplicate defaults to the threshold the write path uses', () => {
    const tool = getToolDefinitions().find(t => t.name === 'kb_check_duplicate');
    assert.strictEqual(tool.schema.threshold.parse(undefined), DUP_THRESHOLD);
    assert.strictEqual(WRITE_THRESHOLD, DUP_THRESHOLD, 'write-note must re-export, not redeclare');
  });

  // A second copy of the number is how they drifted apart the first time, and
  // it drifts silently — nothing type-checks a float against another float.
  it('no module restates the threshold as a literal', () => {
    const offenders = ['write-note.js', 'tools.js', 'cli/link-backfill.js']
      .filter(f => new RegExp(`${DUP_THRESHOLD}`.replace('.', '\\.')).test(read(f)));
    assert.deepStrictEqual(offenders, [], 'import DUP_THRESHOLD instead of repeating its value');
  });

  it('both paths call the shared verdict rather than filtering themselves', () => {
    for (const f of ['write-note.js', 'embeddings/search.js']) {
      assert.match(read(f), /duplicatesIn\(/, `${f} must route its verdict through duplicatesIn`);
    }
  });

  it('treats the threshold as inclusive, and only the threshold', () => {
    const at = duplicatesIn(scored([1, DUP_THRESHOLD]));
    assert.deepStrictEqual(at.map(m => m.document_id), [1], 'a score exactly at the threshold is a duplicate');
    assert.deepStrictEqual(duplicatesIn(scored([2, DUP_THRESHOLD - 0.0001])), []);
  });

  it('reports the fields a caller needs to act on the match', () => {
    assert.deepStrictEqual(duplicatesIn(scored([7, 0.9123])), [
      { document_id: 7, title: 'note 7', tags: 't0', similarity: 0.912 },
    ]);
  });

  it('honours an explicit threshold for callers exploring rather than pre-checking', () => {
    assert.deepStrictEqual(duplicatesIn(scored([1, 0.7], [2, 0.6]), 0.65).map(m => m.document_id), [1]);
  });
});

describe('embeddable body', () => {
  // Whether a note's vector included its Related section used to depend on
  // which of the two embedding sites produced it, so two notes were only
  // comparable if they happened to be indexed the same way.
  it('drops the auto-appended Related section', () => {
    assert.strictEqual(embeddableBody('body text\n\n## Related\n- [[a]] — A (0.9)\n'), 'body text');
  });

  it('leaves a body that has no Related section alone', () => {
    assert.strictEqual(embeddableBody('just a body'), 'just a body');
  });

  // A heading the author wrote, mid-note, is content — only the trailing
  // generated block comes off.
  it('keeps prose that merely mentions related work', () => {
    const body = 'see the Related work below\n\nmore body';
    assert.strictEqual(embeddableBody(body), body);
  });

  it('truncates to the window the embedder is given', () => {
    assert.strictEqual(embeddableBody('x'.repeat(2500)).length, 2000);
  });

  // The strip has to happen before the cut, or a long note keeps the section
  // that a short note drops — which is the inconsistency, not the fix.
  it('strips before truncating, so length cannot decide the content', () => {
    const body = `${'x'.repeat(1990)}\n\n## Related\n- [[a]] — A (0.9)\n`;
    assert.strictEqual(embeddableBody(body), 'x'.repeat(1990));
  });

  it('is the only thing either embedding site embeds', () => {
    const indexer = read('vault/indexer.js');
    const calls = [...indexer.matchAll(/generateEmbedding\(([^)]*)\)/g)].map(m => m[1]);
    assert.ok(calls.length >= 2, 'expected both embedding sites');
    for (const arg of calls) assert.match(arg, /^embeddableBody\(/, `raw text embedded: ${arg}`);
  });
});
