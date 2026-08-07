// PreToolUse (Bash) hook: pure decision logic in decideAndRecord/
// buildTriggerMessage, plus one integration-ish pass through the real CLI
// entry point to exercise the marker-file/JSONL-log I/O it wraps.
import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  decideAndRecord, buildTriggerMessage, resolveSession, MAX_SESSION_WARNINGS, FALLBACK_SESSION,
  TRIGGERS_LOG_DIR, TRIGGER_HOOK_ENABLED_FLAG,
} from '../src/cli/trigger-hook.js';
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
  it('falls back to FALLBACK_SESSION and caps independently when transcript_path is also absent', () => {
    const decision = decideAndRecord({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 1 --delete-branch' } }, { index: INDEX, enabled: true });
    assert.strictEqual(decision.session, FALLBACK_SESSION);
    const logged = JSON.parse(decision.logLine);
    assert.strictEqual(logged.session, FALLBACK_SESSION);
  });
});

// A5: session_id-less calls used to all share one 'unknown' marker — two
// unrelated session_id-less sessions (e.g. two different subagents whose
// session_id semantics were the reason emission defaults off) would
// permanently silence each other's warnings after 2 emissions total, and
// dedupe would wrongly cross between them. transcript_path (present on the
// hook's stdin JSON even when session_id is not) is unique per session, so
// falling back to its filename stem gives each one its own cap again.
describe('resolveSession — transcript_path fallback before FALLBACK_SESSION', () => {
  it('prefers session_id when present, ignoring transcript_path', () => {
    assert.strictEqual(resolveSession({ session_id: 's1', transcript_path: '/x/other.jsonl' }), 's1');
  });

  it('falls back to the transcript_path filename stem when session_id is absent', () => {
    assert.strictEqual(resolveSession({ transcript_path: '/Users/u/.claude/projects/proj/abc123.jsonl' }), 'abc123');
  });

  it('falls back to FALLBACK_SESSION when both are absent', () => {
    assert.strictEqual(resolveSession({}), FALLBACK_SESSION);
    assert.strictEqual(resolveSession(), FALLBACK_SESSION);
  });

  it('falls back to FALLBACK_SESSION when transcript_path is not a string', () => {
    assert.strictEqual(resolveSession({ transcript_path: 42 }), FALLBACK_SESSION);
    assert.strictEqual(resolveSession({ transcript_path: '' }), FALLBACK_SESSION);
  });

  it('two different session_id-less calls with different transcripts get independent identities, not one shared "unknown"', () => {
    const a = decideAndRecord(
      { tool_name: 'Bash', tool_input: { command: 'gh pr merge 1 --delete-branch' }, transcript_path: '/x/session-a.jsonl' },
      { index: INDEX, enabled: true },
    );
    const b = decideAndRecord(
      { tool_name: 'Bash', tool_input: { command: 'gh pr merge 1 --delete-branch' }, transcript_path: '/x/session-b.jsonl' },
      { index: INDEX, enabled: true },
    );
    assert.strictEqual(a.session, 'session-a');
    assert.strictEqual(b.session, 'session-b');
    assert.notStrictEqual(a.session, b.session);
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

// A9: before this fix, a persistently failing appendMarker meant readMarker
// kept returning [] forever (nothing was ever durably written), so the same
// note would emit on every matching Bash call for the rest of the session —
// both the cap and the per-note dedupe dead at once. The fix flips the
// failure direction: deliver() only runs once the marker write is confirmed
// to have landed, so a broken marker path now fails SILENT (no warning,
// ever, for that note) rather than SPAMMING. Verified across repeated calls,
// not just once, since the bug's whole signature was "every call, not just
// the first".
describe('triggerHook — A9: a marker write that never lands must not spam a warning on every call', () => {
  it('a persistently unwritable marker path stays silent across repeated matching calls', () => {
    const brokenKbDir = mkdtempSync(join(tmpdir(), 'kb-trigger-hook-broken-marker-'));
    writeFileSync(join(brokenKbDir, 'trigger-index.json'), JSON.stringify(INDEX));
    writeFileSync(join(brokenKbDir, 'trigger-hook-enabled'), '');
    mkdirSync(join(brokenKbDir, 'logs'), { recursive: true });
    // A file sitting where TRIGGERS_LOG_DIR needs to be a directory —
    // appendMarker's own mkdirSync(..., {recursive:true}) fails every time,
    // reproducing "the marker write persistently fails" without needing
    // real filesystem permission games.
    writeFileSync(join(brokenKbDir, 'logs', 'triggers'), '');

    const input = BASH('gh pr merge 1 --delete-branch', { session_id: 'sess-broken-marker' });
    for (let call = 1; call <= 3; call += 1) {
      const stdout = runHook(input, { KB_DIR: brokenKbDir });
      assert.strictEqual(stdout, '', `call ${call}: a write that never lands must stay silent, not spam`);
    }

    const errorLines = readFileSync(join(brokenKbDir, 'logs', 'hook-errors.log'), 'utf-8').trim().split('\n');
    assert.ok(
      errorLines.filter(l => l.includes('trigger-marker-write')).length >= 3,
      'the write failure is still captured for triage on every attempt, even though nothing is ever delivered',
    );
  });
});

// A6: nothing else prunes TRIGGERS_LOG_DIR, so it grows one marker per
// session and one JSONL file per day forever. The sweep runs opportunistically
// on the fire path (appendMarker) only — exercised here by backdating file
// mtimes and then triggering an emission, never on a plain decline.
describe('triggerHook — marker/log retention sweep runs only on the fire path', () => {
  const daysAgo = (n) => Date.now() / 1000 - n * 24 * 60 * 60;

  it('an emission sweeps markers older than 7 days and jsonl logs older than 30, leaving fresh ones untouched', () => {
    mkdirSync(TRIGGERS_LOG_DIR, { recursive: true });
    const staleMarker = join(TRIGGERS_LOG_DIR, 'stale-sess.json');
    const freshMarker = join(TRIGGERS_LOG_DIR, 'fresh-sess.json');
    const staleLog = join(TRIGGERS_LOG_DIR, 'fires-2020-01-01.jsonl');
    const freshLog = join(TRIGGERS_LOG_DIR, `fires-${new Date().toISOString().slice(0, 10)}.jsonl`);
    writeFileSync(staleMarker, '[]');
    writeFileSync(freshMarker, '[]');
    writeFileSync(staleLog, '{}\n');
    writeFileSync(freshLog, '{}\n');
    utimesSync(staleMarker, daysAgo(8), daysAgo(8));
    utimesSync(freshMarker, daysAgo(1), daysAgo(1));
    utimesSync(staleLog, daysAgo(31), daysAgo(31));
    utimesSync(freshLog, daysAgo(1), daysAgo(1));

    writeFileSync(TRIGGER_HOOK_ENABLED_FLAG, '');
    runHook(BASH('gh pr merge 1 --delete-branch', { session_id: 'sess-sweep-trigger' }));

    assert.strictEqual(existsSync(staleMarker), false, 'a marker older than 7 days is swept');
    assert.strictEqual(existsSync(freshMarker), true, 'a marker younger than 7 days survives');
    assert.strictEqual(existsSync(staleLog), false, 'a jsonl log older than 30 days is swept');
    assert.strictEqual(existsSync(freshLog), true, 'a jsonl log younger than 30 days survives');
  });

  it('a plain decline (no emission) does not sweep', () => {
    mkdirSync(TRIGGERS_LOG_DIR, { recursive: true });
    const staleMarker = join(TRIGGERS_LOG_DIR, 'stale-sess-2.json');
    writeFileSync(staleMarker, '[]');
    utimesSync(staleMarker, daysAgo(8), daysAgo(8));

    // No matching pattern in the index -> decline, not an emission.
    runHook({ session_id: 'sess-no-sweep', tool_name: 'Bash', tool_input: { command: 'git status' } });

    assert.strictEqual(existsSync(staleMarker), true, 'a decline must never trigger the sweep');
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

  it('static imports are only node:fs/os/path — trigger-hook.js loads dynamically, inside the try/catch', () => {
    const src = readFileSync(THIN_BIN, 'utf-8');
    const staticImportLines = src.split('\n').filter(l => /^\s*import\b/.test(l)).map(l => l.trim());
    assert.deepStrictEqual(staticImportLines, [
      "import { appendFileSync, mkdirSync } from 'node:fs';",
      "import { homedir } from 'node:os';",
      "import { join } from 'node:path';",
    ]);
    assert.match(src, /await import\('\.\.\/src\/cli\/trigger-hook\.js'\)/);
    assert.doesNotMatch(src, /^\s*import\b.*(flags\.js|schema\.js|runtime-node\.js)/m);
  });

  it('a module-load failure in the import chain is caught, logged to KB_DIR/logs/hook-errors.log using only node:fs, and still exits 0 with nothing on stdout/stderr', () => {
    const brokenKbDir = mkdtempSync(join(tmpdir(), 'kb-trigger-hook-broken-'));
    // paths.js's own top-level mkdirSync(FILES_DIR) throws when a file already
    // occupies where it needs a directory — the module-load failure this
    // guard exists for, reproduced without touching real disk permissions.
    writeFileSync(join(brokenKbDir, 'files'), '');

    const result = spawnSync(process.execPath, [THIN_BIN], {
      input: JSON.stringify(BASH('git status')),
      env: { ...process.env, KB_DIR: brokenKbDir },
      encoding: 'utf8',
    });

    assert.strictEqual(result.status, 0, 'a broken import chain must still exit 0, never block the Bash call');
    assert.strictEqual(result.stdout, '');
    assert.strictEqual(result.stderr, '', 'no stack trace on stderr — the whole point of the guard');
    const logged = readFileSync(join(brokenKbDir, 'logs', 'hook-errors.log'), 'utf-8');
    assert.match(logged, /trigger-hook-bin: /);
  });
});
