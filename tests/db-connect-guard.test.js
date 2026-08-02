// Runs in its own process so KB_DIR can point somewhere disposable before
// src/paths.js reads it — importing the real module with the real KB_DIR would
// have the test open the actual knowledge base.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const home = mkdtempSync(join(tmpdir(), 'kb-connect-guard-'));
process.env.KB_DIR = home;

let db;

describe('getDb never hands out an unverified connection', () => {
  before(async () => {
    const { initSchema } = await import('../src/db.js');
    const seed = new Database(join(home, 'kb.db'));
    initSchema(seed);
    seed.exec('ALTER TABLE documents DROP COLUMN superseded_at');
    seed.close();
    ({ getDb: db } = await import('../src/db.js'));
  });

  after(() => rmSync(home, { recursive: true, force: true }));

  it('throws again on the next call rather than caching the bad connection', async () => {
    const { SchemaOutOfDateError } = await import('../src/schema.js');

    // A caller that swallows the first failure — the shape that turns a loud
    // refusal into a process quietly running against a database it cannot read.
    let first = null;
    try { db(); } catch (err) { first = err; }
    assert.ok(first instanceof SchemaOutOfDateError);

    assert.throws(() => db(), SchemaOutOfDateError, 'the second call must refuse too');
  });
});
