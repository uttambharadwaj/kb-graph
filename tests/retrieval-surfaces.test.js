// Every read surface, counted rather than inspected. The meter's failure mode
// is silence — a route that logs nothing looks exactly like a route nobody
// called — so each case asserts an exact row delta for one call.
import './helpers/tmp-kb.js';
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { env as transformersEnv } from '@huggingface/transformers';
import { getDb, searchDocuments, getDocument, supersedeDocument } from '../src/db.js';
import { getToolDefinitions } from '../src/tools.js';
import { search as cliSearch } from '../src/cli/search-cli.js';
import { createApiKeyMiddleware } from '../src/middleware/api-key.js';
import { setPassword, createSession } from '../src/auth.js';
import v1Router from '../src/routes/v1.js';
import apiRouter from '../src/routes/api.js';

process.env.KB_API_KEY_CLAUDE = 'surfaces-test-key';

// The smart-search surfaces must be provable without a 25MB model download on
// every CI run. Disabling both model sources makes the embedder throw in ~1ms,
// sending hybridSearch down its semantic-layer-unavailable path — the same one
// a machine with no embeddings takes, and it converges on the same logging
// call. Disabling only the remote source is not enough: the loader still races
// a 60s timeout before giving up. node:test gives each file its own process,
// so this cannot leak into other suites.
transformersEnv.allowRemoteModels = false;
transformersEnv.allowLocalModels = false;

const TERM = 'quintessence';
const docIds = [];

function countBySurface(db) {
  return Object.fromEntries(
    db.prepare('SELECT surface, COUNT(*) n FROM retrievals GROUP BY surface').all().map(r => [r.surface, r.n])
  );
}

// The delta for one call, keyed by surface. `{}` means the call was invisible
// to the meter, which is the assertion for every non-retrieval path.
async function deltaFor(fn) {
  const db = getDb();
  const before = countBySurface(db);
  await fn();
  const after = countBySurface(db);
  const delta = {};
  for (const [surface, n] of Object.entries(after)) {
    if (n - (before[surface] || 0) !== 0) delta[surface] = n - (before[surface] || 0);
  }
  return delta;
}

before(() => {
  const db = getDb();
  const insert = db.prepare(`INSERT INTO documents (title, content, doc_type, tags) VALUES (?, ?, ?, 'metered')`);
  docIds.push(insert.run(`alpha ${TERM}`, `alpha ${TERM} body`, 'note').lastInsertRowid);
  docIds.push(insert.run(`beta ${TERM}`, `beta ${TERM} body`, 'note').lastInsertRowid);
  docIds.push(insert.run(`gamma ${TERM}`, `gamma ${TERM} body`, 'markdown').lastInsertRowid);
  db.prepare(
    `INSERT INTO vault_files (vault_path, content_hash, document_id, title, project) VALUES ('alpha.md', 'h', ?, 'alpha', 'proj-a')`
  ).run(docIds[0]);
  setPassword('surfaces-test-password');
});

