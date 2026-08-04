// Does the code on disk need a migration the databases have not had?
//
// The MCP supervisor replaces its child as soon as src/ changes. When the new
// code carries a migration, that child's `ensureSchemaReady` correctly refuses
// to open the database and the session loses every tool until someone runs
// `kb migrate`. Failing closed is right; doing it after killing a healthy
// server is what turns a one-command chore into an outage. This is the check
// that is free at the only moment it is worth making — before the swap.

import { spawnSync } from 'child_process';
import { statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { MIGRATION_TARGETS } from './migration-targets.js';
import { PENDING_EXIT } from './schema.js';

const KB_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kb.js');
// Past this a check is not going to answer, and the swap it holds up matters
// more than its verdict.
const CHECK_TIMEOUT_MS = 10000;

const stamp = (file) => {
  try {
    const { mtimeMs, size } = statSync(file);
    return `${mtimeMs}:${size}`;
  } catch {
    return 'absent';
  }
};

// The sidecars, not just the database: a migration committed through WAL leaves
// the main file's mtime and size untouched until some later checkpoint, so a
// gate watching that alone would never see `kb migrate` happen and would hold
// the swap forever.
const dbFiles = (target) => {
  const file = target.db();
  return [file, `${file}-wal`, `${file}-shm`];
};

const fingerprint = (files) => files.map(stamp).join('|');

const oneLine = (text) => (text || '').trim().split('\n').map(line => line.trim()).filter(Boolean).join('; ');

/**
 * Run `kb migrate --check` and return a one-line summary of what is behind, or
 * null when nothing is. `checked` is false when the check could not be run at
 * all, which is not the same answer as "nothing is pending".
 *
 * A subprocess rather than a dynamic import because the caller is, by
 * definition, running the old code: node caches every module at import, so
 * evaluating a new migration list needs a new process. Running the operator's
 * own command means the gate and the operator cannot disagree about what
 * "behind" means, and whatever the command prints is what gets reported.
 */
export function runMigrationCheck(kbBin = KB_BIN) {
  const done = spawnSync(process.execPath, [kbBin, 'migrate', '--check'], {
    encoding: 'utf8',
    timeout: CHECK_TIMEOUT_MS,
    // The verdict has to be about the runtime the child will actually be
    // spawned with, which is this one. Re-execing into another node would
    // answer for a process nobody is going to start.
    env: { ...process.env, KB_SKIP_NODE_REEXEC: '1' },
  });
  if (done.status === 0) return { checked: true, summary: null };
  if (done.status === PENDING_EXIT) {
    return { checked: true, summary: oneLine(done.stdout) || 'a database is behind this code' };
  }
  // Fail open. The server's own fail-closed guard is the real safety net; a
  // gate that blocked every reload because it could not run would cause the
  // outage it exists to prevent.
  const why = done.error?.message ?? `exit ${done.status ?? done.signal}`;
  const detail = oneLine(done.stderr);
  console.error(`[KB] migration pre-check did not run (${why}${detail ? `: ${detail}` : ''}); reloading anyway`);
  return { checked: false, summary: null };
}

/**
 * A `runMigrationCheck` that skips the subprocess when its answer cannot have
 * changed, so an ordinary reload pays a handful of stat calls rather than a
 * process spawn, and a held swap can re-check as often as it likes.
 */
export function createMigrationGate({ targets = MIGRATION_TARGETS, run = runMigrationCheck } = {}) {
  let last = null;

  return () => {
    const sources = fingerprint(targets.map(target => target.source));
    if (last?.sources === sources) {
      // A clear verdict expires only when the code does. Writing rows never
      // un-applies a migration, and the databases are written to constantly by
      // the very server being gated — re-checking on that would spawn a process
      // per reload and answer the same thing every time.
      if (!last.summary) return null;
      // A pending one expires the moment either input moves. That is how
      // `kb migrate` releases a held swap.
      if (last.databases === fingerprint(targets.flatMap(dbFiles))) return last.summary;
    }
    // Snapshotted before the check runs, so a write that lands while it is
    // running is not recorded as one this verdict already accounts for.
    const databases = fingerprint(targets.flatMap(dbFiles));
    const { checked, summary } = run();
    // A check that could not run is not a verdict, and must not be cached as one.
    if (checked) last = { sources, databases, summary };
    return summary;
  };
}
