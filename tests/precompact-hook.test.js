import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMPACT_HOOK_LOG,
  buildContinuitySnapshot,
  commitContinuityRecovery,
  findContinuitySnapshot,
  formatContinuitySnapshot,
  snapshotPathFor,
  writeContinuitySnapshot,
} from '../src/cli/precompact-hook.js';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'run-hook.mjs');

function runHook(input) {
  return execFileSync(process.execPath, [HELPER, 'precompact-hook'], {
    input,
    env: process.env,
    encoding: 'utf8',
  });
}

const hookInput = (overrides = {}) => ({
  session_id: 'sess-compact',
  transcript_path: '/tmp/sess-compact.jsonl',
  cwd: '/tmp/project',
  hook_event_name: 'PreCompact',
  trigger: 'auto',
  custom_instructions: '',
  ...overrides,
});

describe('PreCompact capture', () => {
  it('prints nothing and persists a bounded continuity snapshot', () => {
    const transcript = join(process.env.KB_DIR, 'session.jsonl');
    writeFileSync(transcript, [
      JSON.stringify({ type: 'user', message: { content: 'Ship DEMO-3760 and preserve kb_read(3528).' } }),
      JSON.stringify({ type: 'assistant', message: { content: 'Editing src/cli/precompact-hook.js on PR #123 next.' } }),
    ].join('\n'));

    const input = hookInput({ transcript_path: transcript, cwd: process.cwd() });
    assert.equal(runHook(JSON.stringify(input)), '');

    const snapshot = JSON.parse(readFileSync(snapshotPathFor(input), 'utf8'));
    assert.equal(snapshot.session_id, 'sess-compact');
    assert.deepEqual(snapshot.references.tickets, ['DEMO-3760']);
    assert.deepEqual(snapshot.references.kb_notes, ['3528']);
    assert.deepEqual(snapshot.references.pull_requests, ['123']);
    assert.ok(snapshot.recent_context.length > 0);
    assert.ok(snapshot.recent_context.length <= 1800);

    const event = JSON.parse(readFileSync(COMPACT_HOOK_LOG, 'utf8').trim().split('\n').at(-1));
    assert.equal(event.event, 'capture');
    assert.equal(event.outcome, 'saved');
  });

  it('fails open on malformed input, emits no stdout, and records the parse failure', () => {
    assert.equal(runHook('{not json'), '');
    const event = JSON.parse(readFileSync(COMPACT_HOOK_LOG, 'utf8').trim().split('\n').at(-1));
    assert.equal(event.event, 'capture');
    assert.equal(event.outcome, 'parse_error');
  });
});

describe('post-compact recovery', () => {
  it('matches an exact session, formats the snapshot, then consumes it on commit', () => {
    const input = hookInput({ session_id: 'sess-recover' });
    const snapshot = buildContinuitySnapshot(input, {
      now: new Date('2026-08-26T12:00:00.000Z'),
      transcriptText: 'USER: Keep DEMO-3760 exact.\n\nASSISTANT: Next edit tests/precompact-hook.test.js.',
      gitState: { branch: 'demo/precompact-continuity', status: [' M src/cli/precompact-hook.js'] },
    });
    writeContinuitySnapshot(snapshot);

    const recovery = findContinuitySnapshot(
      { ...input, source: 'compact' },
      { now: new Date('2026-08-26T12:01:00.000Z') },
    );
    assert.equal(recovery.outcome, 'exact_session');
    assert.match(formatContinuitySnapshot(recovery.snapshot), /DEMO-3760/);
    assert.match(formatContinuitySnapshot(recovery.snapshot), /demo\/precompact-continuity/);

    commitContinuityRecovery(recovery);
    assert.equal(existsSync(recovery.path), false);
    const event = JSON.parse(readFileSync(COMPACT_HOOK_LOG, 'utf8').trim().split('\n').at(-1));
    assert.equal(event.event, 'recovery');
    assert.equal(event.outcome, 'exact_session');
  });

  it('falls back to a recent snapshot for the same cwd when compaction rotates the session id', () => {
    const before = hookInput({ session_id: 'before-compact', transcript_path: '/tmp/before.jsonl' });
    writeContinuitySnapshot(buildContinuitySnapshot(before, {
      now: new Date('2026-08-26T12:00:00.000Z'),
      transcriptText: 'in flight',
      gitState: { branch: 'feature', status: [] },
    }));

    const recovery = findContinuitySnapshot({
      ...before,
      session_id: 'after-compact',
      transcript_path: '/tmp/after.jsonl',
      source: 'compact',
    }, { now: new Date('2026-08-26T12:02:00.000Z') });

    assert.equal(recovery.outcome, 'cwd_recent');
  });

  it('does not guess when multiple recent sessions share the same cwd', () => {
    for (const sessionId of ['concurrent-a', 'concurrent-b']) {
      const input = hookInput({
        session_id: sessionId,
        transcript_path: `/tmp/${sessionId}.jsonl`,
        cwd: '/tmp/shared-project',
      });
      writeContinuitySnapshot(buildContinuitySnapshot(input, {
        now: new Date('2026-08-26T12:00:00.000Z'),
        transcriptText: sessionId,
        gitState: { branch: sessionId, status: [] },
      }));
    }

    const recovery = findContinuitySnapshot({
      session_id: 'rotated-session',
      transcript_path: '/tmp/rotated-session.jsonl',
      cwd: '/tmp/shared-project',
      source: 'compact',
    }, { now: new Date('2026-08-26T12:02:00.000Z') });

    assert.deepEqual(recovery, { outcome: 'ambiguous_cwd', path: null, snapshot: null });
  });
});
