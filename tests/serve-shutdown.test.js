import './helpers/tmp-kb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectDaemonClient } from '../src/daemon-client.js';

const TIMEOUT_MS = 90_000;

function withDeadline(promise, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), TIMEOUT_MS);
    }),
  ]);
}

test('SIGTERM exits cleanly after the native embedding runtime has loaded', { timeout: TIMEOUT_MS }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'kb-serve-exit-'));
  const kbDir = join(scratch, 'kb');
  const vaultPath = join(scratch, 'vault');
  const socketPath = join(kbDir, 'daemon.sock');
  const controlSocketPath = join(kbDir, 'daemon-ctl.sock');
  mkdirSync(kbDir);
  mkdirSync(vaultPath);

  const child = spawn(process.execPath, ['bin/kb.js', 'serve', `--socket=${socketPath}`], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      KB_DIR: kbDir,
      OBSIDIAN_VAULT_PATH: vaultPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });

  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    await withDeadline(new Promise((resolve, reject) => {
      const ready = chunk => {
        if (chunk.includes('[kb serve] listening on')) {
          child.stderr.off('data', ready);
          resolve();
        }
      };
      child.stderr.on('data', ready);
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(
        new Error(`daemon exited before listening: code=${code} signal=${signal}\n${stderr}`),
      ));
    }), 'the daemon to listen');

    const client = await connectDaemonClient(socketPath);
    try {
      // A write forces the Hugging Face / ONNX embedding runtime to initialize.
      // With only a socket smoke test, process.exit() appears healthy and the
      // native teardown abort this guards never becomes reachable.
      const result = await client.callTool({
        name: 'kb_write',
        arguments: {
          title: 'Native shutdown probe',
          content: 'A throwaway note that loads the embedding runtime before SIGTERM.',
        },
      });
      assert.notEqual(result.isError, true, `kb_write failed: ${JSON.stringify(result.content)}`);
    } finally {
      await client.close();
    }

    child.kill('SIGTERM');
    const result = await withDeadline(exited, 'the daemon to exit after SIGTERM');
    assert.deepEqual(result, { code: 0, signal: null }, stderr);
    assert.doesNotMatch(stderr, /libc\+\+abi|mutex lock failed|Abort trap/, stderr);
    assert.equal(existsSync(socketPath), false, 'the MCP socket must be removed');
    assert.equal(existsSync(controlSocketPath), false, 'the control socket must be removed');
  } finally {
    child.kill('SIGKILL');
    await exited;
    rmSync(scratch, { recursive: true, force: true });
  }
});
