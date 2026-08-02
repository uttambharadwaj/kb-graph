// Read-path telemetry: the write path has always been logged (documents,
// vault_files, harvest_log); nothing recorded whether any of it was ever
// read back. This is the one shared chokepoint for that — every read
// surface funnels through logRetrieval so `surface` values and `session`
// derivation can't drift between call sites.
import { getDb } from './db.js';

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

// session_id from Claude Code's hook stdin JSON is the only *documented*
// source — stable across every hook fired in one session. Stdio MCP
// subprocesses (kb_read/kb_search/kb_context handlers) get no such id from
// Claude Code itself, so those calls fall back to CLAUDE_CODE_SESSION_ID,
// which is set in some orchestration contexts (subagent/background jobs)
// and absent in a plain interactive session — best-effort, not a guarantee.
export function resolveSessionId(hookInput = null) {
  return hookInput?.session_id || process.env.CLAUDE_CODE_SESSION_ID || null;
}

// Never let telemetry break a read: insert failures are swallowed so the
// caller still gets its results, but logged loudly since a silent failure
// here means the meter quietly goes blind.
export function logRetrieval({ docId = null, surface, query = null, session = null }) {
  try {
    if (!SURFACES.includes(surface)) throw new Error(`unknown surface "${surface}"`);
    getDb().prepare(
      'INSERT INTO retrievals (doc_id, surface, query, session) VALUES (?, ?, ?, ?)'
    ).run(docId, surface, query, session);
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
}) {
  if (!surface) return;
  if (results.length === 0) {
    logRetrieval({ surface, query, session });
    return;
  }
  for (const r of results) logRetrieval({ docId: r.id, surface, query, session });
}
