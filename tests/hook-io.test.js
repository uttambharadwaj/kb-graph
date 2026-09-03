import './helpers/tmp-kb.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hookOutput } from '../src/cli/hook-io.js';
import { AGENT } from '../src/process-ancestry.js';

test('hookOutput wraps cursor output in its additional_context envelope', () => {
  const line = hookOutput('KB BRIEFING', { agent: AGENT.CURSOR, hookEventName: 'sessionStart' });
  assert.deepEqual(JSON.parse(line), { additional_context: 'KB BRIEFING' });
});

test('hookOutput stays null for empty cursor output', () => {
  assert.equal(hookOutput('', { agent: AGENT.CURSOR, hookEventName: 'sessionStart' }), null);
});
