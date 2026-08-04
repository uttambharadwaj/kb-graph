import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { MIGRATION_TARGETS, migrationsFor } from '../migration-targets.js';
import { applyMigrations, isEmptyDatabase, PENDING_EXIT, pendingMigrations } from '../schema.js';

// The only path in the codebase that executes DDL. Everything else verifies.

function migrateTarget({ label, prepare, db: dbPath }, migrations, { dryRun }) {
  prepare();
  const file = dbPath();
  const db = new Database(file);
  try {
    const pending = pendingMigrations(db, migrations);
    console.log(`${label}  ${file}`);
    if (pending.length === 0) {
      console.log('  up to date');
      return;
    }
    if (dryRun) {
      for (const migration of pending) {
        console.log(`  pending  ${migration.version}. ${migration.name}`);
        // A data migration's name says what it does, not how much of the table
        // it touches, and "rewrites your facts" is not something to run on a
        // count nobody was shown. Schema migrations have nothing to count and
        // supply no preview.
        if (migration.preview) console.log(`           ${migration.preview(db)}`);
      }
      console.log('  (dry run — nothing written)');
      return;
    }
    // A base migration can create what a later one would have added, so report
    // what actually ran rather than what was pending when we started.
    const ran = new Set(applyMigrations(db, migrations).map(m => m.version));
    for (const migration of pending) {
      const outcome = ran.has(migration.version) ? 'applied  ' : 'no-op    ';
      console.log(`  ${outcome}${migration.version}. ${migration.name}`);
    }
  } finally {
    db.close();
  }
}

/**
 * Whether connecting to this target would throw, without connecting to it.
 *
 * Answers exactly the question `ensureSchemaReady` asks, which is the point: a
 * database that does not exist yet, or that holds nothing, is bootstrapped on
 * connect rather than rejected, so neither is behind. Read-only and creating
 * nothing — unlike `--dry-run`, this runs on machines nobody asked to touch.
 */
function behind({ label, db: dbPath }, migrations) {
  const file = dbPath();
  if (!existsSync(file)) return null;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (isEmptyDatabase(db)) return null;
    const pending = pendingMigrations(db, migrations);
    if (pending.length === 0) return null;
    return `${label}  ${file}  behind by ${pending.length}: ${pending.map(m => `${m.version}. ${m.name}`).join(', ')}`;
  } finally {
    db.close();
  }
}

export async function runMigrateCli(args = []) {
  const check = args.includes('--check');
  const dryRun = args.includes('--dry-run');
  const reports = [];

  for (const target of MIGRATION_TARGETS) {
    const migrations = await migrationsFor(target);
    if (check) {
      const report = behind(target, migrations);
      if (report) reports.push(report);
    } else {
      migrateTarget(target, migrations, { dryRun });
    }
  }

  if (!check) return;
  if (reports.length === 0) {
    console.log('databases are up to date');
    return;
  }
  for (const report of reports) console.log(report);
  // exitCode rather than exit(): the caller returns straight into node's own
  // teardown, which flushes stdout on every platform. A pipe that lost the
  // report would leave the operator with a bare exit code.
  process.exitCode = PENDING_EXIT;
}
