import Database from 'better-sqlite3';
import { DB_PATH } from '../paths.js';
import { MIGRATIONS as KB_MIGRATIONS } from '../db.js';
import { MIGRATIONS as BUS_MIGRATIONS } from '../bus/db.js';
import { ensureBusStorage, getBusDbPath } from '../bus/config.js';
import { applyMigrations, pendingMigrations } from '../schema.js';

// The only path in the codebase that executes DDL. Everything else verifies.
const TARGETS = [
  { label: 'knowledge base', migrations: KB_MIGRATIONS, path: () => DB_PATH, prepare: () => {} },
  { label: 'message bus', migrations: BUS_MIGRATIONS, path: getBusDbPath, prepare: ensureBusStorage },
];

function migrateTarget({ label, migrations, path, prepare }, { dryRun }) {
  prepare();
  const file = path();
  const db = new Database(file);
  try {
    const pending = pendingMigrations(db, migrations);
    console.log(`${label}  ${file}`);
    if (pending.length === 0) {
      console.log('  up to date');
      return 0;
    }
    if (dryRun) {
      for (const migration of pending) console.log(`  pending  ${migration.version}. ${migration.name}`);
      console.log('  (dry run — nothing written)');
      return pending.length;
    }
    // A base migration can create what a later one would have added, so report
    // what actually ran rather than what was pending when we started.
    const ran = new Set(applyMigrations(db, migrations).map(m => m.version));
    for (const migration of pending) {
      const outcome = ran.has(migration.version) ? 'applied  ' : 'no-op    ';
      console.log(`  ${outcome}${migration.version}. ${migration.name}`);
    }
    return ran.size;
  } finally {
    db.close();
  }
}

export function runMigrateCli(args = []) {
  const dryRun = args.includes('--dry-run');
  for (const target of TARGETS) migrateTarget(target, { dryRun });
}
