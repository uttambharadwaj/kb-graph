// Read-path telemetry: the write path has always been logged (documents,
// vault_files, harvest_log); nothing recorded whether any of it was ever
// read back. This is the one shared chokepoint for that — every read
// surface funnels through logRetrieval so `surface` values and `session`
// derivation can't drift between call sites.
import { getDb } from './db.js';
import { resolveClaudeAncestry } from './process-ancestry.js';
import { resolveMapEntry } from './session-map.js';

// Named individually so the report's SQL can reference a surface instead of
// restating the literal: a rename there would otherwise report zero rather
// than fail, and zero is already the expected reading for other reasons.
//
// A surface is one channel's one operation. The MCP surfaces keep their tool
// names so rows logged before the REST/CLI surfaces existed stay readable;
// everything added since is `<channel>_<operation>`.
export const SURFACE = {
  READ: 'kb_read',
  SEARCH: 'kb_search',
  SEARCH_SMART: 'kb_search_smart',
  CONTEXT: 'kb_context',
  TUNNELS: 'kb_tunnels',
  BRIEFING: 'briefing',
  HINT: 'hint',
  REST_READ: 'rest_read',
  REST_SEARCH: 'rest_search',
  REST_SEARCH_SMART: 'rest_search_smart',
  REST_CONTEXT: 'rest_context',
  CLI_SEARCH: 'cli_search',
};

export const SURFACES = Object.values(SURFACE);

// Push surfaces send notes at the agent unasked; pull surfaces are a caller
// going and getting them. The distinction is the whole point of the meter —
// a read path that is 98% push is a push channel, not a retrieval system —
// so the report segments by it rather than re-deriving the split in SQL.
export const PUSH_SURFACES = [SURFACE.BRIEFING, SURFACE.HINT];

// Opening one specific note, on any channel. Follow-through means the reader
// went and opened what was pushed at them; which channel they used to do it
// is not the question, so both belong here or the metric under-counts every
// time a channel is added.
export const READ_SURFACES = [SURFACE.READ, SURFACE.REST_READ];

// Being told to go and look is the one label a person produces unprompted: it
// says the retrieval that should have happened didn't, in their words, at the
// moment it failed. Everything else the meter holds is the system describing
// its own behaviour.
//
// Deliberately narrow. These prompts are read off a store whose owner spends
// whole sessions working ON the knowledge base, so anything that fires on
// merely *discussing* it — "silent fails on the kb", "pin this in the kb" —
// measures the topic instead of the failure. Widen only against a real miss.
const KB = String.raw`(?:kb|knowledge[ -]?base)`;
const KB_NUDGE = new RegExp([
  String.raw`\b(?:look|check|search|read|consult|grep|query)\s+(?:in|at|into|through|up|on)?\s*(?:the\s+)?${KB}\b`,
  String.raw`\b(?:any|some|no)thing\s+(?:\w+\s+){0,3}?in\s+(?:the\s+)?${KB}\b`,
  String.raw`\bkb_(?:search|read|context)\b`,
].join('|'), 'i');

export const isKbNudge = (prompt) => KB_NUDGE.test(prompt || '');

// session_id from Claude Code's hook stdin JSON is the only *documented*
// source — stable across every hook fired in one session. Stdio MCP
// subprocesses (kb_read/kb_search/kb_context handlers) get no such id from
// Claude Code itself.
//
// They used to fall back to CLAUDE_CODE_SESSION_ID, but the MCP server
// process is long-lived and one process hosts many session ids over time
// (/clear and compaction mint a new id without a new process) — an env var
// captured at server-spawn time goes stale, and every call after the first
// stamped a frozen, wrong id. Instead: the hook entrypoints
// (prompt-hint.js, wakeup-hook.js) write claude_pid -> session_id into
// session-map.js every time they run, keyed on the pid of the Claude Code
// CLI process found by walking their own ancestry (process-ancestry.js);
// this walks the SAME ancestry from the server side and reads it back.
//
// Ancestry (which pid is our claude-harness ancestor, and its start time) is
// resolved once and reused for the life of the process — it cannot change
// while this process is alive. The map FILE at that pid is re-read on every
// call, since the session id behind one pid is exactly what changes.
let cachedAncestry = null;
function defaultAncestry() {
  if (!cachedAncestry) cachedAncestry = resolveClaudeAncestry();
  return cachedAncestry;
}

