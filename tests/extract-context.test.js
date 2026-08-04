import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { buildExtractPrompt, chunkForExtract, EXTRACT_PROMPT } from '../src/extract.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

describe('extraction prompt context', () => {
  // The behaviour these support is measured in tests/extract-eval.test.js
  // against the real model. These pin the wiring, which is deterministic and
  // is what silently regresses when someone edits the prompt builder.
  it('shows the neighbouring text and marks it off-limits', () => {
    const prompt = buildExtractPrompt('the middle', { before: 'the start', after: 'the end' });
    assert.match(prompt, /the start/);
    assert.match(prompt, /the end/);
    assert.match(prompt, /do NOT extract facts from this/);
    assert.match(prompt, /Extract only from the Transcript section/);
  });

  it('says nothing about context when a chunk has no neighbours', () => {
    const prompt = buildExtractPrompt('the only chunk');
    assert.doesNotMatch(prompt, /Surrounding text/);
    assert.match(prompt, /the only chunk/);
  });

  // A first or last chunk has one neighbour, and half a context block is still
  // worth showing — the alternative is the boundary chunks losing the very
  // disambiguation this exists to provide.
  it('shows the one neighbour a boundary chunk has', () => {
    assert.match(buildExtractPrompt('first', { after: 'second' }), /Surrounding text/);
    assert.match(buildExtractPrompt('last', { before: 'penultimate' }), /Surrounding text/);
  });

  it('keeps the chunk itself distinguishable from its context', () => {
    const prompt = buildExtractPrompt('MIDDLE', { before: 'BEFORE', after: 'AFTER' });
    const transcript = prompt.slice(prompt.indexOf('# Transcript'), prompt.indexOf('# End of transcript'));
    assert.match(transcript, /MIDDLE/);
    assert.doesNotMatch(transcript, /BEFORE|AFTER/);
  });

  // Every chunk must get its neighbours, or the chunk that happens to straddle
  // a correction is exactly the one still deciding without context.
  it('passes each chunk its neighbours from the same split', () => {
    const src = readFileSync(join(SRC, 'extract.js'), 'utf8');
    const call = src.slice(src.indexOf('chunks.map('), src.indexOf('// A dead chunk'));
    assert.match(call, /before:\s*chunks\[i - 1\]/, 'the preceding chunk must be passed as context');
    assert.match(call, /after:\s*chunks\[i \+ 1\]/, 'the following chunk must be passed as context');
  });

  // Tense is the only signal separating a dead state from a live one, so the
  // rule that reads it has to survive prompt edits.
  it('tells the extractor that a past state with no stated replacement is not a fact', () => {
    assert.match(EXTRACT_PROMPT, /Past tense ends a state/);
    assert.match(EXTRACT_PROMPT, /put it in skipped/);
    assert.match(EXTRACT_PROMPT, /past EVENT is still emittable/);
  });

  it('still splits on width when there are no sentence boundaries', () => {
    const chunks = chunkForExtract('x'.repeat(4000));
    assert.ok(chunks.length > 1, 'a boundary-free blob must still be split');
    assert.ok(chunks.every(c => c.length <= 4000), 'chunks must stay bounded');
  });
});

