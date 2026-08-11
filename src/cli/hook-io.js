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
import { connect } from 'net';
import { join } from 'path';
import { CONTROL_SOCKET_PATH, HOOK_OP } from '../daemon-paths.js';
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

// Per-op default, overridable by ONE env var — the hooks differ enough in
// call frequency and downstream cost (trigger-hook fires on every Bash call;
// wakeup-hook does the most DB work) to want different budgets, but a single
// knob is enough for anyone tuning it under load.
const DEFAULT_DAEMON_TIMEOUT_MS = {
  [HOOK_OP.PROMPT_HINT]: 1500,
  [HOOK_OP.TRIGGER_HOOK]: 800,
  [HOOK_OP.WAKEUP_HOOK]: 3000,
};

export function hookDaemonTimeoutMs(op) {
  const override = Number(process.env.KB_HOOK_DAEMON_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return override;
  return DEFAULT_DAEMON_TIMEOUT_MS[op];
}

/**
 * One request, one connection, line-delimited JSON — the control-socket
 * protocol daemon.js serves. Resolves `{ ok: true, output, plan }` only on a
 * clean answer inside timeoutMs; every other outcome (unreachable,
 * wedged/timed out, malformed response line) resolves `{ ok: false }` so the
 * caller falls back to its in-process compute path without inspecting why.
 * The socket is always destroyed before resolving — a timeout must not leave
 * a connection that could still deliver a late, out-of-band response line.
 *
 * `plan` is the daemon's un-committed write (it ran the compute core with
 * commit: false — see daemon-hook-ops.js): the caller must commit it itself,
 * via its own connection, and only once it has actually decided to deliver
 * `output` — see each hook's own commit*Plan function. A response this
 * function never resolves (daemon too slow, this call already timed out)
 * carries a plan nobody ever commits, which is the fix, not a bug: the
 * daemon made no write of its own to leave behind.
 *
 * @returns {Promise<{ok: true, output: string|null, plan: object|null} | {ok: false}>}
 */
export function callDaemonOp(op, payload, {
  // Every real caller passes this explicitly via hookDaemonTimeoutMs(op); the
  // fallback exists so an omitted value degrades to a slow-but-safe default
  // rather than setTimeout(fn, undefined) — which fires on the next tick.
  timeoutMs = 2000,
  socketPath = process.env.KB_CONTROL_SOCKET_PATH || CONTROL_SOCKET_PATH,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    const socket = connect(socketPath);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => finish({ ok: false }), timeoutMs);

    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ op, payload })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return; // partial line — wait for more, or the deadline
      let parsed;
      try {
        parsed = JSON.parse(buffer.slice(0, newline));
      } catch {
        return finish({ ok: false });
      }
      if (!parsed || parsed.ok !== true) return finish({ ok: false });
      finish({
        ok: true,
        output: 'output' in parsed ? parsed.output : null,
        plan: 'plan' in parsed ? parsed.plan : null,
      });
    });
    socket.once('error', () => finish({ ok: false }));
    socket.once('close', () => finish({ ok: false }));
  });
}
