import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getDb } from '../src/db.js';
import { getToolDefinitions } from '../src/tools.js';

function tool(name) {
  return getToolDefinitions().find(definition => definition.name === name);
}

describe('specialized capture semantic coverage', () => {
  for (const [name, title, args] of [
    ['kb_capture_youtube', 'Embedding probe video', {
      url: 'https://www.youtube.com/watch?v=embedding-probe',
      transcript: 'A durable explanation of the lease renewal algorithm.',
    }],
    ['kb_capture_web', 'Embedding probe article', {
      url: 'https://example.com/embedding-probe',
      content: 'A durable article about cache invalidation ordering.',
    }],
    ['kb_capture_session', 'Session: Verify capture embeddings', {
      goal: 'Verify capture embeddings',
      lessons: 'Specialized captures must remain visible to semantic duplicate checks.',
    }],
    ['kb_capture_fix', 'Embedding probe fix', {
      symptom: 'A captured fix was absent from semantic search.',
      cause: 'The capture index call omitted embeddings.',
      resolution: 'Index the capture with embeddings enabled.',
    }],
  ]) {
    it(`${name} leaves the semantic corpus complete`, async () => {
      const before = getDb().prepare('SELECT COALESCE(MAX(id), 0) AS id FROM documents').get().id;
      const response = await tool(name).handler({ title, ...args });
      assert.notEqual(response.isError, true, response.content[0].text);
      const doc = getDb().prepare('SELECT id FROM documents WHERE id > ? ORDER BY id DESC').get(before);
      assert.ok(doc, `${name} did not create its document`);
      assert.ok(
        getDb().prepare('SELECT 1 FROM embeddings WHERE document_id = ?').get(doc.id),
        `${name} created a live document without an embedding`,
      );
    });
  }
});
