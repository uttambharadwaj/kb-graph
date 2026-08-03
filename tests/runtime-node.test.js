import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  findPreferredKnowledgeBaseNode,
  shouldReexecWithPreferredNode, stableNodePath } from '../src/cli/runtime-node.js';

const tempDirs = [];

function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'kb-runtime-node-test-'));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('runtime node pinning', () => {
  it('reads the pinned knowledge-base node command from agent config', () => {
    const homeDir = makeHome();
    writeJson(join(homeDir, '.codex', 'mcp.json'), {
      mcpServers: {
        'knowledge-base': {
          command: '/custom/node',
          args: ['/tmp/knowledge-base-server/bin/kb.js', 'mcp'],
        },
      },
    });

    assert.strictEqual(findPreferredKnowledgeBaseNode(homeDir), '/custom/node');
  });

  it('ignores non-entrypoint knowledge-base configs', () => {
    const homeDir = makeHome();
    writeJson(join(homeDir, '.claude.json'), {
      mcpServers: {
        'knowledge-base': {
          command: 'kb',
          args: ['mcp'],
        },
      },
    });

    assert.strictEqual(findPreferredKnowledgeBaseNode(homeDir), null);
  });

  it('only reexecs when the preferred node differs from the current runtime', () => {
    assert.strictEqual(shouldReexecWithPreferredNode(null, '/current/node'), false);
    assert.strictEqual(shouldReexecWithPreferredNode('/current/node', '/current/node'), false);
    assert.strictEqual(shouldReexecWithPreferredNode('/preferred/node', '/current/node'), true);
  });
});

// Homebrew's Cellar path names one patch release. Persisting it into a job,
// hook or MCP registration means the next `brew upgrade` deletes the runtime
// out from under all of them at once — and the MCP server fails at spawn,
// before the re-exec logic above can run.
describe('stableNodePath', () => {
  const CELLAR = '/opt/homebrew/Cellar/node@22/22.23.1/bin/node';
  const OPT = '/opt/homebrew/opt/node@22/bin/node';

  it('prefers the version-stable symlink over the versioned directory', () => {
    assert.strictEqual(
      stableNodePath(CELLAR, { exists: () => true, resolve: () => '/real/node' }), OPT);
  });

  it('keeps the literal path when no stable symlink exists', () => {
    assert.strictEqual(stableNodePath(CELLAR, { exists: () => false, resolve: () => '/real/node' }), CELLAR);
  });

  // A symlink pointing somewhere else would quietly move every artifact onto a
  // runtime nobody chose, which is worse than the pin it replaces.
  it('refuses a symlink that resolves to a different binary', () => {
    assert.strictEqual(
      stableNodePath(CELLAR, { exists: () => true, resolve: (p) => (p === OPT ? '/other/node' : '/real/node') }),
      CELLAR);
  });

  it('leaves a path that was never Cellar-shaped alone', () => {
    for (const path of ['/usr/bin/node', '/usr/local/bin/node', '/home/u/.nvm/versions/node/v22.0.0/bin/node']) {
      assert.strictEqual(stableNodePath(path, { exists: () => true, resolve: () => 'x' }), path);
    }
  });
});
