import { execFileSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { SOURCE_FILE } from '../restart-on-change.js';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY_MS = 86400000;

// Two shapes are running at once: a supervisor (`kb.js mcp`) with the real
// server as a `src/mcp.js` child, and — until every session has reconnected
// once — plain `kb.js mcp` servers from before the supervisor shipped. Both are
// matched, because dropping the second kind is the invisible staleness this
// command exists to end.
const MCP_PROCESS = /(?:kb\.js\s+mcp(?:\s|$)|\/src\/mcp\.js(?:\s|$))/;
const MCP_ARGS = /(\S+)\/(bin\/kb\.js\s+mcp|src\/mcp\.js)(?:\s|$)/;
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/;

// `ps -eo lstart` pads the day-of-month to a fixed width, which Date.parse
// rejects; collapsing runs of spaces is enough to make it a date it accepts.
const parseStart = (lstart) => Date.parse(lstart.replace(/\s+/g, ' ').trim());

/**
 * Newest mtime under src/ — a server started before this is serving older code.
 * Walks by hand rather than with readdir's `recursive` option: that landed in
 * Node 18.17 and is silently ignored before it, which would scan only the top
 * level and report a genuinely stale server as current.
 */
export function sourceMtime(dir = SRC_DIR) {
  let newest = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
        newest = Math.max(newest, statSync(full).mtimeMs);
      }
    }
  };
  walk(dir);
  return newest;
}

/**
 * Parse `ps -eo pid,ppid,lstart,args` output into the MCP servers serving stale
 * code. Each server is judged against the checkout it was launched from, not
 * against this one — run from a worktree, a single global cutoff would call
 * every server stale. Split out from the CLI so it is testable without real
 * servers.
 */
export function staleServers(psOutput, mtimeOf = sourceMtime) {
  const stale = [];
  const unknown = [];
  const rows = [];
  for (const line of psOutput.split('\n')) {
    if (!MCP_PROCESS.test(line)) continue;
    // pid, ppid, then lstart's fixed 5 fields (Www Mmm dd hh:mm:ss yyyy), then argv.
    const m = line.match(PS_LINE);
    const args = m && m[4].match(MCP_ARGS);
    const started = m ? parseStart(m[3]) : NaN;
    // A server we cannot judge is reported, never dropped: silently returning
    // "none stale" for a checkout that moved is the same invisible staleness
    // this command exists to end.
    if (!args || !Number.isFinite(started)) {
      unknown.push({ pid: m ? Number(m[1]) : null, line: line.trim(), why: 'unparseable' });
      continue;
    }
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      started,
      root: args[1],
      isChild: args[2].startsWith('src/'),
      line,
    });
  }

  const supervisors = new Set(rows.filter((r) => r.isChild).map((r) => r.ppid));
  for (const row of rows) {
    // A supervisor is judged through its child, which is the process actually
    // holding the module graph. The supervisor's own staleness — a change to
    // the supervisor or the watcher — goes unreported and still needs /mcp.
    if (!row.isChild && supervisors.has(row.pid)) continue;
    let cutoff;
    try {
      cutoff = mtimeOf(join(row.root, 'src'));
    } catch (err) {
      unknown.push({ pid: row.pid, line: row.line.trim(), why: `${row.root}: ${err.message}` });
      continue;
    }
    if (row.started >= cutoff) continue;
    stale.push({
      pid: row.pid,
      started: row.started,
      root: row.root,
      ageDays: Math.floor((cutoff - row.started) / DAY_MS),
    });
  }
  stale.sort((a, b) => a.started - b.started);
  return { stale, unknown };
}

export function runStaleServersCli() {
  const ps = execFileSync('ps', ['-eo', 'pid,ppid,lstart,args'], { encoding: 'utf8' });
  const { stale, unknown } = staleServers(ps);

  const reportUnknown = () => {
    if (!unknown.length) return;
    console.log(`\n${unknown.length} MCP server(s) could not be judged:`);
    for (const u of unknown) console.log(`  pid ${u.pid ?? '?'}  ${u.why}`);
  };

  if (!stale.length) {
    console.log('No stale MCP servers — every running process started after its own last source change.');
    reportUnknown();
    return;
  }

  const roots = [...new Set(stale.map(s => s.root))];
  console.log(`${stale.length} MCP server(s) are serving older code than ${roots.join(', ')}:\n`);
  for (const s of stale) {
    const from = roots.length > 1 ? `  ${s.root}` : '';
    console.log(`  pid ${String(s.pid).padStart(6)}  started ${new Date(s.started).toLocaleString()}  ${s.ageDays}d stale${from}`);
  }
  // Servers from before the supervisor shipped reload nothing on their own, so
  // reconnecting is what retires them. A supervised server reaching this list
  // means its own reload is not working, which reconnecting also fixes.
  reportUnknown();
  console.log('\nReconnect each of those sessions (/mcp in Claude Code) to pick up the current code.');
}
