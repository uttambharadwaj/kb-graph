import './helpers/tmp-kb.js'; // MUST be first — redirects the DB to a temp dir
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
const fakeFail = join(tmp, 'fake-fail.sh');
writeFileSync(fakeFail, '#!/bin/sh\necho "bad input" >&2\nexit 1\n');
chmodSync(fakeFail, 0o755);
// Exits at once but leaves a descendant holding stdout — the shape that hung
// for 1800s in a debrief, because nothing was left for the timeout to kill.
const fakeOrphan = join(tmp, 'fake-orphan.sh');
writeFileSync(fakeOrphan, '#!/bin/sh\nsleep 30 &\nexec sleep 0.05\n');
chmodSync(fakeOrphan, 0o755);
// Same orphaning shape, but the process the flush timer eventually reports on
// failed rather than succeeded — proves the flush path is metered as a
// failure too, not just as the success case above.
const fakeOrphanFail = join(tmp, 'fake-orphan-fail.sh');
writeFileSync(fakeOrphanFail, '#!/bin/sh\nsleep 30 &\nexec false\n');
chmodSync(fakeOrphanFail, 0o755);
const fakeEnv = join(tmp, 'fake-env.sh');
writeFileSync(fakeEnv, '#!/bin/sh\necho "THINKING=$MAX_THINKING_TOKENS"\n');
chmodSync(fakeEnv, 0o755);

// CLAUDE_PATH is read at module load — set it before importing.
process.env.CLAUDE_PATH = fakeEcho;
const { runClaude } = await import('../src/claude-cli.js');
const { getDb } = await import('../src/db.js');

const modelCalls = () => getDb().prepare('SELECT * FROM model_calls ORDER BY id').all();

describe('runClaude subprocess handling', () => {
  // Cleanup lives on the last describe in the file — both share this tmp dir
  // and its fake binaries, and an after() here would delete them out from
  // under the second describe before it runs.
  it('passes --strict-mcp-config so the nested CLI skips MCP startup', async () => {
    const out = await runClaude('ignored', { caller: 'probe' });
    assert.match(out, /--strict-mcp-config/);
  });

  // The runaway thinking this bounds is invisible in the result — the reply
  // looks the same whether it cost 1,800 generated tokens or 8,500 — so the
  // ceiling only stays on if a test asserts it.
  it('bounds the thinking budget so a chunk cannot deliberate past its timeout', async () => {
    process.env.CLAUDE_PATH = fakeEnv;
    const mod = await import('../src/claude-cli.js?bin=env');
    assert.match(await mod.runClaude('ignored', { caller: 'probe' }), /THINKING=4096/);
  });

  it('lets an operator override the thinking budget', async () => {
    process.env.CLAUDE_PATH = fakeEnv;
    process.env.MAX_THINKING_TOKENS = '2048';
    const mod = await import('../src/claude-cli.js?bin=env2');
    assert.match(await mod.runClaude('ignored', { caller: 'probe' }), /THINKING=2048/);
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
    assert.strictEqual(await mod.runClaude('ignored', { timeout: 120000, caller: 'probe' }), '');
    assert.ok(Date.now() - started < 5000, 'must not wait out the full timeout');
  });

  it('names the timeout instead of a bare exit code when the child is killed', async () => {
    // CLAUDE_PATH is bound at module load; a query-string import re-evaluates
    // the module fresh so it picks up the sleeper binary.
    process.env.CLAUDE_PATH = fakeSleep;
    const mod = await import(`../src/claude-cli.js?bin=sleeper`);
    await assert.rejects(
      mod.runClaude('ignored', { timeout: 300, caller: 'probe' }),
      /timed out after \d+ms \(limit 300ms\)/,
    );
  });

  it('throws synchronously when no caller label is given, before spawning anything', () => {
    assert.throws(() => runClaude('ignored'), /caller/);
    assert.throws(() => runClaude('ignored', { model: 'x' }), /caller/);
  });
});

describe('model call metering', () => {
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('records a success row with the model, duration, and both char counts', async () => {
    process.env.CLAUDE_PATH = fakeEcho;
    const mod = await import('../src/claude-cli.js?bin=meter-ok');
    const out = await mod.runClaude('hello there', { caller: 'meter-probe', model: 'fake-model' });
    const row = modelCalls().at(-1);
    assert.strictEqual(row.caller, 'meter-probe');
    assert.strictEqual(row.model, 'fake-model');
    assert.strictEqual(row.ok, 1);
    assert.strictEqual(row.error, null);
    assert.strictEqual(row.prompt_chars, 'hello there'.length);
    assert.strictEqual(row.response_chars, out.length);
    assert.ok(row.duration_ms >= 0);
  });

  it('records a failure row for a clean nonzero exit, and rethrows the same error', async () => {
    process.env.CLAUDE_PATH = fakeFail;
    const mod = await import('../src/claude-cli.js?bin=meter-fail');
    await assert.rejects(
      mod.runClaude('a prompt that fails', { caller: 'meter-probe' }),
      /bad input/,
    );
    const row = modelCalls().at(-1);
    assert.strictEqual(row.caller, 'meter-probe');
    assert.strictEqual(row.ok, 0);
    assert.match(row.error, /exited 1/);
    assert.match(row.error, /bad input/);
    assert.strictEqual(row.response_chars, null, 'nothing came back on a failed call');
  });

  it('records a failure row for a timeout, named as a timeout rather than a bare exit code', async () => {
    process.env.CLAUDE_PATH = fakeSleep;
    const mod = await import('../src/claude-cli.js?bin=meter-timeout');
    await assert.rejects(
      mod.runClaude('ignored', { timeout: 300, caller: 'meter-probe' }),
      /timed out/,
    );
    const row = modelCalls().at(-1);
    assert.strictEqual(row.ok, 0);
    assert.match(row.error, /timed out after \d+ms \(limit 300ms\)/);
  });

  it('records a success row through the orphan-flush path', { timeout: 8000 }, async () => {
    process.env.CLAUDE_PATH = fakeOrphan;
    const mod = await import('../src/claude-cli.js?bin=meter-orphan-ok');
    await mod.runClaude('ignored', { timeout: 120000, caller: 'meter-probe' });
    const row = modelCalls().at(-1);
    assert.strictEqual(row.ok, 1);
    assert.strictEqual(row.response_chars, 0);
  });

  // The flush timer in child-exit.js is what delivers this settle — proving
  // it lands a failure row (not just a success one) is the point, since the
  // whole reason the orphan shape exists is a call that never got to report.
  it('records a failure row through the orphan-flush path', { timeout: 8000 }, async () => {
    process.env.CLAUDE_PATH = fakeOrphanFail;
    const mod = await import('../src/claude-cli.js?bin=meter-orphan-fail');
    await assert.rejects(mod.runClaude('ignored', { timeout: 120000, caller: 'meter-probe' }));
    const row = modelCalls().at(-1);
    assert.strictEqual(row.ok, 0);
    assert.match(row.error, /exited 1/);
  });
});
