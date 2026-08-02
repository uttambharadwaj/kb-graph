// Safety gate for destructive actions — blocks when the reviewer cannot answer.
import { searchDocuments } from '../db.js';
import { runClaudeJSON } from '../claude-cli.js';

const REVIEW_MODEL = 'claude-haiku-4-5-20251001';
const REVIEW_MODELS = [REVIEW_MODEL];

// Shorter than the extractor's: a human is waiting on this before a destructive
// action. The generated-token spread that walks extraction calls past their
// deadline applies here too, so an overrun is an expected outcome rather than an
// exceptional one, and has to read as a block.
const REVIEW_TIMEOUT_MS = Number(process.env.KB_REVIEW_TIMEOUT_MS) || 30000;

const REVIEW_PROMPT = `You are a safety reviewer for a VPS operations team. A destructive action is about to be taken.

CRITICAL CONTEXT: On 2026-03-14, a Vast.ai instance with 299GB of completed encoded media was DESTROYED before transferring files. This cost $9.56 and 18+ hours of GPU work.

Given the action below and any relevant KB context, respond with ONLY valid JSON:
{
  "safe": true/false,
  "risk_level": "low"/"medium"/"high"/"critical",
  "concerns": ["list of specific concerns"],
  "recommendation": "proceed" or "stop and verify X first" or "do Y before this",
  "reasoning": "1-2 sentences"
}

Rules:
- Any cloud instance destroy/terminate without confirmed data transfer = CRITICAL
- Any rm -rf on media/data directories = HIGH
- Any database drop without backup = HIGH
- Any git force push to main = MEDIUM
- Routine container restarts, rebuilds = LOW`;

// A reviewer that could not answer is not a reviewer that approved. The reason
// is carried through verbatim so an operator can tell a timeout from a crash.
const noVerdict = (model, reason) => ({
  safe: false,
  risk_level: 'unknown',
  concerns: [`Safety review did not complete: ${reason}`],
  recommendation: 'manual review needed',
  reasoning: reason,
  model,
});

function gatherKbContext(action) {
  // Surface-less on purpose: these notes go to our own review model, and
  // metering them would have the read-path meter measuring itself.
  const kbResults = searchDocuments(action.slice(0, 100), 5);
  const kbContext = kbResults
    .map(r => `[${r.doc_type}] ${r.title}: ${r.snippet?.replace(/<\/?mark>/g, '').slice(0, 150)}`)
    .join('\n');
  return { kbResults, kbContext };
}

const buildPrompt = (action, context, kbContext) => `${REVIEW_PROMPT}

ACTION: ${action}

${context ? `ADDITIONAL CONTEXT: ${context}` : ''}

KB SEARCH RESULTS (past incidents/lessons):
${kbContext || 'No relevant past incidents found.'}`;

async function askModel(model, prompt) {
  try {
    return { ...await runClaudeJSON(prompt, { model, timeout: REVIEW_TIMEOUT_MS }), model };
  } catch (err) {
    return noVerdict(model, err.message);
  }
}

export async function reviewDestructiveAction(action, context = '') {
  const { kbResults, kbContext } = gatherKbContext(action);
  const verdict = await askModel(REVIEW_MODEL, buildPrompt(action, context, kbContext));
  return { ...verdict, kb_matches: kbResults.length };
}

// Multi-model review: ask all of them, take the most conservative answer.
export async function multiModelReview(action, context = '') {
  const { kbResults, kbContext } = gatherKbContext(action);
  const prompt = buildPrompt(action, context, kbContext);
  const reviews = await Promise.all(REVIEW_MODELS.map(m => askModel(m, prompt)));

  const anySaysUnsafe = reviews.some(r => !r.safe);
  const highestRisk = ['critical', 'high', 'medium', 'low'].find(
    level => reviews.some(r => r.risk_level === level)
  ) || 'unknown';

  return {
    safe: !anySaysUnsafe,
    risk_level: highestRisk,
    reviews,
    kb_matches: kbResults.length,
    consensus: anySaysUnsafe ? 'BLOCKED — at least one model flagged this as unsafe' : 'APPROVED — all models agree this is safe',
  };
}
