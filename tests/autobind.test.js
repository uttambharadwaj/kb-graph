import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { autobind, findTicketInPath, findTicketInGitBranch } from '../src/bus/autobind.js';
import { readBusBinding } from '../src/bus/context.js';

const tempDirs = [];

function makeBusHome() {
  const dir = mkdtempSync(join(tmpdir(), 'kb-bus-autobind-'));
  tempDirs.push(dir);
  process.env.KB_BUS_HOME = dir;
  return dir;
}

function makeWorkspace(path) {
  const root = mkdtempSync(join(tmpdir(), 'kb-autobind-ws-'));
  tempDirs.push(root);
  const full = join(root, path);
  mkdirSync(full, { recursive: true });
  return { root, full };
}

afterEach(() => {
  delete process.env.KB_BUS_HOME;
  delete process.env.CLAUDE_BUS_ROLE;
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('autobind', () => {
  it('extracts ticket from cwd path and binds at the matching ancestor', () => {
    makeBusHome();
    const { full } = makeWorkspace('worktrees/pf-1999-auto-test/src/bus');

    const result = autobind({ agent: 'claude', cwd: full });
    assert.strictEqual(result.bound, true);
    assert.strictEqual(result.channel, 'ws:pf-1999');
    assert.strictEqual(result.reader, 'claude:operator');
    assert.strictEqual(result.source, 'path');
    assert.match(result.cwd, /pf-1999-auto-test$/);

    const resolved = readBusBinding({ agent: 'claude', cwd: full });
    assert.strictEqual(resolved.subscriptions[0].channel, 'ws:pf-1999');
  });

  it('uses CLAUDE_BUS_ROLE env var for reader when set', () => {
    makeBusHome();
    process.env.CLAUDE_BUS_ROLE = 'architect';
    const { full } = makeWorkspace('worktrees/pf-2000-env/src');

    const result = autobind({ agent: 'claude', cwd: full });
    assert.strictEqual(result.reader, 'claude:architect');
  });

  it('returns no-ticket when path and git branch have no PF number', () => {
    makeBusHome();
    const { full } = makeWorkspace('generic/path/no-ticket');

    const result = autobind({ agent: 'claude', cwd: full });
    assert.strictEqual(result.bound, false);
    assert.strictEqual(result.reason, 'no-ticket');
  });

  it('skips when an ancestor binding already resolves', () => {
    makeBusHome();
    const { full } = makeWorkspace('worktrees/pf-3000-existing/src');
    autobind({ agent: 'claude', cwd: full });

    const second = autobind({ agent: 'claude', cwd: full });
    assert.strictEqual(second.bound, false);
    assert.strictEqual(second.reason, 'existing-binding');
  });

  it('falls back to git branch when path has no ticket', () => {
    makeBusHome();
    const { full } = makeWorkspace('generic/repo');
    execFileSync('git', ['-C', full, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', ['-C', full, 'checkout', '-q', '-b', 'uttam/pf-4000-branch-ticket'], {
      stdio: 'ignore',
    });
    execFileSync('git', ['-C', full, 'commit', '-q', '--allow-empty', '-m', 'seed', '--no-gpg-sign'], {
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });

    const match = findTicketInGitBranch(full);
    assert.ok(match);
    assert.strictEqual(match.ticket, '4000');

    const result = autobind({ agent: 'claude', cwd: full });
    assert.strictEqual(result.bound, true);
    assert.strictEqual(result.channel, 'ws:pf-4000');
    assert.strictEqual(result.source, 'git-branch');
  });

  it('findTicketInPath walks ancestors and returns first match', () => {
    const { full } = makeWorkspace('worktrees/pf-5000-deep/nested/subdir');
    const match = findTicketInPath(full);
    assert.ok(match);
    assert.strictEqual(match.ticket, '5000');
    assert.match(match.anchor, /pf-5000-deep$/);
  });

  it('is case-insensitive on the ticket regex', () => {
    const { full } = makeWorkspace('worktrees/PF-6000-UPPER');
    const match = findTicketInPath(full);
    assert.ok(match);
    assert.strictEqual(match.ticket, '6000');
  });

  it('stays quiet when invoked from a hook', () => {
    makeBusHome();
    const { full } = makeWorkspace('worktrees/pf-7000-hook-mode/src');

    const stdout = execFileSync('node', [
      'bin/bus-autobind.js',
      '--agent',
      'claude',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: JSON.stringify({ cwd: full, hook_event_name: 'SessionStart' }),
      env: { ...process.env, KB_BUS_HOME: process.env.KB_BUS_HOME },
    });

    assert.strictEqual(stdout, '');
  });

  it('keeps CLI JSON output when not invoked from a hook', () => {
    makeBusHome();
    const { full } = makeWorkspace('worktrees/pf-8000-cli-mode/src');

    const stdout = execFileSync('node', [
      'bin/bus-autobind.js',
      '--agent',
      'claude',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, KB_BUS_HOME: process.env.KB_BUS_HOME },
    });

    const result = JSON.parse(stdout);
    assert.strictEqual(result.bound, false);
    assert.strictEqual(result.reason, 'no-ticket');
  });
});

describe('configurable ticket regex', () => {
  afterEach(() => { delete process.env.KB_TICKET_REGEX; });

  it('custom regex matches custom ticket style', () => {
    process.env.KB_TICKET_REGEX = 'jira-(\\d+)';
    const hit = findTicketInPath('/tmp/work/jira-123-fix');
    assert.strictEqual(hit.ticket, '123');
    assert.strictEqual(hit.matched.toLowerCase(), 'jira-123');
  });

  it('regex without capture group uses full match as ticket', () => {
    process.env.KB_TICKET_REGEX = 'ticket_[a-z]+';
    const hit = findTicketInPath('/tmp/work/ticket_abc');
    assert.strictEqual(hit.ticket, 'ticket_abc');
  });

  it('invalid regex falls back to default pf pattern', () => {
    process.env.KB_TICKET_REGEX = '(';
    const hit = findTicketInPath('/tmp/work/pf-777');
    assert.strictEqual(hit.ticket, '777');
  });

  it('default channel derivation is unchanged', () => {
    makeBusHome();
    const { full } = makeWorkspace('worktrees/pf-1234-default-channel/src');

    const result = autobind({ agent: 'claude', cwd: full });
    assert.strictEqual(result.bound, true);
    assert.strictEqual(result.channel, 'ws:pf-1234');
  });
});
