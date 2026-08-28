// PreCompact cannot inject context into Claude Code's summarizer. Its stdout
// is parsed as decision JSON, so plain preservation instructions now fail the
// hook. Capture a small local snapshot silently and let SessionStart/compact
// restore it after compaction instead.
import {
  appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'fs';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { join } from 'path';
import { KB_DIR, LOGS_DIR } from '../paths.js';
import { recordHookFailure, watchHookTiming } from './hook-io.js';

const SNAPSHOT_DIR = join(KB_DIR, 'compact-snapshots');
export const COMPACT_HOOK_LOG = join(LOGS_DIR, 'compact-hooks.jsonl');

const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const RECENT_CONTEXT_CAP = 1800;
const CUSTOM_INSTRUCTIONS_CAP = 1000;
const RECOVERY_TTL_MS = 10 * 60 * 1000;
const SNAPSHOT_RETENTION_MS = 24 * 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 750;
const GIT_STATUS_LIMIT = 20;

const unique = (values, limit) => [...new Set(values)].slice(0, limit);
const cap = (value, limit) => String(value ?? '').slice(0, limit);

function sessionIdentity(input = {}) {
  return input.session_id || input.transcript_path || input.cwd || 'unknown';
}

export function snapshotPathFor(input) {
  const key = createHash('sha256').update(String(sessionIdentity(input))).digest('hex').slice(0, 24);
  return join(SNAPSHOT_DIR, `${key}.json`);
}

function readTranscriptTail(path) {
  if (typeof path !== 'string' || !path) return '';
  let fd;
  try {
    const size = statSync(path).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fd = openSync(path, 'r');
    const read = readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8', 0, read);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => ['text', 'input_text', 'output_text'].includes(block?.type) && block.text)
    .map(block => block.text)
    .join('\n');
}

function recentTranscriptContext(raw) {
  const turns = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!['user', 'assistant'].includes(row.type) || row.isSidechain || !row.message) continue;
    const text = contentText(row.message.content).trim();
    if (text && !text.startsWith('<system-reminder>')) turns.push(`${row.type.toUpperCase()}: ${text}`);
  }
  const joined = turns.slice(-4).join('\n\n');
  return joined.length > RECENT_CONTEXT_CAP ? joined.slice(-RECENT_CONTEXT_CAP) : joined;
}

