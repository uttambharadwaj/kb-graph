// PostToolUse checkpoint hook: after a successful durable boundary, remind the
// root agent to capture verified knowledge while the evidence is still fresh.
//
// The hook is intentionally default-off. Disabled invocations record only a
// privacy-bounded candidate row so precision can be measured before rollout.
// It never logs command text or tool output, and emitted copy is constant.
import { createHash } from 'crypto';
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync,
} from 'fs';
import { join } from 'path';

import { KB_DIR, LOGS_DIR } from '../paths.js';
import { AGENT } from '../process-ancestry.js';
import {
  deliver, hookOutput, readAgentFlag, recordHookFailure, watchHookTiming,
} from './hook-io.js';

export const CHECKPOINT_REASON = Object.freeze({
  COMMIT_OR_MERGE: 'commit_or_merge',
  FULL_VERIFICATION: 'full_verification',
  RELEASE_OR_DEPLOY: 'release_or_deploy',
});

export const CHECKPOINT_DECLINE_REASON = Object.freeze({
  CAP: 'cap',
  DISABLED: 'disabled',
  DUPLICATE: 'duplicate',
  KILL_SWITCH: 'kill_switch',
  MARKER_WRITE_FAILED: 'marker_write_failed',
  MISSING_IDENTITY: 'missing_identity',
  UNSUPPORTED_AGENT: 'unsupported_agent',
  WRITE_DENIED: 'write_denied',
});

export const CHECKPOINT_MESSAGES = Object.freeze({
  [CHECKPOINT_REASON.COMMIT_OR_MERGE]:
    'KB CHECKPOINT: A source-control boundary completed. If this work produced durable verified knowledge, capture it now with kb_write (which owns dedupe); use supersedes when correcting an existing note. Skip transient progress.',
  [CHECKPOINT_REASON.FULL_VERIFICATION]:
    'KB CHECKPOINT: Full verification passed. If the result established durable knowledge, capture it now with kb_write (which owns dedupe); use supersedes when correcting an existing note. Skip routine test output.',
  [CHECKPOINT_REASON.RELEASE_OR_DEPLOY]:
    'KB CHECKPOINT: A release or deploy boundary completed. Capture any durable rollout decision, operational lesson, or changed workstream state now with kb_write (which owns dedupe); skip transient progress.',
});

export const MAX_SESSION_CHECKPOINTS = 2;
export const CHECKPOINT_ENABLED_FLAG = join(KB_DIR, 'checkpoint-hook-enabled');
export const CHECKPOINT_DISABLED_FLAG = join(KB_DIR, 'checkpoint-hook-disabled');
export const CHECKPOINT_LOG_DIR = join(LOGS_DIR, 'checkpoints');

const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MARKER_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const SAFE_PERMISSION_MODE = /^[a-z][a-z_-]{0,31}$/;

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function responseSucceeded(response, agent) {
  if (response === undefined || response === null) return false;
  const object = parseObject(response);
  if (!object) return agent === AGENT.CURSOR && typeof response === 'string';
  const rawExitCode = object.exit_code ?? object.exitCode;
  const exitCode = Number.isInteger(rawExitCode)
    ? rawExitCode
    : typeof rawExitCode === 'string' && /^-?\d+$/.test(rawExitCode)
      ? Number(rawExitCode)
      : null;
  if (
    object.is_error === true
    || object.isError === true
    || object.success === false
    || object.cancelled === true
    || object.interrupted === true
    || object.timed_out === true
    || object.timedOut === true
  ) return false;
  if (
    typeof object.status === 'string'
    && /^(?:aborted|cancelled|canceled|error|failed|failure|interrupted|timeout|timed[_ -]?out)$/i.test(object.status)
  ) return false;
  if (exitCode !== null) return exitCode === 0;
  if (object.success === true) return true;
  return typeof object.status === 'string' && /^(?:completed|ok|success|succeeded)$/i.test(object.status);
}

