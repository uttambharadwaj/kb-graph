// tests/setup-hooks.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mergeClaudeHooks, installClaudeHooks } from '../src/cli/setup-hooks.js';

const OPTS = { nodeBin: '/usr/local/bin/node', kbJsPath: '/opt/kb/bin/kb.js' };

test('mergeClaudeHooks adds SessionStart and UserPromptSubmit entries', () => {
  const merged = mergeClaudeHooks({}, OPTS);
  const ss = merged.hooks.SessionStart;
  const ups = merged.hooks.UserPromptSubmit;
  assert.equal(ss.length, 1);
  assert.equal(ss[0].matcher, 'startup|resume|clear|compact');
  assert.equal(ss[0].hooks[0].command, '/usr/local/bin/node /opt/kb/bin/kb.js wakeup-hook');
  assert.equal(ups.length, 1);
  assert.equal(ups[0].matcher, undefined);
  assert.equal(ups[0].hooks[0].command, '/usr/local/bin/node /opt/kb/bin/kb.js prompt-hint');
});

test('mergeClaudeHooks is idempotent', () => {
  const once = mergeClaudeHooks({}, OPTS);
  const twice = mergeClaudeHooks(once, OPTS);
  assert.deepEqual(twice, once);
});

test('mergeClaudeHooks detects existing hooks with different node paths', () => {
  const existing = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/opt/homebrew/bin/node /somewhere/else/kb.js wakeup-hook' }] }] } };
  const merged = mergeClaudeHooks(existing, OPTS);
  assert.equal(merged.hooks.SessionStart.length, 1); // not duplicated
  assert.equal(merged.hooks.UserPromptSubmit.length, 1); // still added
});

test('mergeClaudeHooks preserves unrelated settings and hooks', () => {
  const existing = {
    model: 'opus',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] },
  };
  const merged = mergeClaudeHooks(existing, OPTS);
  assert.equal(merged.model, 'opus');
  assert.equal(merged.hooks.Stop[0].hooks[0].command, 'echo bye');
  assert.notEqual(merged, existing); // did not mutate input
  assert.equal(existing.hooks.SessionStart, undefined);
});

test('installClaudeHooks throws a named error on malformed settings.json and leaves it untouched', () => {
  const home = mkdtempSync(join(tmpdir(), 'kbhooks-'));
  const dir = join(home, '.claude');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'settings.json');
  writeFileSync(path, '{ not json');
  assert.throws(() => installClaudeHooks({ home, ...OPTS }), err => err.message.includes(path));
  assert.equal(readFileSync(path, 'utf8'), '{ not json'); // no write, no backup mangling
  assert.equal(existsSync(`${path}.kb-backup`), false);
});

test('installClaudeHooks leaves no temp file behind', () => {
  const home = mkdtempSync(join(tmpdir(), 'kbhooks-'));
  const { path } = installClaudeHooks({ home, ...OPTS });
  assert.equal(existsSync(`${path}.kb-tmp`), false);
});

test('installClaudeHooks creates settings.json when absent, backs up when present', () => {
  const home = mkdtempSync(join(tmpdir(), 'kbhooks-'));
  const first = installClaudeHooks({ home, ...OPTS });
  assert.equal(first.backup, null);
  const settings = JSON.parse(readFileSync(first.path, 'utf8'));
  assert.equal(settings.hooks.SessionStart.length, 1);

  const second = installClaudeHooks({ home, ...OPTS });
  assert.ok(existsSync(second.backup));
  const after = JSON.parse(readFileSync(second.path, 'utf8'));
  assert.equal(after.hooks.SessionStart.length, 1); // idempotent on disk too
});
