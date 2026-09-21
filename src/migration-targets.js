// Which databases have migrations, and where the lists that define them live.
//
// `source` is load-bearing, not documentation: `kb migrate` loads each target's
// migration list from it. A database omitted here cannot be managed by that
// command; its own startup path must still verify readiness independently.

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { DB_PATH } from './paths.js';

const SRC = dirname(fileURLToPath(import.meta.url));

export const MIGRATION_TARGETS = [
  {
    label: 'knowledge base',
    source: join(SRC, 'db.js'),
    db: () => DB_PATH,
    prepare: () => {},
  },
];

// Imported on demand so the migration command loads only the target it is
// inspecting or changing.
export async function migrationsFor(target) {
  const { MIGRATIONS } = await import(pathToFileURL(target.source).href);
  return MIGRATIONS;
}
