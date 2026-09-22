import './helpers/tmp-kb.js';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  renameSync, statSync, symlinkSync, writeFileSync,
} from 'fs';
import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_PATH, KB_DIR } from '../src/paths.js';
import { setPassword } from '../src/auth.js';
import * as setup from '../src/cli/setup.js';
import { writePrivateFile, writePrivateFiles } from '../src/private-file.js';

const REPO_ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

function modeOf(path) {
  return statSync(path).mode & 0o777;
}

test('setup writes new and existing secret env files with owner-only permissions', () => {
  assert.equal(typeof setup.writeSetupEnv, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'kb-private-env-'));
  const path = join(dir, '.env');

  const previousUmask = process.umask(0o000);
  try {
    setup.writeSetupEnv(path, 'KB_PASSWORD=first-secret\n');
    assert.equal(readFileSync(path, 'utf8'), 'KB_PASSWORD=first-secret\n');
    assert.equal(modeOf(path), 0o600);

    chmodSync(path, 0o666);
    setup.writeSetupEnv(path, 'KB_PASSWORD=new-secret\n');
  } finally {
    process.umask(previousUmask);
  }

  assert.equal(readFileSync(path, 'utf8'), 'KB_PASSWORD=new-secret\n');
  assert.equal(modeOf(path), 0o600);

  const restrictedPath = join(dir, '.env-restrictive-umask');
  const beforeRestrictedWrite = process.umask(0o277);
  try {
    setup.writeSetupEnv(restrictedPath, 'KB_PASSWORD=restricted-secret\n');
  } finally {
    process.umask(beforeRestrictedWrite);
  }
  assert.equal(modeOf(restrictedPath), 0o600);
});

test('password provisioning creates and repairs config.json with owner-only permissions', () => {
  const previousUmask = process.umask(0o000);
  try {
    setPassword('initial-dashboard-secret');
    assert.equal(modeOf(CONFIG_PATH), 0o600);

    writeFileSync(CONFIG_PATH, '{"other":"preserved"}\n');
    chmodSync(CONFIG_PATH, 0o666);
    setPassword('dashboard-secret');
  } finally {
    process.umask(previousUmask);
  }

  assert.equal(modeOf(CONFIG_PATH), 0o600);
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  assert.equal(config.other, 'preserved');
  assert.match(config.passwordHash, /^\$2[aby]\$/);
});

test('setup summary never renders passwords or API keys', () => {
  assert.equal(typeof setup.formatSetupSummary, 'function');
  const text = setup.formatSetupSummary({
    steps: [],
    cfg: {
      port: 3838,
      password: 'dashboard-secret',
      vaultPath: '/tmp/vault',
      agents: ['claude'],
      deploy: 'manual',
      apiKeys: { claude: 'agent-api-secret' },
    },
  });

  assert.doesNotMatch(text, /dashboard-secret|agent-api-secret/);
  assert.match(text, new RegExp(`Credentials:\\s+stored in ${join(KB_DIR, '.env')}`));
});

test('setup next steps use the source entrypoint when run from a checkout', () => {
  assert.equal(setup.setupCliCommand({
    argvPath: '/workspace/kb-graph/bin/kb.js',
    projectRoot: '/workspace/kb-graph',
    cwd: '/workspace/kb-graph',
  }), 'node bin/kb.js');

  const text = setup.formatSetupSummary({
    steps: [],
    ingestPath: '/tmp/vault with spaces',
    cfg: { port: 3838, vaultPath: '/tmp/vault with spaces', agents: [], deploy: 'manual' },
  }, { cliCommand: 'node bin/kb.js' });

  assert.match(text, /Run: node bin\/kb\.js ingest '\/tmp\/vault with spaces'/);
  assert.match(text, /Run: node bin\/kb\.js start/);
});

test('setup next steps keep the global kb command for installed shims', () => {
  assert.equal(setup.setupCliCommand({
    argvPath: '/usr/local/bin/kb',
    projectRoot: '/usr/local/lib/node_modules/kb-graph',
    cwd: '/tmp',
  }), 'kb');
  assert.equal(setup.setupCliCommand({
    argvPath: '/usr/local/lib/node_modules/kb-graph/bin/kb.js',
    projectRoot: '/usr/local/lib/node_modules/kb-graph',
    cwd: '/tmp',
  }), 'kb');

  const text = setup.formatSetupSummary({
    steps: [],
    cfg: { port: 3838, vaultPath: '', agents: [], deploy: 'manual' },
  }, { cliCommand: 'kb' });

  assert.match(text, /Run: kb start/);
  assert.doesNotMatch(text, /node bin\/kb\.js/);
});

test('a node_modules ancestor does not make a source checkout look globally installed', () => {
  const projectRoot = '/workspace/node_modules/source-checkouts/kb-graph';
  assert.equal(setup.setupCliCommand({
    argvPath: `${projectRoot}/bin/kb.js`,
    projectRoot,
    cwd: projectRoot,
  }), 'node bin/kb.js');
});

