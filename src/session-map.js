// claude_pid -> session_id map: the MCP server process is long-lived and one
// process hosts many session ids over time (/clear and compaction mint a new
// id without a new process), so an env var captured at server-spawn time goes
// stale. The two hook entrypoints that receive the real id every prompt
// (prompt-hint.js, wakeup-hook.js) write it here, keyed on the pid of the
// Claude Code CLI process they found by walking their own ancestry
// (process-ancestry.js); resolveSessionId (retrieval.js) walks the SAME
// ancestry from the server side and reads it back.
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { KB_DIR } from './paths.js';
import { resolveClaudeAncestry } from './process-ancestry.js';

export const SESSION_MAP_DIR = join(KB_DIR, 'session-map');

const mapPath = (claudePid) => join(SESSION_MAP_DIR, `${claudePid}.json`);

// One file per claude pid, forever, was the accepted follow-up from #87 —
// nothing ever removes an entry once its process is gone. Age rather than a
// liveness check: confirming a pid is dead is a race against reuse, but a
// mapping nobody has read in a week is safe to drop either way.
const SESSION_MAP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Opportunistic, riding the write path only (never the read path — a reader
// has no business mutating the directory it's scanning). One readdir, one
// stat per sibling, and any error anywhere abandons the rest of the sweep
// silently: the next write tries again, same as a write that fails outright.
function sweepStaleEntries(justWrittenPath) {
  try {
    const now = Date.now();
    for (const name of readdirSync(SESSION_MAP_DIR)) {
      const candidate = join(SESSION_MAP_DIR, name);
      if (candidate === justWrittenPath) continue;
      if (now - statSync(candidate).mtimeMs > SESSION_MAP_MAX_AGE_MS) unlinkSync(candidate);
    }
  } catch {
    // best-effort — see comment above.
  }
}

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
    sweepStaleEntries(path);
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
// was written — a different (and by now possibly dead) process, so the entry
// is reported as a miss, same as no file at all. Read-side never deletes it:
// this process's own ancestry cache can itself be stale (a long-lived server
// outliving its claude parent, pid later reused by a new session), and a
// delete driven by a stale comparison would erase a DIFFERENT, live process's
// current mapping. A mismatched file is inert — every reader already ignores
// it — so it's left for the hygiene slice's age-based sweeper instead.
export function resolveMapEntry(claudePid, pidStart) {
  const entry = readMapEntry(claudePid);
  if (!entry) return { entry: null, pidStartOk: false };
  const pidStartOk = Boolean(pidStart) && entry.pid_start === pidStart;
  return pidStartOk ? { entry, pidStartOk: true } : { entry: null, pidStartOk: false };
}
