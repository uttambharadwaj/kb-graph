// UserPromptSubmit hook: when the user's prompt is actually about something the
// knowledge base holds, print a one-line hint naming those notes. Silent
// otherwise, which is most prompts — a surface that fires every time carries no
// information, so declining is the product, not a failure mode.
import { relevantNotes } from '../hint-relevance.js';
import { liveTierCounts } from '../db.js';
import { isBatchCall } from '../claude-cli.js';
import { SURFACE, logRetrievalResults, resolveSessionId } from '../retrieval.js';
import { recordSessionMap } from '../session-map.js';
import { tierLabel, tiersDiscriminate } from '../tiers.js';
import { HOOK_ERROR_LOG, recordHookFailure, deliver } from './hook-io.js';

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

export async function promptHint() {
  // Our own model subprocesses are not user prompts. They cannot act on a hint
  // (no MCP tools) and logging them makes the read-path meter measure ourselves.
  if (isBatchCall()) process.exit(0);
  try {
    const raw = await readStdin();
    const hookInput = JSON.parse(raw);
    // Every prompt carries the true session id — refresh the claude_pid ->
    // session_id map before anything else, so MCP-surface calls that land
    // between this prompt and the next stay resolvable even if the rest of
    // this hook declines below.
    recordSessionMap(hookInput?.session_id);
    const prompt = hookInput?.prompt || '';
    // Too short to mean anything, a slash command with its own routing, or
    // something the harness said rather than the user.
    const trimmed = prompt.trim();
    if (trimmed.length < 20 || trimmed.startsWith('/') || HARNESS_ENVELOPE.test(trimmed)) process.exit(0);

    const results = relevantNotes(prompt, { limit: MAX_HINTS });
    // A prompt the KB had nothing for is the measurement, not the absence of one:
    // logging only the times we fired leaves a hit rate with no denominator, and
    // declining is now the common case rather than one that never happened.
    logRetrievalResults({
      results,
      surface: SURFACE.HINT,
      query: prompt,
      session: resolveSessionId(hookInput),
    });
    if (results.length === 0) process.exit(0);

    // A tier is only told to the reader when it separates one note from
    // another. While the whole store sits at one tier the label is on every
    // row, which is the same defect as a hint that never declines.
    const showTier = tiersDiscriminate(liveTierCounts());
    const items = results
      .map(r => `#${r.id} "${r.title}" (${r.doc_type}${showTier ? `, ${tierLabel(r.tier)}` : ''})`)
      .join('; ');
    const caveat = showTier ? ' ⚠ marks an unconfirmed model conclusion — treat it as a lead, not a finding.' : '';
    await deliver(`KB HINT: the knowledge base has entries relevant to this prompt: ${items}. Check them with kb_read(id) before exploring from scratch.${caveat}`);
  } catch (err) {
    // Never block a prompt on KB problems — but leave a marker, or a hint that
    // crashed before it could be metered reads as a prompt the store had
    // nothing for, and quietly shrinks the decline denominator.
    recordHookFailure('hint', err);
  }
  process.exit(0);
}
