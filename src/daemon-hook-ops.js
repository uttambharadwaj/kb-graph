// Maps control-socket op names to the same compute cores the CLI hooks fall
// back to (src/cli/prompt-hint.js, wakeup-hook.js, trigger-hook.js) — kept
// separate from daemon.js's own MCP wiring so the control-socket surface has
// one obvious place to extend. Imported only by daemon.js: these compute
// cores pull in db.js, which is exactly what bin/kb-trigger-hook.js's cold
// path (trigger-hook.js's own top-level imports) must not do.
import { computePromptHint } from './cli/prompt-hint.js';
import { computeTriggerHook } from './cli/trigger-hook.js';
import { computeWakeupHook } from './cli/wakeup-hook.js';

// Daemon-side calls always pass fastWrite: false (the default in each
// compute core) — one warm connection, no cross-process write contention,
// so the retrieval-log busy-tolerance the CLI fallback needs is a no-op here.
export const HOOK_OPS = {
  'prompt-hint': ({ prompt, session }) => computePromptHint({ prompt, session }),
  'trigger-hook': ({ hookInput }) => computeTriggerHook(hookInput),
  'wakeup-hook': ({ hookInput, session }) => computeWakeupHook({ hookInput, session }),
};
