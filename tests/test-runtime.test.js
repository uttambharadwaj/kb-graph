import { readFileSync } from 'fs';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  DEFAULT_EMBEDDING_LOAD_TIMEOUT_MS,
  generatePreflightEmbedding,
  resolveEmbeddingLoadTimeoutMs,
} from '../src/embeddings/embed.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const workflow = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
const preflight = readFileSync(new URL('../scripts/test-preflight.mjs', import.meta.url), 'utf8');

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

  it('runs one cancellable matrix per PR and keeps a post-merge main run', () => {
    assert.match(workflow, /push:\s*\n\s+branches: \[main\]/);
    assert.match(workflow, /pull_request:\s*\n\s+branches: \[main\]/);
    assert.match(workflow, /group: test-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.sha \}\}/);
    assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
    assert.strictEqual((workflow.match(/node: \[22, 24, 26\]/g) || []).length, 1);
  });

  it('pins approved Node 24 actions and restores the model cache before preflight', () => {
    const actions = [...workflow.matchAll(/uses:\s+([^@\s]+)@([^\s#]+)/g)]
      .map(([, name, revision]) => ({ name, revision }));
    assert.deepStrictEqual(actions, [
      { name: 'actions/checkout', revision: '3d3c42e5aac5ba805825da76410c181273ba90b1' },
      { name: 'actions/setup-node', revision: '820762786026740c76f36085b0efc47a31fe5020' },
      { name: 'actions/cache', revision: '55cc8345863c7cc4c66a329aec7e433d2d1c52a9' },
    ]);
    const cache = workflow.indexOf('actions/cache@');
    const preflightStep = workflow.indexOf('npm run test:preflight');
    assert.ok(cache >= 0 && cache < preflightStep);
    const cacheStep = workflow.slice(cache, preflightStep);
    assert.match(cacheStep, /path: \.cache\/ci-embedding/);
    assert.match(cacheStep, /hashFiles\('package-lock\.json'\)/);
    assert.doesNotMatch(cacheStep, /github\.(?:sha|run_id)/);
  });

  it('extends only the CI cold-load budget, not the production default', async () => {
    assert.strictEqual(DEFAULT_EMBEDDING_LOAD_TIMEOUT_MS, 60000);
    assert.strictEqual(resolveEmbeddingLoadTimeoutMs(undefined), 60000);
    assert.strictEqual(resolveEmbeddingLoadTimeoutMs('120000'), 120000);
    assert.throws(() => resolveEmbeddingLoadTimeoutMs('1e5'), /decimal integer/);
    assert.throws(() => resolveEmbeddingLoadTimeoutMs('300001'), /at most 300000/);
    assert.match(workflow, /KB_EMBEDDING_PREFLIGHT_TIMEOUT_MS: 120000/);
    assert.match(preflight, /generatePreflightEmbedding\([\s\S]*loadTimeoutMs,\s*\)/);
    const importTransformers = async () => ({
      env: {},
      pipeline: () => new Promise(resolve => {
        setTimeout(() => resolve(async () => ({ data: new Float32Array([1]) })), 20);
      }),
    });
    await assert.rejects(
      generatePreflightEmbedding('cold-cache probe', 1, { importTransformers }),
      /timed out after 1ms/,
    );
  });

  it('keeps the Better Auth MCP plugin on the legacy plugins export path', async () => {
    const { mcp } = await import('better-auth/plugins');
    assert.strictEqual(typeof mcp, 'function');
  });
});
