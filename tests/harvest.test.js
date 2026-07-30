import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'kb-harvest-'));
process.env.KB_DIR = tmp;
process.env.OBSIDIAN_VAULT_PATH = tmp;  // else a real run would touch the live vault
delete process.env.KB_HARVEST_FACTS;    // a host that opted in must not fail the suite

// A claude that answers instantly, so the harvest runs end to end without the
// real CLI. Set before importing: claude-cli reads CLAUDE_PATH once. One reply
// answers both prompts — no lessons, one fact — and the fact carries a call
// counter so every call contributes a distinct row rather than a duplicate.
const stub = join(tmp, 'claude-stub');
const counter = join(tmp, 'calls');
writeFileSync(stub, [
  '#!/bin/sh',
  'cat > /dev/null',
  `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}`,
  `printf '{"result":"{\\\\"notes\\\\":[],\\\\"facts\\\\":[{\\\\"subject\\\\":\\\\"tkt-%s\\\\",\\\\"predicate\\\\":\\\\"blocks\\\\",\\\\"object\\\\":\\\\"tkt-x\\\\",\\\\"category\\\\":\\\\"status\\\\"}],\\\\"skipped\\\\":[]}"}' "$n"`,
].join('\n') + '\n');
chmodSync(stub, 0o755);
process.env.CLAUDE_PATH = stub;

const { extractTranscriptText, chunkText, runHarvest, runHarvestCli, factsRequested } = await import('../src/harvest.js');
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

describe('harvest chunking', () => {
  it('keeps short texts as sequential chunks', () => {
    const chunks = chunkText('x'.repeat(25000));
    assert.strictEqual(chunks.length, 3);
    assert.strictEqual(chunks[0].length, 12000);
  });

  it('caps long texts to head + tail chunks', () => {
    const text = 'a'.repeat(12000 * 30);
    const chunks = chunkText(text);
    assert.strictEqual(chunks.length, 20);
  });
});

describe('harvest fact extraction', () => {
  after(() => rmSync(tmp, { recursive: true, force: true }));

  // The stub answers with a fact whatever it is asked, so whether a row lands
  // is decided entirely by the flag and not by what the transcript says. Long
  // enough to clear MIN_TEXT_CHARS and to span more than one chunk, so the
  // per-chunk loop and its running total are both exercised.
  const write = name => {
    const path = join(tmp, name);
    writeFileSync(path, [
      JSON.stringify({ type: 'user', message: { content: 'who owns the billing service?' } }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'The billing service is owned by the payments team. '.repeat(300) }] },
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

    assert.ok(summary.facts > 1, `expected the chunks to add up, got ${summary.facts}`);
    assert.strictEqual(summary.facts, factCount(), 'the reported count must be the total written, not the last chunk');
  });

  it('takes the last fact flag on the command line', async () => {
    await runHarvestCli(['--no-facts', `--path=${write('cli-off.jsonl')}`]);
    const before = factCount();
    await runHarvestCli(['--no-facts', '--facts', `--path=${write('cli-on.jsonl')}`]);

    assert.ok(factCount() > before, '--facts last must win over an earlier --no-facts');
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
