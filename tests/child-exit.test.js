import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import { onChildDone } from '../src/child-exit.js';

const FLUSH_MS = 200;

describe('onChildDone', () => {
  // Once the flush window has answered, the late 'close' must not answer again.
  // The claude-cli caller resolves a promise, where a second call is swallowed;
  // the bus caller writes a run row, where it is a duplicate write. The
  // descendant here outlives the flush and then dies, which is the only
  // ordering that reaches the second call at all — on a healthy child the
  // cleared timer hides it.
  it('reports once when the pipes close after the flush window has answered', async () => {
    const calls = [];
    const child = spawn('sh', ['-c', 'sleep 0.4 & exit 3'], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise(done => {
      onChildDone(child, code => { calls.push(code); done(); }, FLUSH_MS);
    });
    await new Promise(r => setTimeout(r, 600));
    assert.deepStrictEqual(calls, [3]);
  });

  it('reports the exit code an orphaned pipe would otherwise withhold', async () => {
    // Exits at once, leaving a descendant on stdout: 'close' cannot fire until
    // that descendant does, which is the hang.
    const child = spawn('sh', ['-c', 'sleep 30 & exit 7'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const code = await new Promise(done => onChildDone(child, done, FLUSH_MS));
    assert.strictEqual(code, 7);
  });
});
