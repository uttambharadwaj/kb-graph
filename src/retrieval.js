// Read-path telemetry: the write path has always been logged (documents,
// vault_files, harvest_log); nothing recorded whether any of it was ever
// read back. This is the one shared chokepoint for that — every read
// surface funnels through logRetrieval so `surface` values and `session`
// derivation can't drift between call sites.
import { getDb } from './db.js';

export const SURFACES = ['kb_read', 'kb_search', 'kb_context', 'briefing', 'hint'];

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
