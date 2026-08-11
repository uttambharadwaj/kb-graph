// PreToolUse hook (matcher: Bash): before a Bash call runs, check it against
// the vetted trigger index and warn when a note applies. Runs on every Bash
// call in every session (~227/session median) — see trigger-match.js's own
// header for why this file imports ONLY it and never trigger-relevance.js
// (which loads db.js) or prompt-hint.js (which loads db.js transitively via
// liveTierCounts/retrieval.js).
//
// Emission is gated behind a flag file (KB_DIR/trigger-hook-enabled) and
// defaults OFF: until subagent session_id semantics are measured, the hook
// only logs what it would have said. `kb trigger-hook-enable` deliberately
// does not exist yet — create the flag file by hand once observation looks
// sane.
import {
  existsSync, readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync,
} from 'fs';
import { basename, join } from 'path';
import { KB_DIR, LOGS_DIR } from '../paths.js';
import { loadTriggerIndex, matchCommand } from '../trigger-match.js';
import { callDaemonOp, hookDaemonTimeoutMs, recordHookFailure, deliver } from './hook-io.js';

export const MAX_SESSION_WARNINGS = 2;
export const TRIGGERS_LOG_DIR = join(LOGS_DIR, 'triggers');
export const TRIGGER_HOOK_ENABLED_FLAG = join(KB_DIR, 'trigger-hook-enabled');

// A command this long is already unreadable in the log; the line exists to
// grade fire/decline rates; not to replay the command verbatim.
const COMMAND_LOG_MAX = 2000;

// What every session_id-less call used to share: one marker, so after 2
// emissions ever, every such call (across every actual session) was
// permanently silenced, and dedupe wrongly spanned sessions that had nothing
// to do with each other. Kept as the LAST resort only — see resolveSession.
export const FALLBACK_SESSION = 'unknown';

// session_id is what the hook is given when it has one; transcript_path
// (also on the hook's stdin JSON) names the session's own JSONL file even
// when session_id is absent, and its basename without extension is the same
// session identity src/cli/trigger-corpus.js already keys the corpus on
// (`session column is the fixture filename stem`) — so a marker keyed on it
// lines up with an id nothing else in this codebase invented.
export function resolveSession({ session_id, transcript_path } = {}) {
  if (session_id) return session_id;
  if (typeof transcript_path === 'string' && transcript_path) {
    const stem = basename(transcript_path, '.jsonl');
    if (stem) return stem;
  }
  return FALLBACK_SESSION;
}

const markerPath = (session) => join(TRIGGERS_LOG_DIR, `${session}.json`);
const jsonlPath = (date = new Date()) => join(TRIGGERS_LOG_DIR, `fires-${date.toISOString().slice(0, 10)}.jsonl`);

function readMarker(session) {
  try {
    const ids = JSON.parse(readFileSync(markerPath(session), 'utf-8'));
    return Array.isArray(ids) ? ids : [];
  } catch {
    // Missing (first Bash call of the session) and corrupt (a lost write
    // race, see appendMarker) read identically: an empty session so far.
    return [];
  }
}

// Markers and JSONL logs accumulate one file per session/day forever with
// nothing else pruning them. Swept opportunistically here rather than as a
// separate scheduled job — this path (a fire) is already rare by
// construction (at most MAX_SESSION_WARNINGS times per session), which
// bounds how often the directory gets listed. Self-contained try/catch: a
// sweep failure must never be mistaken for the marker-write failure it runs
// alongside, and must never surface at all beyond its own log line.
const MARKER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function sweepOldTriggerFiles() {
  try {
    const now = Date.now();
    for (const name of readdirSync(TRIGGERS_LOG_DIR)) {
      let maxAge = null;
      if (name.endsWith('.jsonl')) maxAge = LOG_RETENTION_MS;
      else if (name.endsWith('.json')) maxAge = MARKER_RETENTION_MS;
      else continue;
      const full = join(TRIGGERS_LOG_DIR, name);
      if (now - statSync(full).mtimeMs > maxAge) unlinkSync(full);
    }
  } catch (err) {
    recordHookFailure('trigger-log-sweep', err);
  }
}

// Read-modify-write with no lock — two known race shapes, both accepted
// rather than fixed with a lock, because the worst case of each is one extra
// warning, never a crash or an unparseable marker:
//
// 1. Id-drop: two calls racing HERE can each write a marker that drops the
//    other's id (last rename wins). The per-pid tmp name plus rename means
//    neither writer ever observes (or leaves behind) a half-written file —
//    just a dropped id, which reads back as "not yet fired" and can re-fire
//    once more than intended.
//
// 2. Cap TOCTOU: the marker is read (for `fired`) BEFORE the emit decision
//    in triggerHook, and only written (here) AFTER it. Two concurrent Bash
//    calls can each read the same under-cap marker, each independently
//    decide to emit, and each call this function — the cap was checked
//    against a snapshot that was stale by the time either write landed. A
//    lock would close this, but the exposure is bounded (one extra warning
//    in a rare race, on a surface whose whole job is warning about rare
//    things) and not worth the complexity; the return value below (see A9)
//    already fixes the shape that mattered more — a marker that never
//    persists no longer spams a warning on every matching call, since
//    delivery only happens when the write actually landed.
//
// Returns whether the id is now durably in the marker (a fresh write, or
// already present) — false only when the write itself failed, which the
// caller must treat as "did not fire" rather than deliver anyway.
function appendMarker(session, id) {
  sweepOldTriggerFiles();
  try {
    mkdirSync(TRIGGERS_LOG_DIR, { recursive: true });
    const current = readMarker(session);
    if (current.includes(id)) return true;
    const path = markerPath(session);
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify([...current, id]));
    renameSync(tmp, path);
    return true;
  } catch (err) {
    recordHookFailure('trigger-marker-write', err);
    return false;
  }
}

