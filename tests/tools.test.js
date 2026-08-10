import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getToolDefinitions, getHttpToolDefinitions } from '../src/tools.js';
import { getDb } from '../src/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

  // Named in full, and compared both ways. The old form asserted `length >= 20`
  // against a list of 19, so deleting any of the other seven kept the suite
  // green — and the seven not named were the admin-only ones, which are also
  // the ones absent from HTTP and therefore least likely to be missed by hand.
  const CORE_TOOLS = [
    'kb_capture_fix', 'kb_capture_session', 'kb_capture_web', 'kb_capture_youtube',
    'kb_check_duplicate', 'kb_classify', 'kb_context', 'kb_extract',
    'kb_fact_add', 'kb_fact_invalidate', 'kb_fact_query', 'kb_fact_timeline',
    'kb_ingest', 'kb_list', 'kb_promote', 'kb_read', 'kb_safety_check',
    'kb_search', 'kb_search_smart', 'kb_supersede', 'kb_supersede_candidates',
    'kb_synthesize', 'kb_tunnels', 'kb_vault_status', 'kb_wakeup', 'kb_write',
  ];

  it('registers exactly the advertised core tool set', () => {
    const names = getToolDefinitions().map(t => t.name).filter(n => n.startsWith('kb_')).sort();
    assert.deepStrictEqual(names, [...CORE_TOOLS].sort(),
      'the registered kb_ tools and the advertised set have drifted apart');
  });

  // A tool the README documents but nothing routes to is still a tool an agent
  // can call; a tool that quietly stops being registered is not, and no test
  // that only checks for extras would notice.
  it('documents every core tool it registers', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const undocumented = CORE_TOOLS.filter(name => !readme.includes(`\`${name}\``));
    assert.deepStrictEqual(undocumented, [], 'registered tools missing from the README table');
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

// A tool nothing points at is one no agent has a reason to call, which is
// indistinguishable at the census from a tool nobody wants. Both doc tables had
// silently fallen behind the registry — README by two tools, llms.txt by ten.
describe('every registered tool is reachable from the docs', () => {
  const names = () => getToolDefinitions().map(t => t.name);

  for (const file of ['README.md', 'llms.txt']) {
    it(`${file} lists every tool`, () => {
      const doc = readFileSync(join(ROOT, file), 'utf-8');
      const missing = names().filter(n => !doc.includes(n));
      assert.deepStrictEqual(missing, [], `${file} does not mention: ${missing.join(', ')}`);
    });
  }

  // Not a style rule: the short descriptions are the ones that say only what the
  // tool is, and an agent cannot infer a trigger from that.
  it('no description is too short to name a triggering situation', () => {
    const terse = getToolDefinitions()
      .filter(t => t.description.length < 80)
      .map(t => t.name);
    assert.deepStrictEqual(terse, [], `describe when to reach for: ${terse.join(', ')}`);
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

  // MCP calls (kb_read/kb_search/kb_context) each stand on their own — unlike
  // a hint prompt or a briefing, nothing groups several of them into one
  // decision — so none of them carries an event id. Event ids belong to the
  // push surfaces (see hooks-retrieval.test.js).
  it('kb_read, kb_search, and kb_context all log rows with a NULL event id', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO documents (title, content, doc_type) VALUES ('event-id-null-check', 'x', 'note')`).run();
    const readId = db.prepare(`INSERT INTO documents (title, content, doc_type) VALUES ('event-id-null-read', 'x', 'note')`).run().lastInsertRowid;

    await handler('kb_read')({ id: readId });
    await handler('kb_search')({ query: 'event-id-null-check', limit: 20, include_superseded: false });
    await handler('kb_context')({ query: 'event-id-null-check', limit: 15 });

    for (const surface of ['kb_read', 'kb_search', 'kb_context']) {
      const rows = db.prepare('SELECT event_id FROM retrievals WHERE surface = ? ORDER BY id DESC LIMIT 1').all(surface);
      assert.ok(rows.length, `expected at least one ${surface} row`);
      for (const row of rows) assert.strictEqual(row.event_id, null, `${surface} row must not carry an event id`);
    }
  });

  // Same reasoning as the search surfaces: a read of an id that is gone is a
  // read that failed, and dropping it leaves kb_read's miss rate structurally
  // zero rather than measured.
  it('kb_read logs a miss row when the id does not exist', async () => {
    const db = getDb();
    const before = missesFor(db, 'kb_read');
    await handler('kb_read')({ id: 999999 });
    assert.strictEqual(missesFor(db, 'kb_read'), before + 1);
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
