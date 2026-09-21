import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const llms = readFileSync(resolve(root, 'llms.txt'), 'utf8');

function dryRunPack() {
  const output = execFileSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: root, encoding: 'utf8' },
  );
  const [manifest] = JSON.parse(output);
  return manifest;
}

test('package metadata and lifecycle are safe for public global installs', () => {
  assert.equal(pkg.version, '2.1.0');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.repository?.url, 'git+https://github.com/uttambharadwaj/kb-graph.git');
  assert.equal(pkg.homepage, 'https://github.com/uttambharadwaj/kb-graph#readme');
  assert.equal(pkg.bugs?.url, 'https://github.com/uttambharadwaj/kb-graph/issues');
  assert.equal(pkg.publishConfig?.access, 'public');
  assert.equal(pkg.bin?.kb, './bin/kb.js');
  assert.equal(pkg.main, undefined);

  for (const hook of [
    'preinstall', 'install', 'postinstall',
    'prepare', 'prepack', 'postpack',
    'prepublish', 'prepublishOnly', 'publish', 'postpublish',
  ]) {
    assert.equal(pkg.scripts?.[hook], undefined, `package must not define ${hook}`);
  }
});

test('npm pack contains the runtime and excludes repository-only material', () => {
  const manifest = dryRunPack();
  const paths = new Set(manifest.files.map(file => file.path));

  for (const required of [
    'LICENSE',
    'README.md',
    'bin/init-vault.sh',
    'bin/kb-checkpoint-hook.js',
    'bin/kb-trigger-hook.js',
    'bin/kb.js',
    'bin/weekly-synthesis.js',
    'docs/ONBOARDING.md',
    'docs/assets/loop-demo.svg',
    'eval/checkpoint-replay-v1.json',
    'llms.txt',
    'openapi.json',
    'package.json',
    'skills/debrief/SKILL.md',
    'skills/kb-workflow/SKILL.md',
    'src/env.js',
    'src/predicates.json',
    'src/public/index.html',
    'src/routes/openapi.js',
  ]) {
    assert.ok(paths.has(required), `missing required package path: ${required}`);
  }

  for (const path of paths) {
    assert.doesNotMatch(
      path,
      /^(?:\.github|scripts|tests)(?:\/|$)|^(?:CODEMAP|CONTRIBUTING|EXTENDING|SECURITY)\.md$|^kb-server|(?:^|\/)\.env$|setup-config\.json$|\.tgz$|\.db$/,
      `repository-only or private artifact was packed: ${path}`,
    );
  }

  assert.ok(manifest.entryCount <= 180, `package has ${manifest.entryCount} files`);
  assert.ok(manifest.size <= 500_000, `packed size is ${manifest.size} bytes`);
  assert.ok(manifest.unpackedSize <= 2_000_000, `unpacked size is ${manifest.unpackedSize} bytes`);
  const llmsWithoutUrls = llms.replace(/https:\/\/\S+/g, '');
  assert.doesNotMatch(
    llmsWithoutUrls,
    /\b(?:CODEMAP|CONTRIBUTING|EXTENDING|SECURITY)\.md\b|\bkb-server\.service\b/,
    'packed llms.txt references an excluded repository-only file',
  );
  assert.doesNotMatch(llms, /node bin\/kb\.js/, 'packed llms.txt uses a source-only command');
});
