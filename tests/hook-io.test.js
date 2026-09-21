import './helpers/tmp-kb.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_ENVELOPE_EVENT,
  CONTEXT_ENVELOPE_EVENTS,
  hookOutput,
  usesContextEnvelope,
} from '../src/cli/hook-io.js';
import { AGENT } from '../src/process-ancestry.js';

describe('hookOutput versioned agent contracts', () => {
  test('Claude Code >=2.1.248 uses context envelopes only for declared events', () => {
    assert.deepEqual(
      CONTEXT_ENVELOPE_EVENTS,
      [CONTEXT_ENVELOPE_EVENT.POST_TOOL_USE],
    );
    assert.equal(
      usesContextEnvelope(AGENT.CLAUDE, CONTEXT_ENVELOPE_EVENT.POST_TOOL_USE),
      true,
    );
    for (const event of ['SessionStart', 'UserPromptSubmit', 'posttooluse', '', undefined]) {
      assert.equal(usesContextEnvelope(AGENT.CLAUDE, event), false, String(event));
    }
  });

  test('Claude Code >=2.1.248 wraps PostToolUse additional context', () => {
    const line = hookOutput('KB CHECKPOINT', {
      agent: AGENT.CLAUDE,
      hookEventName: CONTEXT_ENVELOPE_EVENT.POST_TOOL_USE,
    });
    assert.deepEqual(JSON.parse(line), {
      hookSpecificOutput: {
        hookEventName: CONTEXT_ENVELOPE_EVENT.POST_TOOL_USE,
        additionalContext: 'KB CHECKPOINT',
      },
    });
  });

  test('Claude SessionStart and UserPromptSubmit keep supported plain text', () => {
    for (const event of ['SessionStart', 'UserPromptSubmit']) {
      assert.equal(hookOutput('KB CONTEXT', {
        agent: AGENT.CLAUDE,
        hookEventName: event,
      }), 'KB CONTEXT');
    }
  });

  test('Claude unknown or missing events do not gain an envelope', () => {
    for (const event of ['postToolUse', 'UnknownEvent', '', undefined]) {
      assert.equal(hookOutput('KB CONTEXT', {
        agent: AGENT.CLAUDE,
        hookEventName: event,
      }), 'KB CONTEXT');
    }
  });

  test('Codex keeps its hookSpecificOutput contract across events', () => {
    for (const event of [
      'SessionStart',
      'UserPromptSubmit',
      CONTEXT_ENVELOPE_EVENT.POST_TOOL_USE,
      'UnknownEvent',
      undefined,
    ]) {
      const parsed = JSON.parse(hookOutput('KB CONTEXT', {
        agent: AGENT.CODEX,
        hookEventName: event,
      }));
      assert.equal(parsed.hookSpecificOutput.hookEventName, event);
      assert.equal(parsed.hookSpecificOutput.additionalContext, 'KB CONTEXT');
    }
  });

  test('Cursor keeps its flat additional_context contract across events', () => {
    for (const event of ['sessionStart', 'beforeSubmitPrompt', 'postToolUse', undefined]) {
      const line = hookOutput('KB CONTEXT', {
        agent: AGENT.CURSOR,
        hookEventName: event,
      });
      assert.deepEqual(JSON.parse(line), { additional_context: 'KB CONTEXT' });
    }
  });

  test('all agent contracts preserve empty output as no output', () => {
    for (const agent of Object.values(AGENT)) {
      for (const output of [null, '']) {
        assert.equal(hookOutput(output, {
          agent,
          hookEventName: CONTEXT_ENVELOPE_EVENT.POST_TOOL_USE,
        }), null);
      }
    }
  });

  test('context envelopes preserve escaping and exact JSON shape', () => {
    const additionalContext = 'quote " slash \\ newline\nunicode \u2028';
    const line = hookOutput(additionalContext, {
      agent: AGENT.CLAUDE,
      hookEventName: CONTEXT_ENVELOPE_EVENT.POST_TOOL_USE,
    });
    assert.deepEqual(Object.keys(JSON.parse(line)), ['hookSpecificOutput']);
    assert.deepEqual(JSON.parse(line).hookSpecificOutput, {
      hookEventName: CONTEXT_ENVELOPE_EVENT.POST_TOOL_USE,
      additionalContext,
    });
  });
});
