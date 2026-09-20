import { closeSync, openSync, readSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { homedir } from 'node:os';

const CURSOR_TRANSCRIPT_SEGMENT = `${sep}agent-transcripts${sep}`;
const CURSOR_PROJECTS_SEGMENT = `${sep}.cursor${sep}projects${sep}`;
const SUBAGENT_SCAN_BYTES = 65536;

export function defaultTranscriptRoots(home = homedir()) {
  return [
    join(home, '.claude', 'projects'),
    join(home, '.codex', 'sessions'),
    join(home, '.cursor', 'projects'),
  ];
}

export function isPrimaryCursorTranscript(path) {
  const sessionDir = dirname(path);
  return path.includes(CURSOR_TRANSCRIPT_SEGMENT)
    && basename(dirname(sessionDir)) === 'agent-transcripts'
    && basename(path, '.jsonl') === basename(sessionDir);
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
