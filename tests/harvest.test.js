import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.KB_DIR = mkdtempSync(join(tmpdir(), 'kb-harvest-'));
const { extractTranscriptText, chunkText } = await import('../src/harvest.js');

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
