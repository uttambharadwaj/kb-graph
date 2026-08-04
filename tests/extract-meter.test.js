import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Point the KB at a throwaway dir BEFORE importing anything that opens the DB.
const tmp = mkdtempSync(join(tmpdir(), 'kb-extract-meter-'));
process.env.KB_DIR = tmp;

// A fake claude, isolated from extract.test.js's: this one exists to prove the
// meter, not the extractor's consolidation rules. All tests below share one DB
// (this file's KB_DIR), so each gets its own marker mapped to its own triple —
// reusing one triple across tests would make the second call a duplicate and
// consolidation would (correctly) add nothing, which is a different thing than
// what each test below is trying to isolate.
// PERMA_DEAD_CHUNK always fails, every attempt, no flake state. It is anchored
// to "# Transcript" so it only fires when the marker is the chunk's OWN
// transcript text, not when it merely shows up in a neighbour's context block
// (buildExtractPrompt embeds chunks[i-1] and chunks[i+1] verbatim as read-only
// context, ahead of the "# Transcript" header) — otherwise a "dead" chunk
// would poison its live neighbours' prompts too and no test here could isolate
// a single failing chunk.
const fakeClaude = join(tmp, 'fake-claude.sh');
const envelope = payload => JSON.stringify({ result: JSON.stringify(payload) });
const factResponse = (subject, object) => envelope({ facts: [{ subject, predicate: 'depends_on', object }], skipped: [] });
writeFileSync(fakeClaude, `#!/bin/sh
prompt=$(cat)
case "$prompt" in
  *"# Transcript"*PERMA_DEAD_CHUNK*) exit 3 ;;
  *SURVIVOR_CHUNK*) echo '${factResponse('svc-survivor', 'svc-target')}' ;;
  *) echo '${factResponse('svc-basic', 'svc-target')}' ;;
esac
`);
chmodSync(fakeClaude, 0o755);
process.env.CLAUDE_PATH = fakeClaude;

const { kbExtract } = await import('../src/extract.js');
const { hashInput } = await import('../src/extract-meter.js');
const { getDb } = await import('../src/db.js');

const rowFor = (text) =>
  getDb().prepare('SELECT * FROM extractions WHERE input_hash = ? ORDER BY id DESC LIMIT 1').get(hashInput(text));

describe('kb_extract instrumentation', () => {
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('logs a record for a successful call', async () => {
    const text = 'svc-basic depends on svc-target in a single short chunk, no markers here.';
    const res = await kbExtract(text, { source: 'meter-test' });

    assert.strictEqual(res.added.length, 1);
    const row = rowFor(text);
    assert.ok(row, 'no extraction record written');
    assert.strictEqual(row.input_hash, hashInput(text));
    assert.strictEqual(row.input_chars, text.length);
    assert.strictEqual(row.chunk_count, 1);
    assert.deepStrictEqual(JSON.parse(row.chunk_chars), [text.length]);
    assert.strictEqual(row.emitted_count, 1);
    assert.strictEqual(row.skipped_count, 0);
    assert.strictEqual(row.chunk_failures, 0);
    assert.strictEqual(row.dry_run, 0);
    assert.strictEqual(row.failed, 0);
    assert.strictEqual(row.from_preview, 0);
    assert.strictEqual(row.source, 'meter-test');
    assert.ok(row.duration_ms >= 0);
    assert.ok(row.created_at);
  });

  it('logs a record for a dry-run call', async () => {
    const text = 'svc-basic depends on svc-target; a dry run is still metered, though nothing is written.';
    const res = await kbExtract(text, { source: 'meter-test', dryRun: true });

    assert.strictEqual(res.dry_run, true);
    const row = rowFor(text);
    assert.ok(row, 'no extraction record written for the dry run');
    assert.strictEqual(row.dry_run, 1);
    assert.strictEqual(row.failed, 0);
    assert.strictEqual(row.emitted_count, 1);
  });

  // The hash and shape metrics must not depend on the call finishing cleanly —
  // that is the whole point of routing the log through a finally.
  it('logs a record for a call that throws', async () => {
    const text = 'svc-basic depends on svc-target, and this call fails during consolidation.';

    await assert.rejects(
      () => kbExtract(text, { source: 'meter-test', observedAt: 'not-a-real-date' }),
      /observed_at is not a date/,
    );

    const row = rowFor(text);
    assert.ok(row, 'no extraction record written for the failed call');
    assert.strictEqual(row.failed, 1);
    assert.strictEqual(row.dry_run, 0);
    // Extraction itself succeeded before consolidation threw, so the shape
    // metrics it already had are still worth keeping.
    assert.strictEqual(row.emitted_count, 1);
    assert.strictEqual(row.chunk_count, 1);
  });

  // The one the instrumentation exists for: one chunk of a multi-chunk call
  // dies for good, but the call as a whole still reports facts added. Nothing
  // about the top-level result says a chunk was lost — the record has to.
  it('records a chunk failure even when the surrounding call reports success', async () => {
    // Two sentences, individually under the 250-char chunk width but combined
    // well over it, so chunkForExtract splits them at the sentence boundary
    // into exactly two chunks (see chunkForExtract's own tests in extract.test.js).
    const goodSentence = `SURVIVOR_CHUNK svc-survivor depends on svc-target ${'x'.repeat(150)}.`;
    const deadSentence = `PERMA_DEAD_CHUNK ${'y'.repeat(100)}.`;
    const text = `${goodSentence} ${deadSentence}`;

    const res = await kbExtract(text, { source: 'meter-test' });

    // The surrounding call looks like a success: a fact came through, no error.
    assert.strictEqual(res.added.length, 1, 'expected the surviving chunk to still add its fact');
    assert.ok(res.skipped.some(s => s.reason?.startsWith('chunk_failed:')), 'the failure is visible in skipped, at least');

    const row = rowFor(text);
    assert.ok(row, 'no extraction record written');
    assert.strictEqual(row.chunk_count, 2);
    assert.deepStrictEqual(JSON.parse(row.chunk_chars), [goodSentence.length, deadSentence.length]);
    assert.strictEqual(row.chunk_failures, 1, 'the dead chunk must be visible in the record');
    assert.strictEqual(row.failed, 0, 'the call itself did not throw');
    assert.strictEqual(row.emitted_count, 1, 'only the surviving chunk emitted a fact');
  });

  // A commit that replays a dry-run preview never calls extractFacts again —
  // no chunks sent, near-zero duration. Without from_preview that reads as an
  // anomaly (facts appeared out of a call that did no visible work); with it,
  // it reads as the cache hit it is. Both directions in one test so neither
  // value can be hardcoded and pass.
  it('marks a replayed commit as from_preview and a fresh call as not', async () => {
    const previewText = 'svc-basic depends on svc-target: a preview-then-commit flow, replayed not re-extracted.';
    await kbExtract(previewText, { source: 'meter-test', dryRun: true });
    await kbExtract(previewText, { source: 'meter-test' }); // commits by replaying the preview above

    const replayRow = rowFor(previewText); // latest row for this hash: the commit, not the dry run
    assert.strictEqual(replayRow.dry_run, 0);
    assert.strictEqual(replayRow.from_preview, 1, 'a commit that reused a preview must record it');

    const freshText = 'svc-basic depends on svc-target in a call with no preview to reuse at all.';
    await kbExtract(freshText, { source: 'meter-test' });
    const freshRow = rowFor(freshText);
    assert.strictEqual(freshRow.from_preview, 0, 'a call that extracted fresh must not claim it replayed one');
  });
});
