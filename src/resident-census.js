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
  supervisor: command(String.raw`\/bin\/kb\.js\s+mcp`),
  worker: command(String.raw`\/src\/mcp\.js`),
  notifier: command(String.raw`\/(?:bin\/bus-notifier\.js|bin\/kb\.js\s+bus-notifier)`),
};

const parseStartedAt = value => Date.parse(String(value).replace(/\s+/g, ' ').trim());
const DAY_MS = 24 * 60 * 60 * 1000;

export function summarizeResidentProcesses(raw, { now = new Date() } = {}) {
  const rows = parseProcessTable(raw);
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const daemons = rows.filter(row => COMMANDS.daemon.test(row.comm));
  const shims = rows.filter(row => COMMANDS.shim.test(row.comm));
  const supervisors = rows.filter(row => COMMANDS.supervisor.test(row.comm));
  const workers = rows.filter(row => COMMANDS.worker.test(row.comm));
  const busNotifiers = rows.filter(row => COMMANDS.notifier.test(row.comm));

  const fallbackShimPids = new Set();
  let orphanWorkers = 0;
  for (const worker of workers) {
    const parent = byPid.get(worker.ppid);
    if (parent && COMMANDS.shim.test(parent.comm)) fallbackShimPids.add(parent.pid);
    else if (!parent || !COMMANDS.supervisor.test(parent.comm)) orphanWorkers++;
  }

  const fallbackStarts = shims
    .filter(shim => fallbackShimPids.has(shim.pid))
    .map(shim => parseStartedAt(shim.lstart))
    .filter(Number.isFinite);
  const oldestFallbackDays = fallbackStarts.length
    ? Math.max(0, Math.floor((now.getTime() - Math.min(...fallbackStarts)) / DAY_MS))
    : null;

  return {
    available: true,
    daemons: daemons.length,
    shims: shims.length,
    daemonShims: Math.max(0, shims.length - fallbackShimPids.size),
    fallbackShims: fallbackShimPids.size,
    oldestFallbackDays,
    legacySupervisors: supervisors.length,
    orphanWorkers,
    busNotifiers: busNotifiers.length,
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
  const fallbackAge = summary.fallbackShims && Number.isInteger(summary.oldestFallbackDays)
    ? `, oldest fallback ${summary.oldestFallbackDays}d`
    : '';
  return `resident topology: ${count(summary.daemons, 'daemon')}`
    + `; shims ${summary.shims} (daemon ${summary.daemonShims}, fallback ${summary.fallbackShims}${fallbackAge})`
    + `; ${count(summary.legacySupervisors, 'legacy supervisor')}`
    + `; ${count(summary.orphanWorkers, 'orphan worker')}`
    + `; ${count(summary.busNotifiers, 'bus notifier')}`;
}