function permissionMode(input) {
  const raw = input?.permission_mode
    ?? input?.permissionMode
    ?? input?.approval_policy
    ?? input?.approvalPolicy
    ?? null;
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  return SAFE_PERMISSION_MODE.test(normalized) ? normalized : 'unknown';
}

function isSubagent(input) {
  if (!input || typeof input !== 'object') return false;
  if (input.is_sidechain === true || input.isSidechain === true || input.is_background_agent === true) return true;
  if (typeof input.agent_id === 'string' && input.agent_id) return true;
  if (typeof input.subagent_id === 'string' && input.subagent_id) return true;
  if (typeof input.agent_type === 'string' && /subagent/i.test(input.agent_type)) return true;
  return typeof input.transcript_path === 'string' && /(?:^|\/)subagents(?:\/|$)/.test(input.transcript_path);
}

export function normalizePostToolUse(input, agent) {
  const eventName = typeof input?.hook_event_name === 'string' ? input.hook_event_name : '';
  const toolName = typeof input?.tool_name === 'string' ? input.tool_name : '';
  const response = input?.tool_response ?? input?.tool_output ?? input?.tool_result;
  const command = typeof input?.tool_input?.command === 'string' ? input.tool_input.command : '';
  const nativeSession = agent === AGENT.CURSOR ? input?.conversation_id : input?.session_id;
  const session = typeof nativeSession === 'string'
    && nativeSession.length <= 200
    && nativeSession === nativeSession.trim()
    && nativeSession
    ? nativeSession
    : null;
  return {
    command,
    eventMatches: eventName.toLowerCase() === 'posttooluse',
    permissionMode: permissionMode(input),
    session,
    subagent: isSubagent(input),
    succeeded: responseSucceeded(response, agent),
    toolMatches: toolName === 'Bash' || toolName === 'Shell',
  };
}

function shellSegments(command) {
  const segments = [];
  let quote = null;
  let escaped = false;
  let segmentStart = 0;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== "'" && (character === '`' || (character === '$' && command[index + 1] === '('))) {
      return null;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === ';' || character === '|' || character === '\n') return null;
    if (character === '&') {
      if (command[index + 1] !== '&') return null;
      segments.push(command.slice(segmentStart, index));
      segmentStart = index + 2;
      index += 1;
    }
  }
  segments.push(command.slice(segmentStart));

  return segments
    .map(segment => segment.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, ''))
    .filter(Boolean);
}

function invokesKb(segment) {
  return /^(?:env\s+[^ ]+\s+)*(?:kb(?:\s|_|$)|node\s+(?:\S*\/)?kb(?:\.js)?(?:\s|$)|npx\s+kb(?:\s|$))/i.test(segment);
}

function shellWords(segment) {
  const words = [];
  let current = '';
  let escaped = false;
  let quote = null;
  for (const character of segment) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        words.push(current);
        current = '';
      }
    } else {
      current += character;
    }
  }
  if (current) words.push(current);
  return words;
}

function gitCommandWords(words) {
  if (words[0] !== 'git') return null;
  let index = 1;
  while (index < words.length) {
    const word = words[index];
    if (/^--(?:git-dir|namespace|work-tree)=/.test(word)) index += 1;
    else if (['-C', '-c', '--config-env', '--git-dir', '--namespace', '--work-tree'].includes(word)) index += 2;
    else break;
  }
  return words.slice(index);
}

function isCommitOrMerge(segment) {
  const words = shellWords(segment);
  const gitWords = gitCommandWords(words);
  if (gitWords?.[0] === 'commit') {
    return !gitWords.slice(1).some(word => ['--dry-run', '--help', '-h'].includes(word));
  }
  if (gitWords?.[0] === 'merge') {
    return !gitWords.slice(1).some(word =>
      ['--abort', '--help', '--no-commit', '--squash', '-h'].includes(word));
  }
  if (words[0] === 'gh' && words[1] === 'pr' && words[2] === 'merge') {
    return !words.slice(3).some(word => ['--auto', '--help'].includes(word));
  }
  return false;
}

