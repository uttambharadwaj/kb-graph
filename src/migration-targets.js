// Which databases have migrations, and where the lists that define them live.
//
// `source` is load-bearing, not documentation: the reload gate stats that file
// to tell "the code moved" from "the database moved", and loads the list from
// it rather than from a static import, so a target this file does not declare
// is one neither `kb migrate` nor the gate can see. One place to add the next
// database, instead of two that drift.

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { ensureBusStorage, getBusDbPath } from './bus/config.js';
import { DB_PATH } from './paths.js';

const SRC = dirname(fileURLToPath(import.meta.url));

export const MIGRATION_TARGETS = [
  {
    label: 'knowledge base',
    source: join(SRC, 'db.js'),
    db: () => DB_PATH,
    prepare: () => {},
  },
  {
    label: 'message bus',
    source: join(SRC, 'bus', 'db.js'),
    db: getBusDbPath,
    prepare: ensureBusStorage,
  },
];

// Imported on demand rather than at module load: the supervisor imports this
// file only to stat a couple of paths, and must not pay for the whole database
// layer to do it.
export async function migrationsFor(target) {
  const { MIGRATIONS } = await import(pathToFileURL(target.source).href);
  return MIGRATIONS;
}
