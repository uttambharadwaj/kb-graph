// One row per model subprocess call. Logged from the single site every caller
// funnels through (runClaude in claude-cli.js), so a caller added later cannot
// ship dark by forgetting a log line -- parity by construction, same design as
// tool-meter.js. Model calls are the expensive, hang-prone surface (see
// child-exit.js) and, until this table, the only unmetered one.
import { getDb } from './db.js';

// Enough of a failure to recognise it and group by it; the full text is in the
// caller's own error handling, and a meter is not a log.
const ERROR_MAX_CHARS = 200;

// Never let telemetry break a model call: insert failures are swallowed so the
// caller still gets its result (or its error), but logged loudly since a
// silent failure here means the meter quietly goes blind -- same contract as
// tool-meter.js and retrieval.js.
export function logModelCall({ caller, model, ok, durationMs, promptChars, responseChars = null, error = null }) {
  try {
    getDb().prepare(
      'INSERT INTO model_calls (caller, model, ok, duration_ms, prompt_chars, response_chars, error) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(caller, model, ok ? 1 : 0, Math.round(durationMs), promptChars, responseChars, error?.slice(0, ERROR_MAX_CHARS) ?? null);
  } catch (err) {
    console.error(`[KB] model call log failed (caller=${caller}): ${err.message}`);
  }
}
