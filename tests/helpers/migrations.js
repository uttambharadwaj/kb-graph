// Building a database that is deliberately behind the code, for the tests that
// need the schema gate to have something to catch.
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { applyMigrations, pendingMigrations } from '../../src/schema.js';

/**
 * The longest prefix of a list that still leaves something pending.
 *
 * Dropping the last entry is not enough: a base migration usually creates what
 * a later one would have added, so the tail of a list is often already
 * `applied` on a database that never ran it. Searching for the prefix keeps
 * these tests honest as migrations are added.
 */
export function shortOf(migrations) {
  for (let n = migrations.length - 1; n > 0; n -= 1) {
    const db = new Database(':memory:');
    applyMigrations(db, migrations.slice(0, n));
    const pending = pendingMigrations(db, migrations);
    db.close();
    if (pending.length > 0) return { applied: migrations.slice(0, n), pending };
  }
  throw new Error('no prefix of this list leaves anything pending');
}

// WAL like the real server, so a test meets the shape production has rather
// than a rollback-journal database no process here ever opens.
export function seedDb(file, migrations) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  applyMigrations(db, migrations);
  db.close();
}