const FULL_VERIFICATION_COMMANDS = new Set([
  'npm test',
  'npm run test',
  'pnpm test',
  'yarn test',
  'bun test',
  'pytest',
  'uv run pytest',
  'go test ./...',
  'cargo test',
  'make test',
]);

function isReleaseOrDeploy(segment) {
  const words = shellWords(segment);
  if (words.some(word => word === '--dry-run' || word === '--help')) return false;
  if (words[0] === 'npm' && (words[1] === 'publish' || (words[1] === 'run' && words[2] === 'deploy'))) return true;
  if (words[0] === 'gh' && words[1] === 'release' && words[2] === 'create') return true;
  if (['make', 'pnpm', 'yarn'].includes(words[0]) && words[1] === 'deploy') return true;
  if (words[0] === 'vercel' && words.includes('--prod')) return true;
  if (words[0] === 'fly' && words[1] === 'deploy') return true;
  if (words[0] === 'railway' && words[1] === 'up') return true;
  const script = ['bash', 'sh'].includes(words[0]) ? words[1] : words[0];
  return typeof script === 'string' && script.split('/').at(-1) === 'deploy.sh';
}

export function classifyCheckpointCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  // The hook only sees the aggregate shell exit. With `;`, `||`, a pipe, or
  // a background command, another command can hide failure (or non-execution)
  // of the checkpoint-looking segment. Decline instead of manufacturing evidence.
  const segments = shellSegments(command.trim());
  if (!segments) return null;
  if (segments.some(invokesKb)) return null;
  if (segments.some(isCommitOrMerge)) return CHECKPOINT_REASON.COMMIT_OR_MERGE;
  if (
    segments.includes('npm run test:preflight')
    && segments.includes('npm run test:suite')
  ) return CHECKPOINT_REASON.FULL_VERIFICATION;
  if (segments.some(segment => FULL_VERIFICATION_COMMANDS.has(shellWords(segment).join(' ')))) {
    return CHECKPOINT_REASON.FULL_VERIFICATION;
  }
  if (segments.some(isReleaseOrDeploy)) return CHECKPOINT_REASON.RELEASE_OR_DEPLOY;
  return null;
}

function writeDenied(input, mode, agent) {
  const signals = [
    mode,
    input?.permission_mode,
    input?.permissionMode,
    input?.approval_policy,
    input?.approvalPolicy,
    input?.sandbox_policy?.type,
    input?.sandboxPolicy?.type,
  ]
    .filter(value => typeof value === 'string')
    .map(value => value.trim().toLowerCase());
  const commonDenial = signals.some(signal =>
    /^(?:deny|denied|plan|read-only|readonly|restricted)$/.test(signal));
  if (commonDenial) return true;
  return agent === AGENT.CODEX
    && signals.some(signal => /^(?:bypasspermissions|never)$/.test(signal));
}

export function decideCheckpoint(input, {
  agent,
  enabled = false,
  killed = false,
  seen = [],
} = {}) {
  const normalized = normalizePostToolUse(input, agent);
  if (!normalized.eventMatches || !normalized.toolMatches || !normalized.command || !normalized.succeeded) return null;
  if (normalized.subagent) return null;
  const reason = classifyCheckpointCommand(normalized.command);
  if (!reason) return null;

  let declineReason = null;
  if (agent === AGENT.CURSOR) declineReason = CHECKPOINT_DECLINE_REASON.UNSUPPORTED_AGENT;
  else if (!normalized.session) declineReason = CHECKPOINT_DECLINE_REASON.MISSING_IDENTITY;
  else if (writeDenied(input, normalized.permissionMode, agent)) {
    declineReason = CHECKPOINT_DECLINE_REASON.WRITE_DENIED;
  } else if (killed) declineReason = CHECKPOINT_DECLINE_REASON.KILL_SWITCH;
  else if (!enabled) declineReason = CHECKPOINT_DECLINE_REASON.DISABLED;
  else if (seen.includes(reason)) declineReason = CHECKPOINT_DECLINE_REASON.DUPLICATE;
  else if (seen.length >= MAX_SESSION_CHECKPOINTS) declineReason = CHECKPOINT_DECLINE_REASON.CAP;

  return {
    declineReason,
    emit: declineReason === null,
    message: CHECKPOINT_MESSAGES[reason],
    permissionMode: normalized.permissionMode,
    reason,
    session: normalized.session,
  };
}