// Console output is the CLI's product, not this test's — silence it so a
// passing run is readable.
async function quietly(fn) {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

describe('MCP surfaces', () => {
  const handler = (name) => getToolDefinitions().find(t => t.name === name).handler;

  it('kb_search logs once per hit and only under its own surface', async () => {
    assert.deepStrictEqual(
      await deltaFor(() => handler('kb_search')({ query: TERM, limit: 20, include_superseded: false })),
      { kb_search: 3 }
    );
  });

  it('kb_read logs exactly one row — the tool layer no longer logs a second', async () => {
    assert.deepStrictEqual(await deltaFor(() => handler('kb_read')({ id: docIds[0] })), { kb_read: 1 });
  });

  it('kb_context logs the briefing set it returns', async () => {
    assert.deepStrictEqual(await deltaFor(() => handler('kb_context')({ query: TERM, limit: 15 })), { kb_context: 3 });
  });

  it('kb_search_smart logs the fused set under its own surface', async () => {
    assert.deepStrictEqual(
      await deltaFor(() => handler('kb_search_smart')({ query: TERM, limit: 10 })),
      { kb_search_smart: 3 },
      'the FTS half must not also log under kb_search'
    );
  });

  it('kb_tunnels meters the bridge docs it hands back', async () => {
    const db = getDb();
    const insert = db.prepare(`INSERT INTO documents (title, content, doc_type, tags) VALUES (?, 'x', 'note', ?)`);
    insert.run('bridged-one', 'tunnel-a, tunnel-b');
    insert.run('bridged-two', 'tunnel-a, tunnel-b');
    assert.deepStrictEqual(
      await deltaFor(() => handler('kb_tunnels')({ from: 'tunnel-a', to: 'tunnel-b', limit: 10 })),
      { kb_tunnels: 2 }
    );
  });

  it('kb_tunnels in single-tag mode returns no docs and logs none', async () => {
    assert.deepStrictEqual(await deltaFor(() => handler('kb_tunnels')({ from: 'tunnel-a', limit: 10 })), {});
  });

  it('kb_list is not a retrieval — a bulk enumeration is not evidence a note was read', async () => {
    assert.deepStrictEqual(await deltaFor(() => handler('kb_list')({ limit: 50 })), {});
  });

  it('the existence check on a kb_write supersede target logs nothing', async () => {
    assert.deepStrictEqual(
      await deltaFor(() => handler('kb_write')({ title: 't', content: 'c', type: 'lesson', supersedes: 999999 })),
      {}
    );
  });
});

describe('REST surfaces', () => {
  const AUTH = { 'X-API-Key': 'surfaces-test-key' };

  async function withServer(fn) {
    const app = express();
    app.use(express.json());
    app.use('/api/v1', createApiKeyMiddleware(), v1Router);
    app.use(apiRouter);
    const server = app.listen(0);
    try {
      await fn(server.address().port);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }

  const get = (port, path, headers = AUTH) => fetch(`http://localhost:${port}${path}`, { headers });

  it('GET /search logs one row per returned result', async () => {
    await withServer(async (port) => {
      assert.deepStrictEqual(await deltaFor(() => get(port, `/api/v1/search?q=${TERM}`)), { rest_search: 3 });
    });
  });

  it('GET /search logs the post-filter set, not everything the search matched', async () => {
    await withServer(async (port) => {
      assert.deepStrictEqual(
        await deltaFor(() => get(port, `/api/v1/search?q=${TERM}&type=note`)),
        { rest_search: 2 },
        'the markdown doc was filtered out of the response and must not count as retrieved'
      );
      assert.deepStrictEqual(
        await deltaFor(() => get(port, `/api/v1/search?q=${TERM}&project=proj-a`)),
        { rest_search: 1 }
      );
    });
  });

  it('GET /search logs a miss row when nothing matches', async () => {
    await withServer(async (port) => {
      assert.deepStrictEqual(await deltaFor(() => get(port, '/api/v1/search?q=zzznothingzzz')), { rest_search: 1 });
      const db = getDb();
      const row = db.prepare("SELECT doc_id FROM retrievals WHERE surface = 'rest_search' AND query = 'zzznothingzzz'").get();
      assert.strictEqual(row.doc_id, null);
    });
  });

  it('GET /context logs its own surface, distinguishable from an MCP kb_context', async () => {
    await withServer(async (port) => {
      assert.deepStrictEqual(await deltaFor(() => get(port, `/api/v1/context?q=${TERM}`)), { rest_context: 3 });
    });
  });

  it('GET /search/smart is distinguishable from an MCP smart search', async () => {
    await withServer(async (port) => {
      assert.deepStrictEqual(await deltaFor(() => get(port, `/api/v1/search/smart?q=${TERM}`)), { rest_search_smart: 3 });
    });
  });

  it('GET /documents/:id logs a read; a 404 logs a miss', async () => {
    await withServer(async (port) => {
      assert.deepStrictEqual(await deltaFor(() => get(port, `/api/v1/documents/${docIds[1]}`)), { rest_read: 1 });
      assert.deepStrictEqual(await deltaFor(() => get(port, '/api/v1/documents/999999')), { rest_read: 1 });
    });
  });

  it('GET /documents (list) is not a retrieval', async () => {
    await withServer(async (port) => {
      assert.deepStrictEqual(await deltaFor(() => get(port, '/api/v1/documents')), {});
    });
  });

  it('the dashboard API meters the same operations under the same surfaces', async () => {
    await withServer(async (port) => {
      const cookie = { Cookie: `kb_session=${createSession()}` };
      assert.deepStrictEqual(await deltaFor(() => get(port, `/api/documents?q=${TERM}`, cookie)), { rest_search: 3 });
      assert.deepStrictEqual(await deltaFor(() => get(port, `/api/documents/${docIds[1]}`, cookie)), { rest_read: 1 });
      assert.deepStrictEqual(await deltaFor(() => get(port, '/api/documents', cookie)), {});
    });
  });

  it('an unauthorized request never reaches the meter', async () => {
    await withServer(async (port) => {
      assert.deepStrictEqual(await deltaFor(() => get(port, `/api/documents?q=${TERM}`, {})), {});
    });
  });
});

describe('CLI surface', () => {
  it('kb search logs under cli_search, not under the MCP search surface', async () => {
    assert.deepStrictEqual(await deltaFor(() => quietly(() => cliSearch(TERM))), { cli_search: 3 });
  });
});

describe('internal lookups stay out of the meter', () => {
  it('searchDocuments and getDocument log nothing without a surface', async () => {
    assert.deepStrictEqual(await deltaFor(() => { searchDocuments(TERM, 10); }), {});
    assert.deepStrictEqual(await deltaFor(() => { getDocument(docIds[0]); }), {});
  });

  it('supersedeDocument reads the row it updates without counting it as a retrieval', async () => {
    assert.deepStrictEqual(await deltaFor(() => { supersedeDocument(docIds[2], { reason: 'test' }); }), {});
  });
});
