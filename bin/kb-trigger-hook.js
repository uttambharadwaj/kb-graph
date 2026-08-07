#!/usr/bin/env node
// bin/kb-trigger-hook.js — the installed PreToolUse (Bash) hook entry point.
//
// Deliberately skips lockPreferredNodeRuntime/flags.js/schema.js and an
// explicit dotenv/config: bin/kb.js's dispatch machinery costs real latency
// before reaching any command, and this runs on every Bash call in every
// session (~227/session median) — that overhead is pure waste here. The node
// binary setup-hooks.js writes into the installed command is already the
// right one, so there is nothing to re-exec. `kb trigger-hook` (bin/kb.js)
// stays as the debuggable path for manual invocation; only the installed
// hook command points here. src/paths.js still loads dotenv/config on its
// own, so env vars behave identically either way.
//
// The import is dynamic and wrapped in try/catch: a module-load failure
// anywhere in the chain (trigger-hook.js, trigger-match.js, paths.js's own
// mkdirSync — e.g. a read-only disk) would otherwise stack-trace to stderr
// on EVERY Bash call, since a static top-level import can't be caught this
// way. The catch path uses only node:fs/os/path — the project's own modules
// are what just failed, so nothing under src/ is safe to lean on here,
// including hook-io.js's HOOK_ERROR_LOG constant, which this mirrors by hand.
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

try {
  const { triggerHook } = await import('../src/cli/trigger-hook.js');
  await triggerHook();
} catch (err) {
  try {
    const kbDir = process.env.KB_DIR || join(homedir(), '.knowledge-base');
    const logDir = join(kbDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    const detail = String(err?.stack || err).replace(/\s*\n\s*/g, ' | ');
    appendFileSync(join(logDir, 'hook-errors.log'), `${new Date().toISOString()} trigger-hook-bin: ${detail}\n`);
  } catch {
    // A fallback logger that fails must not be louder than the load failure it was recording.
  }
  process.exit(0);
}
