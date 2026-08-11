// Maps control-socket op names to the same compute cores the CLI hooks fall
// back to (src/cli/prompt-hint.js, wakeup-hook.js, trigger-hook.js) — kept
// separate from daemon.js's own MCP wiring so the control-socket surface has
// one obvious place to extend. Imported only by daemon.js: these compute
// cores pull in db.js, which is exactly what bin/kb-trigger-hook.js's cold
// path (trigger-hook.js's own top-level imports) must not do.
import { computePromptHint } from './cli/prompt-hint.js';
import { computeTriggerHook } from './cli/trigger-hook.js';
import { computeWakeupHook } from './cli/wakeup-hook.js';
import { HOOK_OP } from './daemon-paths.js';

// Daemon-side calls always pass commit: false. The daemon never knows
// whether the client it is answering is still waiting — a slow response
// races the client's own deadline, and the client may already have fallen
// back and computed (and logged/marked) the same decision itself by the
// time this one arrives. Writing here too would double-log a retrieval row
// or burn a trigger marker for a warning that was never delivered. Instead
// each compute core returns { output, plan }, and only the client — the one
// process that actually knows whether it is using this answer — commits the
// plan, exactly once, right before it delivers. See each compute core's own
// header comment (prompt-hint.js, trigger-hook.js, wakeup-hook.js) for the
// full reasoning.
export const HOOK_OPS = {
  [HOOK_OP.PROMPT_HINT]: ({ prompt, session }) => computePromptHint({ prompt, session, commit: false }),
  [HOOK_OP.TRIGGER_HOOK]: ({ hookInput }) => computeTriggerHook(hookInput, { commit: false }),
  [HOOK_OP.WAKEUP_HOOK]: ({ hookInput, session }) => computeWakeupHook({ hookInput, session, commit: false }),
};
