// Command triggers: patterns that let a note warn BEFORE a Bash tool call
// runs, mirroring how filterAliases (src/hint-relevance.js) vets retrieval
// aliases. Same shape of problem — a model proposes, this grounds and caps —
// but the corpus here is historical Bash commands, not the document store,
// and the payoff is a hook firing on a live shell invocation, so a bad
// pattern is a false alarm on someone's terminal rather than a bad search
// result.
//
// Revision 1 (2026-08-07, docs/plans/2026-08-07-kb-action-triggers-design.md):
// an adversarial review measured the original per-command 1% ceiling against
// real history and it fails on noise (P(fire) = 1-(1-r)^K over ~227 Bash
// calls/session makes a 1%-per-command pattern fire in 90% of sessions), and
// found mention/execution confusion (grep or echo of a dangerous string fired
// it) and prose-as-grounding (filterAliases's own documented body-as-identity
// hole). This file is the post-review shape: session-level ceiling, a shared
// segment matcher used by both the vet and the hook so they grade the same
// predicate, and grounding restricted to the note's own code spans.
import { readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { getDb } from './db.js';
import { KB_DIR } from './paths.js';

export const CORPUS_PATH = join(KB_DIR, 'command-corpus.txt');
export const TRIGGER_INDEX_PATH = join(KB_DIR, 'trigger-index.json');

// A note may carry at most this many patterns — the hook checks every live
// note's patterns on every Bash call, so the cost of a chatty note is paid
// per invocation, not once.
const MAX_TRIGGER_PATTERNS = 3;
// A pattern with many parts is really matching on a whole command line, not a
// reusable danger signal — it stops generalizing past the one example it came
// from.
const MAX_PATTERN_PARTS = 4;
// Below this a part is a stray flag letter or fragment ('-f', 'rm ') that
// substring-matches almost anything.
const MIN_PART_LEN = 3;
// The noise ceiling, measured per SESSION not per command: P(fires at least
// once) = 1-(1-r)^K over a session's Bash calls (K median ~227), so a
// per-command ratio that looks rare still saturates sessions. 5% of sessions
// containing a match at all is the ceiling a pattern must clear.
const MAX_SESSION_HIT_RATIO = 0.05;
// Below this the corpus can't grade a session ratio meaningfully — a handful
// of sessions makes every ratio a multiple of 1/N.
const MIN_CORPUS_SESSIONS = 20;
// Below this the corpus has too few lines full stop, independent of session
// count (a few sessions could still be enormous, or vice versa).
const MIN_CORPUS_LINES = 500;
// A pattern with zero corpus hits is NOT noise-free — the corpus is a few
// days of real usage, workstream-skewed, and a domain it never saw (infra,
// a rare tool) reads identically to a genuinely rare command. Requiring at
// least one hit means "seen and rare" gets in; "never seen" waits for the
// nightly corpus rebuild + re-vet to cover that domain before it can.
const MIN_CORPUS_HITS = 1;

function normalize(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Accepts what a model actually returns for "here are the commands this note
// warns about": an array of proposals, each either a whole pattern as one
// string (parts joined by " && ", matching how someone would write it in a
// shell) or a pattern already split into parts. A bare string is one
// single-proposal call. Anything else proposes nothing rather than throwing —
// this sits upstream of a vet, not a validator with an opinion about the
// caller's mistake.
export function parseTriggerProposals(raw) {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const patterns = [];
  for (const item of items) {
    const rawParts = typeof item === 'string' ? item.split(/\s*&&\s*/)
      : Array.isArray(item) ? item.map(p => typeof p === 'string' ? p : '')
      : [];
    const parts = rawParts.map(p => p.trim()).filter(Boolean);
    if (parts.length) patterns.push(parts);
  }
  return patterns;
}

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
function patternMatchesSegment(parts, segment) {
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

// TSV: `<session>\t<command>`, one line per Bash call. Loaded rows carry the
// session id the ceiling counts distinct sessions over, and a normalized
// command — heredoc-stripping and newline flattening already happened at
// corpus-build time (src/cli/trigger-corpus.js), so this is just case/space.
export function loadCommandCorpus(path = CORPUS_PATH) {
  try {
    return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map(line => {
      const tab = line.indexOf('\t');
      const session = tab === -1 ? '' : line.slice(0, tab);
      const command = tab === -1 ? line : line.slice(tab + 1);
      return { session, command: normalize(command) };
    });
  } catch {
    return [];
  }
}

// Fenced ``` blocks and inline `backtick` spans only — never surrounding
// prose. Grounding a trigger in prose is the exact failure filterAliases's
// own header comment documents for body-as-identity: 'the fix', 'apply',
// 'drop', 'token', 'reset' all read as normal English and would ground almost
// any pattern if prose counted.
function extractCodeSpans(text) {
  const str = String(text ?? '');
  const spans = [];
  const fenced = /```[^\n]*\n?([\s\S]*?)```/g;
  let m;
  while ((m = fenced.exec(str))) spans.push(m[1]);
  const withoutFenced = str.replace(/```[^\n]*\n?[\s\S]*?```/g, ' ');
  const inline = /`([^`\n]+)`/g;
  while ((m = inline.exec(withoutFenced))) spans.push(m[1]);
  return spans.join('\n');
}

// A single plain word ('apply', 'drop') is never a legal trigger even if it
// sits inside a code span — it needs to look like something you'd type as a
// command, not a word that happens to be in one.
function isCommandShaped(part) {
  const words = part.trim().split(/\s+/).filter(Boolean);
  return words.length >= 2 || /[-/._=]/.test(part);
}

// The vet. Only what survives this ever reaches documents.triggers, and only
// documents.triggers ever reaches the hook.
//
// `pinned` is the curation tier: the motivating gotcha (#2778, `gh pr merge
// --delete-branch` on a stack base) runs in 11% of sessions and the noise
// ceiling rightly rejects it as a LEARNED pattern — its shape cannot tell the
// dangerous run from the routine one. A human who decides the warning is
// worth its false fires pins the note, which skips the frequency gates only.
// The fabrication guards (code-span grounding, shape, caps) hold for pins
// too: a human vouches for the noise trade, never for a command the note
// doesn't contain.
export function filterTriggers(proposed, { title, content }, { corpus = loadCommandCorpus(), pinned = false } = {}) {
  const patterns = parseTriggerProposals(proposed).map(parts => parts.map(normalize));
  if (!patterns.length) return '';

  const totalSessions = new Set(corpus.map(c => c.session)).size;
  // A ceiling graded against too little history — too few lines, or too few
  // distinct sessions to make a session ratio meaningful — grades nothing.
  // Same stance as filterAliases's "df of 0 means not indexed yet": nothing
  // ungraded reaches the hook, and the nightly corpus rebuild + re-vet
  // catches these notes up once history exists. A pin is its own grading.
  if (!pinned && (corpus.length < MIN_CORPUS_LINES || totalSessions < MIN_CORPUS_SESSIONS)) return '';

  const codeText = normalize(extractCodeSpans(`${title}\n${content}`));
  // Computed once per call and reused across every proposed pattern, since
  // every pattern re-scans the same corpus.
  const corpusSegments = corpus.map(c => commandSegments(c.command));

  const seen = new Set();
  const accepted = [];

  for (const parts of patterns) {
    if (parts.length > MAX_PATTERN_PARTS) continue;
    if (parts.some(p => p.length < MIN_PART_LEN)) continue;
    // Grounding: the note's own code spans must contain the command it warns
    // about — the same fabrication guard filterAliases applies to synonyms,
    // narrowed to code spans so prose can't ground it (see extractCodeSpans).
    if (parts.some(p => !codeText.includes(p))) continue;
    // Shape: at least one part has to look like something you'd type, not a
    // plain English word a code span happened to contain.
    if (!parts.some(isCommandShaped)) continue;

    const key = parts.join('\0');
    if (seen.has(key)) continue;

    let hits = 0;
    const sessionsHit = new Set();
    for (let i = 0; i < corpus.length; i += 1) {
      if (corpusSegments[i].some(seg => patternMatchesSegment(parts, seg))) {
        hits += 1;
        sessionsHit.add(corpus[i].session);
      }
    }
    if (!pinned && hits < MIN_CORPUS_HITS) continue;
    if (!pinned && totalSessions > 0 && sessionsHit.size / totalSessions > MAX_SESSION_HIT_RATIO) continue;

    seen.add(key);
    const entry = { parts, hits, sessions: sessionsHit.size };
    if (pinned) entry.pinned = true;
    accepted.push(entry);
  }

  if (!accepted.length) return '';
  const kept = accepted
    .sort((a, b) => a.sessions - b.sessions || a.hits - b.hits)
    .slice(0, MAX_TRIGGER_PATTERNS);
  return JSON.stringify(kept);
}

// The hook's read path has no lock on this file, so a rebuild must never
// leave it half-written — write to a temp file in the same directory and
// rename, which POSIX guarantees is atomic.
export function rebuildTriggerIndex(path = TRIGGER_INDEX_PATH) {
  // tier rides along so the hook can carry the unconfirmed-conclusion caveat
  // (as prompt-hint does) without opening the database on the hot path.
  const rows = getDb().prepare(`
    SELECT id, title, tier, triggers FROM documents
    WHERE triggers IS NOT NULL AND superseded_at IS NULL AND doc_type != 'archive'
    ORDER BY id
  `).all();
  const entries = rows.map(r => ({ id: r.id, title: r.title, tier: r.tier, patterns: JSON.parse(r.triggers) }));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries));
  renameSync(tmp, path);
  return entries.length;
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
