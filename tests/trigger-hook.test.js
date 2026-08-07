// PreToolUse (Bash) hook: pure decision logic in decideAndRecord/
// buildTriggerMessage, plus one integration-ish pass through the real CLI
// entry point to exercise the marker-file/JSONL-log I/O it wraps.
import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decideAndRecord, buildTriggerMessage, MAX_SESSION_WARNINGS, TRIGGERS_LOG_DIR, TRIGGER_HOOK_ENABLED_FLAG } from '../src/cli/trigger-hook.js';
import { KB_DIR } from '../src/paths.js';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'run-hook.mjs');
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const THIN_BIN = join(REPO_ROOT, 'bin', 'kb-trigger-hook.js');

function runHook(hookInput, extraEnv = {}) {
  return execFileSync(process.execPath, [HELPER, 'trigger-hook'], {
    input: JSON.stringify(hookInput),
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
  });
}

const ENTRY = { id: 7, title: 'Force-delete branch', tier: 'observed', patterns: [{ parts: ['gh pr merge', '--delete-branch'], hits: 2, sessions: 1 }] };
const INDEX = [ENTRY];
const BASH = (command, extra = {}) => ({ session_id: 's1', tool_name: 'Bash', tool_input: { command }, cwd: '/x', ...extra });

describe('decideAndRecord — non-Bash / no-command calls are not the denominator', () => {
  it('returns null for a non-Bash tool', () => {
    assert.strictEqual(decideAndRecord({ tool_name: 'Read', tool_input: { file_path: '/x' } }, { index: INDEX }), null);
  });

  it('returns null when tool_input.command is missing', () => {
    assert.strictEqual(decideAndRecord({ tool_name: 'Bash', tool_input: {} }, { index: INDEX }), null);
  });

  it('returns null when tool_input.command is empty', () => {
    assert.strictEqual(decideAndRecord({ tool_name: 'Bash', tool_input: { command: '' } }, { index: INDEX }), null);
  });
});

describe('decideAndRecord — non-string tool_input.command never throws', () => {
  it('coerces an object command instead of throwing, and logs it', () => {
    const decision = decideAndRecord({ tool_name: 'Bash', tool_input: { command: { weird: 'shape' } } }, { index: INDEX, enabled: true });
    assert.ok(decision);
    const logged = JSON.parse(decision.logLine);
    assert.strictEqual(logged.command, '[object Object]');
  });

  it('coerces a numeric command instead of throwing', () => {
    assert.doesNotThrow(() => decideAndRecord({ tool_name: 'Bash', tool_input: { command: 12345 } }, { index: INDEX }));
  });
});

describe('decideAndRecord — building the warning', () => {
  it('fires and builds additionalContext for a matching command, with an observed note carrying no caveat', () => {
    const decision = decideAndRecord(BASH('gh pr merge 1 --delete-branch'), { index: INDEX, enabled: true });
    assert.strictEqual(decision.emit, true);
    assert.strictEqual(decision.firedId, 7);
    assert.strictEqual(
      decision.message,
      '⚠ KB TRIGGER: note #7 "Force-delete branch" may apply to this command — kb_read(7) before running it.',
    );
  });

  it('carries the unconfirmed-conclusion caveat for an inferred note', () => {
    const inferred = [{ ...ENTRY, tier: 'inferred' }];
    const decision = decideAndRecord(BASH('gh pr merge 1 --delete-branch'), { index: inferred, enabled: true });
    assert.match(decision.message, /\(⚠ unconfirmed model conclusion — treat as a lead\)/);
  });

  it('treats a missing/unknown tier the same as inferred', () => {
    const untiered = [{ id: 7, title: 'x', patterns: ENTRY.patterns }];
    const decision = decideAndRecord(BASH('gh pr merge 1 --delete-branch'), { index: untiered, enabled: true });
    assert.match(decision.message, /unconfirmed model conclusion/);
  });

  it('carries no caveat for a verified note', () => {
    const verified = [{ ...ENTRY, tier: 'verified' }];
    const decision = decideAndRecord(BASH('gh pr merge 1 --delete-branch'), { index: verified, enabled: true });
    assert.doesNotMatch(decision.message, /unconfirmed/);
  });

  it('buildTriggerMessage is the same function the decision uses', () => {
    assert.strictEqual(buildTriggerMessage(ENTRY), '⚠ KB TRIGGER: note #7 "Force-delete branch" may apply to this command — kb_read(7) before running it.');
  });
});

