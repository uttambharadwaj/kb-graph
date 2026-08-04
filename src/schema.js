// Every command opens the default database, from whatever checkout it happens to
// run in, so DDL on connect migrates the real database by accident — a one-off
// CLI invocation is enough. Connecting verifies against this engine; only
// `kb migrate` executes a migration's `up`.
//
// A migration declares `applied(db)` as cheap introspection of the real schema
// rather than a stored version number. The schema is then its own version: no
// second copy to drift, and installs that predate this code need no manual
// baseline before they can start.

export const MIGRATE_COMMAND = 'kb migrate';
// `kb migrate --check` exits with this when a database is behind the code, so a
// script — or the MCP supervisor's reload gate — can tell "you need to migrate"
// from the 1 that every other kind of failure exits with.
export const PENDING_EXIT = 3;

export class SchemaOutOfDateError extends Error {
  constructor({ label, path, pending }) {
    const list = pending.map(m => `    ${m.version}. ${m.name}`).join('\n');
    super(
      `The ${label} database at ${path} is behind this code.\n`
      + `  Pending migrations:\n${list}\n`
      + `  Run \`${MIGRATE_COMMAND}\` to apply them (\`${MIGRATE_COMMAND} --dry-run\` to preview).`
    );
    this.name = 'SchemaOutOfDateError';
    this.pending = pending.map(m => m.version);
  }
}

// Table and index names come from the migration lists, never from input, but an
// interpolated identifier deserves a boundary check rather than a promise.
function assertIdentifier(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return name;
}

export function hasTable(db, name) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?"
  ).get(name));
}

export function hasIndex(db, name) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?"
  ).get(name));
}

export function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${assertIdentifier(table)})`).all()
    .some(c => c.name === column);
}

// Column at a time, so a migration that died between two ALTERs can be re-run.
export function addColumn(db, table, column, type) {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${assertIdentifier(table)} ADD COLUMN ${assertIdentifier(column)} ${type}`);
}

// A database holding none of our objects has nothing to damage, so creating its
// schema is initialization, not migration. Changing a schema that already exists
// is the thing that needs an explicit command.
export function isEmptyDatabase(db) {
  return db.prepare(
    "SELECT COUNT(*) c FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'"
  ).get().c === 0;
}

export function pendingMigrations(db, migrations) {
  return migrations.filter(m => !m.applied(db));
}

// Re-checks `applied` per step because a base migration usually creates what a
// later one would have added, so a fresh database must skip the later ones.
export function applyMigrations(db, migrations) {
  const ran = [];
  for (const migration of migrations) {
    if (migration.applied(db)) continue;
    db.transaction(() => migration.up(db))();
    ran.push(migration);
  }
  return ran;
}

export function ensureSchemaReady(db, { migrations, label, path }) {
  if (isEmptyDatabase(db)) {
    // One transaction for the whole bootstrap, taken immediately: hooks start in
    // parallel, and a process that connected halfway through someone else's
    // bootstrap would otherwise see a half-built schema and read it as a
    // database in need of migration. The loser of the race waits, then finds
    // every migration already applied.
    db.transaction(() => applyMigrations(db, migrations)).immediate();
    return;
  }
  const pending = pendingMigrations(db, migrations);
  if (pending.length > 0) throw new SchemaOutOfDateError({ label, path, pending });
}
