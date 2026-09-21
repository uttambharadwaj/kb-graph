import { config as loadDotEnv } from 'dotenv';
import { homedir } from 'os';
import { join, resolve } from 'path';

export const DEFAULT_KB_DIR = join(homedir(), '.knowledge-base');
export const ACTIVE_KB_DIR = resolve(process.env.KB_DIR || DEFAULT_KB_DIR);

export function loadKbEnv({
  kbDir = ACTIVE_KB_DIR,
  cwd = process.cwd(),
  load = loadDotEnv,
} = {}) {
  const statePath = join(kbDir, '.env');
  const legacyPath = resolve(cwd, '.env');

  load({ path: statePath, quiet: true });
  if (resolve(statePath) !== legacyPath) {
    // Source installs historically kept .env in the checkout. Load it only
    // after the durable state file so an unrelated cwd cannot replace config.
    load({ path: legacyPath, quiet: true });
  }
  // KB_DIR selects which .env to load, so a KB_DIR inside either loaded file
  // cannot retroactively select a different store for child processes.
  process.env.KB_DIR = kbDir;

  return { statePath, legacyPath };
}

loadKbEnv();