function sessionDigest(agent, session) {
  return createHash('sha256').update(`${agent}:${session}`).digest('hex');
}

function appendCandidateLog(decision, agent) {
  mkdirSync(CHECKPOINT_LOG_DIR, { recursive: true, mode: 0o700 });
  const row = {
    ts: new Date().toISOString(),
    agent,
    session: decision.session,
    reason: decision.reason,
    permission_mode: decision.permissionMode,
    emitted: decision.emit,
    decline_reason: decision.declineReason,
  };
  const path = join(CHECKPOINT_LOG_DIR, `candidates-${row.ts.slice(0, 10)}.jsonl`);
  appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

function reserveCheckpoint(agent, session, reason) {
  mkdirSync(CHECKPOINT_LOG_DIR, { recursive: true, mode: 0o700 });
  const prefix = sessionDigest(agent, session);
  const claimPath = join(CHECKPOINT_LOG_DIR, `${prefix}.${reason}.claim`);
  try {
    writeFileSync(claimPath, `${reason}\n`, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err?.code === 'EEXIST') return CHECKPOINT_DECLINE_REASON.DUPLICATE;
    throw err;
  }

  for (let slot = 1; slot <= MAX_SESSION_CHECKPOINTS; slot += 1) {
    try {
      writeFileSync(
        join(CHECKPOINT_LOG_DIR, `${prefix}.slot-${slot}`),
        `${reason}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      return null;
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        unlinkSync(claimPath);
        throw err;
      }
    }
  }
  unlinkSync(claimPath);
  return CHECKPOINT_DECLINE_REASON.CAP;
}

function sweepOldFiles() {
  try {
    const now = Date.now();
    for (const name of readdirSync(CHECKPOINT_LOG_DIR)) {
      const path = join(CHECKPOINT_LOG_DIR, name);
      const maxAge = name.endsWith('.jsonl')
        ? LOG_RETENTION_MS
        : name.endsWith('.claim') || /\.slot-\d+$/.test(name) ? MARKER_RETENTION_MS : null;
      if (maxAge !== null && now - statSync(path).mtimeMs > maxAge) unlinkSync(path);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') recordHookFailure('checkpoint-log-sweep', err);
  }
}

export function computeCheckpointHook(input, { agent } = {}) {
  const decision = decideCheckpoint(input, {
    agent,
    enabled: existsSync(CHECKPOINT_ENABLED_FLAG),
    killed: existsSync(CHECKPOINT_DISABLED_FLAG),
  });
  if (!decision) return null;

  sweepOldFiles();
  if (decision.emit) {
    try {
      const declined = reserveCheckpoint(agent, decision.session, decision.reason);
      if (declined) {
        decision.emit = false;
        decision.declineReason = declined;
      }
    } catch (err) {
      recordHookFailure('checkpoint-marker-write', err);
      decision.emit = false;
      decision.declineReason = CHECKPOINT_DECLINE_REASON.MARKER_WRITE_FAILED;
    }
  }
  try {
    appendCandidateLog(decision, agent);
  } catch (err) {
    recordHookFailure('checkpoint-candidate-log', err);
  }
  return decision.emit ? decision.message : null;
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function parseHookInput(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('Invalid checkpoint hook input');
  }
}

export async function checkpointHook(args = []) {
  watchHookTiming('checkpoint-hook');
  try {
    const agent = readAgentFlag(args);
    const input = parseHookInput(await readStdin());
    const message = computeCheckpointHook(input, { agent });
    const output = hookOutput(message, { agent, hookEventName: 'PostToolUse' });
    if (output) await deliver(output);
  } catch (err) {
    recordHookFailure('checkpoint-hook', err);
  }
  process.exit(0);
}
