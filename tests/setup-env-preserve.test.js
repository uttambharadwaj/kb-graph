import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvFile } from '../src/cli/setup.js';

test('parseEnvFile reads KEY=value lines, ignores comments and blanks', () => {
  const parsed = parseEnvFile('# comment\nKB_PORT=3838\n\nKB_PASSWORD=s3cret\nAUTH_SECRET=abc==\n');
  assert.deepEqual(parsed, { KB_PORT: '3838', KB_PASSWORD: 's3cret', AUTH_SECRET: 'abc==' });
});
