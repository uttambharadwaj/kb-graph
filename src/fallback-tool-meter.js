// The direct CLI exists only as a recovery path when an agent's MCP transport
// is unavailable. Count that path separately from ordinary tool demand so a
// reliable fallback cannot hide a persistently broken primary surface.
// Arguments and error text are deliberately absent: end-of-session payloads
// routinely contain credentials, logs, and private project context.
import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { LOGS_DIR } from './paths.js';

export const FALLBACK_TOOL_LOG = join(LOGS_DIR, 'direct-tool-fallbacks.jsonl');
export const FALLBACK_TOOL_WINDOW_MS = 24 * 60 * 60 * 1000;

export function recordFallbackTool({ tool, ok, durationMs, outcome }) {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(FALLBACK_TOOL_LOG, `${JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      event: 'fallback_tool',
      tool,
      ok,
      duration_ms: Math.max(0, Math.round(durationMs)),
      outcome,
    })}\n`);
  } catch {
    // A telemetry failure must never turn a recovery path into another outage.
  }
}

export function summarizeFallbackTools({
  now = new Date(),
  windowMs = FALLBACK_TOOL_WINDOW_MS,
  logPath = FALLBACK_TOOL_LOG,
} = {}) {
  const summary = { total: 0, succeeded: 0, failed: 0, tools: {} };
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
    if (row.event !== 'fallback_tool' || typeof row.tool !== 'string') continue;
    summary.total++;
    summary[row.ok ? 'succeeded' : 'failed']++;
    summary.tools[row.tool] = (summary.tools[row.tool] ?? 0) + 1;
  }
  return summary;
}

export function formatFallbackToolSummary(summary) {
  if (!summary?.total) return 'direct tool fallbacks (last 24h): no observations';
  const tools = Object.entries(summary.tools ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tool, count]) => `${tool} ${count}`)
    .join(', ');
  return `direct tool fallbacks (last 24h): ${summary.succeeded}/${summary.total} succeeded`
    + (summary.failed ? `, ${summary.failed} failed` : '')
    + (tools ? ` (${tools})` : '');
}
