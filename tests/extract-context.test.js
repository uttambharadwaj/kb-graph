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
