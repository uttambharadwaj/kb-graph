// tests/upload-path-traversal.test.js
// Regression: POST /api/documents built its temp path from the raw multipart
// filename, so originalname="../../../../etc/cron.d/x" escaped tmpdir.
import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { readdirSync, rmSync, writeFileSync } from 'fs';
import { request as httpRequest } from 'http';
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
  const socketPath = join(tmpdir(), `kb-upload-test-${randomBytes(8).toString('hex')}.sock`);
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(socketPath);
    listener.once('listening', () => resolve(listener));
    listener.once('error', reject);
  });
  try {
    await fn(socketPath);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(socketPath, { force: true });
  }
}

function multipartBody(parts, boundary) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.filename) {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
        `Content-Type: ${part.type || 'application/octet-stream'}\r\n\r\n`
      ));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`));
    }
    chunks.push(Buffer.isBuffer(part.body) ? part.body : Buffer.from(part.body));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function postDocuments(socketPath, body, contentType = 'multipart/form-data; boundary=kbtest') {
  return new Promise((resolve, reject) => {
    let responseResult;
    let responseEnded = false;
    let requestClosed = false;

    const maybeResolve = () => {
      if (responseResult && requestClosed) resolve(responseResult);
    };

    const req = httpRequest({
      socketPath,
      method: 'POST',
      path: '/api/documents',
      headers: {
        Cookie: `kb_session=${createSession()}`,
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        responseEnded = true;
        responseResult = {
          status: res.statusCode,
          async json() {
            return JSON.parse(text);
          },
          text,
        };
        maybeResolve();
      });
    });
    req.once('error', (err) => {
      if (!responseEnded || !['EPIPE', 'ECONNRESET'].includes(err.code)) reject(err);
    });
    req.once('close', () => {
      requestClosed = true;
      maybeResolve();
    });
    req.end(body);
  });
}

describe('upload provenance', () => {
  it('persists the same sanitized source that upload responses report', async () => {
    await withServer(async (socketPath) => {
      const body = multipartBody([
        { name: 'files', filename: '../../reports/original.md', type: 'text/markdown', body: '# Upload Title\n\nbody' },
      ], 'kbtest');
      const res = await postDocuments(socketPath, body);

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

describe('upload resource limits', () => {
  it('cleans the transient upload copy after a valid request', async () => {
    await withServer(async (socketPath) => {
      const filename = 'cleanup-proof.md';
      const leftoversForUpload = () => readdirSync(tmpdir()).filter(name => (
        name.startsWith('kb-upload-') && name.endsWith(`-${filename}`)
      ));
      assert.deepStrictEqual(leftoversForUpload(), []);

      const body = multipartBody([
        { name: 'files', filename, type: 'text/markdown', body: '# Cleanup Proof\n\nbody' },
      ], 'kbtest');
      const res = await postDocuments(socketPath, body);

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(leftoversForUpload(), []);
    });
  });

  it('preserves scalar tags on valid uploads', async () => {
    await withServer(async (socketPath) => {
      const body = multipartBody([
        { name: 'tags', body: 'upload-test, Upload-Test' },
        { name: 'files', filename: 'tagged.md', type: 'text/markdown', body: '# Tagged\n\nbody' },
      ], 'kbtest');
      const res = await postDocuments(socketPath, body);

      assert.strictEqual(res.status, 200);
      const { documents } = await res.json();
      assert.strictEqual(documents.length, 1);
      assert.strictEqual(documents[0].tags, 'upload-test');
      const row = getDb().prepare('SELECT tags FROM documents WHERE id = ?').get(documents[0].id);
      assert.deepStrictEqual(row, { tags: 'upload-test' });
    });
  });

  it('accepts ten uploaded files plus scalar tags when tags arrive first', async () => {
    await withServer(async (socketPath) => {
      const body = multipartBody([
        { name: 'tags', body: 'batch-tag' },
        ...Array.from({ length: 10 }, (_, i) => ({
          name: 'files',
          filename: `batch-first-${i}.md`,
          type: 'text/markdown',
          body: `# Batch First ${i}\n\nbody`,
        })),
      ], 'kbtest');
      const res = await postDocuments(socketPath, body);

      assert.strictEqual(res.status, 200);
      const { documents } = await res.json();
      assert.strictEqual(documents.length, 10);
      assert.deepStrictEqual(new Set(documents.map(doc => doc.tags)), new Set(['batch-tag']));
    });
  });

  it('accepts ten uploaded files plus scalar tags when tags arrive last', async () => {
    await withServer(async (socketPath) => {
      const body = multipartBody([
        ...Array.from({ length: 10 }, (_, i) => ({
          name: 'files',
          filename: `batch-last-${i}.md`,
          type: 'text/markdown',
          body: `# Batch Last ${i}\n\nbody`,
        })),
        { name: 'tags', body: 'batch-tag' },
      ], 'kbtest');
      const res = await postDocuments(socketPath, body);

      assert.strictEqual(res.status, 200);
      const { documents } = await res.json();
      assert.strictEqual(documents.length, 10);
      assert.deepStrictEqual(new Set(documents.map(doc => doc.tags)), new Set(['batch-tag']));
    });
  });

  it('rejects a file over the per-file upload limit before ingesting it', async () => {
    await withServer(async (socketPath) => {
      const body = multipartBody([
        { name: 'files', filename: 'too-large.txt', type: 'text/plain', body: Buffer.alloc(10 * 1024 * 1024 + 1, 'x') },
      ], 'kbtest');
      const res = await postDocuments(socketPath, body);

      assert.strictEqual(res.status, 413);
      assert.deepStrictEqual(await res.json(), {
        error: 'Uploaded file exceeds the 10 MiB per-file limit',
      });
      const row = getDb().prepare('SELECT 1 FROM documents WHERE source = ?').get('too-large.txt');
      assert.strictEqual(row, undefined);
    });
  });

  it('rejects nested tags fields before ingesting the file', async () => {
    await withServer(async (socketPath) => {
      const body = multipartBody([
        { name: 'tags[name]', body: 'upload-test' },
        { name: 'files', filename: 'nested-tags.md', type: 'text/markdown', body: '# Nested Tags\n\nbody' },
      ], 'kbtest');
      const res = await postDocuments(socketPath, body);

      assert.strictEqual(res.status, 400);
      assert.deepStrictEqual(await res.json(), {
        error: 'Upload accepts only scalar field names',
      });
      const row = getDb().prepare('SELECT 1 FROM documents WHERE source = ?').get('nested-tags.md');
      assert.strictEqual(row, undefined);
    });
  });

  it('rejects array-indexed tags fields before ingesting the file', async () => {
    await withServer(async (socketPath) => {
      const body = multipartBody([
        { name: 'tags[999999999]', body: 'upload-test' },
        { name: 'files', filename: 'indexed-tags.md', type: 'text/markdown', body: '# Indexed Tags\n\nbody' },
      ], 'kbtest');
      const res = await postDocuments(socketPath, body);

      assert.strictEqual(res.status, 400);
      assert.deepStrictEqual(await res.json(), {
        error: 'Upload accepts only scalar field names',
      });
      const row = getDb().prepare('SELECT 1 FROM documents WHERE source = ?').get('indexed-tags.md');
      assert.strictEqual(row, undefined);
    });
  });

  it('rejects unexpected multipart file fields', async () => {
    await withServer(async (socketPath) => {
      const body = multipartBody([
        { name: 'attachment', filename: 'wrong-field.txt', type: 'text/plain', body: 'body' },
      ], 'kbtest');
      const res = await postDocuments(socketPath, body);

      assert.strictEqual(res.status, 400);
      assert.deepStrictEqual(await res.json(), {
        error: 'Unexpected upload field: attachment',
      });
    });
  });

  it('rejects more than ten uploaded files', async () => {
    await withServer(async (socketPath) => {
      const body = multipartBody(Array.from({ length: 11 }, (_, i) => ({
        name: 'files',
        filename: `note-${i}.md`,
        type: 'text/markdown',
        body: `# Note ${i}\n\nbody`,
      })), 'kbtest');
      const res = await postDocuments(socketPath, body);

      assert.strictEqual(res.status, 413);
      assert.deepStrictEqual(await res.json(), {
        error: 'Upload accepts at most 10 files per request',
      });
    });
  });

  it('rejects extra non-file fields beyond tags', async () => {
    await withServer(async (socketPath) => {
      const body = multipartBody([
        { name: 'tags', body: 'upload-test' },
        { name: 'note', body: 'extra' },
        { name: 'files', filename: 'field-limit.md', type: 'text/markdown', body: '# Field Limit\n\nbody' },
      ], 'kbtest');
      const res = await postDocuments(socketPath, body);

      assert.strictEqual(res.status, 400);
      assert.deepStrictEqual(await res.json(), {
        error: 'Upload accepts only the optional tags field',
      });
    });
  });

  it('returns a client error for malformed multipart bodies', async () => {
    await withServer(async (socketPath) => {
      const res = await postDocuments(
        socketPath,
        '--broken\r\nContent-Disposition: form-data; name="files"; filename="broken.md"\r\n\r\nunterminated',
        'multipart/form-data; boundary=broken',
      );

      assert.strictEqual(res.status, 400);
      assert.deepStrictEqual(await res.json(), { error: 'Malformed multipart upload' });
    });
  });
});
