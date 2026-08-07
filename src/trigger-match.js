// The command-matching core of the trigger system, split out of
// trigger-relevance.js so it can be imported from the PreToolUse hook
// (src/cli/trigger-hook.js) without pulling in db.js — that hook runs on
// every Bash call (~227/session median), and opening the database there
// would tax every tool call for a feature most sessions never trigger.
// trigger-relevance.js re-exports everything below unchanged, so nothing
// outside these two files needs to know the split happened.
import { readFileSync } from 'fs';
import { join } from 'path';
import { KB_DIR } from './paths.js';

export const CORPUS_PATH = join(KB_DIR, 'command-corpus.txt');
export const TRIGGER_INDEX_PATH = join(KB_DIR, 'trigger-index.json');

// A heredoc body is the note's own text quoted back at a shell prompt, not a
// command anyone ran — 59/117 `gh pr create` corpus hits were heredoc bodies
// in the pre-review measurement. Line-based, matching how bash itself scans:
// on `<<DELIM`/`<<-DELIM` (optionally quoted), every following line is
// dropped up to and including the line that is exactly DELIM. The marker
// line itself is kept, since the real command sits on it (`cat >x <<EOF`).
export function stripHeredocs(command) {
  const lines = String(command ?? '').split('\n');
  const out = [];
  let delimiter = null;
  for (const line of lines) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) delimiter = null;
      continue;
    }
    const start = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (start) delimiter = start[2];
    out.push(line);
  }
  return out.join('\n');
}

// Splits into segments the way a shell would start separate commands:
// `;`, `&&`, `||`, `|`, `$(`, and backtick all begin a new one. Each segment
// then has its leading wrappers stripped (env assignments, sudo, nohup, time,
// env, command) so `KB_DIR=/tmp sudo gh pr merge --delete-branch` and
// `gh pr merge --delete-branch` grade identically — the wrapper is not what
// the pattern is warning about.
const SEGMENT_SPLIT = /\|\||&&|;|\$\(|`|\||&/;
const WRAPPER_TOKENS = new Set(['sudo', 'nohup', 'time', 'env', 'command']);
const ENV_ASSIGNMENT = /^[a-z_][a-z0-9_]*=\S*$/;

function stripWrappers(segment) {
  const tokens = segment.split(' ').filter(Boolean);
  let i = 0;
  while (i < tokens.length && (ENV_ASSIGNMENT.test(tokens[i]) || WRAPPER_TOKENS.has(tokens[i]))) i += 1;
  return tokens.slice(i).join(' ');
}

export function commandSegments(command) {
  const stripped = stripHeredocs(String(command ?? ''));
  const lowered = stripped.toLowerCase();
  const flattened = lowered.replace(/\n/g, ' ; ').replace(/\t/g, ' ');
  const normalized = flattened.replace(/\s+/g, ' ').trim();
  return normalized.split(SEGMENT_SPLIT).map(seg => stripWrappers(seg.trim())).filter(Boolean);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A part made only of letters/digits/spaces is a word or phrase and needs
// token boundaries — otherwise 'eva' substring-matches inside
// 'relevantNotes'. A part with other characters (a flag like
// '--delete-branch') is distinctive enough on its own that a plain substring
// check is the documented, accepted risk.
function partAppears(part, segment) {
  if (/^[a-z0-9 ]+$/.test(part)) {
    return new RegExp(`(?<![a-z0-9_-])${escapeRegex(part)}(?![a-z0-9_-])`).test(segment);
  }
  return segment.includes(part);
}

// The first part anchors the pattern to the START of a segment — the thing a
// segment actually RUNS, not something it merely mentions. This is what
// separates `gh pr merge --delete-branch` (runs it) from
// `grep -- '--delete-branch' notes.md` or `echo "gh pr merge ..."` (mentions
// it) — both contain every part as a substring, neither starts with the
// first one. Remaining parts only need to appear anywhere in the SAME
// segment; a pattern whose parts straddle two segments of a compound command
// does not match either one.
export function patternMatchesSegment(parts, segment) {
  if (!parts.length) return false;
  const [first, ...rest] = parts;
  if (!segment.startsWith(first)) return false;
  // Same boundary class partAppears uses — without `-` here, `git push-to-prod`
  // reads as running `git push`.
  const next = segment[first.length];
  if (next !== undefined && /[a-z0-9_-]/.test(next)) return false;
  return rest.every(p => partAppears(p, segment));
}

// entries = [{ id, title, patterns: [{ parts, hits, sessions }] }]. A note
// fires when ANY of its patterns matches ANY segment of the command — the
// same predicate filterTriggers grades the corpus with, so the hook can never
// fire on something the vet would have rejected as noise (or vice versa).
export function matchCommand(command, entries, { alreadyFired = new Set() } = {}) {
  const segments = commandSegments(command);
  const fired = [];
  for (const entry of entries) {
    if (alreadyFired.has(entry.id)) continue;
    let rarest = null;
    for (const { parts, hits } of entry.patterns || []) {
      if (parts.length && segments.some(seg => patternMatchesSegment(parts, seg))) {
        if (rarest === null || hits < rarest) rarest = hits;
      }
    }
    if (rarest !== null) fired.push({ id: entry.id, title: entry.title, tier: entry.tier, hits: rarest });
  }
  return fired.sort((a, b) => a.hits - b.hits);
}

// The hook must never break a tool call on a KB problem, so a missing or
// corrupt index reads as "nothing to fire on" rather than an error.
export function loadTriggerIndex(path = TRIGGER_INDEX_PATH) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return [];
  }
}
