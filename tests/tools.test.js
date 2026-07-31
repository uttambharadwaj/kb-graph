import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getToolDefinitions, getHttpToolDefinitions } from '../src/tools.js';
import { getDb } from '../src/db.js';

describe('tools', () => {
  it('exports an array of tool definitions', () => {
    const tools = getToolDefinitions();
    assert.ok(Array.isArray(tools));
    assert.ok(tools.length >= 20);
  });

  it('each tool has name, description, schema, handler', () => {
    const tools = getToolDefinitions();
    for (const tool of tools) {
      assert.ok(typeof tool.name === 'string', `tool missing name`);
      assert.ok(typeof tool.description === 'string', `${tool.name} missing description`);
      assert.ok(tool.schema !== undefined, `${tool.name} missing schema`);
      assert.ok(typeof tool.handler === 'function', `${tool.name} missing handler`);
    }
  });

  it('includes all expected tool names', () => {
    const tools = getToolDefinitions();
    const names = tools.map(t => t.name);
    const expected = [
      'bus_send', 'bus_read',
      'kb_search', 'kb_tunnels', 'kb_list', 'kb_read', 'kb_ingest',
      'kb_write', 'kb_vault_status', 'kb_capture_youtube',
      'kb_capture_web', 'kb_capture_session', 'kb_capture_fix',
      'kb_search_smart', 'kb_promote', 'kb_synthesize',
      'kb_classify', 'kb_context', 'kb_safety_check'
    ];
    for (const name of expected) {
      assert.ok(names.includes(name), `missing tool: ${name}`);
    }
  });

  it('getHttpToolDefinitions excludes admin-only tools', () => {
    const httpTools = getHttpToolDefinitions();
    const names = httpTools.map(t => t.name);
    assert.ok(!names.includes('kb_classify'));
    assert.ok(!names.includes('kb_promote'));
    assert.ok(!names.includes('kb_synthesize'));
    assert.ok(!names.includes('kb_safety_check'));
    assert.ok(!names.includes('kb_capture_youtube'));
    assert.ok(!names.includes('bus_send'));
    assert.ok(!names.includes('bus_read'));
    // Should still include read + limited write tools
    assert.ok(names.includes('kb_search'));
    assert.ok(names.includes('kb_ingest'));
    assert.ok(names.includes('kb_write'));
    // kb_tunnels ships over HTTP too — must not be admin-only
    assert.ok(names.includes('kb_tunnels'));
  });

  it('kb_tunnels falls back to neighbors when from and to collapse to one tag', async () => {
    const db = getDb();
    const doc = db.prepare(`INSERT INTO documents (title, content, doc_type, tags) VALUES (?, ?, 'note', ?)`);
    doc.run('a', 'x', 'pipeline, agent');
    doc.run('b', 'y', 'pipeline, agent');
    const tool = getToolDefinitions().find(t => t.name === 'kb_tunnels');
    const res = await tool.handler({ from: 'pipeline', to: 'Pipeline', limit: 10 });
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(parsed.neighbors, 'should return single-tag neighbors mode');
    assert.strictEqual(parsed.stats, undefined, 'should not be two-tag tunnel mode');
  });
});

describe('retrieval logging', () => {
  const handler = (name) => getToolDefinitions().find(t => t.name === name).handler;
  const missesFor = (db, surface) => db.prepare(
    'SELECT COUNT(*) c FROM retrievals WHERE surface = ? AND doc_id IS NULL'
  ).get(surface).c;

  it('kb_read logs a row for the doc it returns', async () => {
    const db = getDb();
    const id = db.prepare(`INSERT INTO documents (title, content, doc_type) VALUES ('r', 'x', 'note')`).run().lastInsertRowid;
    await handler('kb_read')({ id });
    const row = db.prepare("SELECT * FROM retrievals WHERE surface = 'kb_read' AND doc_id = ?").get(id);
    assert.ok(row);
  });

  it('kb_read logs nothing when the id does not exist', async () => {
    const db = getDb();
    const before = db.prepare("SELECT COUNT(*) c FROM retrievals WHERE surface = 'kb_read'").get().c;
    await handler('kb_read')({ id: 999999 });
    const after = db.prepare("SELECT COUNT(*) c FROM retrievals WHERE surface = 'kb_read'").get().c;
    assert.strictEqual(after, before);
  });

  it('kb_search logs one row per returned doc id', async () => {
    const db = getDb();
    const doc = db.prepare(`INSERT INTO documents (title, content, doc_type) VALUES ('search-hit-alpha', 'x', 'note')`).run();
    await handler('kb_search')({ query: 'search-hit-alpha', limit: 20, include_superseded: false });
    const row = db.prepare("SELECT * FROM retrievals WHERE surface = 'kb_search' AND doc_id = ?").get(doc.lastInsertRowid);
    assert.ok(row);
    assert.strictEqual(row.query, 'search-hit-alpha');
  });

  it('kb_search logs a miss row (doc_id NULL) when nothing matches', async () => {
    const db = getDb();
    const before = missesFor(db, 'kb_search');
    await handler('kb_search')({ query: 'zzz-no-such-term-anywhere-zzz', limit: 20, include_superseded: false });
    assert.strictEqual(missesFor(db, 'kb_search'), before + 1);
  });

  it('kb_context logs one row per returned doc id', async () => {
    const db = getDb();
    const doc = db.prepare(`INSERT INTO documents (title, content, doc_type) VALUES ('context-hit-beta', 'x', 'note')`).run();
    await handler('kb_context')({ query: 'context-hit-beta', limit: 15 });
    const row = db.prepare("SELECT * FROM retrievals WHERE surface = 'kb_context' AND doc_id = ?").get(doc.lastInsertRowid);
    assert.ok(row);
  });

  it('kb_context logs a miss row when nothing matches', async () => {
    const db = getDb();
    const before = missesFor(db, 'kb_context');
    await handler('kb_context')({ query: 'zzz-no-such-term-anywhere-zzz', limit: 15 });
    assert.strictEqual(missesFor(db, 'kb_context'), before + 1);
  });

  it('a broken retrievals table does not break kb_read, kb_search, or kb_context', async () => {
    const db = getDb();
    const doc = db.prepare(`INSERT INTO documents (title, content, doc_type) VALUES ('resilient-doc', 'x', 'note')`).run();
    db.exec('DROP TABLE retrievals');
    try {
      const readRes = await handler('kb_read')({ id: doc.lastInsertRowid });
      assert.ok(!readRes.isError);
      const searchRes = await handler('kb_search')({ query: 'resilient-doc', limit: 20, include_superseded: false });
      assert.ok(!searchRes.isError);
      const contextRes = await handler('kb_context')({ query: 'resilient-doc', limit: 15 });
      assert.ok(!contextRes.isError);
    } finally {
      db.exec(`
        CREATE TABLE retrievals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          doc_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
          surface TEXT NOT NULL,
          query TEXT,
          session TEXT,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    }
  });
});
