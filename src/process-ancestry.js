// Identifies "the agent harness process" (Claude Code or Codex CLI) by
// walking a process's ppid chain, and reads that process's start time in the
// same pass — the piece resolveSessionId needs to tell a live session-map
// entry from one left behind by a different process that later got the same
// pid reused (see session-map.js). The same walk also names WHICH harness it
// found, which is how a retrieval row gets its agent tag.
//
// Every piece that can be exercised without spawning a real `ps` is a pure
// function (harnessAgent, findHarnessAncestor, parseProcessTable); the one
// impure entry point (resolveHarnessAncestry) takes its process-table reader
// as an overridable param so callers can inject fixtures instead of mocking
// child_process.
import { execFileSync } from 'child_process';

// The two harnesses that hold real sessions. One spelling, imported by
// everything that stamps or parses an agent tag (retrieval.js, the hooks,
// the reports) so a third agent is added here and nowhere else.
export const AGENT = { CLAUDE: 'claude', CODEX: 'codex', CURSOR: 'cursor' };

export const AGENTS = Object.values(AGENT);

// The CLI spelling of the same tag — the flag hooks are installed with and
// parse at runtime. It lives here, beside the values it carries, so
// setup-hooks.js can write the flag without importing hook-io.js (which pulls
// paths.js and the whole KB_DIR side-effect chain onto the installer path).
export const AGENT_FLAG = '--agent';

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
//
// Codex behaves the same way, verified live against a running Codex CLI:
// comm is `.../@openai/codex-darwin-arm64/vendor/<triple>/bin/codex`, and the
// exact-basename rule excludes its own helper (`codex-code-mode-host`) while
// still matching a differently-installed binary. Unlike Claude, the ChatGPT
// desktop app's bundled binary is also basename `codex`
// (/Applications/ChatGPT.app/Contents/Resources/codex) and is therefore
// matched — correctly: unlike the Claude desktop app, that process runs real
// Codex sessions, so a descendant of it is a codex session.
const HARNESS_BASENAMES = new Map([
  ['claude', AGENT.CLAUDE],
  ['codex', AGENT.CODEX],
]);

// The agent whose harness this comm names, or null for everything else.
export function harnessAgent(comm) {
  if (!comm) return null;
  return HARNESS_BASENAMES.get(comm.split('/').pop()) ?? null;
}

// table: array of {pid, ppid, comm, lstart}. Walks from `pid` through ppid
// links (starting with `pid` itself) and returns the first row whose comm
// names a harness, or null if the chain runs out, loops, or `pid` isn't in
// the table at all. Returns the whole row (not just the pid) so the caller
// gets pid_start from the same table lookup, with no second `ps` call.
export function findHarnessAncestor(pid, table) {
  const byPid = new Map(table.map(p => [p.pid, p]));
  let current = pid;
  const seen = new Set();
  while (current != null && byPid.has(current) && !seen.has(current)) {
    seen.add(current);
    const proc = byPid.get(current);
    if (harnessAgent(proc.comm)) return proc;
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

// This runs on a hook's critical path (every UserPromptSubmit) — a hook must
// never hang indefinitely, so a stuck/wedged `ps` cannot be allowed to block
// it forever. timeout+killSignal bound the wait; execFileSync throws on
// timeout, which resolveHarnessAncestry's catch below turns into the same
// "identity unverifiable" outcome as `ps` being missing entirely.
// maxBuffer is sized generously (a dev box with thousands of processes is
// still well under it) rather than tightly, since undershooting silently
// truncates output mid-row instead of erroring.
//
// Built by a function (not a bare object literal at the call site) so a test
// can assert on the exact options `execFileSync` receives without mocking
// child_process — this repo has no mocking convention, only injectable
// defaults.
const PS_TIMEOUT_MS = 2000;
const PS_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export function psExecOptions() {
  return { encoding: 'utf8', timeout: PS_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: PS_MAX_BUFFER_BYTES };
}

// `-e` (not `-a`/`-ax`): BSD ps's `-a` silently drops any process with no
// controlling terminal unless paired with `-x` — exactly the shape of a hook
// subprocess or a stdio MCP server. `-e` (verified live, both here and on
// Linux procps) selects every process regardless, which combined with `-o`
// is what's needed to see the whole ancestor chain.
function defaultListProcesses() {
  return parseProcessTable(execFileSync('ps', ['-eo', 'pid,ppid,lstart,comm'], psExecOptions()));
}

// The one impure entry point everything else calls: find the nearest harness
// ancestor of `pid`, that ancestor's start time, and which agent it is, from
// one `ps` snapshot. Failures anywhere (ps missing, pid already exited)
// collapse to all-null — every caller treats that as "identity unverifiable"
// and falls back accordingly; this never throws.
export function resolveHarnessAncestry({ pid = process.pid, listProcesses = defaultListProcesses } = {}) {
  const unknown = { harnessPid: null, pidStart: null, agent: null };
  try {
    const match = findHarnessAncestor(pid, listProcesses());
    return match ? { harnessPid: match.pid, pidStart: match.lstart, agent: harnessAgent(match.comm) } : unknown;
  } catch {
    return unknown;
  }
}
