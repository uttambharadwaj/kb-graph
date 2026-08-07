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
import { existsSync, readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { KB_DIR, LOGS_DIR } from '../paths.js';
import { loadTriggerIndex, matchCommand } from '../trigger-match.js';
import { recordHookFailure, deliver } from './hook-io.js';

export const MAX_SESSION_WARNINGS = 2;
export const TRIGGERS_LOG_DIR = join(LOGS_DIR, 'triggers');
export const TRIGGER_HOOK_ENABLED_FLAG = join(KB_DIR, 'trigger-hook-enabled');

// A command this long is already unreadable in the log; the line exists to
// grade fire/decline rates; not to replay the command verbatim.
const COMMAND_LOG_MAX = 2000;

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

// Read-modify-write with no lock — two calls racing here can each write a
// marker that drops the other's id, so the worst case is a note re-firing
// once more than the cap, never a crash or an unparseable marker. The
// per-pid tmp name plus rename means neither writer ever observes (or
// leaves behind) a half-written file.
function appendMarker(session, id) {
  try {
    mkdirSync(TRIGGERS_LOG_DIR, { recursive: true });
    const current = readMarker(session);
    if (current.includes(id)) return;
    const path = markerPath(session);
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify([...current, id]));
    renameSync(tmp, path);
  } catch (err) {
    recordHookFailure('trigger-marker-write', err);
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
  const { session_id, tool_name, tool_input, cwd } = input || {};
  if (tool_name !== 'Bash') return null;
  const rawCommand = tool_input?.command;
  if (!rawCommand) return null;

  const command = String(rawCommand);
  const session = session_id || 'unknown';
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

export async function triggerHook() {
  try {
    const raw = await readStdin();
    const hookInput = JSON.parse(raw);
    // Cheap, I/O-free backstop in front of the real guard inside
    // decideAndRecord: the matcher in settings.json already restricts this
    // subprocess to Bash calls, so this only saves a wasted index/marker
    // read on a misconfigured or manually-fed invocation.
    if (hookInput?.tool_name !== 'Bash' || !hookInput?.tool_input?.command) process.exit(0);

    const session = hookInput.session_id || 'unknown';
    const decision = decideAndRecord(hookInput, {
      index: loadTriggerIndex(),
      fired: readMarker(session),
      enabled: existsSync(TRIGGER_HOOK_ENABLED_FLAG),
    });
    if (!decision) process.exit(0);

    appendJsonlLog(decision.logLine);
    if (decision.emit) {
      appendMarker(decision.session, decision.firedId);
      await deliver(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: decision.message },
      }));
    }
  } catch (err) {
    // Never block a tool call on a KB problem — but leave a marker, same
    // stance as prompt-hint's hint path.
    recordHookFailure('trigger-hook', err);
  }
  process.exit(0);
}
