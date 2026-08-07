// src/cli/setup-hooks.js — install KB briefing/hint hooks into Claude Code settings
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, renameSync } from 'fs';
import { isVersionPinned } from './runtime-node.js';
import { dirname, join } from 'path';

// `script`, when present, is preferred over `subcommand`: it installs
// `${nodeBin} <dir-of-kbJsPath>/<script>` instead of
// `${nodeBin} ${kbJsPath} <subcommand>`. trigger-hook runs on every Bash call
// (~227/session median) and bin/kb.js's own dispatch machinery (flags.js,
// schema.js, runtime-node.js's re-exec check) costs 50-140ms before reaching
// any command — bin/kb-trigger-hook.js skips all of that. `kb trigger-hook`
// (bin/kb.js) still exists as the debuggable manual-invocation path; only the
// installed hook command uses the thin entry.
const HOOK_SPECS = [
  { event: 'SessionStart', matcher: 'startup|resume|clear|compact', subcommand: 'wakeup-hook' },
  { event: 'UserPromptSubmit', matcher: null, subcommand: 'prompt-hint' },
  { event: 'PreToolUse', matcher: 'Bash', script: 'kb-trigger-hook.js' },
];

const commandFor = (spec, { nodeBin, kbJsPath }) => spec.script
  ? `${nodeBin} ${join(dirname(kbJsPath), spec.script)}`
  : `${nodeBin} ${kbJsPath} ${spec.subcommand}`;

// The identity a command must end with to count as "this spec already
// installed" — the trailing subcommand token for the subcommand form, or the
// script's own filename for the script form (the full path always ends with
// it, so this works whether kbJsPath is the dev checkout or a deployed one).
const identifies = (spec, command) => spec.script
  ? (command ?? '').endsWith(spec.script)
  : (command ?? '').endsWith(` ${spec.subcommand}`);

// Pure merge: dedup by the spec's own identity so re-runs and prior manual installs never duplicate.
export function mergeClaudeHooks(settings, { nodeBin, kbJsPath }) {
  const next = structuredClone(settings ?? {});
  next.hooks = next.hooks ?? {};
  for (const spec of HOOK_SPECS) {
    const entries = (next.hooks[spec.event] = next.hooks[spec.event] ?? []);
    const already = entries.some(e => (e.hooks ?? []).some(h => identifies(spec, h.command)));
    if (already) continue;
    const entry = { hooks: [{ type: 'command', command: commandFor(spec, { nodeBin, kbJsPath }) }] };
    if (spec.matcher) entry.matcher = spec.matcher;
    entries.push(entry);
  }
  return next;
}

export function installClaudeHooks({ home, nodeBin, kbJsPath }) {
  const dir = join(home, '.claude');
  const path = join(dir, 'settings.json');
  mkdirSync(dir, { recursive: true });
  let settings = {};
  let backup = null;
  if (existsSync(path)) {
    // Parse before backup/write: a malformed file must abort with zero side effects.
    try {
      settings = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`Cannot parse ${path}: ${err.message} — fix or remove the file and re-run setup`, { cause: err });
    }
    backup = `${path}.kb-backup`;
    copyFileSync(path, backup);
  }
  const json = JSON.stringify(mergeClaudeHooks(settings, { nodeBin, kbJsPath }), null, 2) + '\n';
  // Write-to-temp-then-rename so a crash can't half-write settings.json.
  writeFileSync(`${path}.kb-tmp`, json);
  renameSync(`${path}.kb-tmp`, path);
  return { path, backup };
}

// Hook commands whose absolute paths no longer exist.
//
// A hook is a fire-and-forget subprocess: the host runs it, ignores what it
// prints, and carries on. So a command naming a checkout that has moved, or a
// Node binary a `brew upgrade` replaced, fails identically to one that had
// nothing to say — and the surface it powers goes quiet with nothing anywhere
// reporting it.
//
// One level of indirection is followed, because that is where this has actually
// bitten: the hook command named a shell script that existed, and the dead
// paths were the interpreter and target pinned inside it. Checking only the
// command would have passed that install clean.
// Two segments minimum: a slash-prefixed word with no second segment is a
// slash-command, not a path.
const ABSOLUTE_PATH = /(?:^|[\s"'=])(\/[^\s"':]+\/[^\s"':]+)/g;

const absolutePathsIn = (text) => [...text.matchAll(ABSOLUTE_PATH)]
  .map(m => m[1])
  .filter(path => !path.includes('$'));

export function unresolvableHookCommands(settings, { exists = existsSync, read = readFileSync } = {}) {
  const out = [];
  const scriptPaths = (path) => {
    if (!path.endsWith('.sh')) return [];
    // Assignments only. A path in a comment or a usage string is documentation,
    // and warning about it would train the reader to ignore this line.
    try {
      return [...read(path, 'utf8').matchAll(/^\s*[A-Za-z_][A-Za-z0-9_]*=("?)(\/[^\s"']+)\1/gm)].map(m => m[2]);
    } catch { return []; }
  };

  for (const [event, groups] of Object.entries(settings?.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const hook of group.hooks ?? []) {
        const command = hook.command ?? '';
        const direct = absolutePathsIn(command);
        const indirect = direct.filter(exists).flatMap(scriptPaths);
        const all = [...new Set([...direct, ...indirect])];
        const missing = all.filter(path => !exists(path));
        // Resolves today, stops the moment that package is upgraded: a death already
        // scheduled rather than one that has happened.
        const pinned = all.filter(path => !missing.includes(path) && isVersionPinned(path));
        if (missing.length || pinned.length) out.push({ event, command, missing, pinned });
      }
    }
  }
  return out;
}
