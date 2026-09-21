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

test('OAuth accepts loopback aliases and rejects unrelated origins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-auth-origins-'));
  try {
    const home = join(dir, 'home');
    const kbDir = join(dir, 'state');
    mkdirSync(home);
    mkdirSync(kbDir);

    const authUrl = pathToFileURL(join(root, 'src', 'auth-oauth.js')).href;
    const bindUrl = pathToFileURL(join(root, 'src', 'http-bind.js')).href;
    const script = `
      const { createOAuthAuth } = await import(${JSON.stringify(authUrl)});
      const { resolveHttpTrustedOrigins } = await import(${JSON.stringify(bindUrl)});
      const baseURL = 'http://127.0.0.1:3838';
      const auth = createOAuthAuth({
        baseURL,
        trustedOrigins: resolveHttpTrustedOrigins({ host: '127.0.0.1', port: 3838 }, {}),
      });
      await (await auth.$context).runMigrations();
      const results = [];
      for (const origin of [
        'http://127.0.0.1:3838',
        'http://localhost:3838',
        'http://127.0.0.1:4848',
        'https://evil.example',
      ]) {
        const response = await auth.handler(new Request(
          baseURL + '/api/auth/sign-in/email',
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin,
            },
            body: JSON.stringify({
              email: 'missing@example.com',
              password: 'not-a-real-password',
            }),
          },
        ));
        const body = await response.json();
        results.push({ origin, status: response.status, code: body.code });
      }
      console.log(JSON.stringify(results));
    `;
    const {
      BETTER_AUTH_TRUSTED_ORIGINS: _trustedOrigins,
      BETTER_AUTH_URL: _authUrl,
      DOTENV_CONFIG_PATH: _dotenvPath,
      KB_CORS_ORIGINS: _corsOrigins,
      ...cleanEnv
    } = process.env;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: dir,
      env: {
        ...cleanEnv,
        HOME: home,
        KB_DIR: kbDir,
        BETTER_AUTH_SECRET: 'smoke-secret-smoke-secret-smoke-secret',
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      {
        origin: 'http://127.0.0.1:3838',
        status: 401,
        code: 'INVALID_EMAIL_OR_PASSWORD',
      },
      {
        origin: 'http://localhost:3838',
        status: 401,
        code: 'INVALID_EMAIL_OR_PASSWORD',
      },
      {
        origin: 'http://127.0.0.1:4848',
        status: 403,
        code: 'INVALID_ORIGIN',
      },
      {
        origin: 'https://evil.example',
        status: 403,
        code: 'INVALID_ORIGIN',
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
