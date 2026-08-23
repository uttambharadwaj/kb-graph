// Shared plumbing for agent hooks (Claude Code and Codex): never let a hook
// problem block the tool call or prompt it's attached to, but leave a
// marker — a hook that failed and a hook that had nothing to say are
// identical from outside otherwise, which is why intermittent hook errors
// have never been attributable to a particular hook.
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
import { AGENT, AGENT_FLAG, AGENTS } from '../process-ancestry.js';
import { UsageError, readFlagValue } from './flags.js';

// Re-exported so hook modules keep one import for their flag plumbing.
export { AGENT_FLAG };

// Which client this hook was installed for. Claude Code takes a hook's plain
// stdout as context; Codex takes the JSON envelope below. The flag is the
// source, not ancestry: an installed hook knows which config file it was
// written into, while a `ps` walk is a guess that can only fail at exactly
// the moment the answer matters (a wrapper, a detached spawn). Defaults to
// claude — every hook installed before this flag existed passes nothing.
export function readAgentFlag(args = [], usage = null) {
  const value = readFlagValue(args, AGENT_FLAG);
  // A bare trailing `--agent` reads as absent, which would silently install
  // as claude — the one failure this flag exists to prevent. Present-but-
  // empty is a usage error, not a default.
  if (value === undefined) {
    if (args.includes(AGENT_FLAG)) throw new UsageError(`${AGENT_FLAG} needs a value: ${AGENT_FLAG} <${AGENTS.join('|')}>`, usage);
    return AGENT.CLAUDE;
  }
  if (!AGENTS.includes(value)) {
    throw new UsageError(`${AGENT_FLAG} must be one of: ${AGENTS.join(', ')} (got ${JSON.stringify(value)})`, usage);
  }
  return value;
}

// The JSON shape a hook uses to hand text to Codex as session context. The
// bus hooks (src/bus/cli.js) print the same envelope through this same
// function — one spelling of the shape, since a client that gets the key
// names wrong silently injects nothing.
export function hookJsonEnvelope(hookEventName, additionalContext) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }, null, 2);
}

// What a hook actually writes to stdout for `agent`: plain text for Claude
// Code, the JSON envelope for Codex. Null in, null out — "nothing to say"
// must stay nothing on both clients, never an envelope wrapping an empty
// string.
export function hookOutput(output, { agent, hookEventName }) {
  if (output == null || output === '') return null;
  return agent === AGENT.CODEX ? hookJsonEnvelope(hookEventName, output) : output;
}

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

// A hook the harness kills at its deadline writes nothing anywhere: no output,
// no meter row, no hook-errors line — which is why "hook timed out" reports
// have never been attributable to a path or a duration. This file receives
// only the abnormal tail: a line on SIGTERM (the kill itself, with how far in
// it came) and a line on any completion slower than SLOW_HOOK_MS. Normal
// sub-second runs stay unlogged — trigger-hook fires on every Bash call, and a
// log that grows per call answers no question this one is asked.
export const HOOK_TIMING_LOG = join(LOGS_DIR, 'hook-timings.log');

const SLOW_HOOK_MS = (() => {
  const override = Number(process.env.KB_SLOW_HOOK_MS);
  return Number.isFinite(override) && override > 0 ? override : 2000;
})();

// process.uptime() counts from node boot, not from main-module load, so a
// slow require graph or a cold disk cache shows up in the number — the exact
// component a stopwatch started in application code would miss.
const uptimeMs = () => Math.round(process.uptime() * 1000);

let timingDetail = '';

// Optional context for the timing line — e.g. 'daemon' vs 'fallback' once the
// hook knows which path served it. Last caller wins; empty by default.
export function noteHookTiming(detail) {
  timingDetail = detail;
}

function recordTiming(op, stage, ms) {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    const detail = timingDetail ? ` ${timingDetail}` : '';
    appendFileSync(HOOK_TIMING_LOG, `${new Date().toISOString()} ${op} ${stage} ${ms}ms${detail}\n`);
  } catch {
    // Same rule as recordHookFailure: the logger must not outshout the hook.
  }
}

/**
 * Install the abnormal-tail watchers for one hook invocation. Call once, at
 * the top of the hook's entry function — not at module load, so importing a
 * hook module (tests, the daemon's compute cores) installs nothing.
 */
export function watchHookTiming(op) {
  let recorded = false;
  process.on('SIGTERM', () => {
    recorded = true;
    recordTiming(op, 'sigterm', uptimeMs());
    // exit() here re-enters the 'exit' handler below — `recorded` keeps the
    // kill from also being logged as a slow completion.
    process.exit(143);
  });
  process.on('exit', () => {
    const ms = uptimeMs();
    if (!recorded && ms >= SLOW_HOOK_MS) recordTiming(op, 'slow-exit', ms);
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
