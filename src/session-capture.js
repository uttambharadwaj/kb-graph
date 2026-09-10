// Durable, model-free handoff from lifecycle hooks to the resident daemon.
// Hooks only upsert a small JSON queue item and exit. The daemon later resolves
// the transcript and runs the existing harvest path outside the host's hook
// deadline. Files are used instead of SQLite here so the fallback path cannot
// wait on the KB database's busy timeout while an agent is trying to stop.
import { createHash, randomUUID } from 'crypto';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync,
} from 'fs';
import { basename, dirname, join } from 'path';
import { homedir } from 'os';
import { KB_DIR, LOGS_DIR } from './paths.js';

export const SESSION_CAPTURE_QUEUE_DIR = join(KB_DIR, 'session-capture-queue');
export const SESSION_CAPTURE_RECEIPT_DIR = join(KB_DIR, 'session-capture-receipts');
export const SESSION_CAPTURE_LOG = join(LOGS_DIR, 'session-capture.log');

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

function ensureDirs() {
  mkdirSync(SESSION_CAPTURE_QUEUE_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(SESSION_CAPTURE_RECEIPT_DIR, { recursive: true, mode: 0o700 });
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function writeJsonExclusive(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return true;
  } catch (err) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
}

function captureLog(event) {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(SESSION_CAPTURE_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  } catch { /* capture must not fail because telemetry did */ }
}

export function captureRequest(hookInput = {}, { agent = 'unknown', reason = 'activity', now = Date.now() } = {}) {
  const sessionId = hookInput.session_id || hookInput.sessionId || null;
  const transcriptPath = hookInput.transcript_path || hookInput.transcriptPath || null;
  if (!sessionId && !transcriptPath) return null;
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
  return { ...request, key: captureKey(request) };
}

// Idempotent upsert. If a daemon response loses the race with the hook's
// deadline, the hook writes the same key again in fallback mode; that is one
// queue item, not two captures.
export function enqueueSessionCapture(payload, { now = Date.now() } = {}) {
  const request = captureRequest(payload?.hookInput || payload, {
    agent: payload?.agent,
    reason: payload?.reason,
    now,
  });
  if (!request) return { output: null, plan: null, queued: false, reason: 'missing_identity' };
  ensureDirs();

  const queuePath = join(SESSION_CAPTURE_QUEUE_DIR, `${request.key}.json`);
  const receiptPath = join(SESSION_CAPTURE_RECEIPT_DIR, `${request.key}.json`);
  const receipt = readJson(receiptPath);
  if (request.observedMtime !== null && receipt?.processedMtime >= request.observedMtime) {
    return { output: null, plan: null, queued: false, reason: 'already_processed', key: request.key };
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
  if (request.transcriptPath && existsSync(request.transcriptPath)) return request.transcriptPath;
  if (!request.sessionId) return null;
  const exact = `${request.sessionId}.jsonl`;
  const roots = searchRoots || [join(homedir(), '.claude', 'projects'), join(homedir(), '.codex', 'sessions')];
  for (const root of roots) {
    for (const path of walkJsonl(root)) {
      const name = basename(path);
      // Claude uses <session>.jsonl; Codex uses rollout-<date>-<session>.jsonl.
      if (name === exact || name.endsWith(`-${exact}`)) return path;
    }
  }
  return null;
}

export function sessionCaptureQueueStatus(now = Date.now()) {
  ensureDirs();
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
  ensureDirs();
  recoverExpiredLeases(now);
  return queueFiles()
    .filter(item => item.request && item.request.dueAt <= now)
    .sort((a, b) => a.request.dueAt - b.request.dueAt);
}

function queueFiles() {
  return readdirSync(SESSION_CAPTURE_QUEUE_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => ({ name, request: readJson(join(SESSION_CAPTURE_QUEUE_DIR, name)) }))
    .filter(item => item.request)
    .sort((a, b) => a.request.dueAt - b.request.dueAt);
}

function recoverExpiredLeases(now) {
  for (const name of readdirSync(SESSION_CAPTURE_QUEUE_DIR).filter(name => name.endsWith('.json.working'))) {
    const workingPath = join(SESSION_CAPTURE_QUEUE_DIR, name);
    const leased = readJson(workingPath);
    if (!leased) continue;
    const legacyExpiresAt = () => {
      try { return statSync(workingPath).mtimeMs + LEASE_MS; } catch { return Infinity; }
    };
    const expiresAt = leased.lease?.expiresAt ?? legacyExpiresAt();
    if (expiresAt > now) continue;
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
  runHarvestFn,
} = {}) {
  const harvest = runHarvestFn || (await import('./harvest.js')).runHarvest;
  const result = { processed: 0, failed: 0, skipped: 0 };
  for (const { name, request } of dueQueueFiles(now).slice(0, limit)) {
    const queuePath = join(SESSION_CAPTURE_QUEUE_DIR, name);
    const claim = claimQueueItem(queuePath, request, now);
    if (!claim) continue;
    const { workingPath, leaseOwner } = claim;
    try {
      const transcriptPath = resolveCaptureTranscript(request, searchRoots);
      if (!transcriptPath) throw new Error('transcript not found yet');
      const mtime = statSync(transcriptPath).mtimeMs;
      const receiptPath = join(SESSION_CAPTURE_RECEIPT_DIR, `${request.key}.json`);
      const receipt = readJson(receiptPath);
      if (receipt?.processedMtime >= mtime) {
        result.skipped++;
      } else {
        const summary = await harvest({ onlyPath: transcriptPath, sessionId: request.sessionId, facts: false, maintenance: false });
        if (summary.errors > 0) throw new Error(`harvest reported ${summary.errors} extraction error(s)`);
        if (summary.coverageComplete === false) {
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
