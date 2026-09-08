// Lifecycle hook entry: enqueue only. No extraction, summarization, indexing,
// or graph writes may happen in the host's hook deadline.
import { HOOK_OP } from '../daemon-paths.js';
import { enqueueSessionCapture } from '../session-capture.js';
import { readFlagValue } from './flags.js';
import {
  callDaemonOp, hookDaemonTimeoutMs, noteHookTiming, readAgentFlag,
  recordHookFailure, watchHookTiming,
} from './hook-io.js';

const REASONS = ['activity', 'precompact', 'session_end'];
const USAGE = 'Usage: kb session-capture-hook [--agent <claude|codex>] [--reason=<activity|precompact|session_end>]';

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
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
    const raw = await readStdin();
    const hookInput = raw.trim() ? JSON.parse(raw) : {};
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
