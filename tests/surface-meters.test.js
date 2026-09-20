import './helpers/tmp-kb.js'; // MUST be first — redirects the DB to a temp dir
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { getDb, insertDocument } from '../src/db.js';
import { getToolDefinitions } from '../src/tools.js';
import { metered, readToolResult } from '../src/tool-meter.js';
import { logWriteDecision, WRITE_DECISION_SOURCE } from '../src/write-meter.js';
import { storeEmbedding } from '../src/embeddings/embed.js';
import { callIdentity } from '../src/retrieval.js';
import v1Router from '../src/routes/v1.js';

const calls = () => getDb().prepare('SELECT * FROM tool_calls ORDER BY id').all();

describe('tool meter', () => {
  it('records a successful call with the size of what it returned', async () => {
    await metered('kb_probe_ok', async () => ({ content: [{ type: 'text', text: 'hello' }] }))();
    const row = calls().at(-1);
    assert.strictEqual(row.tool, 'kb_probe_ok');
    assert.strictEqual(row.ok, 1);
    assert.strictEqual(row.result_chars, 5);
    assert.strictEqual(row.error, null);
  });

  // An MCP handler reports a handled failure by setting isError on an ordinary
  // reply rather than by throwing, so a wrapper that only catches would record
  // every one of them as a success — which is the failure rate reading zero on
  // a tool that never works.
  it('counts an isError reply as a failure, not a success', async () => {
    await metered('kb_probe_iserror', async () => (
      { content: [{ type: 'text', text: 'Error: nope' }], isError: true }
    ))();
    const row = calls().at(-1);
    assert.strictEqual(row.ok, 0);
    assert.match(row.error, /nope/);
  });

  it('records a thrown error and rethrows it, so metering changes no outcome', async () => {
    const boom = metered('kb_probe_throw', async () => { throw new Error('exploded'); });
    await assert.rejects(boom, /exploded/);
    const row = calls().at(-1);
    assert.strictEqual(row.ok, 0);
    assert.match(row.error, /exploded/);
  });

  it('returns the handler result untouched', async () => {
    const result = { content: [{ type: 'text', text: 'x' }], extra: 1 };
    assert.deepStrictEqual(await metered('kb_probe_passthrough', async () => result)(), result);
  });

  it('reads an empty reply as zero characters rather than as nothing to record', () => {
    assert.deepStrictEqual(readToolResult({ content: [] }), { ok: true, resultChars: 0, error: null });
  });

  it('records the ambient agent without logging tool input', async () => {
    await callIdentity.run({ agent: 'cursor' }, () =>
      metered('kb_probe_agent', async () => ({ content: [] }))()
    );
    const row = calls().at(-1);
    assert.strictEqual(row.agent, 'cursor');
    assert.strictEqual(Object.hasOwn(row, 'source'), false);
  });
});

