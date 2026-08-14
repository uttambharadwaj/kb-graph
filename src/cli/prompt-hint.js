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
import { HOOK_ERROR_LOG, callDaemonOp, hookDaemonTimeoutMs, noteHookTiming, recordHookFailure, deliver, watchHookTiming } from './hook-io.js';
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
// id, decides the hint (or lack of one). No stdin, no process.exit — callable
// identically from the daemon's control-socket dispatcher and from this
// file's own CLI fallback. Never throws: a failure here is recorded and
// answered as "no hint", the same contract the daemon dispatcher and the CLI
// wrapper both rely on.
//
// commit (default true, the CLI fallback's mode) logs the retrieval
// immediately, inline, and returns { output, plan: null }. commit: false
// (the daemon dispatcher's mode) makes no write at all and instead returns
// the write as `plan` — a slow daemon response the client's deadline already
// gave up on must not silently write a row nothing ever delivered, and a
// daemon response the client DOES use must not be logged by two different
// processes for one decision. Only the process that ends up delivering
// `output` may ever commit `plan` (see commitPromptHintPlan) — exactly once,
// which is the whole point of the split.
export function computePromptHint({ prompt, session, fastWrite = false, commit = true }) {
  try {
    const results = relevantNotes(prompt, { limit: MAX_HINTS });
    // One event id for every doc row (or the single miss row) this prompt
    // produces -- the decision unit is "this prompt got a hint or didn't",
    // not each row it happened to log.
    const eventId = randomUUID();
    if (commit) {
      // A prompt the KB had nothing for is the measurement, not the absence
      // of one: logging only the times we fired leaves a hit rate with no
      // denominator, and declining is now the common case rather than one
      // that never happened.
      logRetrievalResults({ results, surface: SURFACE.HINT, query: prompt, session, eventId, fastWrite });
    }
    const plan = commit ? null : { docIds: results.map(r => r.id), query: prompt, eventId };

    if (results.length === 0) return { output: null, plan };

    // A tier is only told to the reader when it separates one note from
    // another. While the whole store sits at one tier the label is on every
    // row, which is the same defect as a hint that never declines.
    const showTier = tiersDiscriminate(liveTierCounts());
    const items = results
      .map(r => `#${r.id} "${r.title}" (${r.doc_type}${showTier ? `, ${tierLabel(r.tier)}` : ''})`)
      .join('; ');
    const caveat = showTier ? ' ⚠ marks an unconfirmed model conclusion — treat it as a lead, not a finding.' : '';
    const output = `KB HINT: the knowledge base has entries relevant to this prompt: ${items}. Check them with kb_read(id) before exploring from scratch.${caveat}`;
    return { output, plan };
  } catch (err) {
    // Never block a prompt on KB problems — but leave a marker, or a hint that
    // crashed before it could be metered reads as a prompt the store had
    // nothing for, and quietly shrinks the decline denominator.
    recordHookFailure('hint', err);
    return { output: null, plan: null };
  }
}

// Commits a plan computePromptHint returned with commit: false. Caller's
// job to call this at most once, and only for the plan it is actually about
// to deliver — see the header comment on computePromptHint.
export function commitPromptHintPlan(plan, { session, fastWrite }) {
  if (!plan) return;
  const results = plan.docIds.map(id => ({ id }));
  logRetrievalResults({ results, surface: SURFACE.HINT, query: plan.query, session, eventId: plan.eventId, fastWrite });
}

export async function promptHint() {
  watchHookTiming(HOOK_OP.PROMPT_HINT);
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
    let output;
    if (daemon.ok) {
      // This is the one commit for this prompt: the daemon computed with
      // commit: false (see computePromptHint), so nothing has been logged
      // for it yet. A daemon response that arrives after this deadline
      // already fired is simply never reached here — its plan, and the row
      // it would have written, evaporate with it.
      commitPromptHintPlan(daemon.plan, { session, fastWrite: true });
      output = daemon.output;
      noteHookTiming('daemon');
    } else {
      noteHookTiming('fallback');
      ({ output } = computePromptHint({ prompt, session, fastWrite: true }));
    }
    if (output) await deliver(output);
  } catch (err) {
    // Never block a prompt on KB problems — but leave a marker, or a hint that
    // crashed before it could be metered reads as a prompt the store had
    // nothing for, and quietly shrinks the decline denominator.
    recordHookFailure('hint', err);
  }
  process.exit(0);
}
