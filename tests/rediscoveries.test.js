// Rediscovery telemetry: duplicate detection catching an agent re-deriving a
// note the KB already had, at both call sites that can refuse a write
// (kb_check_duplicate's own verdict, kb_write's dedupe refusal), plus the
// `kb rediscoveries` listing over what got logged.
import './helpers/tmp-kb.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import { getToolDefinitions } from '../src/tools.js';
import { insertDocument, getDb } from '../src/db.js';
import { generateEmbedding, embeddingToBuffer } from '../src/embeddings/embed.js';
import { similarDocs } from '../src/embeddings/search.js';
import { SURFACE, callIdentity, resolveSessionId } from '../src/retrieval.js';
import { AGENT } from '../src/process-ancestry.js';
import { countByAgent, rediscoveries, runRediscoveriesCli } from '../src/cli/rediscoveries.js';

const call = async (name, args) => {
  const tool = getToolDefinitions().find(t => t.name === name);
  const res = await tool.handler(args);
  return { text: res.content[0].text, isError: res.isError === true };
};

// Copied from near-neighbors.test.js rather than imported — that helper is
// file-local there. Plants a note whose stored vector sits at an exact
// cosine from `content`, so a duplicate/non-duplicate verdict can be forced
// rather than hoped for from real prose.
async function plantNeighborAt(score, { title, content }) {
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  const unit = (v) => { const mag = Math.sqrt(dot(v, v)); return v.map(x => x / mag); };

  const q = unit(await generateEmbedding(content));
  let seed = 11;
  const r = q.map(() => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; });
  const proj = dot(r, q);
  const perp = unit(r.map((v, i) => v - proj * q[i]));
  const vector = q.map((x, i) => score * x + Math.sqrt(1 - score * score) * perp[i]);

  const doc = insertDocument({ title, content: 'planted', doc_type: 'lesson', tags: '' });
  getDb().prepare(
    'INSERT INTO embeddings (document_id, vault_path, chunk_index, chunk_text, embedding, dimensions) VALUES (?, ?, 0, ?, ?, ?)'
  ).run(doc.id, `planted/${doc.id}.md`, 'planted', embeddingToBuffer(vector), vector.length);

  const scored = (await similarDocs(content, { limit: 50 })).find(s => s.document_id === doc.id);
  assert.ok(Math.abs(scored?.score - score) < 1e-3, `planted at ${score}, scored ${scored?.score}`);
  return doc;
}

const rediscoveryRows = () => getDb().prepare(
  "SELECT * FROM retrievals WHERE surface = ? ORDER BY id"
).all(SURFACE.REDISCOVERY);

describe('kb_check_duplicate logs a rediscovery', () => {
  beforeEach(() => getDb().exec('DELETE FROM embeddings'));

  it('one row per match, sharing an event id, query truncated to 300 chars and the ambient session', async () => {
    const content = `Retries are capped at three attempts, with jitter between them. ${'x'.repeat(400)}`;
    const held = await plantNeighborAt(0.9, { title: 'Retry policy', content });

    const before = rediscoveryRows().length;
    const res = await call('kb_check_duplicate', { content });
    assert.strictEqual(JSON.parse(res.text).is_duplicate, true);

    const rows = rediscoveryRows().slice(before);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].doc_id, held.id);
    assert.strictEqual(rows[0].session, resolveSessionId());
    assert.strictEqual(rows[0].query, content.slice(0, 300));
    assert.strictEqual(rows[0].query.length, 300);
    assert.ok(rows[0].event_id);
  });

  it('shares one event id across every match of a single check', async () => {
    const content = 'Session tokens are minted per run and never reused across runs.';
    const first = await plantNeighborAt(0.95, { title: 'Token note A', content });
    const second = await plantNeighborAt(0.9, { title: 'Token note B', content });

    const before = rediscoveryRows().length;
    const res = await call('kb_check_duplicate', { content });
    assert.strictEqual(JSON.parse(res.text).is_duplicate, true);

    const rows = rediscoveryRows().slice(before);
    assert.strictEqual(rows.length, 2);
    assert.deepStrictEqual(new Set(rows.map(r => r.doc_id)), new Set([first.id, second.id]));
    assert.strictEqual(rows[0].event_id, rows[1].event_id);
  });

  it('logs nothing on a not-a-duplicate verdict', async () => {
    const content = 'Sundial gnomon angle equals the latitude of the site.';
    await plantNeighborAt(0.5, { title: 'Unrelated note', content });

    const before = rediscoveryRows().length;
    const res = await call('kb_check_duplicate', { content });
    assert.strictEqual(JSON.parse(res.text).is_duplicate, false);
    assert.strictEqual(rediscoveryRows().length, before);
  });
});

