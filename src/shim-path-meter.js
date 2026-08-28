// One row per mcp-shim startup decision. The fallback deliberately keeps KB
// tools available when the resident daemon is down, but that same safety net
// makes a broken rollout look healthy unless the chosen path has a denominator.
import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { LOGS_DIR } from './paths.js';
import { join } from 'path';

export const SHIM_PATH_LOG = join(LOGS_DIR, 'mcp-shim-paths.jsonl');
export const SHIM_PATH_WINDOW_MS = 24 * 60 * 60 * 1000;

function appendEvent(event) {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(SHIM_PATH_LOG, `${JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      ...event,
    })}\n`);
  } catch {
    // Losing telemetry must never be the reason a session loses its KB tools.
  }
}

export function recordShimPath({ path, reason, durationMs, errorCode = null }) {
  appendEvent({
    event: 'shim_path',
    path,
    reason,
    duration_ms: durationMs,
    error_code: errorCode,
  });
}

export function recordShimRecovery({ recoveryId, outcome, attempts, durationMs, errorCode = null }) {
  appendEvent({
    event: 'shim_recovery',
    recovery_id: recoveryId,
    outcome,
    attempts,
    duration_ms: durationMs,
    error_code: errorCode,
  });
}

export function summarizeShimPaths({
  now = new Date(),
  windowMs = SHIM_PATH_WINDOW_MS,
  logPath = SHIM_PATH_LOG,
} = {}) {
  const summary = {
    total: 0,
    daemon: 0,
    fallback: 0,
    fallback_reasons: {},
    recoveries: { started: 0, restored: 0, abandoned: 0, unresolved: 0 },
  };
  const recoveries = new Map();
  let lines;
  try {
    lines = readFileSync(logPath, 'utf8').split('\n');
  } catch {
    return summary;
  }

  for (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const age = now.getTime() - new Date(row.ts).getTime();
    if (!Number.isFinite(age) || age < 0 || age > windowMs) continue;
    if (row.event === 'shim_recovery' && row.recovery_id) {
      const outcomes = recoveries.get(row.recovery_id) ?? new Set();
      outcomes.add(row.outcome);
      recoveries.set(row.recovery_id, outcomes);
      continue;
    }
    if (row.event === 'shim_path' && ['daemon', 'fallback'].includes(row.path)) {
      summary.total++;
      summary[row.path]++;
      if (row.path === 'fallback') {
        const reason = row.reason || 'unknown';
        summary.fallback_reasons[reason] = (summary.fallback_reasons[reason] ?? 0) + 1;
      }
    }
  }
  for (const outcomes of recoveries.values()) {
    if (outcomes.has('restored')) summary.recoveries.restored++;
    if (outcomes.has('abandoned')) summary.recoveries.abandoned++;
  }
  // Count recovery ids, not only explicit start rows. A recovery that started
  // just outside the 24h window and completed inside it must not render an
  // impossible "restored 1/0" denominator.
  summary.recoveries.started = recoveries.size;
  summary.recoveries.unresolved = Math.max(
    0,
    summary.recoveries.started - summary.recoveries.restored - summary.recoveries.abandoned,
  );
  return summary;
}

export function formatShimPathSummary(summary) {
  if (!summary?.total && !summary?.recoveries?.started) return 'shim paths (last 24h): no observations';
  const reasons = Object.entries(summary.fallback_reasons ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => `${reason} ${count}`)
    .join(', ');
  const paths = `shim paths (last 24h): daemon ${summary.daemon}/${summary.total}, fallback ${summary.fallback}`
    + (reasons ? ` (${reasons})` : '');
  const recovery = summary.recoveries?.started
    ? `; daemon restarts: restored ${summary.recoveries.restored}/${summary.recoveries.started}`
      + (summary.recoveries.unresolved ? `, unresolved ${summary.recoveries.unresolved}` : '')
      + (summary.recoveries.abandoned ? `, abandoned ${summary.recoveries.abandoned}` : '')
    : '';
  return paths + recovery;
}
