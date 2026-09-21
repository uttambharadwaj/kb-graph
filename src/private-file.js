import { randomUUID } from 'crypto';
import {
  chmodSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'fs';

export const PRIVATE_FILE_MODE = 0o600;

function assertNotSymbolicLink(path) {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`refusing to replace secret-bearing symbolic link: ${path}`);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

function privateTemporaryPath(path) {
  return `${path}.kb-private-${process.pid}-${randomUUID()}.tmp`;
}

export function writePrivateFile(path, content) {
  assertNotSymbolicLink(path);
  const temporaryPath = privateTemporaryPath(path);
  let operationError;
  let committed = false;
  try {
    writeFileSync(temporaryPath, content, {
      flag: 'wx',
      mode: PRIVATE_FILE_MODE,
    });
    chmodSync(temporaryPath, PRIVATE_FILE_MODE);
    assertNotSymbolicLink(path);
    renameSync(temporaryPath, path);
    committed = true;
  } catch (err) {
    operationError = err;
    throw err;
  } finally {
    if (!committed) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch (err) {
        if (!operationError) throw err;
      }
    }
  }
}

function privateWriteError(operationError, secondaryErrors) {
  if (secondaryErrors.length === 0) return operationError;
  return new AggregateError(
    [operationError, ...secondaryErrors],
    `Private file batch failed; rollback or cleanup also failed: ${secondaryErrors.map(err => err.message).join('; ')}`,
  );
}

/**
 * Atomically replace a group of private files as one best-effort transaction.
 *
 * Every output is staged before the first target rename. If a later rename
 * fails, targets already replaced are restored from their original bytes (or
 * removed if they did not exist). Filesystem rollback cannot itself be atomic,
 * so rollback failures are returned alongside the original error.
 */
export function writePrivateFiles(files, {
  chmod = chmodSync,
  readFile = readFileSync,
  rename = renameSync,
  remove = rmSync,
  writeFile = writeFileSync,
} = {}) {
  const paths = files.map(file => file.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error('Private file batch contains duplicate target paths');
  }

  const entries = files.map(file => {
    assertNotSymbolicLink(file.path);
    let original;
    try {
      original = { existed: true, originalContent: readFile(file.path) };
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      original = { existed: false, originalContent: null };
    }
    return {
      ...file,
      ...original,
      temporaryPath: privateTemporaryPath(file.path),
    };
  });
  const staged = [];
  const committed = [];
  let operationError = null;
  const secondaryErrors = [];

  try {
    for (const entry of entries) {
      staged.push(entry);
      writeFile(entry.temporaryPath, entry.content, {
        flag: 'wx',
        mode: PRIVATE_FILE_MODE,
      });
      chmod(entry.temporaryPath, PRIVATE_FILE_MODE);
    }

    // Close the symlink race window created while staging without touching any
    // target until every path has passed the second inspection.
    for (const entry of entries) assertNotSymbolicLink(entry.path);

    for (const entry of entries) {
      rename(entry.temporaryPath, entry.path);
      committed.push(entry);
    }
  } catch (err) {
    operationError = err;
    for (const entry of committed.reverse()) {
      try {
        if (!entry.existed) {
          remove(entry.path, { force: true });
          continue;
        }
        const rollbackPath = privateTemporaryPath(entry.path);
        try {
          writeFile(rollbackPath, entry.originalContent, {
            flag: 'wx',
            mode: PRIVATE_FILE_MODE,
          });
          chmod(rollbackPath, PRIVATE_FILE_MODE);
          rename(rollbackPath, entry.path);
        } finally {
          remove(rollbackPath, { force: true });
        }
      } catch (rollbackError) {
        secondaryErrors.push(rollbackError);
      }
    }
  } finally {
    for (const entry of staged) {
      try {
        remove(entry.temporaryPath, { force: true });
      } catch (cleanupError) {
        secondaryErrors.push(cleanupError);
      }
    }
  }

  if (operationError) throw privateWriteError(operationError, secondaryErrors);
  if (secondaryErrors.length > 0) {
    throw new AggregateError(secondaryErrors, 'Private file batch cleanup failed');
  }
}
