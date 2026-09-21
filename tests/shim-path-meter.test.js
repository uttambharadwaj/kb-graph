import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import {
  formatShimPathSummary,
  recordShimPath,
  recordShimRecovery,
  recordShimRecoveryAttempt,
  SHIM_PATH_LOG,
  SHIM_RECOVERY_STAGES,
  summarizeShimPaths,
} from '../src/shim-path-meter.js';

describe('mcp-shim path telemetry', () => {
  it('records one bounded decision row and summarizes the denominator', () => {
    recordShimPath({ path: 'daemon', reason: 'probe_alive', durationMs: 42 });
    recordShimPath({ path: 'fallback', reason: 'unresponsive', durationMs: 300 });

    const summary = summarizeShimPaths();
    assert.deepEqual(summary, {
      total: 2,
      daemon: 1,
      fallback: 1,
      fallback_reasons: { unresponsive: 1 },
      recoveries: { started: 0, restored: 0, abandoned: 0, unresolved: 0 },
      recovery_failures: {},
    });
    assert.equal(
      formatShimPathSummary(summary),
      'shim paths (last 24h): daemon 1/2, fallback 1 (unresponsive 1)',
    );
  });

  it('reports restored and unresolved daemon-restart denominators', () => {
    writeFileSync(SHIM_PATH_LOG, '');
    recordShimRecovery({ recoveryId: 'restored', outcome: 'started', attempts: 0, durationMs: 0 });
    recordShimRecovery({ recoveryId: 'restored', outcome: 'restored', attempts: 2, durationMs: 175 });
    recordShimRecovery({ recoveryId: 'waiting', outcome: 'started', attempts: 0, durationMs: 0 });

    const summary = summarizeShimPaths();
    assert.deepEqual(summary.recoveries, { started: 2, restored: 1, abandoned: 0, unresolved: 1 });
    assert.equal(
      formatShimPathSummary(summary),
      'shim paths (last 24h): daemon 0/0, fallback 0; daemon restarts: restored 1/2, unresolved 1',
    );
  });

  it('distinguishes connection and handshake recovery failures', () => {
    writeFileSync(SHIM_PATH_LOG, '');
    recordShimRecoveryAttempt({
      recoveryId: 'connect',
      attempt: 1,
      stage: SHIM_RECOVERY_STAGES.CONNECT,
      durationMs: 3,
      errorCode: 'ECONNREFUSED',
    });
    recordShimRecoveryAttempt({
      recoveryId: 'handshake',
      attempt: 1,
      stage: SHIM_RECOVERY_STAGES.HANDSHAKE,
      durationMs: 30000,
      errorCode: 'TIMEOUT',
    });

    const summary = summarizeShimPaths();
    assert.deepEqual(summary.recovery_failures, {
      'connect:ECONNREFUSED': 1,
      'handshake:TIMEOUT': 1,
    });
    assert.match(formatShimPathSummary(summary), /connect:ECONNREFUSED 1/);
    assert.match(formatShimPathSummary(summary), /handshake:TIMEOUT 1/);
  });

  it('ignores malformed, future, and expired rows', () => {
    writeFileSync(SHIM_PATH_LOG, [
      '{bad json',
      JSON.stringify({ ts: '2026-08-24T12:00:00.000Z', path: 'daemon' }),
      JSON.stringify({ ts: '2026-08-27T12:00:00.000Z', path: 'fallback', reason: 'future' }),
    ].join('\n'));

    const summary = summarizeShimPaths({ now: new Date('2026-08-26T12:00:00.000Z') });
    assert.equal(summary.total, 0);
    assert.equal(formatShimPathSummary(summary), 'shim paths (last 24h): no observations');
  });

  it('counts a completion whose start fell outside the window', () => {
    writeFileSync(SHIM_PATH_LOG, `${JSON.stringify({
      ts: '2026-08-26T12:00:00.000Z',
      event: 'shim_recovery',
      recovery_id: 'boundary',
      outcome: 'restored',
    })}\n`);

    const summary = summarizeShimPaths({ now: new Date('2026-08-26T12:00:01.000Z') });
    assert.deepEqual(summary.recoveries, { started: 1, restored: 1, abandoned: 0, unresolved: 0 });
    assert.match(formatShimPathSummary(summary), /restored 1\/1/);
  });
});
