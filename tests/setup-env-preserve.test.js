import './helpers/tmp-kb.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadExistingEnv, parseEnvFile } from '../src/cli/setup.js';

test('parseEnvFile reads KEY=value lines, ignores comments and blanks', () => {
  const parsed = parseEnvFile('# comment\nKB_PORT=3838\n\nKB_PASSWORD=s3cret\nAUTH_SECRET=abc==\n');
  assert.deepEqual(parsed, { KB_PORT: '3838', KB_PASSWORD: 's3cret', AUTH_SECRET: 'abc==' });
});

test('loadExistingEnv migrates legacy values while durable state wins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-setup-env-'));
  try {
    const legacyPath = join(dir, 'legacy.env');
    const statePath = join(dir, 'state.env');
    writeFileSync(legacyPath, 'KB_PASSWORD=legacy\nKB_PORT=3838\n');
    writeFileSync(statePath, 'KB_PASSWORD=durable\nBETTER_AUTH_SECRET=kept\n');

    assert.deepEqual(loadExistingEnv({ statePath, legacyPath }), {
      KB_PASSWORD: 'durable',
      KB_PORT: '3838',
      BETTER_AUTH_SECRET: 'kept',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
