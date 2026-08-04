import './helpers/tmp-kb.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import express from 'express';

import { getToolDefinitions } from '../src/tools.js';
import { insertDocument, getDb } from '../src/db.js';
import { generateEmbedding, embeddingToBuffer } from '../src/embeddings/embed.js';
import { similarDocs, NEAR_FLOOR, NEAR_K, DUP_THRESHOLD } from '../src/embeddings/search.js';
import { RELATED_MIN } from '../src/write-note.js';
import { createApiKeyMiddleware } from '../src/middleware/api-key.js';
import v1Router from '../src/routes/v1.js';

process.env.KB_API_KEY_CLAUDE = 'near-neighbour-test-key';

const call = async (name, args) => {
  const tool = getToolDefinitions().find(t => t.name === name);
  const res = await tool.handler(args);
  return { text: res.content[0].text, isError: res.isError === true };
};

// The audience for this response is a model, so what it has to parse is what is
// asserted: the block below the line, on its own, is valid JSON.
const signalOf = (text) => {
  const at = text.indexOf('\n{');
  return at === -1 ? null : JSON.parse(text.slice(at));
};

/**
 * A live note whose stored vector sits at an exact cosine from `content`.
 *
 * Real prose cannot be aimed at a threshold, and a boundary test that cannot
 * straddle the boundary is only testing that the feature exists. For a unit q
 * and any unit r orthogonal to it, s·q + √(1−s²)·r has cosine exactly s with q.
 */
async function plantNeighborAt(score, { title, content }) {
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  const unit = (v) => { const mag = Math.sqrt(dot(v, v)); return v.map(x => x / mag); };

  const q = unit(await generateEmbedding(content));
  let seed = 7;
  const r = q.map(() => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; });
  const proj = dot(r, q);
  const perp = unit(r.map((v, i) => v - proj * q[i]));
  const vector = q.map((x, i) => score * x + Math.sqrt(1 - score * score) * perp[i]);

  const doc = insertDocument({ title, content: 'planted', doc_type: 'lesson', tags: '' });
  getDb().prepare(
    'INSERT INTO embeddings (document_id, vault_path, chunk_index, chunk_text, embedding, dimensions) VALUES (?, ?, 0, ?, ?, ?)'
  ).run(doc.id, `planted/${doc.id}.md`, 'planted', embeddingToBuffer(vector), vector.length);

  // The plant is the premise of every assertion below it, so it is checked
  // through the same call the write path makes rather than assumed.
  const scored = (await similarDocs(content, { limit: 50 })).find(s => s.document_id === doc.id);
  assert.ok(Math.abs(scored?.score - score) < 1e-3, `planted at ${score}, scored ${scored?.score}`);
  return doc;
}

const wrote = (title) => getDb().prepare('SELECT COUNT(*) c FROM documents WHERE title = ?').get(title).c;

describe('an accepted note is told what it landed beside', () => {
  // Each test owns the semantic space: similarDocs reads this table and nothing
  // else, so emptying it isolates the scores from every note a sibling wrote.
  beforeEach(() => getDb().exec('DELETE FROM embeddings'));

  it('names the live notes on the same ground and how to resolve them', async () => {
    const content = 'The relay clears its lease table on every restart, so leases never outlive a deploy.';
    const held = await plantNeighborAt(0.75, { title: 'Relay lease behaviour', content });

    const res = await call('kb_write', { title: 'Relay leases, revisited', content, type: 'lesson' });
    assert.strictEqual(res.isError, false, res.text);

    const signal = signalOf(res.text);
    assert.deepStrictEqual(signal.near_notes, [{ id: held.id, title: 'Relay lease behaviour', score: 0.75 }]);
    assert.match(signal.next_step, /kb_supersede/, 'the line must name the tool that resolves this');
    assert.match(signal.next_step, /contradicts or replaces/);
    assert.strictEqual(wrote('Relay leases, revisited'), 1, 'the note is still accepted');
  });

  it('reports at most three, closest first', async () => {
    const content = 'Session tokens are minted per run and never reused across runs.';
    const ids = [];
    for (const [i, score] of [0.82, 0.78, 0.7, 0.65].entries()) {
      ids.push((await plantNeighborAt(score, { title: `Token note ${i}`, content })).id);
    }

    const signal = signalOf((await call('kb_write', { title: 'Per-run tokens', content, type: 'lesson' })).text);
    assert.strictEqual(signal.near_notes.length, NEAR_K);
    assert.deepStrictEqual(signal.near_notes.map(n => n.id), ids.slice(0, 3));
    assert.deepStrictEqual(signal.near_notes.map(n => n.score), [0.82, 0.78, 0.7]);
  });

  it('adds nothing to a write onto clean ground', async () => {
    const content = 'Sundial gnomon angle equals the latitude of the site.';
    await plantNeighborAt(0.2, { title: 'A note about something else', content });

    const res = await call('kb_write', { title: 'Gnomon angles', content, type: 'lesson' });
    assert.strictEqual(signalOf(res.text), null, `clean write must stay quiet: ${res.text}`);
    assert.doesNotMatch(res.text, /near_notes|kb_supersede/);
  });

  it('stays quiet just under the floor, where the note is still merely a relative', async () => {
    const content = 'Cache entries are evicted by age, not by size, on this path.';
    const held = await plantNeighborAt(NEAR_FLOOR - 0.02, { title: 'Cache eviction policy', content });

    const res = await call('kb_write', { title: 'Eviction on the read path', content, type: 'lesson' });
    assert.strictEqual(signalOf(res.text), null, `under the floor must not surface: ${res.text}`);
    // Silence here is the floor doing its job, not an empty neighbourhood: the
    // same note is close enough to link, one band down.
    assert.ok(NEAR_FLOOR - 0.02 >= RELATED_MIN);
    assert.match(res.text, new RegExp(`related: #${held.id} Cache eviction policy`));
  });

  it('surfaces just over the floor', async () => {
    const content = 'Cache entries are evicted by age, not by size, on this path.';
    const held = await plantNeighborAt(NEAR_FLOOR + 0.02, { title: 'Cache eviction policy', content });

    const signal = signalOf((await call('kb_write', { title: 'Eviction on the read path', content, type: 'lesson' })).text);
    assert.deepStrictEqual(signal.near_notes.map(n => n.id), [held.id]);
  });

  it('leaves the refusal exactly as it was', async () => {
    const content = 'Queue workers acknowledge a message only after the write commits.';
    await plantNeighborAt(0.9, { title: 'Ack after commit', content });

    const res = await call('kb_write', { title: 'Acknowledge after commit', content, type: 'lesson' });
    const body = JSON.parse(res.text);
    assert.deepStrictEqual(Object.keys(body), ['skipped', 'reason', 'matches', 'remedy'],
      'a refusal gains nothing — the blocker was always named in its own result');
    assert.strictEqual(body.reason, 'duplicate_detected');
    assert.strictEqual(wrote('Acknowledge after commit'), 0, 'the same notes are still refused');
  });

  it('excludes the note being superseded — it is already being retired', async () => {
    const content = 'The scheduler runs at half past the hour, not on the hour.';
    const stale = insertDocument({ title: 'Scheduler timing', content: 'planted', doc_type: 'lesson', tags: '' });
    const q = await generateEmbedding(content);
    getDb().prepare(
      'INSERT INTO embeddings (document_id, vault_path, chunk_index, chunk_text, embedding, dimensions) VALUES (?, ?, 0, ?, ?, ?)'
    ).run(stale.id, 'planted/stale.md', 'planted', embeddingToBuffer(q), q.length);

    const res = await call('kb_write', { title: 'Scheduler timing, corrected', content, type: 'lesson', supersedes: stale.id });
    assert.strictEqual(res.isError, false, res.text);
    assert.strictEqual(signalOf(res.text), null, 'the note you just retired is not a neighbour to consider retiring');
  });
});

