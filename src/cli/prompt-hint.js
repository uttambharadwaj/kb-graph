// UserPromptSubmit hook: when the user's prompt is actually about something the
// knowledge base holds, print a one-line hint naming those notes. Silent
// otherwise, which is most prompts — a surface that fires every time carries no
// information, so declining is the product, not a failure mode.
import { randomUUID } from 'crypto';
import { relevantNotes } from '../hint-relevance.js';
import { liveTierCounts } from '../db.js';
import { isBatchCall } from '../claude-cli.js';
import { SURFACE, logRetrievalResults, resolveSessionId } from '../retrieval.js';
import { recordSessionMap } from '../session-map.js';
import { tierLabel, tiersDiscriminate } from '../tiers.js';
import { HOOK_ERROR_LOG, callDaemonOp, hookDaemonTimeoutMs, recordHookFailure, deliver } from './hook-io.js';
import { HOOK_OP } from '../daemon-paths.js';

const MAX_HINTS = 3;

// Re-exported rather than duplicated — trigger-hook.js (PreToolUse, runs on
// every Bash call) imports these from hook-io.js directly instead of from
// here, since this module pulls in db.js at load time and that hook must not.
export { HOOK_ERROR_LOG, recordHookFailure, deliver };

// Task notifications, system reminders and subagent reports reach this hook the
// same way a typed prompt does, wrapped in a tag. Nobody said them to us, so
// hinting on them is noise and metering them measures the harness — the same
// reason slash commands are skipped below. The whole prompt must be the one
// element: merely *opening* with a tag would also swallow someone asking why
// their <div> renders wrong. The attributes are not optional decoration —
// `<agent-message from="...">` is how a subagent's report arrives, and matching
// only bare tags let 11kB of one through onto the meter.
const HARNESS_ENVELOPE = /^<([a-z][a-z-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>$/i;

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

// The compute core: given an already-gated prompt and its resolved session
// id, decides the hint (or lack of one) and logs the retrieval. No stdin, no
// process.exit — callable identically from the daemon's control-socket
// dispatcher (fastWrite: false, one warm connection, no contention) and from
// this file's own CLI fallback (fastWrite: true, see retrieval.js). Never
// throws: a failure here is recorded and answered as "no hint", the same
// contract the daemon dispatcher and the CLI wrapper both rely on.
export function computePromptHint({ prompt, session, fastWrite = false }) {
  try {
    const results = relevantNotes(prompt, { limit: MAX_HINTS });
    // A prompt the KB had nothing for is the measurement, not the absence of one:
    // logging only the times we fired leaves a hit rate with no denominator, and
    // declining is now the common case rather than one that never happened.
    // One event id for every doc row (or the single miss row) this prompt
    // produces -- the decision unit is "this prompt got a hint or didn't",
    // not each row it happened to log.
    logRetrievalResults({
      results,
      surface: SURFACE.HINT,
      query: prompt,
      session,
      eventId: randomUUID(),
      fastWrite,
    });
    if (results.length === 0) return null;

    // A tier is only told to the reader when it separates one note from
    // another. While the whole store sits at one tier the label is on every
    // row, which is the same defect as a hint that never declines.
    const showTier = tiersDiscriminate(liveTierCounts());
    const items = results
      .map(r => `#${r.id} "${r.title}" (${r.doc_type}${showTier ? `, ${tierLabel(r.tier)}` : ''})`)
      .join('; ');
    const caveat = showTier ? ' ⚠ marks an unconfirmed model conclusion — treat it as a lead, not a finding.' : '';
    return `KB HINT: the knowledge base has entries relevant to this prompt: ${items}. Check them with kb_read(id) before exploring from scratch.${caveat}`;
  } catch (err) {
    // Never block a prompt on KB problems — but leave a marker, or a hint that
    // crashed before it could be metered reads as a prompt the store had
    // nothing for, and quietly shrinks the decline denominator.
    recordHookFailure('hint', err);
    return null;
  }
}

export async function promptHint() {
  // Our own model subprocesses are not user prompts. They cannot act on a hint
  // (no MCP tools) and logging them makes the read-path meter measure ourselves.
  if (isBatchCall()) process.exit(0);
  try {
    const raw = await readStdin();
    const hookInput = JSON.parse(raw);
    const prompt = hookInput?.prompt || '';
    // Too short to mean anything, a slash command with its own routing, or
    // something the harness said rather than the user. Checked before the
    // session-map write below: that write costs a `ps` call, and the large
    // majority of prompts hitting this hook are short/slash-command noise —
    // no reason to pay it on ones this hook is about to decline anyway.
    // wakeup-hook.js's SessionStart fires far less often, so it keeps its
    // write unconditional.
    const trimmed = prompt.trim();
    if (trimmed.length < 20 || trimmed.startsWith('/') || HARNESS_ENVELOPE.test(trimmed)) process.exit(0);

    // Every prompt that reaches here carries the true session id — refresh
    // the claude_pid -> session_id map so MCP-surface calls landing before
    // the next prompt stay resolvable. Ancestry-dependent (walks THIS
    // process's own parent chain) — must run here, never daemon-side.
    recordSessionMap(hookInput?.session_id);
    // Same reason: resolveSessionId falls back to ancestry when hookInput
    // carries no session_id. Resolved once, here, and handed to compute as a
    // plain value so neither the daemon nor the fallback branch below ever
    // has to touch ancestry again.
    const session = resolveSessionId(hookInput);

    const daemon = await callDaemonOp(HOOK_OP.PROMPT_HINT, { prompt, session }, { timeoutMs: hookDaemonTimeoutMs(HOOK_OP.PROMPT_HINT) });
    const output = daemon.ok ? daemon.output : computePromptHint({ prompt, session, fastWrite: true });
    if (output) await deliver(output);
  } catch (err) {
    // Never block a prompt on KB problems — but leave a marker, or a hint that
    // crashed before it could be metered reads as a prompt the store had
    // nothing for, and quietly shrinks the decline denominator.
    recordHookFailure('hint', err);
  }
  process.exit(0);
}
