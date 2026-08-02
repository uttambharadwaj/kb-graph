// UserPromptSubmit hook: when the user's prompt is actually about something the
// knowledge base holds, print a one-line hint naming those notes. Silent
// otherwise, which is most prompts — a surface that fires every time carries no
// information, so declining is the product, not a failure mode.
import { relevantNotes } from '../hint-relevance.js';
import { liveTierCounts } from '../db.js';
import { isBatchCall } from '../claude-cli.js';
import { SURFACE, logRetrievalResults, resolveSessionId } from '../retrieval.js';
import { tierLabel, tiersDiscriminate } from '../tiers.js';

const MAX_HINTS = 3;

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
    // Too short to mean anything, or a slash command with its own routing.
    if (prompt.trim().length < 20 || prompt.trim().startsWith('/')) process.exit(0);

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
    console.log(`KB HINT: the knowledge base has entries relevant to this prompt: ${items}. Check them with kb_read(id) before exploring from scratch.${caveat}`);
  } catch {
    // Never block a prompt on KB problems.
  }
  process.exit(0);
}
