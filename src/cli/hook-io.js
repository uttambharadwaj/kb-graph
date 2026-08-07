// Shared plumbing for Claude Code hooks: never let a hook problem block the
// tool call or prompt it's attached to, but leave a marker — a hook that
// failed and a hook that had nothing to say are identical from outside
// otherwise, which is why intermittent hook errors have never been
// attributable to a particular hook.
//
// Split out of prompt-hint.js (which re-exports both, so nothing importing
// them from there breaks) because prompt-hint.js itself imports db.js at
// module top-level (via liveTierCounts/retrieval.js), and the PreToolUse
// trigger hook (trigger-hook.js) runs on every Bash call — it must reuse this
// logic without dragging the database onto that path.
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { LOGS_DIR } from '../paths.js';

// Shared across every hook that reuses this module (prompt-hint.js and
// trigger-hook.js so far) — one name, not one per hook, so a failure here
// doesn't file itself under a different hook's name and mislead triage.
export const HOOK_ERROR_LOG = join(LOGS_DIR, 'hook-errors.log');

export function recordHookFailure(stage, err) {
  try {
    // paths.js creates the files dir, not this one, and the first thing ever
    // written here is by definition a failure — the worst moment to discover
    // the destination is missing.
    mkdirSync(LOGS_DIR, { recursive: true });
    // One failure is one line. A stack pasted in raw makes `wc -l` on this file
    // count frames, which is the wrong answer to the only question it is asked.
    const detail = String(err?.stack || err).replace(/\s*\n\s*/g, ' | ');
    appendFileSync(HOOK_ERROR_LOG, `${new Date().toISOString()} ${stage}: ${detail}\n`);
  } catch {
    // A logger that fails must not be louder than the thing it was logging.
  }
}

// console.log returns before the pipe has taken the bytes, so a delivery that
// fails is recorded by the meter as a hint that fired and seen by the caller as
// nothing at all. Wait for the write, and say so when it does not land.
export function deliver(line, out = process.stdout) {
  return new Promise(resolve => {
    out.write(`${line}\n`, err => {
      if (err) recordHookFailure('deliver', err);
      resolve();
    });
  });
}
