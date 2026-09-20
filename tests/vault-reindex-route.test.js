import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { createSession } from '../src/auth.js';
import { getDb } from '../src/db.js';
import apiRouter from '../src/routes/api.js';
import { indexVault } from '../src/vault/indexer.js';

async function withServer(run) {
  const app = express();
  app.use(apiRouter);
  const socketPath = join(tmpdir(), `kb-reindex-test-${randomBytes(8).toString('hex')}.sock`);
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(socketPath);
    listener.once('listening', () => resolve(listener));
    listener.once('error', reject);
  });
  try {
    await run(socketPath);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(socketPath, { force: true });
  }
}

function postReindex(socketPath) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      socketPath,
      method: 'POST',
      path: '/api/vault/reindex',
      headers: { Cookie: `kb_session=${createSession()}` },
    }, res => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject);
    req.end();
  });
}

describe('post-sync vault reindex', () => {
  it('replaces an edited note and its semantic vector together', async () => {
    const vault = process.env.OBSIDIAN_VAULT_PATH;
    const directory = join(vault, 'inbox');
    const path = join(directory, 'post-sync-edit.md');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, '---\ntitle: Post-sync edit\n---\n\nOriginal semantic body.');
    await indexVault(vault, { embeddings: true });

    writeFileSync(path, '---\ntitle: Post-sync edit\n---\n\nReplacement semantic body.');
    await withServer(async socketPath => {
      assert.equal(await postReindex(socketPath), 200);
    });

    const doc = getDb().prepare("SELECT id, content FROM documents WHERE title = 'Post-sync edit'").get();
    const embedding = getDb().prepare(
      'SELECT chunk_text FROM embeddings WHERE document_id = ? ORDER BY chunk_index LIMIT 1',
    ).get(doc.id);
    assert.equal(doc.content, 'Replacement semantic body.');
    assert.match(embedding.chunk_text, /Replacement semantic body/);
    assert.doesNotMatch(embedding.chunk_text, /Original semantic body/);
  });
});
