// tests/upload-path-traversal.test.js
// Regression: POST /api/documents built its temp path from the raw multipart
// filename, so originalname="../../../../etc/cron.d/x" escaped tmpdir.
import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { rmSync, writeFileSync } from 'fs';
import { join, basename, dirname } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { env as transformersEnv } from '@huggingface/transformers';
import { createSession } from '../src/auth.js';
import { getDb } from '../src/db.js';
import { ingestFile } from '../src/ingest.js';
import apiRouter from '../src/routes/api.js';

transformersEnv.allowRemoteModels = false;
transformersEnv.allowLocalModels = false;

// Mirrors the temp-path construction in src/routes/api.js.
function tempPathFor(originalname) {
  const tempName = `kb-upload-${randomBytes(8).toString('hex')}-${basename(originalname)}`;
  return join(tmpdir(), tempName);
}

describe('upload temp path stays inside tmpdir', () => {
  const payloads = [
    '../../../../etc/cron.d/pwn',
    '..%2f..%2fetc/passwd',        // literal, not URL-decoded here — still must not escape
    '/etc/passwd',
    'subdir/../../escape.txt',
    'a/b/c/normal.md',
    'report.pdf',
    '..',
  ];

  for (const p of payloads) {
    it(`neutralizes ${JSON.stringify(p)}`, () => {
      assert.strictEqual(dirname(tempPathFor(p)), tmpdir());
    });
  }
});

async function withServer(fn) {
  const app = express();
  app.use(apiRouter);
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0);
    listener.once('listening', () => resolve(listener));
    listener.once('error', reject);
  });
  const port = server.address().port;
  try {
    await fn(port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

describe('upload provenance', () => {
  it('persists the same sanitized source that upload responses report', async () => {
    await withServer(async (port) => {
      const form = new FormData();
      form.append('files', new Blob(['# Upload Title\n\nbody'], { type: 'text/markdown' }), '../../reports/original.md');

      const res = await fetch(`http://localhost:${port}/api/documents`, {
        method: 'POST',
        headers: { Cookie: `kb_session=${createSession()}` },
        body: form,
      });

      assert.strictEqual(res.status, 200);
      const { documents } = await res.json();
      assert.strictEqual(documents.length, 1);
      assert.strictEqual(documents[0].source, 'original.md');

      const row = getDb().prepare('SELECT title, source FROM documents WHERE id = ?').get(documents[0].id);
      assert.deepStrictEqual(row, { title: 'original', source: 'original.md' });
    });
  });

  it('keeps direct file ingest source as the ingested file basename', async () => {
    const file = join(tmpdir(), `kb-upload-source-${randomBytes(8).toString('hex')}.md`);
    writeFileSync(file, '# Direct Title\n\nbody');

    try {
      const doc = await ingestFile(file);

      assert.strictEqual(doc.source, basename(file));
      const row = getDb().prepare('SELECT source FROM documents WHERE id = ?').get(doc.id);
      assert.strictEqual(row.source, basename(file));
    } finally {
      rmSync(file, { force: true });
    }
  });
});
