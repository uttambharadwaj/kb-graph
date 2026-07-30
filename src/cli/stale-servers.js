import { execFileSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { SOURCE_FILE } from '../restart-on-change.js';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY_MS = 86400000;

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
 * Parse `ps -eo pid,lstart,args` output into the MCP servers serving stale code.
 * Each server is judged against the checkout it was launched from, not against
 * this one — run from a worktree, a single global cutoff would call every
 * server stale. Split out from the CLI so it is testable without real servers.
 */
export function staleServers(psOutput, mtimeOf = sourceMtime) {
  const stale = [];
  const unknown = [];
  for (const line of psOutput.split('\n')) {
    if (!/kb\.js\s+mcp(?:\s|$)/.test(line)) continue;
    // pid, then lstart's fixed 5 fields (Www Mmm dd hh:mm:ss yyyy), then argv.
    const m = line.match(/^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
    const bin = m && m[3].match(/(\S+)\/bin\/kb\.js\s+mcp(?:\s|$)/);
    const started = m ? parseStart(m[2]) : NaN;
    // A server we cannot judge is reported, never dropped: silently returning
    // "none stale" for a checkout that moved is the same invisible staleness
    // this command exists to end.
    if (!bin || !Number.isFinite(started)) {
      unknown.push({ pid: m ? Number(m[1]) : null, line: line.trim(), why: 'unparseable' });
      continue;
    }
    let cutoff;
    try {
      cutoff = mtimeOf(join(bin[1], 'src'));
    } catch (err) {
      unknown.push({ pid: Number(m[1]), line: line.trim(), why: `${bin[1]}: ${err.message}` });
      continue;
    }
    if (started >= cutoff) continue;
    stale.push({
      pid: Number(m[1]),
      started,
      root: bin[1],
      ageDays: Math.floor((cutoff - started) / DAY_MS),
    });
  }
  stale.sort((a, b) => a.started - b.started);
  return { stale, unknown };
}

export function runStaleServersCli() {
  const ps = execFileSync('ps', ['-eo', 'pid,lstart,args'], { encoding: 'utf8' });
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
  // Servers from before src/restart-on-change.js shipped have no watcher, so
  // they will never notice on their own. Reconnecting is what retires them.
  reportUnknown();
  // Reconnecting is the one instruction that holds for every client. Claude Code
  // also respawns a dead stdio server on the next tool call, so ending one there
  // is safe; that is not verified for other clients, so do not tell people it is.
  console.log('\nReconnect each of those sessions (/mcp in Claude Code) to pick up the current code.');
}
