import { closeSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { homedir } from 'node:os';

const CURSOR_TRANSCRIPT_SEGMENT = `${sep}agent-transcripts${sep}`;
const CURSOR_PROJECTS_SEGMENT = `${sep}.cursor${sep}projects${sep}`;
const SUBAGENT_SCAN_BYTES = 65536;

export const CURSOR_TRANSCRIPT_DECLINE_REASON = Object.freeze({
  IDENTITY_MISMATCH: 'identity_mismatch',
  INVALID_PATH: 'invalid_transcript_path',
  MISSING_ID: 'missing_conversation_id',
  MISSING_PATH: 'missing_transcript_path',
  UNAVAILABLE: 'transcript_unavailable',
});

const RETRYABLE_PATH_ERROR = new Set(['EACCES', 'EBUSY', 'EIO', 'ENOENT', 'EPERM']);

function declineCursorTranscript(reason, retryable = false) {
  return { ok: false, reason, retryable };
}

function isContainedPath(root, path) {
  const fromRoot = relative(root, path);
  return fromRoot !== ''
    && fromRoot !== '..'
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot);
}

export function defaultCursorTranscriptRoot(home = homedir()) {
  return join(home, '.cursor', 'projects');
}

export function defaultTranscriptRoots(home = homedir()) {
  return [
    join(home, '.claude', 'projects'),
    join(home, '.codex', 'sessions'),
    defaultCursorTranscriptRoot(home),
  ];
}

export function isPrimaryCursorTranscript(path) {
  const sessionDir = dirname(path);
  return path.includes(CURSOR_TRANSCRIPT_SEGMENT)
    && basename(dirname(sessionDir)) === 'agent-transcripts'
    && basename(path, '.jsonl') === basename(sessionDir);
}

export function validateCursorTranscriptPath(path, conversationId, {
  root = defaultCursorTranscriptRoot(),
} = {}) {
  if (typeof conversationId !== 'string' || conversationId.length === 0) {
    return declineCursorTranscript(CURSOR_TRANSCRIPT_DECLINE_REASON.MISSING_ID);
  }
  if (typeof path !== 'string' || path.length === 0) {
    return declineCursorTranscript(CURSOR_TRANSCRIPT_DECLINE_REASON.MISSING_PATH);
  }
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink() || extname(path) !== '.jsonl') {
      return declineCursorTranscript(CURSOR_TRANSCRIPT_DECLINE_REASON.INVALID_PATH);
    }
    const realRoot = realpathSync(root);
    const realPath = realpathSync(path);
    const fromRoot = relative(realRoot, realPath);
    const parts = fromRoot.split(sep);
    if (
      !isContainedPath(realRoot, realPath)
      || parts.length !== 4
      || parts[1] !== 'agent-transcripts'
      || !isPrimaryCursorTranscript(realPath)
    ) {
      return declineCursorTranscript(CURSOR_TRANSCRIPT_DECLINE_REASON.INVALID_PATH);
    }
    if (basename(realPath, '.jsonl') !== conversationId) {
      return declineCursorTranscript(CURSOR_TRANSCRIPT_DECLINE_REASON.IDENTITY_MISMATCH);
    }
    return { ok: true, path: realPath };
  } catch (err) {
    const retryable = RETRYABLE_PATH_ERROR.has(err?.code);
    return declineCursorTranscript(
      retryable
        ? CURSOR_TRANSCRIPT_DECLINE_REASON.UNAVAILABLE
        : CURSOR_TRANSCRIPT_DECLINE_REASON.INVALID_PATH,
      retryable,
    );
  }
}

export function isDiscoverableTranscript(path) {
  if (path.includes(CURSOR_PROJECTS_SEGMENT)) return isPrimaryCursorTranscript(path);
  return !path.includes(CURSOR_TRANSCRIPT_SEGMENT) || isPrimaryCursorTranscript(path);
}

export function isActualSubagentTranscript(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(SUBAGENT_SCAN_BYTES);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.toString('utf8', 0, read);
    return /"thread_source"\s*:\s*"subagent"/.test(head)
      || /"source"\s*:\s*\{\s*"subagent"\s*:\s*\{\s*"thread_spawn"/.test(head);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already gone */ }
  }
}
