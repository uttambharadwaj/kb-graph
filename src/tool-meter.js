// One row per MCP tool call. `retrievals` covers what was read and
// `extract-meter.js` covers one tool's input; this covers the other 25, which
// nobody could so much as count. Demand per tool decides which of them are
// worth keeping, an error rate is the difference between a tool that is
// unpopular and one that is broken, and a duration is what makes a call that
// never returns visible as something other than silence.
//
// Logged at the single place every tool is registered, so a tool added later
// is metered without anyone remembering to do it — the property that matters,
// since the tools nobody routes to are exactly the ones nobody instruments.
import { getDb } from './db.js';
import { resolveSessionId } from './retrieval.js';

// Enough of a failure to recognise it and group by it; the full text is in the
// caller's transcript, and a meter is not a log.
const ERROR_MAX_CHARS = 200;

// Never let telemetry break a tool call: insert failures are swallowed so the
// caller still gets its result, but logged loudly since a silent failure here
// means the meter quietly goes blind — same contract as retrieval.js.
export function logToolCall({ tool, ok, durationMs, resultChars = null, error = null, session = resolveSessionId() }) {
  try {
    getDb().prepare(
      'INSERT INTO tool_calls (tool, ok, duration_ms, result_chars, error, session) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(tool, ok ? 1 : 0, Math.round(durationMs), resultChars, error?.slice(0, ERROR_MAX_CHARS) ?? null, session);
  } catch (err) {
    console.error(`[KB] tool call log failed (tool=${tool}): ${err.message}`);
  }
}

// What a handler's reply says about how it went, without knowing the tool.
// An MCP handler reports a handled failure as `isError` on an ordinary reply
// rather than by throwing, so a wrapper that only catches sees every one of
// them as a success.
export function readToolResult(result) {
  const text = (result?.content ?? []).map(c => c?.text ?? '').join('');
  return {
    ok: !result?.isError,
    resultChars: text.length,
    error: result?.isError ? text : null,
  };
}

// Wrap a handler so its call is metered. Returns whatever the handler returned,
// and rethrows whatever it threw: a meter that changes an outcome is worse than
// no meter.
export function metered(name, handler) {
  return async (...args) => {
    const started = Date.now();
    try {
      const result = await handler(...args);
      const { ok, resultChars, error } = readToolResult(result);
      logToolCall({ tool: name, ok, durationMs: Date.now() - started, resultChars, error });
      return result;
    } catch (err) {
      logToolCall({ tool: name, ok: false, durationMs: Date.now() - started, error: String(err?.message || err) });
      throw err;
    }
  };
}
