import { randomUUID } from 'crypto';
import {
  chmodSync, lstatSync, renameSync, rmSync, writeFileSync,
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

export function writePrivateFile(path, content) {
  assertNotSymbolicLink(path);
  const temporaryPath = `${path}.kb-private-${process.pid}-${randomUUID()}.tmp`;
  let operationError;
  try {
    writeFileSync(temporaryPath, content, {
      flag: 'wx',
      mode: PRIVATE_FILE_MODE,
    });
    chmodSync(temporaryPath, PRIVATE_FILE_MODE);
    assertNotSymbolicLink(path);
    renameSync(temporaryPath, path);
  } catch (err) {
    operationError = err;
    throw err;
  } finally {
    try {
      rmSync(temporaryPath, { force: true });
    } catch (err) {
      if (!operationError) throw err;
    }
  }
}
