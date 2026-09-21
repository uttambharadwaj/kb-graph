import './helpers/tmp-kb.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import {
  dirname, isAbsolute, join, resolve,
} from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawnSync } from 'child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readLoadedEnv({ kbDir, cwd }) {
  const pathsUrl = pathToFileURL(join(root, 'src', 'paths.js')).href;
  const embedUrl = pathToFileURL(join(root, 'src', 'embeddings', 'embed.js')).href;
  const script = `
    const { KB_DIR } = await import(${JSON.stringify(pathsUrl)});
    const { resolveEmbeddingCacheDir } = await import(${JSON.stringify(embedUrl)});
    console.log(JSON.stringify({
      KB_DIR,
      envKbDir: process.env.KB_DIR,
      KB_PORT: process.env.KB_PORT,
      KB_PASSWORD: process.env.KB_PASSWORD,
      cacheDir: resolveEmbeddingCacheDir(),
    }));
  `;
  const env = { ...process.env, KB_DIR: kbDir };
  delete env.KB_PORT;
  delete env.KB_PASSWORD;
  delete env.KB_EMBEDDING_CACHE_DIR;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('durable KB_DIR env takes precedence over checkout env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-env-'));
  try {
    const kbDir = join(dir, 'state');
    const cwd = join(dir, 'checkout');
    mkdirSync(kbDir);
    mkdirSync(cwd);
    writeFileSync(
      join(kbDir, '.env'),
      `KB_DIR=${join(dir, 'ignored-state-selector')}\nKB_PORT=4040\nKB_PASSWORD=durable\nKB_EMBEDDING_CACHE_DIR=${join(dir, 'custom-models')}\n`,
    );
    writeFileSync(join(cwd, '.env'), 'KB_PORT=5050\nKB_PASSWORD=checkout\n');

    assert.deepEqual(readLoadedEnv({ kbDir, cwd }), {
      KB_DIR: kbDir,
      envKbDir: kbDir,
      KB_PORT: '4040',
      KB_PASSWORD: 'durable',
      cacheDir: join(dir, 'custom-models'),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unrelated caller cwd cannot inject fallback configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-env-'));
  try {
    const kbDir = join(dir, 'state');
    const cwd = join(dir, 'checkout');
    mkdirSync(kbDir);
    mkdirSync(cwd);
    writeFileSync(join(cwd, '.env'), 'KB_PORT=5050\nKB_PASSWORD=checkout\n');

    const loaded = readLoadedEnv({ kbDir, cwd });
    assert.equal(loaded.KB_PORT, undefined);
    assert.equal(loaded.KB_PASSWORD, undefined);
    assert.equal(loaded.envKbDir, kbDir);
    assert.equal(loaded.cacheDir, join(kbDir, 'models'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('relative KB_DIR is normalized before integrations inherit it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-env-relative-'));
  try {
    const kbDir = join(dir, 'state');
    mkdirSync(kbDir);
    writeFileSync(join(kbDir, '.env'), 'KB_PORT=6060\n');

    const loaded = readLoadedEnv({ kbDir: 'state', cwd: dir });
    assert.equal(isAbsolute(loaded.KB_DIR), true);
    assert.equal(loaded.envKbDir, loaded.KB_DIR);
    assert.equal(loaded.KB_DIR.endsWith('/state'), true);
    assert.equal(loaded.KB_PORT, '6060');
    assert.equal(loaded.cacheDir, join(loaded.KB_DIR, 'models'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
