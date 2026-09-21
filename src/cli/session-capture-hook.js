// Lifecycle hook entry: enqueue only. No extraction, summarization, indexing,
// or graph writes may happen in the host's hook deadline.
import { HOOK_OP } from '../daemon-paths.js';
import {
  SESSION_CAPTURE_DECLINE_REASON,
  enqueueSessionCapture,
} from '../session-capture.js';
import { readFlagValue } from './flags.js';
import {
  callDaemonOp, hookDaemonTimeoutMs, noteHookTiming, readAgentFlag,
  recordHookFailure, watchHookTiming,
} from './hook-io.js';

const REASONS = ['activity', 'precompact', 'session_end'];
const USAGE = 'Usage: kb session-capture-hook [--agent <claude|codex|cursor>] [--reason=<activity|precompact|session_end>]';
export const MAX_SESSION_CAPTURE_STDIN_BYTES = 1024 * 1024;

export async function readSessionCaptureInput(
  input = process.stdin,
  maxBytes = MAX_SESSION_CAPTURE_STDIN_BYTES,
) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > maxBytes) {
      return { ok: false, reason: SESSION_CAPTURE_DECLINE_REASON.INPUT_TOO_LARGE };
    }
    chunks.push(buffer);
  }
  try {
    const data = Buffer.concat(chunks, bytes).toString('utf8');
    return { ok: true, hookInput: data.trim() ? JSON.parse(data) : {} };
  } catch {
    return { ok: false, reason: SESSION_CAPTURE_DECLINE_REASON.MALFORMED_JSON };
  }
}

export async function sessionCaptureHook(args = []) {
  const agent = readAgentFlag(args, USAGE);
  const reason = readFlagValue(args, '--reason') || 'activity';
  if (!REASONS.includes(reason)) throw new Error(`--reason must be one of: ${REASONS.join(', ')}`);
  watchHookTiming(HOOK_OP.SESSION_CAPTURE);
  // Do not import claude-cli.js for its one-line helper: that module pulls the
  // model meter and database onto a hook whose fallback is deliberately only a
  // filesystem write. The variable is the shared contract.
  if (process.env.KB_BATCH === '1') return;
  try {
    const parsed = await readSessionCaptureInput();
    if (!parsed.ok) {
      return { output: null, plan: null, queued: false, reason: parsed.reason };
    }
    const { hookInput } = parsed;
    const payload = { hookInput, agent, reason };
    const daemon = await callDaemonOp(HOOK_OP.SESSION_CAPTURE, payload, {
      timeoutMs: hookDaemonTimeoutMs(HOOK_OP.SESSION_CAPTURE),
    });
    if (daemon.ok) noteHookTiming('daemon');
    else {
      enqueueSessionCapture(payload);
      noteHookTiming('fallback');
    }
  } catch (err) {
    recordHookFailure('session-capture', err);
  }
}
