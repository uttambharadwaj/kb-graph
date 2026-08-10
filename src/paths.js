import 'dotenv/config';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';

// tests/helpers/tmp-kb.js checks this to prove it ran before we did.
globalThis.__KB_PATHS_LOADED__ = true;

const REAL_DEFAULT_KB_DIR = join(homedir(), '.knowledge-base');
export const KB_DIR = process.env.KB_DIR || REAL_DEFAULT_KB_DIR;

// ESM evaluates a module's imports before its own top-level code, regardless
// of source position, so "set env before the import" fixtures run too late.
// A test process (NODE_TEST_CONTEXT) must never resolve the real KB dir.
// NODE_TEST_CONTEXT is an undocumented node:test internal (Node 22: "child-v8");
// if a Node upgrade renames it this check silently disarms — tmp-kb.js's
// load-order flag is the version-independent backstop.
if (process.env.NODE_TEST_CONTEXT && KB_DIR === REAL_DEFAULT_KB_DIR) {
  throw new Error(
    'kb-graph: test process resolved KB_DIR to the real ~/.knowledge-base. ' +
    'A src module was likely imported before tests/helpers/tmp-kb.js set ' +
    'process.env.KB_DIR — import that helper as the first import statement ' +
    'in the test file (ESM evaluates import subtrees before the importing ' +
    "module's own code, so source position alone doesn't fix this)."
  );
}

export const FILES_DIR = join(KB_DIR, 'files');
// Job logs live with the data, not in /tmp. A weekly job's log sits untouched
// for seven days, which is long enough for the platform's temp reaper to delete
// it — so the job whose failures are hardest to notice was the only one that
// never had a log left to read.
export const LOGS_DIR = join(KB_DIR, 'logs');
export const DB_PATH = join(KB_DIR, 'kb.db');
export const CONFIG_PATH = join(KB_DIR, 'config.json');
export const PID_PATH = join(KB_DIR, 'kb.pid');

mkdirSync(FILES_DIR, { recursive: true });