// A qualifier that lands in a different chunk from its claim is not merely
// missing — the claim goes to the graph unqualified, which for "safe only
// under X" or "deliberate, tracked for revert" states the opposite of the
// source. The context block in buildExtractPrompt does not close this: it
// shows neighbours and forbids extracting from them, so a qualifier seen only
// there is read and discarded (measured, 3 of 12 runs, in extract-eval).
// These are the deterministic half of that behaviour — what each chunk
// CONTAINS, which is decidable without a model.
describe('qualifiers reaching the chunk that carries their claim', () => {
  const chunkWith = (chunks, needle) => chunks.findIndex(c => c.includes(needle));

  // Unrelated prose that shares no anchor with the claims below, used to push
  // a qualifier a controlled number of chunks away from what it qualifies.
  const FILLER = 'The release notes were reviewed by the on-call engineer during the handover. '
    + 'A dashboard panel was added for queue depth in the same afternoon. '
    + 'The runbook now links to the escalation policy for paging. '
    + 'Someone renamed the staging bucket without telling anyone. '
    + 'The weekly report was posted late again. ';

  it('keeps a claim and its qualifier together when they already fit one chunk', () => {
    const chunks = chunkForExtract(
      'Production Metronome configuration points at sandbox Metronome. '
      + 'This is temporary and tracked by TICKET-42 for revert.');

    assert.strictEqual(chunks.length, 1, 'short input should not have been split at all');
  });

  // Distance 1, the shape that made the eval case flaky: enough preceding text
  // that greedy packing cuts the boundary between the claim and the sentence
  // qualifying it. Before the fix these were chunks 0 and 1.
  it('fuses a back-referencing qualifier onto the claim one chunk away', () => {
    const chunks = chunkForExtract(
      'The team spent the morning triaging billing alerts after a spike in webhook retries. '
      + 'Most of the retries turned out to be a benign side effect of a provider maintenance window. '
      + 'Production Metronome configuration points at sandbox Metronome. '
      + 'This is temporary and tracked by TICKET-42 for revert.');

    assert.ok(chunks.length > 1, 'fixture no longer splits at all — re-pad it');
    assert.strictEqual(
      chunkWith(chunks, 'This is temporary'),
      chunkWith(chunks, 'Production Metronome configuration'),
      'the claim and its qualifier went to different chunks',
    );
  });

  // The qualifier is the last sentence of the text, so the last chunk holding
  // it is where the split put it; anywhere earlier is a copy that was routed
  // there. Measuring the distance on the post-routing chunks instead would
  // report 0 the moment the fix works.
  const DISTANT = {
    qualifier: 'The write cache is safe only when writes are single-threaded.',
    claim: 'The write cache is safe. ',
  };
  const distantFixture = () => {
    const chunks = chunkForExtract(`${DISTANT.claim}${FILLER}${FILLER}${DISTANT.qualifier}`);
    const home = chunks.findLastIndex(c => c.includes(DISTANT.qualifier));
    const claimChunk = chunkWith(chunks, DISTANT.claim);
    assert.strictEqual(home, chunks.length - 1, 'fixture no longer ends on the qualifier');
    assert.ok(home - claimChunk >= 2, `qualifier is only ${home - claimChunk} chunks from its claim`);
    return { chunks, home, claimChunk };
  };

  // Distance 2+, which no amount of neighbour overlap can reach: the qualifier
  // names its own subject, so it is routed to the claim rather than carried.
  it('routes a qualifier that names its subject to a claim several chunks away', () => {
    const { chunks, claimChunk } = distantFixture();

    assert.ok(chunks[claimChunk].includes(DISTANT.qualifier),
      'the claim went out with no sign of its condition');
  });

  it('leaves chunks that make no claim about the subject alone', () => {
    const { chunks, home, claimChunk } = distantFixture();

    const strays = chunks
      .map((chunk, i) => ({ chunk, i }))
      .filter(({ i }) => i !== home && i !== claimChunk)
      .filter(({ chunk }) => chunk.includes(DISTANT.qualifier));
    assert.ok(chunks.length > 2, 'fixture has no third chunk to check');
    assert.deepStrictEqual(strays, [], 'a qualifier was copied onto text it says nothing about');
  });

  // One shared word is coincidence. Routing on it would put every qualifier in
  // every chunk, which is the payload cost the fan-out exists to avoid.
  it('does not route on a single incidental word in common', () => {
    const qualifier = 'The write cache is safe only when writes are single-threaded.';
    const chunks = chunkForExtract(
      `The deployment cache was cleared on Tuesday. ${FILLER}${FILLER}${qualifier}`);

    const cacheChunk = chunkWith(chunks, 'The deployment cache was cleared');
    assert.ok(!chunks[cacheChunk].includes(qualifier), 'routed on "cache" alone');
  });

  // Copies are bounded, or a qualifier-dense transcript doubles every chunk it
  // touches and the calls start failing on payload instead of losing meaning.
  it('bounds what one chunk will absorb and never changes the fan-out', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      `The write cache is safe only when partition ${i} is quiescent.`).join(' ');
    const chunks = chunkForExtract(`The write cache is safe. ${FILLER}${many}`);

    assert.ok(chunks.length <= 8, `${chunks.length} chunks is more than the fan-out allows`);
    // Each chunk may take on at most its own width in attached qualifiers, so
    // nothing can more than double.
    const widest = Math.max(...chunks.map(c => c.length));
    assert.ok(widest <= 2 * 250 + 120, `a chunk grew to ${widest} chars`);
  });

  // The honest edge: fusing is best-effort, and a pair too wide for one chunk
  // stays split rather than overflowing a width every other chunk respects.
  // Pinned so the trade-off is visible rather than discovered later.
  it('leaves an anaphoric pair split when it cannot fit one chunk', () => {
    const claim = `The ${'very '.repeat(30)}long claim sentence points at the sandbox.`;
    const chunks = chunkForExtract(
      `${claim} This is temporary and tracked by TICKET-42 for revert.`);

    assert.notStrictEqual(
      chunkWith(chunks, 'This is temporary'),
      chunkWith(chunks, 'long claim sentence'),
      'fixture now fits one chunk — widen the claim',
    );
  });
});
