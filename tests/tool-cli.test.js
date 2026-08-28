import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FALLBACK_TOOL_LOG, formatFallbackToolSummary, summarizeFallbackTools } from '../src/fallback-tool-meter.js';

const KB_BIN = fileURLToPath(new URL('../bin/kb.js', import.meta.url));

function runTool(name, input, extraArgs = []) {
  return spawnSync(process.execPath, [KB_BIN, 'tool', name, ...extraArgs], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, KB_SKIP_NODE_REEXEC: '1' },
  });
}

describe('kb tool fallback', () => {
  it('invokes an allowlisted handler with MCP-equivalent validation', () => {
    const result = runTool('kb_fact_add', {
      subject: 'pf-3296', predicate: 'status', object: 'in_progress', source: 'test',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /pf-3296/);
    assert.match(result.stdout, /in_progress/);
  });

  it('rejects missing required input before invoking a handler', () => {
    const result = runTool('kb_fact_add', { subject: 'pf-3296' });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /Invalid input for kb_fact_add/);
  });

  it('refuses tools outside the capture-recovery allowlist', () => {
    const result = runTool('bus_send', {});

    assert.equal(result.status, 2);
    assert.match(result.stderr, /not available through kb tool/);
  });

  it('returns handler failures as exit 1 without changing their message', () => {
    const result = runTool('kb_read', { id: 999999 });

    assert.equal(result.status, 1);
    assert.match(result.stdout, /Document with ID 999999 not found/);
  });

  it('closes the capture loop without an MCP process', { timeout: 60000 }, () => {
    const content = 'A disconnected end-of-session capture still uses the canonical KB write and indexing path.';
    const first = runTool('kb_write', {
      title: 'Disconnected capture path', content, type: 'lesson', tags: 'general,pf-3296',
    });
    assert.equal(first.status, 0, first.stderr);
    const firstId = Number(first.stdout.match(/Note #(\d+)/)?.[1]);
    assert.ok(firstId, first.stdout);

    const duplicate = runTool('kb_check_duplicate', { content });
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.equal(JSON.parse(duplicate.stdout).is_duplicate, true);

    const replacement = runTool('kb_write', {
      title: 'Disconnected capture path, corrected',
      content: 'The sanctioned direct CLI is the automatic fallback when an agent loses its MCP transport.',
      type: 'lesson',
      tags: 'general,pf-3296',
    });
    assert.equal(replacement.status, 0, replacement.stderr);
    const replacementId = Number(replacement.stdout.match(/Note #(\d+)/)?.[1]);
    assert.ok(replacementId, replacement.stdout);

    const supersede = runTool('kb_supersede', {
      id: firstId, replacement_id: replacementId, reason: 'corrected by disconnected CLI test',
    });
    assert.equal(supersede.status, 0, supersede.stderr);
    assert.match(supersede.stdout, new RegExp(`superseded .* by #${replacementId}`));

    const read = runTool('kb_read', { id: firstId });
    assert.equal(read.status, 0, read.stderr);
    assert.match(read.stdout, new RegExp(`SUPERSEDED .* by #${replacementId}`));
  });

  it('records privacy-safe fallback outcomes and summarizes their denominator', () => {
    const rows = readFileSync(FALLBACK_TOOL_LOG, 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    assert.ok(rows.length >= 4);
    assert.ok(rows.every(row => !('input' in row) && !('error' in row)));
    assert.ok(rows.every(row => row.tool === 'disallowed' || row.tool.startsWith('kb_')));

    const summary = summarizeFallbackTools();
    assert.ok(summary.total >= 4);
    assert.ok(summary.succeeded >= 1);
    assert.ok(summary.failed >= 3);
    assert.match(formatFallbackToolSummary(summary), /direct tool fallbacks \(last 24h\):/);
  });

  it('ignores malformed, future, and expired telemetry rows', () => {
    writeFileSync(FALLBACK_TOOL_LOG, [
      '{bad json',
      JSON.stringify({ ts: '2026-08-24T12:00:00.000Z', event: 'fallback_tool', tool: 'kb_write', ok: true }),
      JSON.stringify({ ts: '2026-08-27T12:00:00.000Z', event: 'fallback_tool', tool: 'kb_write', ok: true }),
    ].join('\n'));

    const summary = summarizeFallbackTools({ now: new Date('2026-08-26T12:00:00.000Z') });
    assert.deepEqual(summary, { total: 0, succeeded: 0, failed: 0, tools: {} });
    assert.equal(formatFallbackToolSummary(summary), 'direct tool fallbacks (last 24h): no observations');
  });
});
