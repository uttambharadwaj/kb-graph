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

// Quote-aware scan, one pass: tracks single/double-quote state and a
// backslash escape (bash's own rule — nothing is special inside single
// quotes, not even a backslash; outside single quotes a backslash escapes
// the very next character, so an escaped quote or operator never toggles
// state or triggers a break). `isBreak(text, i)` is consulted only OUTSIDE
// any quote; when it returns a positive length, that many characters are
// consumed as the break (discarded) and a new chunk starts after them.
// Shared by the top-level segment split and the wrapper-token split below —
// both need "quotes and escapes hide what they contain from the splitter",
// just with a different notion of what a break is.
function quoteAwareSplit(text, isBreak) {
  const chunks = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (!inSingle && ch === '\\' && i + 1 < text.length) {
      current += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (!inDouble && ch === "'") { inSingle = !inSingle; current += ch; i += 1; continue; }
    if (!inSingle && ch === '"') { inDouble = !inDouble; current += ch; i += 1; continue; }
    if (!inSingle && !inDouble) {
      const len = isBreak(text, i);
      if (len > 0) { chunks.push(current); current = ''; i += len; continue; }
    }
    current += ch;
    i += 1;
  }
  chunks.push(current);
  return chunks;
}

function prevNonSpace(text, i) {
  let j = i - 1;
  while (j >= 0 && text[j] === ' ') j -= 1;
  return j >= 0 ? text[j] : undefined;
}

// `;` `|` `` ` `` always split; `||`/`&&`/`$(` are two-character operators
// checked first so a lone `&` or `|` that happens to be half of one isn't
// mis-split on its own. A lone `&` splits too (background job) UNLESS it's
// part of a redirect (`2>&1`, `&>`, `>&2`) — the previous non-space char or
// the very next char being `>` is the tell, since a background `&` never
// sits directly against one. `)` is never a break (unchanged from before —
// it only ever closed a `$(` visually, was never itself a split point).
function segmentBreakLen(text, i) {
  const ch = text[i];
  const next = text[i + 1];
  if ((ch === '|' && next === '|') || (ch === '&' && next === '&') || (ch === '$' && next === '(')) return 2;
  if (ch === ';' || ch === '|' || ch === '`') return 1;
  if (ch === '&') return prevNonSpace(text, i) === '>' || next === '>' ? 0 : 1;
  return 0;
}

// A plain space, outside quotes — used to tokenize a segment into words for
// wrapper-stripping, so a quoted value with an internal space
// (`NAME="John Doe"`) stays one token instead of splitting mid-value.
const wordBreakLen = (text, i) => text[i] === ' ' ? 1 : 0;

// A heredoc body is the note's own text quoted back at a shell prompt, not a
// command anyone ran — 59/117 `gh pr create` corpus hits were heredoc bodies
// in the pre-review measurement. Line-based, matching how bash itself scans.
//
// `(?<!<)<<(?!<)` requires exactly two `<` characters on either side: a
// here-string (`<<<`) is not a heredoc opener, and without this guard the
// regex still matches by sliding one character over (`<< word` inside
// `<<< word`), silently swallowing everything after as a body whose
// delimiter never arrives.
//
// Multiple openers on one line queue in the order bash consumes their
// bodies (`cat <<A <<B` reads A's body first, ending at a line that is
// exactly `A`, then B's, ending at a line that is exactly `B`) — tracking
// only the first delimiter let a second heredoc's body read as live
// commands.
//
// A queue still non-empty at end of input (no line ever matched the
// pending delimiter — the false-positive case is a bit-shift read as an
// opener, e.g. `1 << bits` with no line that is just `bits`) fails safe:
// return the ORIGINAL, unstripped. A possible false positive — checking a
// command that was actually safe — beats the alternative of silently never
// checking one that wasn't.
const HEREDOC_OPENER = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;

export function stripHeredocs(command) {
  const raw = String(command ?? '');
  const lines = raw.split('\n');
  const out = [];
  const queue = [];
  for (const line of lines) {
    if (queue.length) {
      if (line.trim() === queue[0]) queue.shift();
      continue;
    }
    HEREDOC_OPENER.lastIndex = 0;
    let m;
    while ((m = HEREDOC_OPENER.exec(line))) queue.push(m[2]);
    out.push(line);
  }
  if (queue.length) return raw;
  return out.join('\n');
}

// Splits into segments the way a shell would start separate commands, and
// (see quoteAwareSplit) never inside a quoted or backslash-escaped span:
// `echo "do not run; gh pr merge --delete-branch"` is one segment starting
// with `echo`, not two with the second starting mid-mention. Each segment
// then has its leading wrappers stripped (env assignments, sudo, nohup,
// time, env, command) so `KB_DIR=/tmp sudo gh pr merge --delete-branch` and
// `gh pr merge --delete-branch` grade identically — the wrapper is not what
// the pattern is warning about. Wrapper tokenizing is quote-aware too, so
// `GIT_AUTHOR_NAME="John Doe" gh pr merge --delete-branch` strips the whole
// quoted assignment as one token instead of anchoring on `doe"`.
const WRAPPER_TOKENS = new Set(['sudo', 'nohup', 'time', 'env', 'command']);
// Prefix only (not `\S*` to the end) — a quote-aware token can legitimately
// contain a space, e.g. `name="a b"`.
const ENV_ASSIGNMENT = /^[a-z_][a-z0-9_]*=/;

function stripWrappers(segment) {
  const tokens = quoteAwareSplit(segment, wordBreakLen).filter(Boolean);
  let i = 0;
  while (i < tokens.length && (ENV_ASSIGNMENT.test(tokens[i]) || WRAPPER_TOKENS.has(tokens[i]))) i += 1;
  return tokens.slice(i).join(' ');
}

export function commandSegments(command) {
  const stripped = stripHeredocs(String(command ?? ''));
  const lowered = stripped.toLowerCase();
  const flattened = lowered.replace(/\n/g, ' ; ').replace(/\t/g, ' ');
  const normalized = flattened.replace(/\s+/g, ' ').trim();
  return quoteAwareSplit(normalized, segmentBreakLen).map(seg => stripWrappers(seg.trim())).filter(Boolean);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Compiled once per distinct part, not once per (part, segment) pair — this
// runs per corpus row during vetting and per index entry on every Bash call
// in the hook, so a fresh RegExp per call was an O(corpus-rows) /
// O(entries-per-call) compile cost for the same handful of parts.
const partRegexCache = new Map();

// A part made only of letters/digits/spaces is a word or phrase and needs
// token boundaries — otherwise 'eva' substring-matches inside
// 'relevantNotes'. A part with other characters (a flag like
// '--delete-branch') is distinctive enough on its own that a plain substring
// check is the documented, accepted risk.
function partAppears(part, segment) {
  if (/^[a-z0-9 ]+$/.test(part)) {
    let re = partRegexCache.get(part);
    if (!re) {
      re = new RegExp(`(?<![a-z0-9_-])${escapeRegex(part)}(?![a-z0-9_-])`);
      partRegexCache.set(part, re);
    }
    return re.test(segment);
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