describe('decideAndRecord — declines are logged, never silently dropped', () => {
  it('a command with no index entries logs a decline (matched: []) and does not emit', () => {
    const decision = decideAndRecord(BASH('git status'), { index: [], enabled: true });
    assert.strictEqual(decision.emit, false);
    const logged = JSON.parse(decision.logLine);
    assert.deepStrictEqual(logged.matched, []);
    assert.strictEqual(logged.emitted, false);
  });

  it('a command that matches but is not enabled logs the match and never emits — log-only is the default', () => {
    const decision = decideAndRecord(BASH('gh pr merge 1 --delete-branch'), { index: INDEX, enabled: false });
    assert.strictEqual(decision.emit, false);
    assert.strictEqual(decision.message, null);
    const logged = JSON.parse(decision.logLine);
    assert.deepStrictEqual(logged.matched, [{ id: 7, hits: 2 }]);
    assert.strictEqual(logged.emitted, false);
  });
});

describe('decideAndRecord — session cap', () => {
  it(`never emits once the session marker already holds ${MAX_SESSION_WARNINGS} ids, but still logs the match`, () => {
    const decision = decideAndRecord(BASH('gh pr merge 1 --delete-branch'), { index: INDEX, enabled: true, fired: [1, 2] });
    assert.strictEqual(decision.emit, false);
    const logged = JSON.parse(decision.logLine);
    assert.deepStrictEqual(logged.matched, [{ id: 7, hits: 2 }]);
  });

  it('still emits with exactly one slot left under the cap', () => {
    const decision = decideAndRecord(BASH('gh pr merge 1 --delete-branch'), { index: INDEX, enabled: true, fired: [1] });
    assert.strictEqual(decision.emit, true);
  });
});

describe('decideAndRecord — dedupe: an id already in the marker never re-fires', () => {
  it('excludes an already-fired id from matches entirely', () => {
    const decision = decideAndRecord(BASH('gh pr merge 1 --delete-branch'), { index: INDEX, enabled: true, fired: [7] });
    assert.strictEqual(decision.emit, false);
    const logged = JSON.parse(decision.logLine);
    assert.deepStrictEqual(logged.matched, []);
  });
});

describe('decideAndRecord — one note per call, even when several match', () => {
  it('emits only the rarest of three matching notes', () => {
    const common = { id: 1, title: 'Common', tier: 'observed', patterns: [{ parts: ['gh pr merge'], hits: 50, sessions: 10 }] };
    const mid = { id: 2, title: 'Mid', tier: 'observed', patterns: [{ parts: ['gh pr merge', '--squash'], hits: 10, sessions: 4 }] };
    const rare = { id: 3, title: 'Rare', tier: 'observed', patterns: [{ parts: ['gh pr merge', '--delete-branch'], hits: 1, sessions: 1 }] };
    const decision = decideAndRecord(BASH('gh pr merge 1 --squash --delete-branch'), { index: [common, mid, rare], enabled: true });
    assert.strictEqual(decision.emit, true);
    assert.strictEqual(decision.firedId, 3);
    const logged = JSON.parse(decision.logLine);
    assert.strictEqual(logged.matched.length, 3, 'all three matches are logged even though only one fires');
  });
});

