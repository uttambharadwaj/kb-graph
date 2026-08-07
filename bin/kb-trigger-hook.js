#!/usr/bin/env node
// bin/kb-trigger-hook.js — the installed PreToolUse (Bash) hook entry point.
//
// Deliberately skips lockPreferredNodeRuntime/flags.js/schema.js and an
// explicit dotenv/config: bin/kb.js's dispatch machinery costs 50-140ms
// before reaching any command, and this runs on every Bash call in every
// session (~227/session median) — that overhead is pure waste here. The node
// binary setup-hooks.js writes into the installed command is already the
// right one, so there is nothing to re-exec. `kb trigger-hook` (bin/kb.js)
// stays as the debuggable path for manual invocation; only the installed
// hook command points here. src/paths.js still loads dotenv/config on its
// own, so env vars behave identically either way.
import { triggerHook } from '../src/cli/trigger-hook.js';

await triggerHook();
