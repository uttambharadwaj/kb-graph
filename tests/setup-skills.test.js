import './helpers/tmp-kb.js';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, test } from 'node:test';
import { BUNDLED_SKILL_NAMES, installBundledSkills } from '../src/cli/setup-skills.js';

const roots = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kb-setup-skills-'));
  roots.push(root);
  const home = join(root, 'home');
  const projectRoot = join(root, 'package');
  for (const name of BUNDLED_SKILL_NAMES) {
    const source = join(projectRoot, 'skills', name);
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), `${name} canonical\n`);
  }
  return { home, projectRoot };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

test('installs the closed bundled skill set and reruns idempotently', () => {
  const { home, projectRoot } = fixture();

  const first = installBundledSkills({ home, projectRoot });
  const second = installBundledSkills({ home, projectRoot });

  assert.deepEqual(first.map(item => item.action), BUNDLED_SKILL_NAMES.map(name => `Installed ${name} skill`));
  assert.deepEqual(second.map(item => item.action), BUNDLED_SKILL_NAMES.map(name => `Skill ${name} already present — left untouched`));
});

test('preserves customized skills byte-for-byte', () => {
  const { home, projectRoot } = fixture();
  const destination = join(home, '.claude', 'skills', 'debrief', 'SKILL.md');
  mkdirSync(join(destination, '..'), { recursive: true });
  writeFileSync(destination, 'user customization\n');

  installBundledSkills({ home, projectRoot });

  assert.equal(readFileSync(destination, 'utf8'), 'user customization\n');
  assert.equal(
    readFileSync(join(home, '.claude', 'skills', 'kb-workflow', 'SKILL.md'), 'utf8'),
    'kb-workflow canonical\n',
  );
});

test('rolls back every newly installed skill when a later commit fails', () => {
  const { home, projectRoot } = fixture();
  let commits = 0;

  assert.throws(
    () => installBundledSkills({
      home,
      projectRoot,
      rename(from, to) {
        commits += 1;
        if (commits === 2) throw new Error('injected skill commit failure');
        renameSync(from, to);
      },
    }),
    /injected skill commit failure/,
  );

  for (const name of BUNDLED_SKILL_NAMES) {
    assert.equal(existsSync(join(home, '.claude', 'skills', name)), false);
  }
});

test('cleans a partially copied staging directory', () => {
  const { home, projectRoot } = fixture();
  const destinationRoot = join(home, '.claude', 'skills');

  assert.throws(
    () => installBundledSkills({
      home,
      projectRoot,
      copy(_source, destination) {
        mkdirSync(destination, { recursive: true });
        writeFileSync(join(destination, 'partial'), 'incomplete');
        throw new Error('injected copy failure');
      },
    }),
    /injected copy failure/,
  );

  assert.deepEqual(readdirSync(destinationRoot), []);
});
