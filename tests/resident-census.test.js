import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatResidentProcessSummary,
  inspectResidentProcesses,
  summarizeResidentProcesses,
} from '../src/resident-census.js';

const row = (pid, ppid, started, command) =>
  `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${started} ${command}`;

const ps = (...rows) => ['PID PPID STARTED COMMAND', ...rows].join('\n');

describe('resident KB process census', () => {
  it('separates daemon-backed shims from live compatibility workers', () => {
    const raw = ps(
      row(100, 1, 'Wed Aug 26 14:00:00 2026', 'node /repo/bin/kb.js serve'),
      row(200, 10, 'Wed Aug 26 13:00:00 2026', 'node /repo/bin/kb.js mcp-shim'),
      row(300, 11, 'Mon Aug 24 12:00:00 2026', 'node /repo/bin/kb.js mcp-shim'),
      row(301, 300, 'Wed Aug 26 14:01:00 2026', 'node /repo/src/mcp.js'),
      row(400, 12, 'Sun Aug 23 12:00:00 2026', 'node /repo/bin/kb.js mcp'),
      row(401, 400, 'Wed Aug 26 14:02:00 2026', 'node /repo/src/mcp.js'),
      row(500, 1, 'Wed Aug 26 14:03:00 2026', 'node /repo/src/mcp.js'),
      row(600, 1, 'Wed Aug 26 14:04:00 2026', 'node /repo/bin/bus-notifier.js --serve'),
      row(700, 1, 'Wed Aug 26 14:05:00 2026', 'node /other/bin/kb.js search'),
    );

    const summary = summarizeResidentProcesses(raw, { now: new Date('2026-08-26T15:00:00-05:00') });

    assert.deepStrictEqual(summary, {
      available: true,
      daemons: 1,
      shims: 2,
      daemonShims: 1,
      fallbackShims: 1,
      oldestFallbackDays: 2,
      legacySupervisors: 1,
      orphanWorkers: 1,
      busNotifiers: 1,
    });
    assert.equal(
      formatResidentProcessSummary(summary),
      'resident topology: 1 daemon; shims 2 (daemon 1, fallback 1, oldest fallback 2d); 1 legacy supervisor; 1 orphan worker; 1 bus notifier',
    );
  });

  it('does not mistake mcp-shim for the legacy mcp command', () => {
    const raw = ps(
      row(200, 10, 'Wed Aug 26 13:00:00 2026', 'node /repo/bin/kb.js mcp-shim'),
      row(201, 10, 'Wed Aug 26 13:00:00 2026', '/bin/zsh -c echo /repo/bin/kb.js mcp-shim'),
    );

    const summary = summarizeResidentProcesses(raw);

    assert.strictEqual(summary.shims, 1);
    assert.strictEqual(summary.legacySupervisors, 0);
  });

  it('reports a bounded census failure instead of hiding the denominator', () => {
    const summary = inspectResidentProcesses({
      listProcesses: () => {
        throw new Error('ps timed out');
      },
    });

    assert.deepStrictEqual(summary, { available: false, error: 'ps timed out' });
    assert.equal(
      formatResidentProcessSummary(summary),
      'resident topology: unavailable (ps timed out)',
    );
  });
});
