// UserPromptSubmit hook: FTS-match the user's prompt against the KB and, when
// there are strong hits, print a one-line hint so the agent knows relevant
// entries exist. Silent (no stdout) when nothing clears the relevance bar.
import { searchDocuments } from '../db.js';
import { isBatchCall } from '../claude-cli.js';
import { logRetrieval, resolveSessionId } from '../retrieval.js';

// bm25 rank is negative-is-better; title matches get -20 and tag matches -10
// boosts in searchDocuments, so -12 keeps title/tag-grade hits and strong
// content matches while dropping incidental keyword overlap.
const RANK_THRESHOLD = -12;
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

    const results = searchDocuments(prompt, 10)
      .filter(r => r.rank <= RANK_THRESHOLD && r.doc_type !== 'archive')
      .slice(0, MAX_HINTS);
    const session = resolveSessionId(hookInput);
    // A prompt the KB had nothing for is the measurement, not the absence of one:
    // logging only the times we fired leaves a hit rate with no denominator.
    if (results.length === 0) {
      logRetrieval({ surface: 'hint', query: prompt, session });
      process.exit(0);
    }

    for (const r of results) logRetrieval({ docId: r.id, surface: 'hint', query: prompt, session });

    const items = results.map(r => `#${r.id} "${r.title}" (${r.doc_type})`).join('; ');
    console.log(`KB HINT: the knowledge base has entries relevant to this prompt: ${items}. Check them with kb_read(id) before exploring from scratch.`);
  } catch {
    // Never block a prompt on KB problems.
  }
  process.exit(0);
}
