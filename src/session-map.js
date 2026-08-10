// claude_pid -> session_id map: the MCP server process is long-lived and one
// process hosts many session ids over time (/clear and compaction mint a new
// id without a new process), so an env var captured at server-spawn time goes
// stale. The two hook entrypoints that receive the real id every prompt
// (prompt-hint.js, wakeup-hook.js) write it here, keyed on the pid of the
// Claude Code CLI process they found by walking their own ancestry
// (process-ancestry.js); resolveSessionId (retrieval.js) walks the SAME
// ancestry from the server side and reads it back.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { KB_DIR } from './paths.js';
import { resolveClaudeAncestry } from './process-ancestry.js';

export const SESSION_MAP_DIR = join(KB_DIR, 'session-map');

const mapPath = (claudePid) => join(SESSION_MAP_DIR, `${claudePid}.json`);

// Hook side. Never lets a map-write problem break the hook it's called from:
// wrapped fully, failures silent — same contract as every other hook-adjacent
// write in this repo (see hook-io.js, trigger-hook.js's marker write).
// Returns whether the write landed, for callers/tests that care.
export function recordSessionMap(sessionId, { resolve = resolveClaudeAncestry } = {}) {
  if (!sessionId) return false;
  try {
    const { claudePid, pidStart } = resolve();
    if (claudePid == null || !pidStart) return false;
    mkdirSync(SESSION_MAP_DIR, { recursive: true });
    const path = mapPath(claudePid);
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ pid: claudePid, pid_start: pidStart, session_id: sessionId, ts: new Date().toISOString() }));
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

function readMapEntry(claudePid) {
  try {
    const entry = JSON.parse(readFileSync(mapPath(claudePid), 'utf-8'));
    return entry && typeof entry.session_id === 'string' && entry.session_id ? entry : null;
  } catch {
    return null;
  }
}

// Server side. `pidStart` is the caller's own freshly-resolved start time for
// this same claudePid; a mismatch means the pid was reused since the entry
// was written — a different process entirely, which is worse than no entry —
// so it's swept off disk rather than left to mislead the next reader too.
// `entry` is still returned on a mismatch (with pidStartOk: false): the
// caller (resolveSessionId) uses it only as a corroboration source for an
// independently-supplied env var, never trusts it standalone.
export function resolveMapEntry(claudePid, pidStart) {
  const entry = readMapEntry(claudePid);
  if (!entry) return { entry: null, pidStartOk: false };
  const pidStartOk = Boolean(pidStart) && entry.pid_start === pidStart;
  if (!pidStartOk) {
    try {
      if (existsSync(mapPath(claudePid))) unlinkSync(mapPath(claudePid));
    } catch {
      // Best-effort sweep — a failed delete just leaves a stale file, not a
      // reason to fail this read.
    }
  }
  return { entry, pidStartOk };
}