// No env fallback: CLAUDE_CODE_SESSION_ID is set in some orchestration
// contexts (subagent/background jobs) and absent in a plain interactive
// session, but nothing about its presence proves it's *current* for this
// process — a stale value inherited from a parent environment reads
// identically to a fresh one. A pid_start-mismatched map entry names a dead
// process's session id, and corroborating env against it just re-admits the
// same stale-id failure mode this walk exists to kill — stale is worse than
// NULL, which is the whole premise of the switch away from the env var.
// Only a pid_start-verified map hit is trusted; anything else is NULL.
export function resolveSessionId(hookInput = null, { getAncestry = defaultAncestry } = {}) {
  if (hookInput?.session_id) return hookInput.session_id;
  const { claudePid, pidStart } = getAncestry();
  if (claudePid == null) return null;
  const { entry, pidStartOk } = resolveMapEntry(claudePid, pidStart);
  return entry && pidStartOk ? entry.session_id : null;
}

// Exact ids already polluting the table from manual smoke/verification runs
// that predate the naming convention below -- kept as a literal list rather
// than folded into the regex so a new one-off id doesn't have to be shaped
// like these to get excluded; it just has to follow the prefix convention.
const TEST_SESSION_LITERALS = new Set(['smoke-test', 'smoke-2', 'smoke-compact-test', 'live-verify']);

// The naming convention for smoke/manual-verification sessions going forward.
const TEST_SESSION_PREFIX = /^(?:smoke|test|fake)[-_]/i;

// Whether a session id names a smoke/verification run rather than real usage.
// Computed at write time (see logRetrieval) so every report reads is_test off
// the row instead of repeating this classification in its own SQL.
export function isTestSession(session) {
  if (!session) return false;
  return TEST_SESSION_PREFIX.test(session) || TEST_SESSION_LITERALS.has(session);
}

// Never let telemetry break a read: insert failures are swallowed so the
// caller still gets its results, but logged loudly since a silent failure
// here means the meter quietly goes blind.
//
// eventId is the caller's to generate and reuse: one hint prompt's ≤3 doc
// rows, one SessionStart's briefing rows, or one search/context/tunnels
// call's result rows all share a single id, so the group they form is a
// property of the data instead of something a report reconstructs from
// timestamps — reconstruction can't tell two same-second calls apart.
// Left NULL only for a call whose result is already exactly one row
// (kb_read/getDocument).
export function logRetrieval({ docId = null, surface, query = null, session = null, eventId = null }) {
  try {
    if (!SURFACES.includes(surface)) throw new Error(`unknown surface "${surface}"`);
    getDb().prepare(
      'INSERT INTO retrievals (doc_id, surface, query, session, event_id, is_test) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(docId, surface, query, session, eventId, isTestSession(session) ? 1 : 0);
  } catch (err) {
    console.error(`[KB] retrieval log failed (surface=${surface}, doc_id=${docId}): ${err.message}`);
  }
}

// The one place a result set becomes rows, so the miss row, the per-doc rows
// and the session lookup can't drift between channels.
//
// Self-gating: no surface means an internal lookup (a supersede reading the
// row it is about to update), not a retrieval.
//
// Log what you RETURN. searchDocuments/getDocument call this for you when
// passed a surface; a caller that filters or merges first must leave the
// surface off and call this on its final set, or the meter counts documents
// the caller never saw.
export function logRetrievalResults({
  results = [],
  surface,
  query = null,
  session = resolveSessionId(),
  eventId = null,
}) {
  if (!surface) return;
  if (results.length === 0) {
    logRetrieval({ surface, query, session, eventId });
    return;
  }
  for (const r of results) logRetrieval({ docId: r.id, surface, query, session, eventId });
}