describe('write decision meter', () => {
  const ids = {};
  before(async () => {
    const note = async title => {
      const { id } = insertDocument({ title, content: title, doc_type: 'lesson', tags: 'meter' });
      await storeEmbedding(id, title);
      return id;
    };
    ids.neighbour = await note('An existing note the next write lands near');
    ids.accepted = await note('A note written despite a close neighbour');
    ids.alone = await note('A note written into empty space');

    // An accept just under the line is the row that did not used to exist:
    // refusals were always visible in their own result.
    logWriteDecision({ nearest: { document_id: ids.neighbour, score: 0.77 }, threshold: 0.82, refused: false, docId: ids.accepted });
    logWriteDecision({ nearest: { document_id: ids.neighbour, score: 0.91 }, threshold: 0.82, refused: true });
    logWriteDecision({ nearest: null, threshold: 0.82, refused: false, docId: ids.alone });
  });

  it('exports a frozen closed source vocabulary', () => {
    assert.ok(Object.isFrozen(WRITE_DECISION_SOURCE));
    assert.deepStrictEqual(Object.keys(WRITE_DECISION_SOURCE), ['MCP', 'REST', 'HARVEST', 'CLI']);
    assert.strictEqual(new Set(Object.values(WRITE_DECISION_SOURCE)).size, 4);
  });

  it('persists explicit nullable attribution overrides exactly', () => {
    logWriteDecision({
      nearest: null,
      threshold: 0.82,
      refused: false,
      session: null,
      agent: null,
      source: WRITE_DECISION_SOURCE.REST,
    });
    const row = getDb().prepare('SELECT session, agent, source FROM write_decisions ORDER BY id DESC').get();
    assert.deepStrictEqual(row, { session: null, agent: null, source: WRITE_DECISION_SOURCE.REST });
  });

  it('defaults attribution from ambient call identity', () => {
    callIdentity.run({ agent: 'claude' }, () => logWriteDecision({
      nearest: null,
      threshold: 0.82,
      refused: false,
      source: WRITE_DECISION_SOURCE.HARVEST,
    }));
    const row = getDb().prepare('SELECT session, agent, source FROM write_decisions ORDER BY id DESC').get();
    assert.deepStrictEqual(row, { session: null, agent: 'claude', source: WRITE_DECISION_SOURCE.HARVEST });
  });

  it('records the nearest neighbour of an accepted write, not only of a refused one', () => {
    const accepted = getDb().prepare('SELECT * FROM write_decisions WHERE refused = 0 AND doc_id = ?').get(ids.accepted);
    assert.strictEqual(accepted.nearest_score, 0.77);
    assert.strictEqual(accepted.nearest_id, ids.neighbour);
  });

  it('distinguishes a write with no neighbour from one it never scored', () => {
    const alone = getDb().prepare('SELECT * FROM write_decisions WHERE doc_id = ?').get(ids.alone);
    assert.strictEqual(alone.nearest_score, null);
    assert.strictEqual(alone.nearest_id, null);
  });

  // A refusal writes no note, so its row has nothing to point at — and that
  // must not be mistaken for the row above, which had no neighbour.
  it('records a refusal even though there is no note to attach it to', () => {
    const refused = getDb().prepare('SELECT * FROM write_decisions WHERE refused = 1').get();
    assert.strictEqual(refused.doc_id, null);
    assert.strictEqual(refused.nearest_score, 0.91);
  });

  it('keeps the threshold that was in force, so an old row stays readable after it moves', () => {
    const rows = getDb().prepare('SELECT DISTINCT threshold FROM write_decisions WHERE doc_id IS NOT NULL OR refused = 1').all();
    assert.deepStrictEqual(rows, [{ threshold: 0.82 }]);
  });

  // Through the real tool, not the logger: the accept path is the whole point
  // of the table, and a direct call to the logger proves only that the logger
  // works. Nothing else here would notice if writeNote stopped calling it.
  it('records a row when a real write is accepted', async () => {
    const kbWrite = getToolDefinitions().find(t => t.name === 'kb_write');
    const before = getDb().prepare('SELECT COUNT(*) c FROM write_decisions').get().c;
    const res = await kbWrite.handler({
      title: 'A note written through the tool to prove the meter is wired',
      content: 'Body distinct enough from anything else in the fixture store.',
      type: 'lesson',
    });
    assert.notStrictEqual(res.isError, true, res.content[0].text);
    assert.strictEqual(getDb().prepare('SELECT COUNT(*) c FROM write_decisions').get().c, before + 1);
    const row = getDb().prepare('SELECT * FROM write_decisions ORDER BY id DESC').get();
    assert.strictEqual(row.refused, 0);
    assert.ok(row.doc_id, 'an accepted write records the note it produced');
    assert.strictEqual(row.source, WRITE_DECISION_SOURCE.MCP);
  });

  it('attributes REST ingest writes to the REST source', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1', v1Router);
    const server = await new Promise(resolve => {
      const listening = app.listen(0, () => resolve(listening));
    });
    try {
      const response = await fetch(`http://localhost:${server.address().port}/api/v1/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'A note written through REST to prove attribution',
          content: 'REST attribution integration content distinct from every other meter fixture.',
        }),
      });
      assert.strictEqual(response.status, 201, await response.text());
    } finally {
      await new Promise(resolve => server.close(resolve));
    }

    const row = getDb().prepare('SELECT source FROM write_decisions ORDER BY id DESC').get();
    assert.strictEqual(row.source, WRITE_DECISION_SOURCE.REST);
  });
});
