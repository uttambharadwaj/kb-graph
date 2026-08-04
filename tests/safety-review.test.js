import './helpers/tmp-kb.js';
import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// One fake claude whose behaviour is picked by an env var the child inherits,
// rather than one binary per case — the module reads CLAUDE_PATH once at load,
// so swapping the path between tests would need a fresh module each time.
const tmp = mkdtempSync(join(tmpdir(), 'kb-safety-'));
const fake = join(tmp, 'fake-claude.sh');
const verdict = JSON.stringify({
  result: JSON.stringify({
    safe: true, risk_level: 'low', concerns: [], recommendation: 'proceed', reasoning: 'routine',
  }),
});
// Built with JSON.stringify and emitted through a quoted heredoc: writing the
// envelope inline in a template literal eats the backslashes and ships a stub
// that can never parse.
writeFileSync(fake, `#!/bin/sh
case "$FAKE_CLAUDE" in
  ok) cat <<'ENVELOPE'
${verdict}
ENVELOPE
    ;;
  garbage) echo 'I am afraid I cannot do that' ;;
  crash) echo 'model backend unreachable' >&2; exit 3 ;;
  # exec so the deadline's SIGTERM reaches the sleep itself; a forked child
  # outlives the shell and holds stdout open until it finishes on its own.
  slow) exec sleep 5 ;;
esac
`);
chmodSync(fake, 0o755);

process.env.CLAUDE_PATH = fake;
process.env.KB_REVIEW_TIMEOUT_MS = '400';
const { reviewDestructiveAction, multiModelReview } = await import('../src/safety/review.js');
const { getDb } = await import('../src/db.js');

const modelCalls = () => getDb().prepare("SELECT * FROM model_calls WHERE caller = 'safety-review' ORDER BY id").all();

describe('safety review verdicts', () => {
  after(() => rmSync(tmp, { recursive: true, force: true }));
  beforeEach(() => { delete process.env.FAKE_CLAUDE; });

  // Through the real caller, not the logger directly: this is the review
  // module's own runClaudeJSON call in askModel, proving the 'safety-review'
  // label actually reaches runClaude rather than just existing in the source.
  it('passes a real verdict through, and meters the call that produced it', async () => {
    process.env.FAKE_CLAUDE = 'ok';
    const result = await reviewDestructiveAction('restart a container');
    assert.equal(result.safe, true);
    assert.equal(result.risk_level, 'low');

    const row = modelCalls().at(-1);
    assert.strictEqual(row.model, result.model);
    assert.strictEqual(row.ok, 1);
    assert.strictEqual(row.error, null);
    assert.ok(row.response_chars > 0);
  });

  // The whole point of the gate: a reviewer that never answered must not be
  // mistaken for one that raised no objection.
  it('blocks when the reviewer overruns its deadline', async () => {
    process.env.FAKE_CLAUDE = 'slow';
    const result = await reviewDestructiveAction('destroy instance 12345');
    assert.equal(result.safe, false);
    assert.equal(result.risk_level, 'unknown');

    const row = modelCalls().at(-1);
    assert.strictEqual(row.ok, 0);
    assert.match(row.error, /timed out/);
  });

  it('names the timeout rather than a bare exit code', async () => {
    process.env.FAKE_CLAUDE = 'slow';
    const result = await reviewDestructiveAction('destroy instance 12345');
    assert.match(result.reasoning, /timed out after \d+ms \(limit 400ms\)/);
  });

  it('distinguishes a crash from a timeout, and keeps the child stderr', async () => {
    process.env.FAKE_CLAUDE = 'crash';
    const result = await reviewDestructiveAction('drop the database');
    assert.equal(result.safe, false);
    assert.match(result.reasoning, /exited 3/);
    assert.match(result.reasoning, /model backend unreachable/);
    assert.doesNotMatch(result.reasoning, /timed out/);

    const row = modelCalls().at(-1);
    assert.strictEqual(row.ok, 0);
    assert.match(row.error, /exited 3/);
  });

  it('blocks when the reviewer answers with something that is not a verdict', async () => {
    process.env.FAKE_CLAUDE = 'garbage';
    const result = await reviewDestructiveAction('rm -rf /media');
    assert.equal(result.safe, false);
    assert.match(result.concerns[0], /did not complete/);
  });

  it('blocks the multi-model consensus when a model returns no verdict', async () => {
    process.env.FAKE_CLAUDE = 'slow';
    const result = await multiModelReview('force push to main');
    assert.equal(result.safe, false);
    assert.match(result.consensus, /^BLOCKED/);
  });
});
