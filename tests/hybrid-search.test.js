import './helpers/tmp-kb.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, searchDocuments } from '../src/db.js';
import { env as transformersEnv } from '@huggingface/transformers';
import { hybridMergeOrder, hybridSearch } from '../src/embeddings/search.js';

transformersEnv.allowRemoteModels = false;
transformersEnv.allowLocalModels = false;

function plant({ title = 'quintessence', content = 'quintessence', project = 'wanted', type = 'lesson', retired = false } = {}) {
  const db = getDb();
  const id = db.prepare('INSERT INTO documents (title, content, doc_type, tags, superseded_at) VALUES (?, ?, ?, ?, ?)')
    .run(title, content, type, 'filter-test', retired ? '2026-01-01' : null).lastInsertRowid;
  if (project != null) {
    db.prepare('INSERT INTO vault_files (vault_path, content_hash, document_id, title, project) VALUES (?, ?, ?, ?, ?)')
      .run(`${id}.md`, 'hash', id, title, project);
  }
  return id;
}

describe('hybrid result merging', () => {
  it('ranks vector-backed overlaps ahead of lexical-only matches', () => {
    const both = { id: 1, source: 'both', semantic_score: 0.4, fts_rank: -1, tier: 'inferred' };
    const semantic = { id: 2, source: 'semantic', semantic_score: 0.9, fts_rank: 0, tier: 'verified' };
    const fts = { id: 3, source: 'fts', semantic_score: 0, fts_rank: -10, tier: 'verified' };

    assert.deepEqual([fts, semantic, both].sort(hybridMergeOrder).map(r => r.source), ['both', 'semantic', 'fts']);
  });
});

describe('hybrid filters during semantic failure', () => {
  beforeEach(() => getDb().exec('DELETE FROM embeddings; DELETE FROM vault_files; DELETE FROM documents'));

  for (const filters of [{ project: 'wanted' }, { type: 'lesson' }, { project: 'wanted', type: 'lesson' }]) {
    it(`filters before candidate limits: ${JSON.stringify(filters)}`, async () => {
      // More high-ranked distractors than hybrid's FTS candidate budget.
      for (let i = 0; i < 6; i++) plant({ project: 'other', type: 'research' });
      if (filters.project) plant({ project: null });
      const expected = [
        plant({ title: 'Matching note' }),
        plant({ title: 'Lexical-only note' }),
      ];
      const results = await hybridSearch('quintessence', { ...filters, limit: 2 });
      assert.deepEqual(results.map(r => r.id).sort((a, b) => a - b), expected);
      assert.equal(results.find(r => r.id === expected[0]).source, 'fts');
      assert.equal(results.find(r => r.id === expected[1]).source, 'fts');
    });
  }

  it('applies both filters to stop-word and OR-query fallbacks', async () => {
    plant({ title: 'the', content: 'quintessence missingterm', project: 'other' });
    plant({ title: 'the', content: 'quintessence missingterm', type: 'research' });
    const id = plant({ title: 'the', content: 'quintessence' });
    for (const query of ['the', 'quintessence missingterm']) {
      const rows = await hybridSearch(query, { project: 'wanted', type: 'lesson', limit: 1 });
      assert.deepEqual(rows.map(r => r.id), [id]);
    }
  });

  it('preserves superseded visibility while excluding nonmatching notes', async () => {
    const active = plant();
    const retired = plant({ retired: true });
    plant({ project: 'other', retired: true });
    const options = { project: 'wanted', type: 'lesson', limit: 10 };
    assert.deepEqual((await hybridSearch('quintessence', options)).map(r => r.id), [active]);
    assert.deepEqual((await hybridSearch('quintessence', { ...options, includeSuperseded: true })).map(r => r.id).sort(), [active, retired].sort());
    assert.equal(searchDocuments('quintessence', 10, { ...options, tags: 'absent' }).length, 0);
  });
});
