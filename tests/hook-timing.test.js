// Point the KB at a throwaway dir BEFORE anything opens the real DB.
import './helpers/tmp-kb.js';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// The watchers write on process death, so they are exercised in a real child
// process, not in-process — SIGTERM and 'exit' cannot be simulated on the test
// runner's own process without killing it.
const CHILD = `
  import { noteHookTiming, watchHookTiming } from '${join(process.cwd(), 'src/cli/hook-io.js').replace(/\\/g, '/')}';
  watchHookTiming('prompt-hint');
  noteHookTiming(process.argv[1] || '');
  if (process.env.CHILD_HANG) setInterval(() => {}, 1000);
`;

function runChild({ env = {}, detail = '', hang = false, signalAfterMs = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-hook-timing-'));
  return new Promise(resolve => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', CHILD, detail], {
      env: { ...process.env, KB_DIR: dir, ...(hang ? { CHILD_HANG: '1' } : {}), ...env },
    });
    if (signalAfterMs) setTimeout(() => proc.kill('SIGTERM'), signalAfterMs);
    proc.on('close', code => {
      const log = join(dir, 'logs', 'hook-timings.log');
      resolve({ code, lines: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] });
    });
  });
}

describe('hook timing log', () => {
  it('logs a completion slower than the threshold, with the path detail', async () => {
    const { lines } = await runChild({ env: { KB_SLOW_HOOK_MS: '1' }, detail: 'fallback' });
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /prompt-hint slow-exit \d+ms fallback$/);
  });

  it('stays silent on a completion under the threshold', async () => {
    const { lines } = await runChild({ env: { KB_SLOW_HOOK_MS: '60000' } });
    assert.deepStrictEqual(lines, []);
  });

  it('logs a SIGTERM kill exactly once — not again as a slow exit', async () => {
    const { code, lines } = await runChild({
      env: { KB_SLOW_HOOK_MS: '1' },
      hang: true,
      signalAfterMs: 300,
    });
    assert.strictEqual(code, 143);
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /prompt-hint sigterm \d+ms$/);
  });
});
