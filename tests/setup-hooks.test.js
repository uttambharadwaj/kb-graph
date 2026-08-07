// tests/setup-hooks.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mergeClaudeHooks, installClaudeHooks , unresolvableHookCommands } from '../src/cli/setup-hooks.js';

const OPTS = { nodeBin: '/usr/local/bin/node', kbJsPath: '/opt/kb/bin/kb.js' };

test('mergeClaudeHooks adds SessionStart, UserPromptSubmit and PreToolUse entries', () => {
  const merged = mergeClaudeHooks({}, OPTS);
  const ss = merged.hooks.SessionStart;
  const ups = merged.hooks.UserPromptSubmit;
  const ptu = merged.hooks.PreToolUse;
  assert.equal(ss.length, 1);
  assert.equal(ss[0].matcher, 'startup|resume|clear|compact');
  assert.equal(ss[0].hooks[0].command, '/usr/local/bin/node /opt/kb/bin/kb.js wakeup-hook');
  assert.equal(ups.length, 1);
  assert.equal(ups[0].matcher, undefined);
  assert.equal(ups[0].hooks[0].command, '/usr/local/bin/node /opt/kb/bin/kb.js prompt-hint');
  assert.equal(ptu.length, 1);
  assert.equal(ptu[0].matcher, 'Bash');
  // Script form, not the subcommand form: bin/kb-trigger-hook.js beside
  // bin/kb.js, not `kb.js trigger-hook` — see setup-hooks.js's HOOK_SPECS
  // comment for why this one hook skips bin/kb.js's dispatch machinery.
  assert.equal(ptu[0].hooks[0].command, '/usr/local/bin/node /opt/kb/bin/kb-trigger-hook.js');
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
  assert.equal(merged.hooks.PreToolUse.length, 1); // still added
});

// A real settings.json can already carry unrelated PreToolUse entries (e.g. a
// hand-written style-review reminder) with their own matcher — the dedup key
// is the spec's own identity (script filename here, subcommand elsewhere),
// not the event, so trigger-hook must land beside them rather than
// displacing or merging into them.
test('mergeClaudeHooks adds trigger-hook alongside an unrelated PreToolUse entry', () => {
  const existing = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: "echo 'style reminder'" }] }] } };
  const merged = mergeClaudeHooks(existing, OPTS);
  assert.equal(merged.hooks.PreToolUse.length, 2);
  assert.equal(merged.hooks.PreToolUse[0].hooks[0].command, "echo 'style reminder'");
  assert.equal(merged.hooks.PreToolUse[1].hooks[0].command, '/usr/local/bin/node /opt/kb/bin/kb-trigger-hook.js');
});

// The script form's dedup checks the command for the script's own filename,
// not a leading-space-prefixed token — since the full path is
// `<dir>/kb-trigger-hook.js`, a naive ` ${subcommand}`-style suffix check
// would never match it and every re-run would install a duplicate. Exercised
// here with the checkout directory itself differing between runs (e.g. a
// prior install from a dev checkout, now re-run from the deploy checkout),
// which the plain kbJsPath-equality the idempotency test above already
// covers would not catch.
test('mergeClaudeHooks recognizes an already-installed script hook even from a different checkout directory', () => {
  const existing = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/node /Users/dev/kb-checkout/bin/kb-trigger-hook.js' }] }] } };
  const merged = mergeClaudeHooks(existing, { nodeBin: '/usr/local/bin/node', kbJsPath: '/opt/kb/bin/kb.js' });
  assert.equal(merged.hooks.PreToolUse.length, 1, 'not duplicated even though the directory prefix differs');
});

// A4: a real prior commit of this stack installed the subcommand form
// (`kb.js trigger-hook`) before the thin entry existed. The PreToolUse spec
// now carries the subcommand alongside the script so a settings.json still
// holding that install is recognized too — without this, re-running setup
// on a machine that installed before the thin entry landed would install a
// SECOND PreToolUse hook rather than replacing or recognizing the first.
test('mergeClaudeHooks recognizes a legacy subcommand-form trigger-hook install and does not duplicate it', () => {
  const existing = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/node /opt/kb/bin/kb.js trigger-hook' }] }] } };
  const merged = mergeClaudeHooks(existing, OPTS);
  assert.equal(merged.hooks.PreToolUse.length, 1, 'the legacy install must be recognized, not duplicated');
  assert.equal(merged.hooks.PreToolUse[0].hooks[0].command, '/usr/local/bin/node /opt/kb/bin/kb.js trigger-hook', 'the legacy command is left as-is — only a fresh install writes the script form');
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

// A hook is fire-and-forget: the host runs it, ignores its output, and carries
// on. A command naming a path that has moved fails exactly like one with
// nothing to report, so nothing surfaces it until someone goes looking.
const hookSettings = (command, event = 'Stop') => ({ hooks: { [event]: [{ hooks: [{ type: 'command', command }] }] } });
const nothingExists = () => false;

test('reports a hook command whose own path is gone', () => {
  const found = unresolvableHookCommands(hookSettings('/gone/node /gone/kb.js wakeup-hook'), { exists: nothingExists });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].missing, ['/gone/node', '/gone/kb.js']);
  assert.equal(found[0].event, 'Stop');
});

test('says nothing when every hook path resolves', () => {
  assert.deepEqual(
    unresolvableHookCommands(hookSettings('/bin/node /opt/kb/bin/kb.js wakeup-hook'), { exists: () => true }), []);
});

// The real defect: the script the hook named existed, and the dead paths were
// the interpreter and target pinned inside it. A command-only check passes that
// install clean, which is exactly how it went unnoticed.
test('follows the script a hook names, because that is where the dead paths were', () => {
  const script = [
    '#!/bin/bash',
    'NODE="/opt/homebrew/Cellar/node@22/22.21.1_4/bin/node"',
    'HOOK="/Users/u/Documents/tf/repos/kb/bin/bus-hook-current.js"',
    '# see /Users/u/docs/design.md for why',   // a comment is documentation, not a dependency
  ].join('\n');
  const found = unresolvableHookCommands(hookSettings('/home/u/.claude/bus-stop-hook.sh claude'), {
    exists: (p) => p.endsWith('bus-stop-hook.sh'),
    read: () => script,
  });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].missing, [
    '/opt/homebrew/Cellar/node@22/22.21.1_4/bin/node',
    '/Users/u/Documents/tf/repos/kb/bin/bus-hook-current.js',
  ], 'a path in a comment must not be reported as a dependency');
});

// `/style-review` is a slash-command, not a path. Warning about it would train
// the reader to ignore the line that carries the real one.
test('does not mistake a slash-command for a path', () => {
  assert.deepEqual(
    unresolvableHookCommands(hookSettings('echo /style-review', 'PreToolUse'), { exists: nothingExists }), []);
});

// A Cellar path resolves right up until the package is upgraded, at which point
// every artifact holding one dies in the same hour. Reporting only what has
// already stopped resolving finds the corpse, never the pin.
test('reports a version-pinned path before it stops resolving', () => {
  const pinned = '/opt/homebrew/Cellar/node@22/22.23.1/bin/node';
  const found = unresolvableHookCommands(hookSettings(`${pinned} /opt/kb/bin/kb.js wakeup-hook`), { exists: () => true });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].missing, [], 'nothing is missing yet — that is the point');
  assert.deepEqual(found[0].pinned, [pinned]);
});

test('a version-stable symlink is not reported as pinned', () => {
  assert.deepEqual(
    unresolvableHookCommands(hookSettings('/opt/homebrew/opt/node@22/bin/node /opt/kb/bin/kb.js wakeup-hook'), { exists: () => true }),
    []);
});
