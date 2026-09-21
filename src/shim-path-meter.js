// One row per mcp-shim startup decision. The fallback deliberately keeps KB
// tools available when the resident daemon is down, but that same safety net
// makes a broken rollout look healthy unless the chosen path has a denominator.
import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { LOGS_DIR } from './paths.js';
import { join } from 'path';

export const SHIM_PATH_LOG = join(LOGS_DIR, 'mcp-shim-paths.jsonl');
export const SHIM_PATH_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SHIM_RECOVERY_STAGES = Object.freeze({
  CONNECT: 'connect',
  HANDSHAKE: 'handshake',
});

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

export function recordShimRecoveryAttempt({ recoveryId, attempt, stage, durationMs, errorCode = null }) {
  appendEvent({
    event: 'shim_recovery_attempt',
    recovery_id: recoveryId,
    attempt,
    stage,
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
    recovery_failures: {},
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
    if (row.event === 'shim_recovery_attempt' && row.stage) {
      const failure = `${row.stage}:${row.error_code || 'unknown'}`;
      summary.recovery_failures[failure] = (summary.recovery_failures[failure] ?? 0) + 1;
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

function formatCounts(counts) {
  return Object.entries(counts ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, count]) => `${label} ${count}`)
    .join(', ');
}

export function formatShimPathSummary(summary) {
  const failures = formatCounts(summary?.recovery_failures);
  if (!summary?.total
    && !summary?.recoveries?.started
    && !failures) {
    return 'shim paths (last 24h): no observations';
  }
  const reasons = formatCounts(summary.fallback_reasons);
  const paths = `shim paths (last 24h): daemon ${summary.daemon}/${summary.total}, fallback ${summary.fallback}`
    + (reasons ? ` (${reasons})` : '');
  const recovery = summary.recoveries?.started
    ? `; daemon restarts: restored ${summary.recoveries.restored}/${summary.recoveries.started}`
      + (summary.recoveries.unresolved ? `, unresolved ${summary.recoveries.unresolved}` : '')
      + (summary.recoveries.abandoned ? `, abandoned ${summary.recoveries.abandoned}` : '')
    : '';
  return paths + recovery + (failures ? `; recovery failures: ${failures}` : '');
}
