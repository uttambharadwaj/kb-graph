import { readFileSync } from 'fs';
import { describe, it } from 'node:test';
import assert from 'node:assert';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const workflow = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');

const supportedNodeRange = '22.x || 24.x || 26.x';

describe('test runtime contract', () => {
  it('keeps the supported Node majors explicit and consistent', () => {
    assert.strictEqual(pkg.engines.node, supportedNodeRange);
    assert.strictEqual(lock.packages[''].engines.node, supportedNodeRange);
    assert.strictEqual(readFileSync(new URL('../.node-version', import.meta.url), 'utf8').trim(), '22');
    assert.match(
      readFileSync(new URL('../.npmrc', import.meta.url), 'utf8'),
      /(?:^|\n)engine-strict=true(?:\n|$)/,
    );
  });

  it('warms the embedding cache before the parallel suite locally and in CI', () => {
    assert.strictEqual(pkg.scripts.pretest, 'npm run test:preflight');
    assert.strictEqual(pkg.scripts.test, 'npm run test:suite');
    assert.ok(workflow.indexOf('npm run test:preflight') < workflow.indexOf('npm run test:suite'));
    assert.match(workflow, /KB_EMBEDDING_CACHE_DIR:/);
    assert.match(workflow, /node: \[22, 24, 26\]/);
  });

  it('keeps the Better Auth MCP plugin on the legacy plugins export path', async () => {
    const { mcp } = await import('better-auth/plugins');
    assert.strictEqual(typeof mcp, 'function');
  });
});