describe('decideAndRecord — command truncation in the log', () => {
  it('truncates a command longer than 2000 chars', () => {
    const long = 'echo ' + 'x'.repeat(3000);
    const decision = decideAndRecord(BASH(long), { index: [], enabled: true });
    const logged = JSON.parse(decision.logLine);
    assert.strictEqual(logged.command.length, 2000);
    assert.strictEqual(logged.command, long.slice(0, 2000));
  });

  it('leaves a short command untouched', () => {
    const decision = decideAndRecord(BASH('git status'), { index: [], enabled: true });
    assert.strictEqual(JSON.parse(decision.logLine).command, 'git status');
  });
});

describe('decideAndRecord — missing session_id still gets its own cap', () => {
  it('falls back to "unknown" and caps independently', () => {
    const decision = decideAndRecord({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 1 --delete-branch' } }, { index: INDEX, enabled: true });
    assert.strictEqual(decision.session, 'unknown');
    const logged = JSON.parse(decision.logLine);
    assert.strictEqual(logged.session, 'unknown');
  });
});

// The refactor guard: trigger-hook.js's index/matcher dependency is
// trigger-match.js, which must never import db.js (and therefore never load
// the better-sqlite3 native addon) — that module graph runs on every Bash
// call. Two layers: a static source check (stable, instant, catches the
// obvious case), and a dynamic one that actually imports trigger-hook.js in
// a fresh child process and inspects what landed in the CJS require cache
// (ESM's interop with a native CJS addon like better-sqlite3 goes through
// there) — the static check alone can't see a transitive import introduced
// through a re-export it doesn't grep for.
describe('trigger-match.js / trigger-hook.js stay off the database', () => {
  it('has no import of db.js or better-sqlite3 in trigger-match.js source', () => {
    const src = readFileSync(new URL('../src/trigger-match.js', import.meta.url), 'utf-8');
    assert.doesNotMatch(src, /from ['"]\.\/db\.js['"]/);
    assert.doesNotMatch(src, /better-sqlite3/);
  });

  it('trigger-hook.js imports the matcher from trigger-match.js, not trigger-relevance.js (which loads db.js)', () => {
    const src = readFileSync(new URL('../src/cli/trigger-hook.js', import.meta.url), 'utf-8');
    assert.match(src, /from ['"]\.\.\/trigger-match\.js['"]/);
    assert.doesNotMatch(src, /from ['"]\.\.\/trigger-relevance\.js['"]/);
    assert.doesNotMatch(src, /from ['"]\.\/prompt-hint\.js['"]/, 'prompt-hint.js loads db.js transitively — hook-io.js is the shared piece');
  });

  it('importing trigger-hook.js in a fresh process never loads better-sqlite3 or db.js', () => {
    const target = new URL('../src/cli/trigger-hook.js', import.meta.url).href;
    const script = `
      import { createRequire } from 'module';
      await import(${JSON.stringify(target)});
      const req = createRequire(import.meta.url);
      const cached = Object.keys(req('module')._cache || {});
      const hits = cached.filter(k => k.includes('better-sqlite3') || k.endsWith('/db.js'));
      process.stdout.write(JSON.stringify(hits));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf-8' });
    assert.deepStrictEqual(JSON.parse(out), [], 'trigger-hook.js pulled in better-sqlite3 or db.js at import time');
  });
});

// Integration-ish: the real CLI entry point, its marker file and its JSONL
// log, round-tripped through a fresh KB_DIR — no mocking of fs.
describe('triggerHook — marker and log round trip', () => {
  it('log-only by default: logs the match, marker file untouched, nothing on stdout', () => {
    const kbDir = process.env.KB_DIR;
    mkdirSync(TRIGGERS_LOG_DIR, { recursive: true });
    const indexPath = join(kbDir, 'trigger-index.json');
    writeFileSync(indexPath, JSON.stringify(INDEX));

    const stdout = runHook(BASH('gh pr merge 1 --delete-branch', { session_id: 'sess-integ-1' }));
    assert.strictEqual(stdout, '', 'log-only mode emits nothing on stdout');
    assert.strictEqual(existsSync(join(TRIGGERS_LOG_DIR, 'sess-integ-1.json')), false, 'no emission means no marker write');

    const today = new Date().toISOString().slice(0, 10);
    const lines = readFileSync(join(TRIGGERS_LOG_DIR, `fires-${today}.jsonl`), 'utf-8').trim().split('\n');
    const row = JSON.parse(lines.at(-1));
    assert.strictEqual(row.session, 'sess-integ-1');
    assert.strictEqual(row.emitted, false);
    assert.deepStrictEqual(row.matched, [{ id: 7, hits: 2 }]);
  });

  it('enabled via the flag file: emits, writes the marker, and a second call for the same note is silent', () => {
    writeFileSync(TRIGGER_HOOK_ENABLED_FLAG, '');
    const input = BASH('gh pr merge 1 --delete-branch', { session_id: 'sess-integ-2' });

    const first = runHook(input);
    assert.match(first, /"additionalContext":"⚠ KB TRIGGER: note #7/);
    const marker = JSON.parse(readFileSync(join(TRIGGERS_LOG_DIR, 'sess-integ-2.json'), 'utf-8'));
    assert.deepStrictEqual(marker, [7]);

    const second = runHook(input);
    assert.strictEqual(second, '', 'the same note in the same session does not fire twice');
  });

  it('a corrupt marker file is tolerated as an empty session, not a crash', () => {
    writeFileSync(join(TRIGGERS_LOG_DIR, 'sess-integ-3.json'), 'not json');
    const stdout = runHook(BASH('gh pr merge 1 --delete-branch', { session_id: 'sess-integ-3' }));
    assert.match(stdout, /additionalContext/, 'a corrupt marker reads as no prior fires, so this one still emits');
  });

  it('non-Bash tool calls print nothing and write no log line', () => {
    const today = new Date().toISOString().slice(0, 10);
    const logPath = join(TRIGGERS_LOG_DIR, `fires-${today}.jsonl`);
    const before = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
    const stdout = runHook({ session_id: 'sess-non-bash', tool_name: 'Read', tool_input: { file_path: '/x' } });
    assert.strictEqual(stdout, '');
    const after = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
    assert.strictEqual(after, before, 'a non-Bash call must not grow the denominator');
  });
});

// run-hook.mjs above dynamically imports src/cli/trigger-hook.js, which
// proves the logic but not the actual artifact setup-hooks.js installs. This
// spawns bin/kb-trigger-hook.js itself, the thin entry point with none of
// bin/kb.js's flags/schema/runtime-node dispatch machinery.
describe('bin/kb-trigger-hook.js — the thin installed entry point', () => {
  const runBin = (hookInput, extraEnv = {}) => execFileSync(process.execPath, [THIN_BIN], {
    input: JSON.stringify(hookInput),
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
  });

  it('emits the same envelope as the src/cli/trigger-hook.js path, end to end', () => {
    const indexPath = join(process.env.KB_DIR, 'trigger-index.json');
    writeFileSync(indexPath, JSON.stringify(INDEX));
    writeFileSync(TRIGGER_HOOK_ENABLED_FLAG, '');

    const stdout = runBin(BASH('gh pr merge 1 --delete-branch', { session_id: 'sess-thin-bin' }));
    assert.match(stdout, /"additionalContext":"⚠ KB TRIGGER: note #7/);
  });

  it('empty stdin exits cleanly with nothing printed — it must never block the Bash call it wraps', () => {
    const stdout = execFileSync(process.execPath, [THIN_BIN], { input: '', env: process.env, encoding: 'utf8' });
    assert.strictEqual(stdout, '');
  });

  it('imports only trigger-hook.js — no flags.js, schema.js, runtime-node.js or an explicit dotenv import', () => {
    const src = readFileSync(THIN_BIN, 'utf-8');
    const importLines = src.split('\n').filter(l => /^\s*import\b/.test(l));
    assert.deepStrictEqual(importLines.map(l => l.trim()), ["import { triggerHook } from '../src/cli/trigger-hook.js';"]);
  });
});
