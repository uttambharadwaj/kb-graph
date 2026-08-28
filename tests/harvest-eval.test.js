import './helpers/tmp-kb.js';

import { describe, it } from 'node:test';
import assert from 'node:assert';

// Slow behavioral coverage against the real model:
//   KB_EVAL=1 node --test tests/harvest-eval.test.js
const { buildLessonsPrompt } = await import('../src/harvest.js');
const { runClaudeJSON } = await import('../src/claude-cli.js');

describe('harvest lesson behavior', { skip: !process.env.KB_EVAL, timeout: 180000 }, () => {
  it('does not launder a customer-reported number into a benchmark', async () => {
    const transcript = `
USER: We need to decide whether to publish the cost claim.
ASSISTANT: A customer pasted an answer from a chat UI saying one run cost between $0.40 and $1.10.
USER: That is only a self-reported chat answer. We have no invoice, token export, repeated trial, or controlled comparison. Keep it as an anecdote, not a benchmark or counter-proof.
ASSISTANT: Agreed. The number is useful only as a weak signal until we measure it directly.
`;
    const { notes = [] } = await runClaudeJSON(buildLessonsPrompt(transcript), {
      timeout: 120000,
      caller: 'harvest-eval',
    });

    assert.ok(notes.length > 0, 'dropped the durable evidence-quality lesson');
    const rendered = notes.map(n => `${n.title}\n${n.content}`).join('\n').toLowerCase();
    assert.match(rendered, /anecdot|reported|self-reported|chat ui/,
      'did not preserve the weak provenance or measurement method');
    assert.doesNotMatch(rendered, /customer benchmark|private benchmark|counter-proof|falsified|measured result/,
      'upgraded the anecdote into controlled evidence');
  });
});
