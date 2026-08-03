import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getMarkdownIngestMetadata, normalizeIngestOptions, ingestFile, ingestDirectory } from '../src/ingest.js';
import { similarDocs } from '../src/embeddings/search.js';

describe('ingest helpers', () => {
  it('preserves frontmatter metadata when ingesting markdown notes', () => {
    const metadata = getMarkdownIngestMetadata(`---
title: "Large PR Protocol: design-led, invariant-gated"
type: workflow
tags: [ux-labs, large-pr, review]
project: ux-labs
---

# Body

Use invariants.`, 'large-pr-protocol.md');

    assert.deepStrictEqual(metadata, {
      title: 'Large PR Protocol: design-led, invariant-gated',
      content: '# Body\n\nUse invariants.',
      doc_type: 'workflow',
      tags: 'ux-labs, large-pr, review',
    });
  });

  it('keeps string tag arguments backward-compatible for kb_ingest callers', () => {
    assert.deepStrictEqual(normalizeIngestOptions('ux-labs,large-pr'), {
      tags: 'ux-labs,large-pr',
    });
  });
});

// PF-3189: ingested documents had no vault file, and the reindex job — which
// only walks the vault — therefore never embedded them. They were reachable by
// full-text search and by nothing else, permanently and without any error.
describe('ingest reaches every retrieval surface', () => {
  it('embeds an ingested file, so semantic search can return it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-ingest-src-'));
    const file = join(dir, 'zarquon-relay.md');
    writeFileSync(file, 'The zarquon relay clears its lease table on restart.');

    const doc = await ingestFile(file);

    assert.strictEqual(doc.embedded, 1, doc.embedError || 'ingest wrote no embedding');
    // The property that matters is not that a row exists but that the read path
    // returns the document — a vector nothing retrieves is the same as none.
    const hits = await similarDocs('what clears the zarquon lease table?', { limit: 5 });
    assert.ok(hits.some(h => h.document_id === doc.id), 'ingested document is invisible to semantic search');
    rmSync(dir, { recursive: true, force: true });
  });
});

// The README used to say the duplicate check "runs before every write", which
// was false here. The asymmetry is the decision, so it is pinned: a change to
// this behaviour should have to change a test that says why.
describe('bulk file import dedups on name, deliberately not on content', () => {
  function corpus(files) {
    const dir = mkdtempSync(join(tmpdir(), 'kb-ingest-dup-'));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
  }

  it('skips a file it has already imported by name', async () => {
    const dir = corpus({ 'note.md': '# Sundial\n\nGnomon angle equals latitude.' });
    assert.deepStrictEqual(
      [(await ingestDirectory(dir)).ingested, (await ingestDirectory(dir)).skipped],
      [1, 1],
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps both when the same content arrives under two names', async () => {
    const body = '# Kiln schedule\n\nHold at 1000C for forty minutes, then cool slowly.';
    const dir = corpus({ 'kiln.md': body, 'kiln-copy.md': body });

    const result = await ingestDirectory(dir);
    assert.strictEqual(result.ingested, 2, 'refusing the second would drop content the import asked for');
    assert.strictEqual(result.skipped, 0);
    rmSync(dir, { recursive: true, force: true });
  });
});