describe('kb_write dedupe refusal logs a rediscovery', () => {
  beforeEach(() => getDb().exec('DELETE FROM embeddings'));

  it('logs a rediscovery row when the write is refused as a duplicate', async () => {
    const content = 'Queue workers acknowledge a message only after the write commits.';
    const held = await plantNeighborAt(0.9, { title: 'Ack after commit', content });

    const before = rediscoveryRows().length;
    const res = await call('kb_write', { title: 'Acknowledge after commit', content, type: 'lesson' });
    assert.strictEqual(JSON.parse(res.text).reason, 'duplicate_detected');

    const rows = rediscoveryRows().slice(before);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].doc_id, held.id);
    assert.strictEqual(rows[0].session, resolveSessionId());
  });

  it('logs nothing when the write is accepted', async () => {
    const content = 'Sundial gnomon angle equals the latitude of the site, measured at solar noon.';
    await plantNeighborAt(0.2, { title: 'Unrelated note', content });

    const before = rediscoveryRows().length;
    const res = await call('kb_write', { title: 'Gnomon angles at noon', content, type: 'lesson' });
    assert.strictEqual(res.isError, false, res.text);
    assert.strictEqual(rediscoveryRows().length, before);
  });

  // One rediscovery event reached by two paths (check-then-write) must be
  // stamped the same way by both, or the same event lands in the table twice
  // under two different sessions. write-note.js used to hardcode null here
  // while kb_check_duplicate resolved it, which only looked consistent
  // because the resolution was null in every context that had been measured.
  it('stamps the same session as kb_check_duplicate for the same content', async () => {
    const identity = { harnessPid: 91001, pidStart: 'START-91001', agent: AGENT.CODEX };
    const content = 'Credentials are resolved at tool-call time, never at session start.';
    await plantNeighborAt(0.9, { title: 'Stateless credential resolution', content });

    const before = rediscoveryRows().length;
    await callIdentity.run(identity, async () => {
      await call('kb_check_duplicate', { content });
      await call('kb_write', { title: 'Credentials resolved late', content, type: 'lesson' });
    });

    const rows = rediscoveryRows().slice(before);
    assert.strictEqual(rows.length, 2, 'both call sites must log the refusal');
    // No session map exists for this pid, so the verified answer is null at
    // both sites — the assertion that matters is that they AGREE, whatever
    // the ambient resolution says.
    assert.strictEqual(rows[0].session, rows[1].session);
    assert.strictEqual(rows[0].agent, AGENT.CODEX);
    assert.strictEqual(rows[1].agent, AGENT.CODEX);
  });
});

