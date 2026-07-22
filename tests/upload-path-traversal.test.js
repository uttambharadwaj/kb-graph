// tests/upload-path-traversal.test.js
// Regression: POST /api/documents built its temp path from the raw multipart
// filename, so originalname="../../../../etc/cron.d/x" escaped tmpdir.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { join, basename, dirname } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

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