function appendJsonlLog(line) {
  try {
    mkdirSync(TRIGGERS_LOG_DIR, { recursive: true });
    appendFileSync(jsonlPath(), `${line}\n`);
  } catch (err) {
    recordHookFailure('trigger-log', err);
  }
}

// Tier rides on the matched entry (trigger-index.json carries it — see
// rebuildTriggerIndex in trigger-relevance.js) so the caveat can be decided
// without opening the database, mirroring prompt-hint's tier caveat.
const tierCaveat = (tier) =>
  tier === 'verified' || tier === 'observed' ? '' : ' (⚠ unconfirmed model conclusion — treat as a lead)';

export const buildTriggerMessage = (match) =>
  `⚠ KB TRIGGER: note #${match.id} "${match.title}"${tierCaveat(match.tier)} may apply to this command — kb_read(${match.id}) before running it.`;

// The whole decision, with no I/O: given the hook's parsed stdin, the loaded
// index, the session's already-fired ids and whether emission is enabled,
// decides what the JSONL log line says and whether (and what) to emit. Tests
// exercise this directly; the exported CLI entry point below is the thin
// impure shell around it.
//
// Returns null for anything that is not a Bash call with a command — callers
// must not log those, since a call that was never the denominator would
// understate the decline rate rather than leaving it honestly absent.
export function decideAndRecord(input, { index = [], fired = [], enabled = false } = {}) {
  const { tool_name, tool_input, cwd } = input || {};
  if (tool_name !== 'Bash') return null;
  const rawCommand = tool_input?.command;
  if (!rawCommand) return null;

  const command = String(rawCommand);
  const session = resolveSession(input);
  const matches = matchCommand(command, index, { alreadyFired: new Set(fired) });

  const emit = matches.length > 0 && enabled && fired.length < MAX_SESSION_WARNINGS;
  const chosen = emit ? matches[0] : null; // matchCommand already sorts rarest-first

  const logLine = JSON.stringify({
    ts: new Date().toISOString(),
    session,
    cwd: cwd ?? null,
    matched: matches.map(m => ({ id: m.id, hits: m.hits })),
    emitted: emit,
    command: command.length > COMMAND_LOG_MAX ? command.slice(0, COMMAND_LOG_MAX) : command,
  });

  return {
    session,
    logLine,
    emit,
    message: chosen ? buildTriggerMessage(chosen) : null,
    firedId: chosen ? chosen.id : null,
  };
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

// The compute core: given the raw hook stdin (already known to be a Bash
// call with a command), decides whether a trigger fires and returns the
// JSON-stringified hook output to print, or null. No stdin, no
// process.exit, no ancestry — trigger-hook has none of prompt-hint's or
// wakeup-hook's session-map/ancestry dependency (resolveSession here reads
// only session_id/transcript_path off the payload), so this is safe to call
// identically from the daemon dispatcher or this file's own CLI fallback.
export function computeTriggerHook(hookInput) {
  try {
    const session = resolveSession(hookInput);
    const decision = decideAndRecord(hookInput, {
      index: loadTriggerIndex(),
      fired: readMarker(session),
      enabled: existsSync(TRIGGER_HOOK_ENABLED_FLAG),
    });
    if (!decision) return null;

    appendJsonlLog(decision.logLine);
    if (!decision.emit) return null;

    // A9: write before returning an answer to deliver, and only answer if
    // the write actually landed. A persistently failing marker write
    // (unwritable dir, disk full) must never be silently read back as
    // "nothing has fired yet" — that would spam the same warning on every
    // matching Bash call all session, both cap and dedupe dead. Failing to
    // warn once is the right direction for this surface; recordHookFailure
    // (inside appendMarker) still captures the write failure for triage.
    const persisted = appendMarker(decision.session, decision.firedId);
    if (!persisted) return null;

    return JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: decision.message },
    });
  } catch (err) {
    // Never block a tool call on a KB problem — but leave a marker, same
    // stance as prompt-hint's hint path.
    recordHookFailure('trigger-hook', err);
    return null;
  }
}

export async function triggerHook() {
  try {
    const raw = await readStdin();
    const hookInput = JSON.parse(raw);
    // Cheap, I/O-free backstop in front of the real guard inside
    // decideAndRecord: the matcher in settings.json already restricts this
    // subprocess to Bash calls, so this only saves a wasted index/marker
    // read (and a socket dial) on a misconfigured or manually-fed invocation.
    if (hookInput?.tool_name !== 'Bash' || !hookInput?.tool_input?.command) process.exit(0);

    const daemon = await callDaemonOp('trigger-hook', { hookInput }, { timeoutMs: hookDaemonTimeoutMs('trigger-hook') });
    const output = daemon.ok ? daemon.output : computeTriggerHook(hookInput);
    if (output) await deliver(output);
  } catch (err) {
    // Never block a tool call on a KB problem — but leave a marker, same
    // stance as prompt-hint's hint path.
    recordHookFailure('trigger-hook', err);
  }
  process.exit(0);
}
