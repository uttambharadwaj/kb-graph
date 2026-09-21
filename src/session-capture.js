// Durable, model-free handoff from lifecycle hooks to the resident daemon.
// Hooks only upsert a small JSON queue item and exit. The daemon later resolves
// the transcript and runs the existing harvest path outside the host's hook
// deadline. Files are used instead of SQLite here so the fallback path cannot
// wait on the KB database's busy timeout while an agent is trying to stop.
import { createHash, randomUUID } from 'crypto';
import {
  appendFileSync, chmodSync, closeSync, existsSync, fchmodSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'fs';
import { basename, dirname, join } from 'path';
import { KB_DIR, LOGS_DIR } from './paths.js';
import { HOOK_DECLINE_REASON, validateHookHost } from './hook-host.js';
import { PRIVATE_FILE_MODE } from './private-file.js';
import { AGENT } from './process-ancestry.js';
import {
  CURSOR_TRANSCRIPT_DECLINE_REASON,
  defaultCursorTranscriptRoot,
  defaultTranscriptRoots,
  isActualSubagentTranscript,
  isDiscoverableTranscript,
  validateCursorTranscriptPath,
} from './transcript-paths.js';

export const SESSION_CAPTURE_DECLINE_REASON = Object.freeze({
  ...HOOK_DECLINE_REASON,
  ...CURSOR_TRANSCRIPT_DECLINE_REASON,
  ALREADY_PROCESSED: 'already_processed',
  INPUT_TOO_LARGE: 'input_too_large',
  MALFORMED_JSON: 'malformed_json',
  MISSING_IDENTITY: 'missing_identity',
  CURSOR_CAPTURE_DISABLED: 'cursor_capture_disabled',
  CURSOR_CAPTURE_NOT_ENABLED: 'cursor_capture_not_enabled',
});

export const SESSION_CAPTURE_QUEUE_DIR = join(KB_DIR, 'session-capture-queue');
export const SESSION_CAPTURE_RECEIPT_DIR = join(KB_DIR, 'session-capture-receipts');
export const SESSION_CAPTURE_LOG = join(LOGS_DIR, 'session-capture.log');
export const CURSOR_CAPTURE_ENABLED_MARKER = join(KB_DIR, 'cursor-capture-enabled');
export const CURSOR_CAPTURE_DISABLED_MARKER = join(KB_DIR, 'cursor-capture-disabled');

const DELAY_MS = {
  session_end: 0,
  precompact: 5 * 60 * 1000,
  activity: 30 * 60 * 1000,
};
const RETRY_MS = 5 * 60 * 1000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;
const LEASE_MS = 10 * 60 * 1000;

const reasonRank = reason => ({ activity: 1, precompact: 2, session_end: 3 })[reason] || 0;
const safeReason = reason => Object.hasOwn(DELAY_MS, reason) ? reason : 'activity';
const captureKey = ({ agent, transcriptPath, sessionId }) => createHash('sha256')
  .update(`${agent || 'unknown'}\0${sessionId || transcriptPath}`)
  .digest('hex');

export function ensureSessionCaptureDirectories({
  chmod = chmodSync,
  mkdir = mkdirSync,
  onRepairError = () => {},
} = {}) {
  for (const path of [SESSION_CAPTURE_QUEUE_DIR, SESSION_CAPTURE_RECEIPT_DIR]) {
    try {
      mkdir(path, { recursive: true, mode: 0o700 });
      chmod(path, 0o700);
    } catch (err) {
      onRepairError(err);
    }
  }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
    chmodSync(tmp, PRIVATE_FILE_MODE);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function writeJsonExclusive(path, value, {
  chmod = fchmodSync,
  close = closeSync,
  open = openSync,
  remove = rmSync,
  write = writeFileSync,
} = {}) {
  let created = false;
  let fd;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    fd = open(path, 'wx', PRIVATE_FILE_MODE);
    created = true;
    write(fd, `${JSON.stringify(value, null, 2)}\n`);
    chmod(fd, PRIVATE_FILE_MODE);
    const closingFd = fd;
    fd = undefined;
    close(closingFd);
    return true;
  } catch (err) {
    if (fd !== undefined) {
      try { close(fd); } catch { /* preserve the original write or chmod error */ }
    }
    if (created) remove(path, { force: true });
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
}

function captureLog(event) {
  try {
    mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
    chmodSync(LOGS_DIR, 0o700);
    try {
      chmodSync(SESSION_CAPTURE_LOG, PRIVATE_FILE_MODE);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    appendFileSync(SESSION_CAPTURE_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, {
      mode: PRIVATE_FILE_MODE,
    });
    chmodSync(SESSION_CAPTURE_LOG, PRIVATE_FILE_MODE);
  } catch { /* capture must not fail because telemetry did */ }
}

function declineCapture(reason, details = {}) {
  return { output: null, plan: null, queued: false, reason, ...details };
}

function cursorCaptureDeclineReason() {
  if (existsSync(CURSOR_CAPTURE_DISABLED_MARKER)) {
    return SESSION_CAPTURE_DECLINE_REASON.CURSOR_CAPTURE_DISABLED;
  }
  if (!existsSync(CURSOR_CAPTURE_ENABLED_MARKER)) {
    return SESSION_CAPTURE_DECLINE_REASON.CURSOR_CAPTURE_NOT_ENABLED;
  }
  return null;
}

function createCaptureRequest(hookInput, {
  agent = 'unknown',
  reason = 'activity',
  now = Date.now(),
  cursorTranscriptRoot = defaultCursorTranscriptRoot(),
} = {}) {
  let sessionId;
  let transcriptPath;
  if (agent === AGENT.CURSOR) {
    // Queue only identities proven at the hook boundary. A temporarily
    // unavailable path cannot be persisted safely; later natural stop or
    // preCompact events may retry. Once queued, process-time IO failures use
    // the ordinary retry lease below instead of discarding the validated item.
    const identity = validateCursorTranscriptPath(
      hookInput.transcript_path,
      hookInput.conversation_id,
      { root: cursorTranscriptRoot },
    );
    if (!identity.ok) return identity;
    sessionId = hookInput.conversation_id;
    transcriptPath = identity.path;
  } else {
    sessionId = hookInput.session_id || hookInput.sessionId
      || hookInput.conversation_id || hookInput.conversationId || null;
    transcriptPath = hookInput.transcript_path || hookInput.transcriptPath || null;
  }
  if (!sessionId && !transcriptPath) {
    return { ok: false, reason: SESSION_CAPTURE_DECLINE_REASON.MISSING_IDENTITY };
  }
  if (
    transcriptPath
    && (!isDiscoverableTranscript(transcriptPath) || isActualSubagentTranscript(transcriptPath))
  ) {
    return { ok: false, reason: SESSION_CAPTURE_DECLINE_REASON.MISSING_IDENTITY };
  }
  let observedMtime = null;
  if (transcriptPath) {
    try { observedMtime = statSync(transcriptPath).mtimeMs; } catch { /* daemon may resolve it later */ }
  }
  const normalizedReason = safeReason(reason);
  const request = {
    agent,
    reason: normalizedReason,
    sessionId,
    transcriptPath,
    cwd: hookInput.cwd || null,
    observedMtime,
    observedAt: now,
    dueAt: now + DELAY_MS[normalizedReason],
    attempts: 0,
  };
  return { ok: true, request: { ...request, key: captureKey(request) } };
}

export function captureRequest(hookInput = {}, options = {}) {
  const result = createCaptureRequest(hookInput, options);
  return result.ok ? result.request : null;
}

// Idempotent upsert. If a daemon response loses the race with the hook's
// deadline, the hook writes the same key again in fallback mode; that is one
// queue item, not two captures.
export function enqueueSessionCapture(payload, {
  now = Date.now(),
  cursorTranscriptRoot = defaultCursorTranscriptRoot(),
} = {}) {
  const hookInput = payload?.hookInput || payload;
  const host = validateHookHost(hookInput, payload?.agent);
  if (!host.ok) {
    return declineCapture(host.reason);
  }
  if (payload?.agent === AGENT.CURSOR) {
    const reason = cursorCaptureDeclineReason();
    if (reason) return declineCapture(reason);
  }
  const capture = createCaptureRequest(hookInput, {
    agent: payload?.agent,
    reason: payload?.reason,
    now,
    cursorTranscriptRoot,
  });
  if (!capture.ok) return declineCapture(capture.reason);
  const { request } = capture;
  ensureSessionCaptureDirectories();

  const queuePath = join(SESSION_CAPTURE_QUEUE_DIR, `${request.key}.json`);
  const receiptPath = join(SESSION_CAPTURE_RECEIPT_DIR, `${request.key}.json`);
  const receipt = readJson(receiptPath);
  if (request.observedMtime !== null && receipt?.processedMtime >= request.observedMtime) {
    return declineCapture(SESSION_CAPTURE_DECLINE_REASON.ALREADY_PROCESSED, {
      key: request.key,
    });
  }

  const prior = readJson(queuePath);
  if (prior) {
    const newReasonWins = reasonRank(request.reason) >= reasonRank(prior.reason);
    request.reason = newReasonWins ? request.reason : prior.reason;
    request.dueAt = request.reason === 'activity'
      ? Math.max(prior.dueAt || 0, request.dueAt)
      : Math.min(prior.dueAt || request.dueAt, request.dueAt);
    request.attempts = prior.attempts || 0;
    request.transcriptPath ||= prior.transcriptPath;
    request.sessionId ||= prior.sessionId;
    request.observedMtime = Math.max(prior.observedMtime || 0, request.observedMtime || 0) || null;
  }
  atomicJson(queuePath, request);
  // Codex Stop fires after every turn. The queue update is useful; one log row
  // per turn is not. Record creation and lifecycle upgrades only.
  if (!prior || reasonRank(request.reason) > reasonRank(prior.reason)) {
    captureLog({ event: 'queued', key: request.key, agent: request.agent, reason: request.reason, dueAt: request.dueAt });
  }
  return { output: null, plan: null, queued: true, key: request.key, dueAt: request.dueAt };
}

function* walkJsonl(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJsonl(path);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path;
  }
}

export function resolveCaptureTranscript(request, searchRoots) {
  if (request.agent === AGENT.CURSOR) return null;
  if (request.transcriptPath && existsSync(request.transcriptPath)) return request.transcriptPath;
  if (!request.sessionId) return null;
  const exact = `${request.sessionId}.jsonl`;
  const roots = searchRoots || defaultTranscriptRoots();
  for (const root of roots) {
    for (const path of walkJsonl(root)) {
      const name = basename(path);
      // Claude uses <session>.jsonl; Codex uses rollout-<date>-<session>.jsonl.
      // Return an exact nested Cursor subagent match too: the processor must
      // classify and discard it instead of mistaking exclusion for absence
      // and retrying the request forever.
      if (name === exact || name.endsWith(`-${exact}`)) return path;
    }
  }
  return null;
}

function resolveQueuedTranscript(request, searchRoots, cursorTranscriptRoot) {
  if (request.agent === AGENT.CURSOR) {
    return validateCursorTranscriptPath(
      request.transcriptPath,
      request.sessionId,
      { root: cursorTranscriptRoot },
    );
  }
  return { ok: true, path: resolveCaptureTranscript(request, searchRoots) };
}

export function sessionCaptureQueueStatus(now = Date.now()) {
  ensureSessionCaptureDirectories();
  const requests = queueFiles().map(item => item.request).filter(Boolean);
  const due = requests.filter(request => request.dueAt <= now);
  return {
    queued: requests.length,
    due: due.length,
    failed: requests.filter(request => (request.attempts || 0) > 0).length,
    oldestOverdueMs: due.length ? Math.max(...due.map(request => now - request.dueAt)) : 0,
  };
}

function dueQueueFiles(now) {
  ensureSessionCaptureDirectories();
  recoverExpiredLeases(now);
  return queueFiles()
    .filter(item => item.request && item.request.dueAt <= now)
    .sort((a, b) => a.request.dueAt - b.request.dueAt);
}

function queueFiles() {
  return readdirSync(SESSION_CAPTURE_QUEUE_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      const path = join(SESSION_CAPTURE_QUEUE_DIR, name);
      try { chmodSync(path, PRIVATE_FILE_MODE); } catch { /* best effort; the 0700 parent remains the privacy boundary */ }
      return { name, request: readJson(path) };
    })
    .filter(item => item.request)
    .sort((a, b) => a.request.dueAt - b.request.dueAt);
}

function legacyLeaseExpiresAt(path) {
  try { return statSync(path).mtimeMs + LEASE_MS; } catch { return Infinity; }
}

function recoverExpiredLeases(now) {
  for (const name of readdirSync(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json.working'))) {
    const workingPath = join(SESSION_CAPTURE_QUEUE_DIR, name);
    try { chmodSync(workingPath, PRIVATE_FILE_MODE); } catch { /* expiry still clears an unrecoverable stale lease */ }
    const leased = readJson(workingPath);
    const expiresAt = leased?.lease?.expiresAt ?? legacyLeaseExpiresAt(workingPath);
    if (expiresAt > now) continue;
    if (!leased) {
      rmSync(workingPath, { force: true });
      captureLog({ event: 'discarded', path: workingPath, expiredAt: expiresAt, reason: 'unreadable_lease' });
      continue;
    }
    const queuePath = join(SESSION_CAPTURE_QUEUE_DIR, name.slice(0, -'.working'.length));
    const request = { ...leased };
    delete request.lease;
    if (!existsSync(queuePath)) atomicJson(queuePath, request);
    rmSync(workingPath, { force: true });
    captureLog({ event: 'recovered', key: request.key, expiredAt: expiresAt, legacy: !leased.lease || undefined });
  }
}

function claimQueueItem(queuePath, request, now) {
  const workingPath = `${queuePath}.working`;
  const owner = `${process.pid}-${randomUUID()}`;
  const leased = {
    ...request,
    lease: {
      owner,
      startedAt: now,
      expiresAt: now + LEASE_MS,
    },
  };
  try {
    if (!writeJsonExclusive(workingPath, leased)) return null;
    rmSync(queuePath, { force: true });
    return { workingPath, leaseOwner: owner };
  } catch {
    const current = readJson(workingPath);
    if (current?.lease?.owner === owner) rmSync(workingPath, { force: true });
    return null;
  }
}

function removeOwnedLease(workingPath, owner) {
  const current = readJson(workingPath);
  if (current?.lease?.owner === owner) rmSync(workingPath, { force: true });
}

function requeueIncomplete(queuePath, workingPath, owner, request, now) {
  const retry = {
    ...request,
    dueAt: now + RETRY_MS,
    lastError: 'harvest coverage incomplete',
  };
  if (!existsSync(queuePath)) atomicJson(queuePath, retry);
  removeOwnedLease(workingPath, owner);
  captureLog({ event: 'incomplete', key: request.key, retryAt: retry.dueAt });
}

export async function processSessionCaptureQueue({
  now = Date.now(),
  limit = 1,
  searchRoots,
  cursorTranscriptRoot = defaultCursorTranscriptRoot(),
  runHarvestFn,
} = {}) {
  const harvest = runHarvestFn || (await import('./harvest.js')).runHarvest;
  const result = { processed: 0, failed: 0, skipped: 0 };
  const processable = dueQueueFiles(now).filter(
    ({ request }) => request.agent !== AGENT.CURSOR || !cursorCaptureDeclineReason(),
  );
  for (const { name, request } of processable.slice(0, limit)) {
    const queuePath = join(SESSION_CAPTURE_QUEUE_DIR, name);
    const claim = claimQueueItem(queuePath, request, now);
    if (!claim) continue;
    const { workingPath, leaseOwner } = claim;
    try {
      const resolved = resolveQueuedTranscript(request, searchRoots, cursorTranscriptRoot);
      if (!resolved.ok) {
        if (resolved.retryable) throw new Error(resolved.reason);
        result.skipped++;
        removeOwnedLease(workingPath, leaseOwner);
        captureLog({ event: 'discarded', key: request.key, reason: resolved.reason });
        continue;
      }
      const { path: transcriptPath } = resolved;
      if (!transcriptPath) throw new Error('transcript not found yet');
      if (!isDiscoverableTranscript(transcriptPath) || isActualSubagentTranscript(transcriptPath)) {
        result.skipped++;
        removeOwnedLease(workingPath, leaseOwner);
        captureLog({ event: 'discarded', key: request.key, reason: 'subagent_transcript' });
        continue;
      }
      const mtime = statSync(transcriptPath).mtimeMs;
      const receiptPath = join(SESSION_CAPTURE_RECEIPT_DIR, `${request.key}.json`);
      const receipt = readJson(receiptPath);
      if (receipt?.processedMtime >= mtime) {
        result.skipped++;
      } else {
        const summary = await harvest({
          onlyPath: transcriptPath,
          sessionId: request.sessionId,
          agent: request.agent,
          facts: false,
          maintenance: false,
        });
        if (summary.errors > 0) throw new Error(`harvest reported ${summary.errors} extraction error(s)`);
        if (summary.coverageComplete !== true) {
          requeueIncomplete(queuePath, workingPath, leaseOwner, request, now);
          continue;
        }
        atomicJson(receiptPath, {
          key: request.key,
          sessionId: request.sessionId,
          transcriptPath,
          processedMtime: mtime,
          processedAt: Date.now(),
          summary: { sessions: summary.sessions, notes: summary.notes, tooShort: summary.tooShort },
        });
        result.processed++;
        captureLog({ event: 'processed', key: request.key, transcriptPath, notes: summary.notes, tooShort: summary.tooShort });
      }
      removeOwnedLease(workingPath, leaseOwner);
    } catch (err) {
      result.failed++;
      const attempts = (request.attempts || 0) + 1;
      const retryDelay = Math.min(MAX_RETRY_MS, RETRY_MS * (2 ** Math.min(attempts - 1, 10)));
      const retry = { ...request, attempts, dueAt: now + retryDelay, lastError: err.message };
      // A newer hook may already have queued fresher state while this item was
      // working. Keep that row and discard only this failed claim.
      if (!existsSync(queuePath)) atomicJson(queuePath, retry);
      removeOwnedLease(workingPath, leaseOwner);
      captureLog({ event: 'failed', key: request.key, attempt: retry.attempts, error: err.message });
    }
  }
  return result;
}
