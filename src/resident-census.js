// Live topology census for the resident-service rollout. Startup-event meters
// cannot see processes that loaded older code, so `serve --status` also needs
// the same ground-truth source the rollout's done condition names: one `ps`
// snapshot with parent relationships.
import { execFileSync } from 'node:child_process';
import { parseProcessTable, psExecOptions } from './process-ancestry.js';

// Match the process executable and script at the start of argv. A loose
// substring match would count diagnostic shells whose quoted command happens
// to mention `kb.js mcp-shim`.
const NODE = String.raw`(?:(?:\S*\/)?node(?:\s+--\S+)*\s+)?`;
const command = suffix => new RegExp(`^${NODE}\\S*${suffix}(?:\\s|$)`);
const COMMANDS = {
  daemon: command(String.raw`\/bin\/kb\.js\s+serve`),
  shim: command(String.raw`\/bin\/kb\.js\s+mcp-shim`),
  mcp: command(String.raw`\/bin\/kb\.js\s+mcp`),
  worker: command(String.raw`\/src\/mcp\.js`),
};

const parseStartedAt = value => Date.parse(String(value).replace(/\s+/g, ' ').trim());
const DAY_MS = 24 * 60 * 60 * 1000;

export function summarizeResidentProcesses(raw, { now = new Date() } = {}) {
  const rows = parseProcessTable(raw);
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const daemons = rows.filter(row => COMMANDS.daemon.test(row.comm));
  const shims = rows.filter(row => COMMANDS.shim.test(row.comm));
  const mcpCommands = rows.filter(row => COMMANDS.mcp.test(row.comm));
  const workers = rows.filter(row => COMMANDS.worker.test(row.comm));

  const legacyFallbackShimPids = new Set();
  const legacySupervisorPids = new Set();
  let unparentedMcpServers = 0;
  for (const worker of workers) {
    const parent = byPid.get(worker.ppid);
    if (parent && COMMANDS.shim.test(parent.comm)) legacyFallbackShimPids.add(parent.pid);
    else if (parent && COMMANDS.mcp.test(parent.comm)) legacySupervisorPids.add(parent.pid);
    else unparentedMcpServers++;
  }

  const legacyFallbackStarts = shims
    .filter(shim => legacyFallbackShimPids.has(shim.pid))
    .map(shim => parseStartedAt(shim.lstart))
    .filter(Number.isFinite);
  const oldestLegacyFallbackDays = legacyFallbackStarts.length
    ? Math.max(0, Math.floor((now.getTime() - Math.min(...legacyFallbackStarts)) / DAY_MS))
    : null;

  return {
    available: true,
    daemons: daemons.length,
    shims: shims.length,
    legacyFallbackShims: legacyFallbackShimPids.size,
    oldestLegacyFallbackDays,
    childlessMcpCommands: Math.max(0, mcpCommands.length - legacySupervisorPids.size),
    legacySupervisors: legacySupervisorPids.size,
    unparentedMcpServers,
  };
}

export function inspectResidentProcesses({
  listProcesses = () => execFileSync(
    'ps', ['-eo', 'pid,ppid,lstart,args'], psExecOptions(),
  ),
  now = new Date(),
} = {}) {
  try {
    return summarizeResidentProcesses(listProcesses(), { now });
  } catch (err) {
    return { available: false, error: err.message };
  }
}

const count = (value, singular, plural = `${singular}s`) =>
  `${value} ${value === 1 ? singular : plural}`;

export function formatResidentProcessSummary(summary) {
  if (!summary?.available) {
    return `resident topology: unavailable (${summary?.error || 'unknown error'})`;
  }
  const fallbackAge = summary.legacyFallbackShims && Number.isInteger(summary.oldestLegacyFallbackDays)
    ? `, oldest ${summary.oldestLegacyFallbackDays}d`
    : '';
  return `resident topology: ${count(summary.daemons, 'daemon')}`
    + `; ${count(summary.shims, 'shim')}`
    + `; ${count(summary.legacyFallbackShims, 'legacy child fallback')}${fallbackAge}`
    + `; ${count(summary.childlessMcpCommands, 'childless mcp command')}`
    + `; ${count(summary.legacySupervisors, 'legacy supervisor')}`
    + `; ${count(summary.unparentedMcpServers, 'unparented MCP server')}`;
}
