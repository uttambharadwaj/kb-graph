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
// Exits at once but leaves a descendant holding stdout — the shape that hung
// for 1800s in a debrief, because nothing was left for the timeout to kill.
const fakeOrphan = join(tmp, 'fake-orphan.sh');
writeFileSync(fakeOrphan, '#!/bin/sh\nsleep 30 &\nexec sleep 0.05\n');
chmodSync(fakeOrphan, 0o755);
const fakeEnv = join(tmp, 'fake-env.sh');
writeFileSync(fakeEnv, '#!/bin/sh\necho "THINKING=$MAX_THINKING_TOKENS"\n');
chmodSync(fakeEnv, 0o755);

// CLAUDE_PATH is read at module load — set it before importing.
process.env.CLAUDE_PATH = fakeEcho;
const { runClaude } = await import('../src/claude-cli.js');

describe('runClaude subprocess handling', () => {
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('passes --strict-mcp-config so the nested CLI skips MCP startup', async () => {
    const out = await runClaude('ignored');
    assert.match(out, /--strict-mcp-config/);
  });

  // The runaway thinking this bounds is invisible in the result — the reply
  // looks the same whether it cost 1,800 generated tokens or 8,500 — so the
  // ceiling only stays on if a test asserts it.
  it('bounds the thinking budget so a chunk cannot deliberate past its timeout', async () => {
    process.env.CLAUDE_PATH = fakeEnv;
    const mod = await import('../src/claude-cli.js?bin=env');
    assert.match(await mod.runClaude('ignored'), /THINKING=4096/);
  });

  it('lets an operator override the thinking budget', async () => {
    process.env.CLAUDE_PATH = fakeEnv;
    process.env.MAX_THINKING_TOKENS = '2048';
    const mod = await import('../src/claude-cli.js?bin=env2');
    assert.match(await mod.runClaude('ignored'), /THINKING=2048/);
    delete process.env.MAX_THINKING_TOKENS;
  });

  // The test timeout is the assertion: without the flush window this call never
  // settles at all, and a hang and a slow pass are indistinguishable otherwise.
  it('answers once the child is dead even if a descendant holds its pipes', { timeout: 8000 }, async () => {
    process.env.CLAUDE_PATH = fakeOrphan;
    const mod = await import('../src/claude-cli.js?bin=orphan');
    const started = Date.now();
    // Exit 0 with no JSON on stdout, so the call resolves and the parse fails
    // downstream — the point is that it answers, well inside its own timeout.
    assert.strictEqual(await mod.runClaude('ignored', { timeout: 120000 }), '');
    assert.ok(Date.now() - started < 5000, 'must not wait out the full timeout');
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
