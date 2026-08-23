// Read-path telemetry: the write path has always been logged (documents,
// vault_files, harvest_log); nothing recorded whether any of it was ever
// read back. This is the one shared chokepoint for that — every read
// surface funnels through logRetrieval so `surface` values and `session`
// derivation can't drift between call sites.
import { AsyncLocalStorage } from 'async_hooks';
import { DEFAULT_BUSY_TIMEOUT_MS, getDb } from './db.js';
import { resolveHarnessAncestry } from './process-ancestry.js';
import { resolveMapEntry } from './session-map.js';

// A cold-booted hook process's connection carries the same 5s busy_timeout as
// every other caller — fine for a warm, single-writer process (the daemon),
// wrong for a one-shot hook racing a long writer under a 10s hook budget.
// `fastWrite` narrows the wait to this before the INSERT, so a busy DB drops
// the write (still caught below) instead of blocking most of the budget.
const FAST_WRITE_BUSY_TIMEOUT_MS = 100;

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
  // Not a retrieval — a rediscovery is duplicate detection catching an agent
  // re-deriving something the KB already had. Deliberately absent from
  // PUSH_SURFACES/READ_SURFACES: it's neither a push nor a pull of a note,
  // it's a signal that a write attempt collided with one.
  REDISCOVERY: 'rediscovery',
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
// (prompt-hint.js, wakeup-hook.js) write harness_pid -> session_id into
// session-map.js every time they run, keyed on the pid of the harness
// process found by walking their own ancestry (process-ancestry.js); this
// walks the SAME ancestry from the server side and reads it back.
//
// Ancestry (which pid is our harness ancestor, which agent it is, and its
// start time) is resolved once and reused for the life of the process — it
// cannot change while this process is alive. The map FILE at that pid is
// re-read on every call, since the session id behind one pid is exactly what
// changes.
//
// The process-cached walk is only right when the process IS a descendant of
// the harness. Under the resident daemon it is not: one launchd-parented
// process serves every session, so its own walk names launchd and every
// MCP-surface row it wrote came out session=NULL, agent=NULL. There the
// identity arrives per connection (the shim's hello line, see
// shim-hello.js) and the daemon binds it around each tool call through this
// store — per connection, so two harnesses calling at once cannot
// cross-stamp each other. Unset (in-process `kb mcp`, the REST/CLI surfaces,
// a hook) means the process's own walk is the right answer, which is the
// fallback below.
export const callIdentity = new AsyncLocalStorage();

let cachedAncestry = null;
function defaultAncestry() {
  const bound = callIdentity.getStore();
  if (bound) return bound;
  if (!cachedAncestry) cachedAncestry = resolveHarnessAncestry();
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
  const { harnessPid, pidStart } = getAncestry();
  if (harnessPid == null) return null;
  const { entry, pidStartOk } = resolveMapEntry(harnessPid, pidStart);
  return entry && pidStartOk ? entry.session_id : null;
}

// Which harness this process is running under, off the SAME cached ancestry
// walk resolveSessionId uses — one `ps` for both answers. Unlike the session
// id there is no map file to consult and nothing to go stale: the agent
// behind a pid cannot change while that process is alive. NULL when the walk
// found no harness at all (a cron job, the resident daemon, a bare shell).
export function resolveAgent({ getAncestry = defaultAncestry } = {}) {
  return getAncestry().agent ?? null;
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
//
// agent: the hook entrypoints know which client they were installed for and
// pass it explicitly; everything else (MCP/REST/CLI surfaces) falls back to
// the ancestry walk, which names the harness this process is a descendant of.
// NULL when neither knows, and reports read that as "unknown" rather than
// assuming Claude — the whole point of the column is that the answer used to
// be assumed.
export function logRetrieval({ docId = null, surface, query = null, session = null, eventId = null, agent = null, fastWrite = false }) {
  try {
    if (!SURFACES.includes(surface)) throw new Error(`unknown surface "${surface}"`);
    const database = getDb();
    // Single-threaded, synchronous driver: no other call on this connection
    // can interleave between the lowered pragma and its restore below.
    if (fastWrite) database.pragma(`busy_timeout = ${FAST_WRITE_BUSY_TIMEOUT_MS}`);
    try {
      database.prepare(
        'INSERT INTO retrievals (doc_id, surface, query, session, event_id, is_test, agent) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(docId, surface, query, session, eventId, isTestSession(session) ? 1 : 0, agent ?? resolveAgent());
    } finally {
      if (fastWrite) database.pragma(`busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
    }
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
  agent = null,
  fastWrite = false,
}) {
  if (!surface) return;
  if (results.length === 0) {
    logRetrieval({ surface, query, session, eventId, agent, fastWrite });
    return;
  }
  for (const r of results) logRetrieval({ docId: r.id, surface, query, session, eventId, agent, fastWrite });
}
