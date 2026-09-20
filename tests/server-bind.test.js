import './helpers/tmp-kb.js';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdirSync, mkdtempSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_HTTP_HOST,
  formatHttpServerUrl,
  listenHttpServer,
  resolveHttpBind,
  resolveHttpOrigin,
} from '../src/http-bind.js';
import {
  buildEnvContent,
  dockerComposeContent,
  parseAutoArgs,
  resolvePersistedHttpHost,
  resolvePersistedHttpPort,
} from '../src/cli/setup.js';

async function close(server) {
  server.close();
  await once(server, 'close');
}

test('HTTP bind defaults to loopback and the standard port', () => {
  assert.deepEqual(resolveHttpBind({}), {
    host: DEFAULT_HTTP_HOST,
    port: 3838,
  });
  assert.equal(DEFAULT_HTTP_HOST, '127.0.0.1');
});

test('KB_HOST explicitly opts into remote binding', () => {
  assert.deepEqual(resolveHttpBind({
    KB_HOST: ' 0.0.0.0 ',
    KB_PORT: '4848',
  }), {
    host: '0.0.0.0',
    port: 4848,
  });
});

test('hostnames and unbracketed IPv6 addresses are valid explicit binds', () => {
  assert.equal(resolveHttpBind({ KB_HOST: 'localhost' }).host, 'localhost');
  assert.equal(resolveHttpBind({ KB_HOST: '::1' }).host, '::1');
  assert.equal(resolveHttpBind({ KB_HOST: '::' }).host, '::');
});

test('empty bind hosts stay loopback-only', () => {
  for (const KB_HOST of ['', '   ']) {
    assert.equal(resolveHttpBind({ KB_HOST }).host, DEFAULT_HTTP_HOST);
  }
});

test('invalid bind hosts fail closed before server startup', () => {
  for (const KB_HOST of [
    'http://0.0.0.0',
    '127.0.0.1:3838',
    '[::1]',
    '127.0.0.1\nKB_PORT=80',
    '0',
    '00',
    '0.0.0.00',
    '2130706433',
    '0x0',
    '0x00000000',
    '0x7f000001',
    '0177.0.0.1',
    '127.1',
  ]) {
    assert.throws(
      () => resolveHttpBind({ KB_HOST }),
      /KB_HOST/,
      KB_HOST,
    );
  }
});

test('invalid ports fail closed before server startup', () => {
  for (const KB_PORT of ['0', '-1', '65536', 'abc', '3838oops', '3.5']) {
    assert.throws(
      () => resolveHttpBind({ KB_PORT }),
      /KB_PORT/,
      KB_PORT,
    );
  }
});

test('the listener binds the resolved host, not the platform wildcard default', async () => {
  for (const host of ['127.0.0.1', '0.0.0.0']) {
    const app = express();
    const server = listenHttpServer(app, { host, port: 0 });
    await once(server, 'listening');
    try {
      assert.equal(server.address().address, host);
    } finally {
      await close(server);
    }
  }
});

test('startup URLs name the actual bind host and format IPv6 safely', () => {
  assert.equal(
    formatHttpServerUrl({ host: '0.0.0.0', port: 3838 }),
    'http://0.0.0.0:3838',
  );
  assert.equal(
    formatHttpServerUrl({ host: '::1', port: 3838 }),
    'http://[::1]:3838',
  );
  assert.equal(
    resolveHttpOrigin({ host: '192.168.1.10', port: 3838 }, {}),
    'http://192.168.1.10:3838',
  );
  assert.equal(
    resolveHttpOrigin({ host: '0.0.0.0', port: 3838 }, {}),
    'http://localhost:3838',
  );
  for (const host of ['::', '::0', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0']) {
    assert.equal(resolveHttpOrigin({ host, port: 3838 }, {}), 'http://localhost:3838');
  }
  assert.equal(
    resolveHttpOrigin(
      { host: '127.0.0.1', port: 3838 },
      { BETTER_AUTH_URL: 'https://kb.example.com/' },
    ),
    'https://kb.example.com',
  );
});

test('setup preserves the bind host in generated env and automatic flags', () => {
  const cfg = parseAutoArgs(['--host=0.0.0.0']);
  assert.equal(cfg.host, '0.0.0.0');
  assert.match(buildEnvContent({
    port: 3838,
    host: cfg.host,
    password: 'secret',
    vaultPath: '',
    agents: [],
    authSecret: 'auth-secret',
  }), /^KB_HOST=0\.0\.0\.0$/m);
});

test('setup recovers from an invalid persisted host without weakening explicit validation', () => {
  const warnings = [];
  assert.equal(
    resolvePersistedHttpHost('http://0.0.0.0', error => warnings.push(error.message)),
    DEFAULT_HTTP_HOST,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /KB_HOST/);
  assert.throws(
    () => parseAutoArgs(['--host=http://0.0.0.0']),
    /KB_HOST/,
  );
});

test('setup recovers from an invalid persisted port without weakening explicit validation', () => {
  const warnings = [];
  assert.equal(
    resolvePersistedHttpPort('99999', error => warnings.push(error.message)),
    3838,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /KB_PORT/);
  assert.throws(
    () => parseAutoArgs(['--port=99999']),
    /KB_PORT/,
  );
});

test('generated containers expose HTTP only on host loopback', () => {
  const compose = dockerComposeContent({
    port: 3838,
    vaultPath: '',
  });
  assert.match(compose, /"127\.0\.0\.1:3838:3838"/);
  assert.match(compose, /KB_HOST: 0\.0\.0\.0/);
});

test('the setup CLI accepts --host and rejects unsafe values before writing', () => {
  const kbBin = fileURLToPath(new URL('../bin/kb.js', import.meta.url));
  const result = spawnSync(
    process.execPath,
    [kbBin, 'setup', '--auto', '--host=http://0.0.0.0'],
    {
      encoding: 'utf8',
      env: { ...process.env, KB_SKIP_NODE_REEXEC: '1' },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /KB_HOST/);
  assert.doesNotMatch(result.stderr, /Unknown flag/);
});

test('the production server binds to loopback by default', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kb-server-bind-'));
  mkdirSync(join(home, '.knowledge-base'));
  mkdirSync(join(home, 'kb-data'));
  const {
    BETTER_AUTH_URL: _authUrl,
    KB_DIR: _kbDir,
    KB_HOST: _host,
    ...parentEnv
  } = process.env;
  const child = fork(
    fileURLToPath(new URL('./fixtures/server-address-child.js', import.meta.url)),
    [],
    {
      silent: true,
      env: {
        ...parentEnv,
        HOME: home,
        BETTER_AUTH_URL: '',
        KB_DIR: join(home, 'kb-data'),
        KB_HOST: '',
        KB_PASSWORD: 'test-password',
        KB_PORT: '3838',
        BETTER_AUTH_SECRET: 'test-secret-at-least-thirty-two-characters',
      },
    },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const [address] = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(([code, signal]) => {
        throw new Error(`server child exited ${code ?? signal}: ${stderr}`);
      }),
    ]);
    assert.equal(address.address, DEFAULT_HTTP_HOST);
    const discovery = await fetch(
      `http://${DEFAULT_HTTP_HOST}:${address.port}/.well-known/openid-configuration`,
    );
    assert.equal(discovery.status, 200);
    const metadata = await discovery.text();
    assert.match(metadata, new RegExp(`http://${DEFAULT_HTTP_HOST}:`));
    assert.doesNotMatch(metadata, /http:\/\/localhost:/);
    child.send('close');
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
  }
});