test('setup summary does not label refused steps as done', () => {
  const text = setup.formatSetupSummary({
    steps: [{
      action: 'Refused to move the MCP registration for cursor',
      error: 'points at another checkout',
    }],
    cfg: { port: 3838, vaultPath: '', agents: ['cursor'], deploy: 'manual' },
  }, { cliCommand: 'kb' });

  assert.match(text, /\[warning\] Refused to move the MCP registration for cursor/);
  assert.doesNotMatch(text, /\[done\] Refused to move/);
});

test('interactive secret prompts do not render their default value', async () => {
  assert.equal(typeof setup.askSecret, 'function');
  let renderedQuestion = '';
  const rl = new EventEmitter();
  rl.output = new EventEmitter();
  rl.output.write = (_value, callback) => callback?.();
  rl._writeToOutput = () => {};
  rl.question = (question, answer) => {
    renderedQuestion = question;
    answer('');
  };
  rl.close = () => rl.emit('close');

  assert.equal(await setup.askSecret(rl, 'Dashboard password', 'generated-secret'), 'generated-secret');
  assert.doesNotMatch(renderedQuestion, /generated-secret/);
  assert.match(renderedQuestion, /leave blank to keep or generate/i);
});

test('interactive secret prompts suppress typed input and restore output', async () => {
  const writes = [];
  let submit;
  const originalWrite = function originalWrite(value) {
    writes.push(value);
  };
  const rl = new EventEmitter();
  rl.output = new EventEmitter();
  rl.output.write = (value, callback) => {
    writes.push(value);
    callback?.();
  };
  rl._writeToOutput = originalWrite;
  rl.question = function question(value, answer) {
    this._writeToOutput(value);
    submit = answer;
  };
  rl.close = () => rl.emit('close');

  const result = setup.askSecret(rl, 'Dashboard password', 'generated-secret');
  rl._writeToOutput('typed-dashboard-secret');
  rl._writeToOutput('\n');
  submit('typed-dashboard-secret');

  assert.equal(await result, 'typed-dashboard-secret');
  assert.doesNotMatch(writes.join(''), /typed-dashboard-secret/);
  assert.equal(writes.filter(value => value === '\n').length, 1);
  assert.equal(rl._writeToOutput, originalWrite);
});

test('interactive secret prompts fail closed when output cannot be muted', () => {
  const rl = {
    question() {
      assert.fail('question must not run when secret input would be echoed');
    },
  };

  assert.throws(
    () => setup.askSecret(rl, 'Dashboard password', 'generated-secret'),
    /cannot securely prompt/,
  );
});

test('private-write crash artifacts are excluded from Git and package contents', () => {
  const gitignore = readFileSync(fileURLToPath(new URL('../.gitignore', import.meta.url)), 'utf8');
  assert.match(gitignore, /^\*\.kb-private-\*\.tmp$/m);

  const artifact = join(REPO_ROOT, `.env.kb-private-${process.pid}-test.tmp`);
  writeFileSync(artifact, 'KB_PASSWORD=must-not-ship\n', { mode: 0o600 });
  try {
    const gitStatus = execFileSync(
      'git',
      ['status', '--short', '--untracked-files=all', '--', artifact],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    assert.equal(gitStatus, '');

    const packed = JSON.parse(execFileSync(
      'npm',
      ['pack', '--dry-run', '--json'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    ));
    assert.equal(packed.length, 1);
    assert.ok(Array.isArray(packed[0].files));
    const files = packed[0].files.map(file => file.path);
    assert.ok(!files.includes(artifact.slice(REPO_ROOT.length + 1)));
  } finally {
    rmSync(artifact, { force: true });
  }
});

test('setup production paths use the private writer and redacted output', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/cli/setup.js', import.meta.url)), 'utf8');
  assert.match(source, /writeSetupEnv\(envPath, envContent\)/);
  assert.match(source, /askSecret\(rl, 'Dashboard password', randomPw\)/);
  assert.match(source, /out\(formatSetupSummary\(results\)\)/);

  const authSource = readFileSync(fileURLToPath(new URL('../src/auth.js', import.meta.url)), 'utf8');
  assert.match(authSource, /await askHidden\(rl, 'Set dashboard password: ', '', \{ trim: false \}\)/);
});

test('private writes refuse to replace a symbolic link silently', {
  skip: process.platform === 'win32',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-private-symlink-'));
  const target = join(dir, 'target.env');
  const path = join(dir, '.env');
  writeFileSync(target, 'KB_PASSWORD=old-secret\n');
  chmodSync(target, 0o644);
  symlinkSync(target, path);

  assert.throws(
    () => setup.writeSetupEnv(path, 'KB_PASSWORD=new-secret\n'),
    /symbolic link/,
  );
  assert.equal(lstatSync(path).isSymbolicLink(), true);
  assert.equal(readFileSync(target, 'utf8'), 'KB_PASSWORD=old-secret\n');
  assert.equal(modeOf(target), 0o644);
});

test('private writes also refuse dangling symbolic links', {
  skip: process.platform === 'win32',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-private-dangling-symlink-'));
  const target = join(dir, 'missing-target.env');
  const path = join(dir, '.env');
  symlinkSync(target, path);

  assert.throws(
    () => setup.writeSetupEnv(path, 'KB_PASSWORD=new-secret\n'),
    /symbolic link/,
  );
  assert.equal(lstatSync(path).isSymbolicLink(), true);
});

test('password updates preserve malformed config instead of replacing it', () => {
  const malformed = '{"other":"must-survive"';
  writeFileSync(CONFIG_PATH, malformed);

  assert.throws(() => setPassword('dashboard-secret'), /parse|JSON|config/i);
  assert.equal(readFileSync(CONFIG_PATH, 'utf8'), malformed);
});

test('failed private-file commits remove temporary secret files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-private-failed-commit-'));
  const destination = join(dir, 'destination');
  mkdirSync(destination);

  assert.throws(() => writePrivateFile(destination, 'secret'));
  assert.deepEqual(
    readdirSync(dir).filter(name => name.includes('.kb-private-')),
    [],
  );
  assert.equal(statSync(destination).isDirectory(), true);
});