describe('kb rediscoveries CLI', () => {
  it('lists rows within the day window, joined to the note title', () => {
    const doc = insertDocument({ title: 'Rediscovered note', content: 'x', doc_type: 'lesson', tags: '' });
    getDb().prepare(
      'INSERT INTO retrievals (doc_id, surface, query, session, event_id, is_test) VALUES (?, ?, ?, ?, ?, 0)'
    ).run(doc.id, SURFACE.REDISCOVERY, 'the checked content', null, 'evt-cli-test');

    const rows = rediscoveries(getDb(), { days: 14 });
    const row = rows.find(r => r.doc_id === doc.id);
    assert.ok(row, 'the freshly inserted rediscovery row must appear');
    assert.strictEqual(row.title, 'Rediscovered note');
    assert.strictEqual(row.query, 'the checked content');
  });

  it('excludes rows older than the requested window', () => {
    const doc = insertDocument({ title: 'Old rediscovery', content: 'x', doc_type: 'lesson', tags: '' });
    getDb().prepare(
      "INSERT INTO retrievals (doc_id, surface, query, session, event_id, is_test, created_at) VALUES (?, ?, ?, ?, ?, 0, datetime('now', '-30 days'))"
    ).run(doc.id, SURFACE.REDISCOVERY, 'stale query', null, 'evt-cli-old');

    const rows = rediscoveries(getDb(), { days: 14 });
    assert.ok(!rows.some(r => r.doc_id === doc.id), 'a row older than the window must not appear');
  });

  it('runRediscoveriesCli --json prints the same rows as the direct query', () => {
    const doc = insertDocument({ title: 'CLI json note', content: 'x', doc_type: 'lesson', tags: '' });
    getDb().prepare(
      'INSERT INTO retrievals (doc_id, surface, query, session, event_id, is_test) VALUES (?, ?, ?, ?, ?, 0)'
    ).run(doc.id, SURFACE.REDISCOVERY, 'json cli query', null, 'evt-cli-json');

    const logs = [];
    const original = console.log;
    console.log = (msg) => logs.push(msg);
    try {
      runRediscoveriesCli(['--json']);
    } finally {
      console.log = original;
    }
    const printed = JSON.parse(logs.join('\n'));
    assert.ok(printed.some(r => r.doc_id === doc.id && r.query === 'json cli query'));
  });
});

// A rediscovery is an agent re-deriving what the KB already had — which agent
// is the actionable half of that (a client that keeps re-deriving is one the
// push surfaces are failing).
describe('rediscoveries per-agent breakdown', () => {
  function insertRediscovery({ title, agent }) {
    const doc = insertDocument({ title, content: 'x', doc_type: 'lesson', tags: '' });
    getDb().prepare(
      'INSERT INTO retrievals (doc_id, surface, query, session, event_id, is_test, agent) VALUES (?, ?, ?, NULL, ?, 0, ?)'
    ).run(doc.id, SURFACE.REDISCOVERY, 'a checked body', `evt-${title}`, agent);
    return doc.id;
  }

  it('counts each agent and files NULL-agent rows under unknown', () => {
    const rows = [
      { agent: 'claude' }, { agent: 'claude' }, { agent: 'codex' }, { agent: null }, { agent: 'gemini' },
    ];
    assert.deepStrictEqual(countByAgent(rows), { claude: 2, codex: 1, unknown: 2 });
  });

  it('carries the agent through the listing query and onto the CLI\'s JSON rows', () => {
    const codexDoc = insertRediscovery({ title: 'Codex rediscovery note', agent: 'codex' });

    const row = rediscoveries(getDb(), { days: 14 }).find(r => r.doc_id === codexDoc);
    assert.ok(row);
    assert.strictEqual(row.agent, 'codex');

    const logs = [];
    const original = console.log;
    console.log = (msg) => logs.push(msg);
    try {
      runRediscoveriesCli(['--json']);
    } finally {
      console.log = original;
    }
    const printed = JSON.parse(logs.join('\n'));
    assert.ok(printed.some(r => r.doc_id === codexDoc && r.agent === 'codex'));
  });

  it('prints the breakdown line under the total in the text output', () => {
    insertRediscovery({ title: 'Claude rediscovery note', agent: 'claude' });

    const logs = [];
    const original = console.log;
    console.log = (msg) => logs.push(msg);
    try {
      runRediscoveriesCli([]);
    } finally {
      console.log = original;
    }
    const [totalLine, agentLine] = logs;
    assert.match(totalLine, /^Rediscoveries in the last 14 day\(s\): \d+$/);
    assert.match(agentLine, /^ {2}by agent: claude \d+, codex \d+, unknown \d+$/);

    // The parts must sum to the total printed above them, or the line lies.
    const total = Number(totalLine.match(/: (\d+)$/)[1]);
    const parts = [...agentLine.matchAll(/(\d+)/g)].map(m => Number(m[1]));
    assert.strictEqual(parts.reduce((a, b) => a + b, 0), total);
  });
});
