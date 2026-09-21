import { randomUUID } from 'crypto';
import {
  cpSync, existsSync, mkdirSync, renameSync, rmSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const BUNDLED_SKILL_NAMES = ['debrief', 'kb-workflow'];

export function installBundledSkills({
  home = homedir(),
  projectRoot,
  copy = cpSync,
  exists = existsSync,
  mkdir = mkdirSync,
  rename = renameSync,
  remove = rmSync,
} = {}) {
  if (!projectRoot) throw new Error('installBundledSkills requires projectRoot');

  const sourceRoot = join(projectRoot, 'skills');
  const destinationRoot = join(home, '.claude', 'skills');
  const results = [];
  const staged = [];
  const committed = [];
  try {
    for (const name of BUNDLED_SKILL_NAMES) {
      const destination = join(destinationRoot, name);
      if (exists(destination)) {
        results.push({ action: `Skill ${name} already present — left untouched`, path: destination });
        continue;
      }

      mkdir(destinationRoot, { recursive: true });
      const temporaryPath = `${destination}.kb-stage-${process.pid}-${randomUUID()}`;
      staged.push({ name, destination, temporaryPath });
      copy(join(sourceRoot, name), temporaryPath, { recursive: true });
    }

    for (const { name, destination, temporaryPath } of staged) {
      rename(temporaryPath, destination);
      committed.push(destination);
      results.push({ action: `Installed ${name} skill`, path: destination });
    }
    return results;
  } catch (error) {
    const cleanupErrors = [];
    for (const destination of committed.toReversed()) {
      try {
        remove(destination, { recursive: true, force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `Skill installation failed and rollback was incomplete: ${cleanupErrors.map(item => item.message).join('; ')}`,
      );
    }
    throw error;
  } finally {
    for (const { temporaryPath } of staged) {
      remove(temporaryPath, { recursive: true, force: true });
    }
  }
}
