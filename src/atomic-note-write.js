import { createHash, randomUUID } from 'crypto';
import {
  mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'fs';
import { basename, dirname, join } from 'path';
import { tmpdir, userInfo } from 'os';

const NOTE_LOCK_STALE_MS = 30_000;
const NOTE_LOCK_OWNER = typeof process.getuid === 'function'
  ? String(process.getuid())
  : createHash('sha256').update(userInfo().username).digest('hex').slice(0, 16);
const NOTE_LOCK_ROOT = join(tmpdir(), `kb-provider-note-locks-${NOTE_LOCK_OWNER}`);

export function noteWriteLockPath(path, lockRoot = NOTE_LOCK_ROOT) {
  const key = createHash('sha256').update(path).digest('hex');
  return join(lockRoot, key);
}

function claimStaleLock(lockPath) {
  const markerPath = join(lockPath, '.reaper');
  const token = randomUUID();
  try {
    writeFileSync(markerPath, token, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    if (err.code !== 'EEXIST') throw err;
    if (Date.now() - statSync(markerPath).mtimeMs < NOTE_LOCK_STALE_MS) {
      throw new Error('another provider write is in progress');
    }
    rmSync(markerPath, { force: true });
    try {
      writeFileSync(markerPath, token, { flag: 'wx', mode: 0o600 });
    } catch (retryError) {
      if (retryError.code === 'EEXIST' || retryError.code === 'ENOENT') {
        throw new Error('another provider write is in progress');
      }
      throw retryError;
    }
  }

  if (readFileSync(markerPath, 'utf8') !== token) {
    throw new Error('another provider write is in progress');
  }
  rmSync(lockPath, { recursive: true, force: true });
}

function acquireNoteLock(path, lockRoot) {
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const lockPath = noteWriteLockPath(path, lockRoot);
  try {
    mkdirSync(lockPath, { mode: 0o700 });
    return lockPath;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  try {
    if (Date.now() - statSync(lockPath).mtimeMs < NOTE_LOCK_STALE_MS) {
      throw new Error('another provider write is in progress');
    }
    claimStaleLock(lockPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  try {
    mkdirSync(lockPath, { mode: 0o700 });
    return lockPath;
  } catch (err) {
    if (err.code === 'EEXIST') throw new Error('another provider write is in progress');
    throw err;
  }
}

function cleanupAbandonedTemps(path) {
  const prefix = `${basename(path)}.`;
  for (const entry of readdirSync(dirname(path))) {
    if (!entry.startsWith(prefix) || !/\.\d+\.[0-9a-f-]{36}\.tmp$/.test(entry)) continue;
    const temporaryPath = join(dirname(path), entry);
    if (Date.now() - statSync(temporaryPath).mtimeMs >= NOTE_LOCK_STALE_MS) {
      rmSync(temporaryPath, { force: true });
    }
  }
}

export function replaceNoteIfUnchanged(path, expected, replacement, {
  lockRoot = NOTE_LOCK_ROOT,
} = {}) {
  const lockPath = acquireNoteLock(path, lockRoot);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    cleanupAbandonedTemps(path);
    const mode = statSync(path).mode & 0o777;
    writeFileSync(temporaryPath, replacement, { flag: 'wx', mode });
    if (readFileSync(path, 'utf8') !== expected) {
      throw new Error('note changed while provider call was in flight');
    }
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
    rmSync(lockPath, { recursive: true, force: true });
  }
}
