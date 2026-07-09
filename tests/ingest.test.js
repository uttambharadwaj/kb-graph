import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getMarkdownIngestMetadata, normalizeIngestOptions } from '../src/ingest.js';

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
