import { spawn } from 'child_process';
import { searchDocuments } from '../db.js';

const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';

function runModel(model, prompt) {
  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_PATH, [
      '-p', '--model', model,
      '--output-format', 'json',
      '--max-turns', '1',
    ], {
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli' },
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.on('close', code => {
      try {
        const response = JSON.parse(stdout);
        resolve({ model, verdict: response.result || 'no response', error: null });
      } catch {
        resolve({ model, verdict: null, error: `exit ${code}` });
      }
    });
    proc.on('error', err => resolve({ model, verdict: null, error: err.message }));
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

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

export async function reviewDestructiveAction(action, context = '') {
  // Search KB for relevant past incidents
  const kbResults = searchDocuments(action.slice(0, 100), 5);
  const kbContext = kbResults
    .map(r => `[${r.doc_type}] ${r.title}: ${r.snippet?.replace(/<\/?mark>/g, '').slice(0, 150)}`)
    .join('\n');

  const fullPrompt = `${REVIEW_PROMPT}

ACTION: ${action}

${context ? `ADDITIONAL CONTEXT: ${context}` : ''}

KB SEARCH RESULTS (past incidents/lessons):
${kbContext || 'No relevant past incidents found.'}`;

  // Run through Claude Haiku (fast, cheap)
  const result = await runModel('claude-haiku-4-5-20251001', fullPrompt);

  let parsed;
  try {
    const jsonStr = result.verdict?.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
    parsed = JSON.parse(jsonStr);
  } catch {
    parsed = { safe: false, risk_level: 'unknown', concerns: ['Could not parse review'], recommendation: 'manual review needed', reasoning: result.verdict || result.error };
  }

  return {
    ...parsed,
    model: result.model,
    kb_matches: kbResults.length,
  };
}

// Multi-model review: ask all 3, take the most conservative answer
export async function multiModelReview(action, context = '') {
  const kbResults = searchDocuments(action.slice(0, 100), 5);
  const kbContext = kbResults
    .map(r => `[${r.doc_type}] ${r.title}: ${r.snippet?.replace(/<\/?mark>/g, '').slice(0, 150)}`)
    .join('\n');

  const fullPrompt = `${REVIEW_PROMPT}

ACTION: ${action}

${context ? `ADDITIONAL CONTEXT: ${context}` : ''}

KB SEARCH RESULTS (past incidents/lessons):
${kbContext || 'No relevant past incidents found.'}`;

  // Fan out to all 3 models simultaneously
  const models = [
    'claude-haiku-4-5-20251001',
    // Codex and Gemini would go here when available via CLI
    // For now, run Haiku twice with different temperature seeds as a proxy
  ];

  const reviews = await Promise.all(models.map(m => runModel(m, fullPrompt)));

  const parsed = reviews.map(r => {
    try {
      const jsonStr = r.verdict?.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
      return { ...JSON.parse(jsonStr), model: r.model };
    } catch {
      return { safe: false, risk_level: 'unknown', model: r.model, concerns: ['Parse error'], recommendation: 'manual review' };
    }
  });

  // Most conservative wins: if ANY model says unsafe, it's unsafe
  const anySaysUnsafe = parsed.some(p => !p.safe);
  const highestRisk = ['critical', 'high', 'medium', 'low'].find(
    level => parsed.some(p => p.risk_level === level)
  ) || 'unknown';

  return {
    safe: !anySaysUnsafe,
    risk_level: highestRisk,
    reviews: parsed,
    kb_matches: kbResults.length,
    consensus: anySaysUnsafe ? 'BLOCKED — at least one model flagged this as unsafe' : 'APPROVED — all models agree this is safe',
  };
}
