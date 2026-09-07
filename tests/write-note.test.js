import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { env as transformersEnv } from '@huggingface/transformers';
import { writeNote } from '../src/write-note.js';
import { getDocument } from '../src/db.js';

// Exercise filename allocation even when semantic dedup is unavailable.
transformersEnv.allowRemoteModels = false;
transformersEnv.allowLocalModels = false;
const vault = process.env.OBSIDIAN_VAULT_PATH;
const date = new Date().toISOString().split('T')[0];

describe('note filename collisions', () => {
  for (const [name, titles] of [
    ['same title', ['Collision note', 'Collision note']],
    ['normalized slug', ['Punctuation: collision', 'Punctuation collision!']],
    ['truncated slug', ['a'.repeat(60) + ' first', 'a'.repeat(60) + ' second']],
  ]) {
    it(`preserves distinct notes with the ${name}`, async () => {
      const first = await writeNote(vault, { title: titles[0], content: 'Original body.' });
      const second = await writeNote(vault, { title: titles[1], content: 'Distinct body.' });
      assert.equal(first.skipped, false);
      assert.equal(second.skipped, false);
      assert.equal(second.path, first.path.replace(/\.md$/, '-2.md'));
      assert.ok(first.docId);
      assert.ok(second.docId);
      assert.notEqual(first.docId, second.docId);
      assert.match(readFileSync(join(vault, first.path), 'utf8'), /Original body\./);
      assert.match(getDocument(first.docId).content, /Original body\./);
      assert.match(getDocument(second.docId).content, /Distinct body\./);
    });
  }

  it('preserves an existing file that has not been indexed', async () => {
    mkdirSync(join(vault, 'inbox'), { recursive: true });
    const path = `inbox/${date}-unindexed-collision.md`;
    writeFileSync(join(vault, path), 'Handwritten note.');
    const result = await writeNote(vault, { title: 'Unindexed collision', content: 'New note.' });
    assert.equal(result.path, path.replace(/\.md$/, '-2.md'));
    assert.equal(readFileSync(join(vault, path), 'utf8'), 'Handwritten note.');
  });

  it('allocates separate files and document ids for concurrent writes', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      writeNote(vault, { title: 'Concurrent collision', content: `Concurrent body ${i}.` })
    ));
    const base = `inbox/${date}-concurrent-collision`;
    assert.deepEqual(results.map(r => r.path).sort(),
      [`${base}.md`, ...[2, 3, 4, 5].map(n => `${base}-${n}.md`)].sort());
    assert.equal(new Set(results.map(r => r.docId)).size, 5);
    for (const [i, result] of results.entries()) {
      assert.equal(result.skipped, false);
      assert.ok(result.docId);
      assert.match(readFileSync(join(vault, result.path), 'utf8'), new RegExp(`Concurrent body ${i}\\.`));
      assert.match(getDocument(result.docId).content, new RegExp(`Concurrent body ${i}\\.`));
    }
  });

  it('overwrites only the explicitly targeted note, including a suffixed target', async () => {
    const title = 'Targeted collision';
    const first = await writeNote(vault, { title, content: 'First note.' });
    const target = await writeNote(vault, { title, content: 'Target note.' });
    const corrected = await writeNote(vault, { title, content: 'Corrected target.', excludeId: target.docId });
    assert.equal(corrected.path, target.path);
    assert.equal(corrected.docId, target.docId);
    assert.match(getDocument(first.docId).content, /First note\./);
    assert.match(getDocument(target.docId).content, /Corrected target\./);
  });
});
