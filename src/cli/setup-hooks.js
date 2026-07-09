// src/cli/setup-hooks.js — install KB briefing/hint hooks into Claude Code settings
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';

const HOOK_SPECS = [
  { event: 'SessionStart', matcher: 'startup|resume|clear|compact', subcommand: 'wakeup-hook' },
  { event: 'UserPromptSubmit', matcher: null, subcommand: 'prompt-hint' },
];

// Pure merge: dedup by subcommand so re-runs and prior manual installs never duplicate.
export function mergeClaudeHooks(settings, { nodeBin, kbJsPath }) {
  const next = structuredClone(settings ?? {});
  next.hooks = next.hooks ?? {};
  for (const spec of HOOK_SPECS) {
    const entries = (next.hooks[spec.event] = next.hooks[spec.event] ?? []);
    const already = entries.some(e =>
      (e.hooks ?? []).some(h => (h.command ?? '').endsWith(` ${spec.subcommand}`)));
    if (already) continue;
    const entry = { hooks: [{ type: 'command', command: `${nodeBin} ${kbJsPath} ${spec.subcommand}` }] };
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
