import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Fake claude binaries so these tests need no network and run in ms.
const tmp = mkdtempSync(join(tmpdir(), 'kb-claude-cli-'));
const fakeEcho = join(tmp, 'fake-echo.sh');
writeFileSync(fakeEcho, '#!/bin/sh\necho "$@"\n');
chmodSync(fakeEcho, 0o755);
const fakeSleep = join(tmp, 'fake-sleep.sh');
writeFileSync(fakeSleep, '#!/bin/sh\nsleep 5\n');
chmodSync(fakeSleep, 0o755);

// CLAUDE_PATH is read at module load — set it before importing.
process.env.CLAUDE_PATH = fakeEcho;
const { runClaude } = await import('../src/claude-cli.js');

describe('runClaude subprocess handling', () => {
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('passes --strict-mcp-config so the nested CLI skips MCP startup', async () => {
    const out = await runClaude('ignored');
    assert.match(out, /--strict-mcp-config/);
  });

  it('names the timeout instead of a bare exit code when the child is killed', async () => {
    // CLAUDE_PATH is bound at module load; a query-string import re-evaluates
    // the module fresh so it picks up the sleeper binary.
    process.env.CLAUDE_PATH = fakeSleep;
    const mod = await import(`../src/claude-cli.js?bin=sleeper`);
    await assert.rejects(
      mod.runClaude('ignored', { timeout: 300 }),
      /timed out after \d+ms \(limit 300ms\)/,
    );
  });
});