describe('the pre-check and the write describe the same neighbourhood', () => {
  beforeEach(() => getDb().exec('DELETE FROM embeddings'));

  // The drift this guards shipped once in the other direction: kb_check_duplicate
  // green-lit content the write then refused. A pre-check that omits what the
  // write reports sends the caller into the write blind in the same way.
  it('kb_check_duplicate answers with the neighbours kb_write will report', async () => {
    const content = 'Retries are capped at three attempts, with jitter between them.';
    await plantNeighborAt(0.7, { title: 'Retry policy', content });

    const pre = JSON.parse((await call('kb_check_duplicate', { content })).text);
    assert.strictEqual(pre.is_duplicate, false);

    const post = signalOf((await call('kb_write', { title: 'Retry caps', content, type: 'lesson' })).text);
    assert.deepStrictEqual(pre.near_notes, post.near_notes);
    assert.strictEqual(pre.next_step, post.next_step);
  });

  it('kb_check_duplicate omits them on a duplicate verdict, as the write omits them on a refusal', async () => {
    const content = 'Retries are capped at three attempts, with jitter between them.';
    await plantNeighborAt(0.9, { title: 'Retry policy', content });

    const pre = JSON.parse((await call('kb_check_duplicate', { content })).text);
    assert.strictEqual(pre.is_duplicate, true);
    assert.deepStrictEqual(Object.keys(pre), ['is_duplicate', 'matches']);
  });

  it('kb_ingest carries the same fields as kb_write', async () => {
    const content = 'Backfills run in batches of five hundred rows to stay under the lock timeout.';
    const held = await plantNeighborAt(0.7, { title: 'Backfill batch size', content });

    const body = JSON.parse((await call('kb_ingest', { title: 'Batching backfills', content })).text);
    assert.deepStrictEqual(body.near_notes, [{ id: held.id, title: 'Backfill batch size', score: 0.7 }]);
    assert.match(body.next_step, /kb_supersede/);
  });

  it('POST /api/v1/ingest carries them too', async () => {
    const content = 'Uploads larger than ten megabytes are streamed rather than buffered.';
    const held = await plantNeighborAt(0.7, { title: 'Upload streaming threshold', content });

    const app = express();
    app.use(express.json());
    app.use('/api/v1', createApiKeyMiddleware(), v1Router);
    const server = app.listen(0);
    try {
      const res = await fetch(`http://localhost:${server.address().port}/api/v1/ingest`, {
        method: 'POST',
        headers: { 'X-API-Key': process.env.KB_API_KEY_CLAUDE, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Streaming large uploads', content }),
      });
      assert.strictEqual(res.status, 201);
      const body = await res.json();
      assert.deepStrictEqual(body.near_notes, [{ id: held.id, title: 'Upload streaming threshold', score: 0.7 }]);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

describe('the near band', () => {
  // Both ends are borrowed from decisions made elsewhere, so both can move
  // without anyone here noticing. Inverted or collapsed, the band is empty and
  // the signal silently stops existing — which looks exactly like clean writes.
  it('sits between the link floor and the refusal line', () => {
    assert.ok(RELATED_MIN <= NEAR_FLOOR, 'a note not worth linking is not worth a supersede prompt');
    assert.ok(NEAR_FLOOR < DUP_THRESHOLD, 'above the refusal line nothing is ever accepted, so nothing is reported');
  });
});
