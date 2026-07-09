import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  findPreferredKnowledgeBaseNode,
  shouldReexecWithPreferredNode,
} from '../src/cli/runtime-node.js';

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
