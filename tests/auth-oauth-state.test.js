import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('OAuth database follows KB_DIR instead of the package or home directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-auth-state-'));
  try {
    const home = join(dir, 'home');
    const kbDir = join(dir, 'state');
    mkdirSync(home);
    mkdirSync(kbDir);

    const authUrl = pathToFileURL(join(root, 'src', 'auth-oauth.js')).href;
    const script = `
      const { existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { createOAuthAuth } = await import(${JSON.stringify(authUrl)});
      createOAuthAuth({ baseURL: 'http://127.0.0.1:3838' });
      console.log(JSON.stringify({
        state: existsSync(join(process.env.KB_DIR, 'auth.db')),
        defaultHome: existsSync(join(process.env.HOME, '.knowledge-base', 'auth.db')),
      }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: dir,
      env: {
        ...process.env,
        HOME: home,
        KB_DIR: kbDir,
        BETTER_AUTH_SECRET: 'smoke-secret-smoke-secret-smoke-secret',
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      state: true,
      defaultHome: false,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
