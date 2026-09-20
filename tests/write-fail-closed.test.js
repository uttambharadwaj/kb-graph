import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { env as transformersEnv } from '@huggingface/transformers';

transformersEnv.allowRemoteModels = false;
transformersEnv.allowLocalModels = false;

const { getDb, getDocument } = await import('../src/db.js');
const { getToolDefinitions } = await import('../src/tools.js');
const { createApiKeyMiddleware } = await import('../src/middleware/api-key.js');
const { default: v1Router } = await import('../src/routes/v1.js');
const { writeNote, WRITE_SKIP_REASON } = await import('../src/write-note.js');
const { resolveProcessStart } = await import('../src/process-ancestry.js');

process.env.KB_API_KEY_CLAUDE = 'fail-closed-test-key';
const vault = process.env.OBSIDIAN_VAULT_PATH;

function tableCount(table) {
  return getDb().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function tool(name) {
  return getToolDefinitions().find(definition => definition.name === name);
}

function assertDedupeUnavailable(result) {
  assert.deepEqual(result, {
    skipped: true,
    reason: WRITE_SKIP_REASON.DEDUPE_UNAVAILABLE,
    retryable: true,
  });
}

describe('fail-closed authored note writes', () => {
  it('writes no durable state when semantic dedupe is unavailable', async () => {
    const before = Object.fromEntries(
      ['documents', 'vault_files', 'embeddings', 'doc_links', 'write_decisions']
        .map(table => [table, tableCount(table)]),
    );

    const result = await writeNote(vault, {
      title: 'Unchecked direct note',
      content: 'The canonical writer must not create this note without a duplicate verdict.',
    });

    assertDedupeUnavailable(result);
    for (const [table, count] of Object.entries(before)) {
      assert.equal(tableCount(table), count, table);
    }
    assert.equal(existsSync(join(vault, 'inbox')), false);
  });

  it('returns a distinct MCP error and writes nothing when dedupe is unavailable', async () => {
    const before = tableCount('documents');

    const response = await tool('kb_write').handler({
      title: 'Unchecked MCP note',
      content: 'The MCP surface must not create this note without a duplicate verdict.',
      type: 'lesson',
    });

    assert.equal(response.isError, true);
    const result = JSON.parse(response.content[0].text);
    assertDedupeUnavailable(result);
    assert.equal(tableCount('documents'), before);
  });

  it('keeps the public kb_ingest tool on the same fail-closed contract', async () => {
    const before = tableCount('documents');

    const response = await tool('kb_ingest').handler({
      title: 'Unchecked public ingest',
      content: 'The public ingest alias must not turn an unavailable verdict into a duplicate.',
    });

    assert.equal(response.isError, true);
    assertDedupeUnavailable(JSON.parse(response.content[0].text));
    assert.equal(tableCount('documents'), before);
  });

  it('returns a retryable REST error and writes nothing when dedupe is unavailable', async () => {
    const before = tableCount('documents');
    const app = express();
    app.use(express.json());
    app.use('/api/v1', createApiKeyMiddleware(), v1Router);
    const server = app.listen(0);
    try {
      const response = await fetch(`http://localhost:${server.address().port}/api/v1/ingest`, {
        method: 'POST',
        headers: {
          'X-API-Key': process.env.KB_API_KEY_CLAUDE,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Unchecked REST note',
          content: 'The REST surface must not create this note without a duplicate verdict.',
        }),
      });

      assert.equal(response.status, 503);
      assertDedupeUnavailable(await response.json());
      assert.equal(tableCount('documents'), before);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('allows a known correction to proceed during a dedupe outage', async () => {
    const seeded = await writeNote(
      vault,
      {
        title: 'Known correction target',
        content: 'The first version is wrong.',
        type: 'lesson',
      },
      { findSimilar: async () => [] },
    );
    assert.equal(seeded.skipped, false);

    const inPlace = await tool('kb_write').handler({
      title: 'Known correction target',
      content: 'The corrected version is right.',
      type: 'lesson',
      supersedes: seeded.docId,
    });
    assert.notEqual(inPlace.isError, true, inPlace.content[0].text);
    assert.match(inPlace.content[0].text, new RegExp(`updated #${seeded.docId} in place`));
    assert.match(getDocument(seeded.docId).content, /corrected version is right/);

    const replacement = await tool('kb_write').handler({
      title: 'Known correction replacement',
      content: 'The durable replacement has a clearer title.',
      type: 'lesson',
      supersedes: seeded.docId,
    });
    assert.notEqual(replacement.isError, true, replacement.content[0].text);
    const replacementId = Number(replacement.content[0].text.match(/^Note #(\d+)/)?.[1]);
    assert.ok(replacementId);
    assert.equal(getDocument(seeded.docId).superseded_by, replacementId);

    getDb().prepare(`
      INSERT INTO embeddings (document_id, chunk_index, chunk_text, embedding, dimensions)
      VALUES (?, 0, 'stale', ?, 1)
    `).run(replacementId, Buffer.from(new Float32Array([1]).buffer));
    const correctedAgain = await tool('kb_write').handler({
      title: 'Known correction replacement',
      content: 'A later correction must not retain the old semantic vector.',
      type: 'lesson',
      supersedes: replacementId,
    });
    assert.notEqual(correctedAgain.isError, true, correctedAgain.content[0].text);
    assert.equal(
      getDb().prepare('SELECT COUNT(*) AS count FROM embeddings WHERE document_id = ?').get(replacementId).count,
      0,
      'failed re-embedding must expose a corpus gap instead of retaining a stale vector',
    );
  });

  it('refuses when a live document is missing its embedding even if scoring returns no matches', async () => {
    getDb().prepare(
      "INSERT INTO documents (title, content, doc_type) VALUES ('Unembedded live note', 'Existing content.', 'lesson')",
    ).run();
    const before = tableCount('documents');

    const result = await writeNote(
      vault,
      {
        title: 'Unchecked partial-corpus note',
        content: 'A successful query over an incomplete corpus is not a duplicate verdict.',
      },
      { findSimilar: async () => [] },
    );

    assertDedupeUnavailable(result);
    assert.equal(tableCount('documents'), before);
  });

  it('serializes the duplicate verdict with the authored write', async () => {
    getDb().exec('DELETE FROM embeddings; DELETE FROM documents;');
    let arrivals = 0;
    let releaseBarrier;
    const barrier = new Promise(resolve => { releaseBarrier = resolve; });
    const findSimilar = async content => {
      arrivals++;
      if (arrivals === 2) releaseBarrier();
      await Promise.race([barrier, new Promise(resolve => setTimeout(resolve, 50))]);
      const existing = getDb().prepare(`
        SELECT id, title FROM documents
        WHERE content = ? AND superseded_at IS NULL
        LIMIT 1
      `).get(content);
      return existing
        ? [{ document_id: existing.id, title: existing.title, score: 1 }]
        : [];
    };
    const note = {
      title: 'Concurrent duplicate gate',
      content: 'Only one concurrent authored write may cross this semantic boundary.',
    };

    transformersEnv.allowLocalModels = true;
    let results;
    try {
      results = await Promise.all([
        writeNote(vault, note, { findSimilar }),
        writeNote(vault, note, { findSimilar }),
      ]);
    } finally {
      transformersEnv.allowLocalModels = false;
    }

    assert.equal(results.filter(result => !result.skipped).length, 1);
    assert.equal(results.filter(result => result.reason === WRITE_SKIP_REASON.DUPLICATE).length, 1);
  });

  it('atomically reclaims a write lock whose owner has exited', async () => {
    getDb().exec('DELETE FROM embeddings; DELETE FROM documents;');
    getDb().prepare(`
      INSERT OR REPLACE INTO meta (key, value)
      VALUES ('runtime:authored-write-lock', ?)
    `).run(JSON.stringify({ token: 'abandoned', pid: 999_999 }));

    const result = await writeNote(
      vault,
      { title: 'Recovered write lock', content: 'A dead owner must not block authored writes forever.' },
      { findSimilar: async () => [] },
    );

    assert.equal(result.skipped, false, JSON.stringify(result));
    assert.equal(
      getDb().prepare("SELECT 1 FROM meta WHERE key = 'runtime:authored-write-lock'").get(),
      undefined,
    );
  });

  it('reclaims a stale lock after its pid has been reused', async () => {
    getDb().exec('DELETE FROM embeddings; DELETE FROM documents;');
    assert.ok(resolveProcessStart(), 'current process start identity is unavailable');
    getDb().prepare(`
      INSERT OR REPLACE INTO meta (key, value)
      VALUES ('runtime:authored-write-lock', ?)
    `).run(JSON.stringify({
      token: 'previous-process-at-this-pid',
      pid: process.pid,
      pid_start: 'Mon Jan  1 00:00:00 2001',
    }));

    const result = await writeNote(
      vault,
      { title: 'Reused pid lock', content: 'Process identity includes its start time, not only its pid.' },
      { findSimilar: async () => [] },
    );

    assert.equal(result.skipped, false, JSON.stringify(result));
  });

  it('does not report a durable write as failed when lock release is transiently unavailable', async () => {
    getDb().exec(`
      DELETE FROM embeddings;
      DELETE FROM documents;
      CREATE TEMP TRIGGER fail_authored_lock_release
      BEFORE DELETE ON meta
      WHEN OLD.key = 'runtime:authored-write-lock'
      BEGIN
        SELECT RAISE(ABORT, 'forced lock release failure');
      END;
    `);
    let result;
    try {
      result = await writeNote(
        vault,
        {
          title: 'Release failure still succeeds',
          content: 'The durable write result must survive a transient lock-release failure.',
        },
        { findSimilar: async () => [] },
      );
    } finally {
      getDb().exec('DROP TRIGGER IF EXISTS fail_authored_lock_release');
    }

    assert.equal(result.skipped, false, JSON.stringify(result));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(
      getDb().prepare("SELECT 1 FROM meta WHERE key = 'runtime:authored-write-lock'").get(),
      undefined,
    );
  });
});
