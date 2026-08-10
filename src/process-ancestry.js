// Identifies "the Claude Code harness process" by walking a process's ppid
// chain, and reads that process's start time in the same pass — the piece
// resolveSessionId needs to tell a live session-map entry from one left
// behind by a different process that later got the same pid reused (see
// session-map.js).
//
// Every piece that can be exercised without spawning a real `ps` is a pure
// function (isClaudeHarness, findClaudeAncestor, parseProcessTable); the one
// impure entry point (resolveClaudeAncestry) takes its process-table reader
// as an overridable param so callers can inject fixtures instead of mocking
// child_process.
import { execFileSync } from 'child_process';

// Nearest-ancestor match, not an exact-name allowlist: the CLI binary as
// installed varies (~/.local/bin/claude, a Homebrew shim, a versioned
// .../versions/X.Y.Z copy invoked with argv0 rewritten by a daemon, etc) but
// every layer that actually IS the CLI — as opposed to a desktop app, an
// orchestrator that merely shells out to a command named "claude-hook", or a
// hook/MCP subprocess — resolves to a binary whose basename is exactly
// "claude". Verified live against a running Claude Code process tree: macOS
// `ps -eo ...,comm` reports comm as the full invoked path, untruncated; Linux
// procps reports just the bare (and, at 15+ chars, truncated —
// TASK_COMM_LEN) executable name with no path at all. Both funnel through the
// same basename-equality check below, and truncation only ever shortens a
// name — it can't turn something else into exactly "claude" — so the six-char
// target is unaffected either way. Case-sensitive on purpose: the Claude
// desktop app ships as "Claude" (capital C) and is deliberately excluded — a
// stdio MCP server launched by the desktop app has no session_id in the
// CLI's sense, and should fall through to NULL rather than borrow an
// unrelated identity.
export function isClaudeHarness(comm) {
  if (!comm) return false;
  const base = comm.split('/').pop();
  return base === 'claude';
}

// table: array of {pid, ppid, comm, lstart}. Walks from `pid` through ppid
// links (starting with `pid` itself) and returns the first row matching
// isClaudeHarness, or null if the chain runs out, loops, or `pid` isn't in
// the table at all. Returns the whole row (not just the pid) so the caller
// gets pid_start from the same table lookup, with no second `ps` call.
export function findClaudeAncestor(pid, table) {
  const byPid = new Map(table.map(p => [p.pid, p]));
  let current = pid;
  const seen = new Set();
  while (current != null && byPid.has(current) && !seen.has(current)) {
    seen.add(current);
    const proc = byPid.get(current);
    if (isClaudeHarness(proc.comm)) return proc;
    current = proc.ppid;
  }
  return null;
}

// `ps -eo pid,ppid,lstart,comm` in one call — cli/stale-servers.js parses the
// same shape (pid, ppid, lstart, args) for the same reason: pid_start must
// come from the same snapshot as the ancestry walk, and lstart's own 5
// space-separated sub-fields ("Www Mmm dd hh:mm:ss yyyy") sit between ppid
// and the last column, so a naive whitespace split misreads them as separate
// columns. Duplicated here rather than imported from stale-servers.js: that
// module pulls in the migration/schema CLI dependency chain, too heavy to
// drag onto a hook subprocess spawned every prompt.
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/;

export function parseProcessTable(raw) {
  const table = [];
  for (const line of raw.split('\n')) {
    const m = PS_LINE.exec(line);
    if (m) table.push({ pid: Number(m[1]), ppid: Number(m[2]), lstart: m[3], comm: m[4] });
  }
  return table;
}

// `-e` (not `-a`/`-ax`): BSD ps's `-a` silently drops any process with no
// controlling terminal unless paired with `-x` — exactly the shape of a hook
// subprocess or a stdio MCP server. `-e` (verified live, both here and on
// Linux procps) selects every process regardless, which combined with `-o`
// is what's needed to see the whole ancestor chain.
function defaultListProcesses() {
  return parseProcessTable(execFileSync('ps', ['-eo', 'pid,ppid,lstart,comm'], { encoding: 'utf8' }));
}

// The one impure entry point everything else calls: find the nearest
// claude-harness ancestor of `pid` and that ancestor's start time, from one
// `ps` snapshot. Failures anywhere (ps missing, pid already exited) collapse
// to { claudePid: null, pidStart: null } — every caller treats that as
// "identity unverifiable" and falls back accordingly; this never throws.
export function resolveClaudeAncestry({ pid = process.pid, listProcesses = defaultListProcesses } = {}) {
  try {
    const match = findClaudeAncestor(pid, listProcesses());
    return match ? { claudePid: match.pid, pidStart: match.lstart } : { claudePid: null, pidStart: null };
  } catch {
    return { claudePid: null, pidStart: null };
  }
}
