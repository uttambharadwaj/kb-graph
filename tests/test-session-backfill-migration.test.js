// Point the KB at a throwaway dir BEFORE anything opens the real DB.
import './helpers/tmp-kb.js';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

const { MIGRATIONS } = await import('../src/db.js');
const { applyMigrations, pendingMigrations } = await import('../src/schema.js');

// A fixture database, built and migrated in the test, never the live one.
function seededFixture(sessions) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-migration-18-'));
  const db = new Database(join(dir, 'kb.db'));
  applyMigrations(db, MIGRATIONS);
  const insert = db.prepare('INSERT INTO retrievals (surface, session) VALUES (?, ?)');
  for (const session of sessions) insert.run('kb_read', session);
  return db;
}

const isTestFlags = db => db.prepare('SELECT session, is_test FROM retrievals ORDER BY id').all();

describe('migration 18 — backfilling is_test on historical smoke rows', () => {
  const migration = MIGRATIONS.find(m => m.version === 18);

  it('is pending on a database holding unflagged smoke sessions, and previews its count', () => {
    const db = seededFixture(['smoke-test', 'real-session-1', 'test-planning-notes']);
    assert.ok(pendingMigrations(db, MIGRATIONS).map(m => m.version).includes(18));
    assert.strictEqual(migration.preview(db), '2 rows flagged is_test');
    db.close();
  });

  it('flags the exact literal set from isTestSession()', () => {
    const literals = ['smoke-test', 'smoke-2', 'smoke-compact-test', 'live-verify'];
    const db = seededFixture(literals);
    applyMigrations(db, MIGRATIONS);
    assert.deepStrictEqual(isTestFlags(db).map(r => r.is_test), literals.map(() => 1));
    db.close();
  });

  it('flags every documented prefix convention, hyphen and underscore, case-insensitively', () => {
    const sessions = [
      'smoke-anything', 'smoke_anything', 'SMOKE-Shout',
      'test-anything', 'test_anything', 'Test-Case',
      'fake-anything', 'fake_anything', 'FAKE_x',
    ];
    const db = seededFixture(sessions);
    applyMigrations(db, MIGRATIONS);
    assert.deepStrictEqual(isTestFlags(db).map(r => r.is_test), sessions.map(() => 1));
    db.close();
  });

  it('leaves a real session, and near-misses that only share a substring, unflagged', () => {
    const sessions = [
      'real-work-session',
      'contest-planning',   // contains "test" but does not start with it
      'attestation',        // contains "test" mid-word
      'protest-notes',      // contains "test" mid-word
    ];
    const db = seededFixture(sessions);
    applyMigrations(db, MIGRATIONS);
    assert.deepStrictEqual(isTestFlags(db).map(r => r.is_test), sessions.map(() => 0));
    db.close();
  });

  it('does not treat LIKE\'s single-character wildcard as a literal underscore', () => {
    // "smokeXfoo" has one arbitrary character where the underscore-separator
    // pattern expects a literal "_" -- a naive `LIKE 'smoke_%'` (no ESCAPE)
    // would match this via the wildcard, which isTestSession()'s regex
    // (literal `[-_]`) never would.
    const sessions = ['smokeXfoo', 'testXfoo', 'fakeYbar'];
    const db = seededFixture(sessions);
    applyMigrations(db, MIGRATIONS);
    assert.deepStrictEqual(isTestFlags(db).map(r => r.is_test), sessions.map(() => 0));
    db.close();
  });

  it('leaves envelope rows untouched -- wrong provenance, not test traffic', () => {
    const db = seededFixture([]);
    db.prepare('INSERT INTO retrievals (surface, session, query) VALUES (?, ?, ?)').run(
      'prompt_hint', 'real-session-9', '<agent-message from="scheduled-audit">done</agent-message>'
    );
    applyMigrations(db, MIGRATIONS);
    assert.strictEqual(db.prepare('SELECT is_test FROM retrievals').pluck().get(), 0);
    db.close();
  });

  it('is idempotent -- a second pass reports nothing pending and touches nothing further', () => {
    const db = seededFixture(['smoke-test', 'real-session-2']);
    applyMigrations(db, MIGRATIONS);
    const after1 = isTestFlags(db);
    assert.deepStrictEqual(pendingMigrations(db, MIGRATIONS).map(m => m.version), []);
    assert.strictEqual(applyMigrations(db, MIGRATIONS).length, 0);
    assert.deepStrictEqual(isTestFlags(db), after1);
    db.close();
  });

  it('is a no-op re-flagging a row already flagged at write time', () => {
    const db = seededFixture([]);
    db.prepare('INSERT INTO retrievals (surface, session, is_test) VALUES (?, ?, 1)').run('kb_read', 'smoke-test');
    assert.strictEqual(migration.preview(db), '0 rows flagged is_test');
    assert.deepStrictEqual(pendingMigrations(db, MIGRATIONS).map(m => m.version), []);
    db.close();
  });

  it('has nothing to say about a database with no retrievals table yet', () => {
    const db = new Database(join(mkdtempSync(join(tmpdir(), 'kb-empty-18-')), 'kb.db'));
    assert.strictEqual(migration.applied(db), true);
    applyMigrations(db, MIGRATIONS);
    assert.deepStrictEqual(pendingMigrations(db, MIGRATIONS), []);
    db.close();
  });

  it('runs after migration 17 in version order', () => {
    const versions = MIGRATIONS.map(m => m.version);
    assert.ok(versions.indexOf(17) < versions.indexOf(18));
  });
});
