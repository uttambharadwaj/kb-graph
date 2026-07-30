import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'kb-harvest-'));
process.env.KB_DIR = tmp;
process.env.OBSIDIAN_VAULT_PATH = tmp;  // else a real run would touch the live vault

// A claude that answers instantly, so the harvest runs end to end without the
// real CLI. Set before importing: claude-cli reads CLAUDE_PATH once. The reply
// answers both prompts at once — no lessons, but one perfectly good fact — so
// reinstating the extraction pass would write a row and fail the test below.
const stub = join(tmp, 'claude-stub');
const reply = JSON.stringify({ notes: [], facts: [{ subject: 'tkt-1000', predicate: 'blocks', object: 'tkt-1001', category: 'status' }], skipped: [] });
writeFileSync(stub, `#!/bin/sh\ncat > /dev/null\ncat <<'EOF'\n${JSON.stringify({ result: reply })}\nEOF\n`);
chmodSync(stub, 0o755);
process.env.CLAUDE_PATH = stub;

const { extractTranscriptText, runHarvest, factsRequested } = await import('../src/harvest.js');
const { getDb } = await import('../src/db.js');

describe('harvest transcript parsing', () => {
  it('extracts Claude Code user/assistant text turns', () => {
    const raw = [
      JSON.stringify({ type: 'user', message: { content: 'fix the login bug' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Found it: stale token.' }, { type: 'tool_use', name: 'Bash' }] } }),
      JSON.stringify({ type: 'permission-mode', permissionMode: 'default' }),
    ].join('\n');
    const text = extractTranscriptText(raw);
    assert.match(text, /USER: fix the login bug/);
    assert.match(text, /ASSISTANT: Found it: stale token\./);
    assert.doesNotMatch(text, /permission/);
  });

  it('skips sidechain (subagent) turns and system reminders', () => {
    const raw = [
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent noise' }] } }),
      JSON.stringify({ type: 'user', message: { content: '<system-reminder>injected</system-reminder>' } }),
      JSON.stringify({ type: 'user', message: { content: 'real question' } }),
    ].join('\n');
    const text = extractTranscriptText(raw);
    assert.doesNotMatch(text, /subagent noise/);
    assert.doesNotMatch(text, /injected/);
    assert.match(text, /real question/);
  });

  it('extracts Codex rollout message payloads', () => {
    const raw = JSON.stringify({
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'codex says hi' }] },
    });
    assert.match(extractTranscriptText(raw), /ASSISTANT: codex says hi/);
  });

  it('tolerates malformed lines', () => {
    assert.strictEqual(extractTranscriptText('not json\n{"broken":'), '');
  });
});

describe('harvest fact extraction', () => {
  after(() => rmSync(tmp, { recursive: true, force: true }));

  // The stub answers with a fact whatever it is asked, so whether a row lands
  // is decided entirely by the flag and not by what the transcript says.
  const write = name => {
    const path = join(tmp, name);
    writeFileSync(path, [
      JSON.stringify({ type: 'user', message: { content: 'who owns the billing service?' } }),
      // Repeated to clear MIN_TEXT_CHARS; below it the session is skipped.
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'The billing service is owned by the payments team. '.repeat(200) }] },
      }),
    ].join('\n'));
    return path;
  };
  const factCount = () => getDb().prepare('SELECT COUNT(*) AS n FROM facts').get().n;

  it('is off by default', async () => {
    const summary = await runHarvest({ onlyPath: write('default.jsonl') });

    assert.strictEqual(summary.sessions, 1, 'the session must actually be harvested, not skipped as too short');
    assert.strictEqual(summary.facts, 0);
    assert.strictEqual(factCount(), 0);
  });

  it('extracts when asked', async () => {
    const summary = await runHarvest({ onlyPath: write('opted-in.jsonl'), facts: true });

    assert.strictEqual(summary.facts, 1);
    assert.strictEqual(factCount(), 1);
  });

  it('reads KB_HARVEST_FACTS when the caller says nothing', () => {
    const prev = process.env.KB_HARVEST_FACTS;
    try {
      delete process.env.KB_HARVEST_FACTS;
      assert.strictEqual(factsRequested({}), false);
      process.env.KB_HARVEST_FACTS = '1';
      assert.strictEqual(factsRequested({}), true);
      process.env.KB_HARVEST_FACTS = 'true';
      assert.strictEqual(factsRequested({}), true, 'a plausible spelling must not silently mean off');
      // An explicit argument still wins, so --no-facts works on an opted-in host.
      assert.strictEqual(factsRequested({ facts: false }), false);
    } finally {
      if (prev === undefined) delete process.env.KB_HARVEST_FACTS; else process.env.KB_HARVEST_FACTS = prev;
    }
  });
});