test('private-file batches stage every file before replacing any target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-private-batch-stage-'));
  const first = join(dir, 'first.json');
  const second = join(dir, 'second.json');
  writeFileSync(first, 'first-old');
  writeFileSync(second, 'second-old');
  let writes = 0;

  assert.throws(
    () => writePrivateFiles([
      { path: first, content: 'first-new' },
      { path: second, content: 'second-new' },
    ], {
      writeFile(path, content, options) {
        writes += 1;
        if (writes === 2) {
          writeFileSync(path, 'partial-secret', options);
          throw new Error('injected stage failure');
        }
        return writeFileSync(path, content, options);
      },
    }),
    /injected stage failure/,
  );

  assert.equal(readFileSync(first, 'utf8'), 'first-old');
  assert.equal(readFileSync(second, 'utf8'), 'second-old');
  assert.deepEqual(readdirSync(dir).sort(), ['first.json', 'second.json']);
});

test('private-file batches roll back an earlier replacement after a later commit failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-private-batch-rollback-'));
  const first = join(dir, 'first.json');
  const second = join(dir, 'second.json');
  writeFileSync(first, 'first-old');
  writeFileSync(second, 'second-old');
  let failed = false;

  assert.throws(
    () => writePrivateFiles([
      { path: first, content: 'first-new' },
      { path: second, content: 'second-new' },
    ], {
      rename(from, to) {
        if (!failed && to === second && from.includes('.kb-private-')) {
          failed = true;
          throw new Error('injected commit failure');
        }
        return renameSync(from, to);
      },
    }),
    /injected commit failure/,
  );

  assert.equal(readFileSync(first, 'utf8'), 'first-old');
  assert.equal(readFileSync(second, 'utf8'), 'second-old');
  assert.deepEqual(readdirSync(dir).sort(), ['first.json', 'second.json']);
});

test('private-file batch rollback deletes a target that did not previously exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-private-batch-rollback-new-'));
  const first = join(dir, 'first.json');
  const second = join(dir, 'second.json');
  writeFileSync(second, 'second-old');
  let failed = false;

  assert.throws(
    () => writePrivateFiles([
      { path: first, content: 'first-new' },
      { path: second, content: 'second-new' },
    ], {
      rename(from, to) {
        if (!failed && to === second && from.includes('.kb-private-')) {
          failed = true;
          throw new Error('injected commit failure');
        }
        return renameSync(from, to);
      },
    }),
    /injected commit failure/,
  );

  assert.equal(existsSync(first), false);
  assert.equal(readFileSync(second, 'utf8'), 'second-old');
  assert.deepEqual(readdirSync(dir), ['second.json']);
});

test('private-file batches surface rollback failures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-private-batch-rollback-failure-'));
  const first = join(dir, 'first.json');
  const second = join(dir, 'second.json');
  writeFileSync(first, 'first-old');
  writeFileSync(second, 'second-old');
  let commitFailed = false;

  assert.throws(
    () => writePrivateFiles([
      { path: first, content: 'first-new' },
      { path: second, content: 'second-new' },
    ], {
      rename(from, to) {
        if (!commitFailed && to === second && from.includes('.kb-private-')) {
          commitFailed = true;
          throw new Error('injected commit failure');
        }
        if (commitFailed && to === first && from.includes('.kb-private-')) {
          throw new Error('injected rollback failure');
        }
        return renameSync(from, to);
      },
    }),
    err => err instanceof AggregateError
      && err.errors.some(cause => /commit failure/.test(cause.message))
      && err.errors.some(cause => /rollback failure/.test(cause.message)),
  );
  assert.deepEqual(
    readdirSync(dir).filter(name => name.includes('.kb-private-')),
    [],
  );
});
