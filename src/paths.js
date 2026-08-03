import 'dotenv/config';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';

export const KB_DIR = process.env.KB_DIR || join(homedir(), '.knowledge-base');
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
