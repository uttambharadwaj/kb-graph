// UserPromptSubmit hook: when the user's prompt is actually about something the
// knowledge base holds, print a one-line hint naming those notes. Silent
// otherwise, which is most prompts — a surface that fires every time carries no
// information, so declining is the product, not a failure mode.
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { relevantNotes } from '../hint-relevance.js';
import { liveTierCounts } from '../db.js';
import { isBatchCall } from '../claude-cli.js';
import { LOGS_DIR } from '../paths.js';
import { SURFACE, logRetrievalResults, resolveSessionId } from '../retrieval.js';
import { tierLabel, tiersDiscriminate } from '../tiers.js';

const MAX_HINTS = 3;

export const HOOK_ERROR_LOG = join(LOGS_DIR, 'prompt-hint-errors.log');

// Non-blocking is right — a knowledge base problem must never stop a prompt —
// but silent is not. A hook that failed and a hook that had nothing to say are
// identical from outside, which is why intermittent hook errors have never been
// attributable to a particular hook. One line, then exit 0 exactly as before.
export function recordHookFailure(stage, err) {
  try {
    // paths.js creates the files dir, not this one, and the first thing ever
    // written here is by definition a failure — the worst moment to discover
    // the destination is missing.
    mkdirSync(LOGS_DIR, { recursive: true });
    // One failure is one line. A stack pasted in raw makes `wc -l` on this file
    // count frames, which is the wrong answer to the only question it is asked.
    const detail = String(err?.stack || err).replace(/\s*\n\s*/g, ' | ');
    appendFileSync(HOOK_ERROR_LOG, `${new Date().toISOString()} ${stage}: ${detail}\n`);
  } catch {
    // A logger that fails must not be louder than the thing it was logging.
  }
}

// console.log returns before the pipe has taken the bytes, so a delivery that
// fails is recorded by the meter as a hint that fired and seen by the caller as
// nothing at all. Wait for the write, and say so when it does not land.
export function deliver(line, out = process.stdout) {
  return new Promise(resolve => {
    out.write(`${line}\n`, err => {
      if (err) recordHookFailure('deliver', err);
      resolve();
    });
  });
}

// Task notifications and system reminders reach this hook the same way a typed
// prompt does, wrapped in a tag. Nobody said them to us, so hinting on them is
// noise and metering them measures the harness — the same reason slash commands
// are skipped below. The whole prompt must be the one element: merely *opening*
// with a tag would also swallow someone asking why their <div> renders wrong.
const HARNESS_ENVELOPE = /^<([a-z][a-z-]*)>[\s\S]*<\/\1>$/i;

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