function referencesIn(text) {
  const tickets = unique([...text.matchAll(/\b[A-Z]{2,10}-\d+\b/g)].map(match => match[0]), 40);
  const pullRequests = unique([
    ...[...text.matchAll(/\b(?:PR|pull request)\s*#?(\d+)\b/gi)].map(match => match[1]),
    ...[...text.matchAll(/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/gi)].map(match => match[1]),
  ], 30);
  const kbNotes = unique([
    ...[...text.matchAll(/\bkb_read\(\s*(\d+)\s*\)/gi)].map(match => match[1]),
    ...[...text.matchAll(/\bKB note\s*#?(\d+)\b/gi)].map(match => match[1]),
  ], 40);
  const paths = unique([...text.matchAll(/(?:^|[\s"'`])((?:\/Users|\/private|\/tmp)\/[^\s"'`<>|]+|(?:src|tests|bin|docs|repos)\/[A-Za-z0-9._/@+\-]+)/gm)]
    .map(match => match[1].replace(/[),.;:]+$/, '')), 40);
  return { tickets, pull_requests: pullRequests, kb_notes: kbNotes, paths };
}

function readGitState(cwd) {
  if (typeof cwd !== 'string' || !cwd) return { branch: null, status: [] };
  const run = (args) => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  try {
    const branch = run(['branch', '--show-current']) || null;
    const status = run(['status', '--short']).split('\n').filter(Boolean).slice(0, GIT_STATUS_LIMIT);
    return { branch, status };
  } catch {
    return { branch: null, status: [] };
  }
}

export function buildContinuitySnapshot(input = {}, {
  now = new Date(),
  transcriptText,
  gitState,
} = {}) {
  const recentContext = transcriptText === undefined
    ? recentTranscriptContext(readTranscriptTail(input.transcript_path))
    : cap(transcriptText, RECENT_CONTEXT_CAP);
  const customInstructions = cap(input.custom_instructions, CUSTOM_INSTRUCTIONS_CAP);
  const references = referencesIn(`${recentContext}\n${customInstructions}`);
  return {
    schema_version: 1,
    captured_at: now.toISOString(),
    session_id: input.session_id ?? null,
    transcript_path: input.transcript_path ?? null,
    cwd: input.cwd ?? null,
    trigger: input.trigger ?? null,
    custom_instructions: customInstructions,
    git: gitState ?? readGitState(input.cwd),
    references,
    recent_context: recentContext,
  };
}

function sweepOldSnapshots(now = Date.now()) {
  try {
    for (const name of readdirSync(SNAPSHOT_DIR)) {
      if (!name.endsWith('.json')) continue;
      const path = join(SNAPSHOT_DIR, name);
      if (now - statSync(path).mtimeMs > SNAPSHOT_RETENTION_MS) unlinkSync(path);
    }
  } catch {
    // Missing directory and sweep races are both harmless; capture continues.
  }
}

export function writeContinuitySnapshot(snapshot) {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  sweepOldSnapshots(new Date(snapshot.captured_at).getTime());
  const path = snapshotPathFor(snapshot);
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

function recordCompactEvent(event) {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(COMPACT_HOOK_LOG, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
  } catch {
    // Observability must never turn compaction into a blocking failure.
  }
}

export function findContinuitySnapshot(input = {}, { now = new Date() } = {}) {
  let candidates = [];
  try {
    candidates = readdirSync(SNAPSHOT_DIR)
      .filter(name => name.endsWith('.json'))
      .flatMap(name => {
        const path = join(SNAPSHOT_DIR, name);
        try { return [{ path, snapshot: JSON.parse(readFileSync(path, 'utf8')) }]; } catch { return []; }
      })
      .filter(({ snapshot }) => {
        const age = now.getTime() - new Date(snapshot.captured_at).getTime();
        return Number.isFinite(age) && age >= 0 && age <= RECOVERY_TTL_MS;
      });
  } catch {
    return { outcome: 'none', path: null, snapshot: null };
  }

  const newest = (rows) => rows.sort((a, b) => b.snapshot.captured_at.localeCompare(a.snapshot.captured_at))[0];
  let match = newest(candidates.filter(row => input.session_id && row.snapshot.session_id === input.session_id));
  if (match) return { outcome: 'exact_session', ...match };
  match = newest(candidates.filter(row => input.transcript_path && row.snapshot.transcript_path === input.transcript_path));
  if (match) return { outcome: 'exact_transcript', ...match };
  const cwdMatches = candidates.filter(row => input.cwd && row.snapshot.cwd === input.cwd);
  if (cwdMatches.length === 1) return { outcome: 'cwd_recent', ...cwdMatches[0] };
  if (cwdMatches.length > 1) return { outcome: 'ambiguous_cwd', path: null, snapshot: null };
  return { outcome: 'none', path: null, snapshot: null };
}

export function formatContinuitySnapshot(snapshot) {
  if (!snapshot) return null;
  const refs = snapshot.references ?? {};
  const referenceParts = [
    refs.tickets?.length ? `tickets ${refs.tickets.join(', ')}` : null,
    refs.pull_requests?.length ? `PRs ${refs.pull_requests.map(id => `#${id}`).join(', ')}` : null,
    refs.kb_notes?.length ? `KB notes ${refs.kb_notes.map(id => `#${id}`).join(', ')}` : null,
    refs.paths?.length ? `paths ${refs.paths.join(', ')}` : null,
  ].filter(Boolean);
  return [
    `--- Pre-compact continuity snapshot (${snapshot.captured_at}) ---`,
    snapshot.cwd ? `cwd: ${snapshot.cwd}` : null,
    snapshot.git?.branch ? `branch: ${snapshot.git.branch}` : null,
    ...(snapshot.git?.status?.length ? ['git status:', ...snapshot.git.status] : []),
    referenceParts.length ? `references: ${referenceParts.join('; ')}` : null,
    snapshot.custom_instructions ? `compact instructions: ${snapshot.custom_instructions}` : null,
    snapshot.recent_context ? `Recent in-flight context:\n${snapshot.recent_context}` : null,
  ].filter(Boolean).join('\n');
}

export function commitContinuityRecovery(recovery) {
  if (!recovery) return;
  if (recovery.path) {
    try { unlinkSync(recovery.path); } catch (err) { recordHookFailure('compact-snapshot-consume', err); }
  }
  recordCompactEvent({
    event: 'recovery',
    outcome: recovery.outcome,
    session_id: recovery.snapshot?.session_id ?? null,
    trigger: recovery.snapshot?.trigger ?? null,
  });
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

export async function precompactHook() {
  const startedAt = Date.now();
  watchHookTiming('precompact-hook');
  let input;
  try {
    input = JSON.parse((await readStdin()) || '{}');
  } catch (err) {
    recordHookFailure('precompact-parse', err);
    recordCompactEvent({ event: 'capture', outcome: 'parse_error', duration_ms: Date.now() - startedAt });
    process.exit(0);
  }

  try {
    const snapshot = buildContinuitySnapshot(input);
    writeContinuitySnapshot(snapshot);
    recordCompactEvent({
      event: 'capture',
      outcome: 'saved',
      duration_ms: Date.now() - startedAt,
      session_id: snapshot.session_id,
      trigger: snapshot.trigger,
      recent_context_chars: snapshot.recent_context.length,
      git_status_rows: snapshot.git.status.length,
    });
  } catch (err) {
    recordHookFailure('precompact-write', err);
    recordCompactEvent({
      event: 'capture',
      outcome: 'write_error',
      duration_ms: Date.now() - startedAt,
      session_id: input.session_id ?? null,
      trigger: input.trigger ?? null,
    });
  }
  // PreCompact stdout must stay empty. Exit 0 with no decision means allow.
  process.exit(0);
}
