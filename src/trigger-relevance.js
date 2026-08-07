// Command triggers: patterns that let a note warn BEFORE a Bash tool call
// runs, mirroring how filterAliases (src/hint-relevance.js) vets retrieval
// aliases. Same shape of problem — a model proposes, this grounds and caps —
// but the corpus here is historical Bash commands, not the document store,
// and the payoff is a hook firing on a live shell invocation, so a bad
// pattern is a false alarm on someone's terminal rather than a bad search
// result.
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
// The noise ceiling: a pattern common enough in real history to fire on
// ordinary work is not a warning, it's a nag.
const MAX_CORPUS_HIT_RATIO = 0.01;
// Below this the corpus is too small to grade a ceiling against — see the
// early return in filterTriggers.
const MIN_CORPUS_LINES = 500;

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

export function loadCommandCorpus(path = CORPUS_PATH) {
  try {
    return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map(normalize);
  } catch {
    return [];
  }
}

// The vet. Only what survives this ever reaches documents.triggers, and only
// documents.triggers ever reaches the hook.
export function filterTriggers(proposed, { title, content }, { corpus = loadCommandCorpus() } = {}) {
  const patterns = parseTriggerProposals(proposed).map(parts => parts.map(normalize));
  if (!patterns.length) return '';

  // A ceiling graded against too little history grades nothing — same stance
  // as filterAliases's "df of 0 means not indexed yet". A future --revet-style
  // pass catches these notes up once a corpus exists; nothing ungraded should
  // reach the hook in the meantime.
  if (corpus.length < MIN_CORPUS_LINES) return '';

  const noteText = normalize(`${title}\n${content}`);
  const hitCeiling = corpus.length * MAX_CORPUS_HIT_RATIO;
  const seen = new Set();
  const accepted = [];

  for (const parts of patterns) {
    if (parts.length > MAX_PATTERN_PARTS) continue;
    if (parts.some(p => p.length < MIN_PART_LEN)) continue;
    // Grounding: the note's own text must contain the command it warns
    // about, the same fabrication guard filterAliases applies to synonyms.
    if (parts.some(p => !noteText.includes(p))) continue;

    const key = parts.join('\0');
    if (seen.has(key)) continue;

    const hits = corpus.reduce((n, line) => n + (parts.every(p => line.includes(p)) ? 1 : 0), 0);
    // hits === 0 is kept: a pattern that never matched history is noise-free
    // by definition, not unproven — it just hasn't happened yet.
    if (hits > hitCeiling) continue;

    seen.add(key);
    accepted.push({ parts, hits });
  }

  if (!accepted.length) return '';
  const kept = accepted.sort((a, b) => a.hits - b.hits).slice(0, MAX_TRIGGER_PATTERNS);
  return JSON.stringify(kept);
}

// entries = [{ id, title, patterns: [{ parts, hits }] }], as loadTriggerIndex
// returns them. A note fires when ANY of its patterns has every part present
// in the command, in any position — this is a tripwire, not a parser.
export function matchCommand(command, entries, { alreadyFired = new Set() } = {}) {
  const normalized = normalize(command);
  const fired = [];
  for (const entry of entries) {
    if (alreadyFired.has(entry.id)) continue;
    let rarest = null;
    for (const { parts, hits } of entry.patterns || []) {
      if (parts.length && parts.every(p => normalized.includes(p))) {
        if (rarest === null || hits < rarest) rarest = hits;
      }
    }
    if (rarest !== null) fired.push({ id: entry.id, title: entry.title, hits: rarest });
  }
  return fired.sort((a, b) => a.hits - b.hits);
}

// The hook's read path has no lock on this file, so a rebuild must never
// leave it half-written — write to a temp file in the same directory and
// rename, which POSIX guarantees is atomic.
export function rebuildTriggerIndex(path = TRIGGER_INDEX_PATH) {
  const rows = getDb().prepare(`
    SELECT id, title, triggers FROM documents
    WHERE triggers IS NOT NULL AND superseded_at IS NULL AND doc_type != 'archive'
    ORDER BY id
  `).all();
  const entries = rows.map(r => ({ id: r.id, title: r.title, patterns: JSON.parse(r.triggers) }));
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
