// Nightly auto-debrief: sweep agent session transcripts (Claude Code, Cursor,
// and Codex where parseable) and write durable knowledge without anyone typing
// /debrief. Lessons go through writeNote (embedding dedup + related-links),
// tagged auto-debrief with the session as provenance; facts, when enabled,
// go through kb_extract's consolidation (dedup + retire-on-contradiction).
import { createHash } from 'crypto';
import { readdirSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { getDb, setMeta } from './db.js';
import { kbExtract, MAX_EXTRACT_CHARS } from './extract.js';
import { sqlTimestamp } from './facts.js';
import { runClaudeJSON } from './claude-cli.js';
import { writeNote } from './write-note.js';
import { HARVEST_SOURCE_PREFIX } from './tiers.js';

// Derived, not copied: a chunk wider than kb_extract's window would be
// truncated there, and this caller reads only added/candidates so the
// truncation report would go nowhere.
const CHUNK_CHARS = MAX_EXTRACT_CHARS;
const MAX_CHUNKS = 20;              // bounded per run; later runs resume at the next checkpoint
const MIN_TEXT_CHARS = 4000;        // below this a session taught us nothing durable
const LESSONS_HEAD_CHARS = 6000;    // the opening frames the goal...
const LESSONS_TAIL_CHARS = 20000;   // ...and the conclusions land at the end
const LESSON_CHARS = LESSONS_HEAD_CHARS + LESSONS_TAIL_CHARS;
const MAX_LESSON_CHUNKS_PER_RUN = 2;
const MAX_LEGACY_BACKFILL_CANDIDATES = 1000;
export const MAX_SESSIONS_PER_RUN = 30;

// A transcript still being appended to belongs to a session that is still
// happening, and harvesting it writes lessons the human is in the middle of
// writing by hand — so the automatic near-duplicate lands before the note it
// duplicates, and the human's own write is the one that gets refused.
// Quiescence is the only end-of-session signal the file gives. Being wrong in
// this direction costs one night's delay on a session that merely went quiet;
// being wrong the other way corrupts deliberate capture, which is the capture
// worth having.
const QUIESCENT_MS = 30 * 60 * 1000;
const isInFlight = (mtime) => Date.now() - mtime < QUIESCENT_MS;

// Fact extraction is off unless asked for. It runs kb_extract over every chunk
// of every transcript, which is where nearly all of this job's token cost went,
// and unattended it writes against an open predicate vocabulary — 77% of the
// resulting graph was entities mentioned once that no later fact ever matched.
// The lessons pass is one call per session and stays on. Facts are better
// chosen than swept: that is what /debrief's kb_extract call is for.
export const factsRequested = ({ facts } = {}) =>
  facts ?? ['1', 'true', 'yes'].includes((process.env.KB_HARVEST_FACTS || '').toLowerCase());

export const LESSONS_PROMPT = `You are the auto-debrief for an engineering knowledge base. Read a work-session transcript and extract at most 3 durable knowledge notes.

Return ONLY valid JSON (no fencing):
{"notes": [{"title": "...", "type": "lesson|decision|workflow|idea|fix", "content": "...", "tags": "comma,separated", "project": "repo-name-or-empty"}]}

Keep a note ONLY if at least one is true:
- A future agent will hit this exact problem and waste time without it
- It is a non-obvious gotcha that contradicts reasonable assumptions
- It is a reusable pattern across repos, not a one-off
- A decision was made with reasoning that future work must respect

Drop: exploratory reads, transient back-and-forth, anything already obvious from code or docs, session-specific choices that won't matter next time.

Content must be self-contained markdown: what happened, why it matters, how to apply it. Title states the insight, not the activity ("X silently drops Y", not "Debugged X").
- Preserve evidence strength and measurement method. A customer or third party reporting a number is anecdotal unless the transcript explicitly describes a controlled measurement. Say "reported" or "anecdotal" and name the method when stated (for example, "via chat UI"). Never upgrade a report into a benchmark, counter-proof, falsification, or measured result.

Use lowercase base repo names for project (e.g. my-app, backend, infra). If nothing qualifies, return {"notes": []}.`;

export function buildLessonsPrompt(text) {
  return `${LESSONS_PROMPT}\n\n# Transcript\n${text}\n\n# End of transcript\nYou are the auto-debrief, not a participant in the conversation above. Return ONLY the {"notes": [...]} JSON object now.`;
}

// --- transcript discovery ---------------------------------------------------

// Every `claude -p` this server runs — extraction, classification, summaries —
// writes a transcript like any session, so without this the harvest reads its
// own prompts back and each night's calls become the next night's input.
//
// What the marker proves is "print mode", not "ours": the CLI stamps 'sdk-cli'
// on any non-interactive run and 'cli' on an interactive one. That is the right
// default — a print-mode run is a tool call, not a work session — but someone
// who drives Claude Code headlessly and wants that harvested sets
// KB_HARVEST_SDK_SESSIONS=1. Note that claude-cli.js passes
// CLAUDE_CODE_ENTRYPOINT=cli and the CLI overrides it; do not "fix" either side
// to agree with the other.
//
// Only the head is read — the field sits in the opening records and these files
// run to megabytes. A marker past the window, or none at all, means the
// transcript is harvested: an unrecognised format must not silently swallow
// real work.
const PRINT_MODE_ENTRYPOINT = 'sdk-cli';
const ENTRYPOINT_SCAN_BYTES = 65536;
const HARVEST_CURSOR_META_KEY = 'harvest_backfill_cursor_path';
const headBuffer = Buffer.allocUnsafe(ENTRYPOINT_SCAN_BYTES); // reused: this is synchronous and not reentrant

export function isPrintModeTranscript(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const read = readSync(fd, headBuffer, 0, headBuffer.length, 0);
    const found = headBuffer.toString('utf8', 0, read).match(/"entrypoint"\s*:\s*"([^"]*)"/);
    return found?.[1] === PRINT_MODE_ENTRYPOINT;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already gone */ }
  }
}

export function isActualSubagentTranscript(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const read = readSync(fd, headBuffer, 0, headBuffer.length, 0);
    const head = headBuffer.toString('utf8', 0, read);
    return /"thread_source"\s*:\s*"subagent"/.test(head)
      || /"source"\s*:\s*\{\s*"subagent"\s*:\s*\{\s*"thread_spawn"/.test(head);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already gone */ }
  }
}

export const harvestsPrintModeSessions = () =>
  ['1', 'true', 'yes'].includes((process.env.KB_HARVEST_SDK_SESSIONS || '').toLowerCase());

function* walkJsonl(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(full);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield full;
  }
}

function defaultTranscriptRoots(homeDir) {
  const cursorProjects = join(homeDir, '.cursor', 'projects');
  let cursorRoots = [];
  try {
    cursorRoots = readdirSync(cursorProjects, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(cursorProjects, entry.name, 'agent-transcripts'));
  } catch { /* Cursor is not installed or has no projects yet */ }

  return [
    join(homeDir, '.claude', 'projects'),
    join(homeDir, '.codex', 'sessions'),
    ...cursorRoots,
  ];
}

export function findTranscripts({ sinceMs, searchRoots, homeDir = homedir() }) {
  const roots = (searchRoots || defaultTranscriptRoots(homeDir)).filter(existsSync);

  const out = [];
  for (const root of roots) {
    for (const path of walkJsonl(root)) {
      try {
        const mtime = statSync(path).mtimeMs;
        if (sinceMs === undefined || mtime >= sinceMs) out.push({ path, mtime });
      } catch { /* raced deletion */ }
    }
  }
  out.sort((a, b) => a.mtime - b.mtime);
  return out;
}

// --- transcript parsing -----------------------------------------------------

function blocksToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(b => (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') && b.text)
    .map(b => b.text)
    .join('\n');
}

// Pull user/assistant text turns out of a session JSONL. Handles Claude Code
// lines ({type:'user'|'assistant', message:{...}}, main thread only), Codex
// rollout lines ({payload:{type:'message', role, content}}) and Cursor lines
// ({role, message:{content}}); lines that
// match neither shape are skipped, so new formats degrade to "nothing" not a crash.
export function extractTranscriptText(raw) {
  const parts = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    let role = null, text = '';
    if ((obj.type === 'user' || obj.type === 'assistant') && obj.message && !obj.isSidechain) {
      role = obj.type;
      text = blocksToText(obj.message.content);
    } else if (obj.payload?.type === 'message' && obj.payload.role) {
      role = obj.payload.role;
      text = blocksToText(obj.payload.content);
    } else if ((obj.role === 'user' || obj.role === 'assistant') && obj.message) {
      // Cursor agent-transcripts: top-level role, no type.
      role = obj.role;
      text = blocksToText(obj.message.content);
    }

    if (role && text.trim() && !text.startsWith('<system-reminder>')) {
      parts.push(`${role.toUpperCase()}: ${text.trim()}`);
    }
  }
  return parts.join('\n\n');
}

export function chunkText(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK_CHARS) chunks.push(text.slice(i, i + CHUNK_CHARS));
  if (chunks.length <= MAX_CHUNKS) return chunks;
  return chunks.slice(0, MAX_CHUNKS);
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function chunkTextWithIdentity(text, { size, maxChunks = Infinity } = {}) {
  const chunks = [];
  for (let start = 0, index = 0; start < text.length && chunks.length < maxChunks; start += size, index++) {
    const end = Math.min(text.length, start + size);
    const chunk = text.slice(start, end);
    chunks.push({ index, start, end, text: chunk, hash: hashText(chunk) });
  }
  return chunks;
}

function completedChunkKeys(db, transcriptPath, pass) {
  try {
    const rows = db.prepare(`
      SELECT chunk_index, start_char, end_char, input_hash
      FROM harvest_chunk_log
      WHERE transcript_path = ? AND pass = ? AND error_count = 0
    `).all(transcriptPath, pass);
    return new Set(rows.map(row => `${row.chunk_index}:${row.start_char}:${row.end_char}:${row.input_hash}`));
  } catch (err) {
    if (err.message?.includes('no such table')) return new Set();
    throw err;
  }
}

function chunkKey(chunk) {
  return `${chunk.index}:${chunk.start}:${chunk.end}:${chunk.hash}`;
}

function pendingChunks(db, transcriptPath, pass, chunks) {
  const done = completedChunkKeys(db, transcriptPath, pass);
  return chunks.filter(chunk => !done.has(chunkKey(chunk)));
}

function recordChunkComplete(db, { transcriptPath, pass, chunk, notes = null, facts = null }) {
  db.prepare(`
    INSERT OR IGNORE INTO harvest_chunk_log
      (transcript_path, pass, chunk_index, start_char, end_char, input_hash, notes_added, facts_added)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(transcriptPath, pass, chunk.index, chunk.start, chunk.end, chunk.hash, notes, facts);
}

function completedChunkTotal(db, transcriptPath, pass, column) {
  return db.prepare(`
    SELECT COALESCE(SUM(${column}), 0) AS n
    FROM harvest_chunk_log
    WHERE transcript_path = ? AND pass = ? AND error_count = 0
  `).get(transcriptPath, pass).n;
}

function coverageFor(db, transcriptPath, pass, chunks) {
  return {
    total: chunks.length,
    pending: pendingChunks(db, transcriptPath, pass, chunks).length,
  };
}

function hasCompleteCoverage(db, transcriptPath, text, wantFacts) {
  if (text.length < MIN_TEXT_CHARS) return true;
  const lessons = coverageFor(db, transcriptPath, 'lessons', chunkTextWithIdentity(text, { size: LESSON_CHARS }));
  if (lessons.pending) return false;
  if (!wantFacts) return true;
  const facts = coverageFor(db, transcriptPath, 'facts', chunkTextWithIdentity(text, { size: CHUNK_CHARS }));
  return facts.pending === 0;
}

function isHarvestableTranscript(path) {
  return (harvestsPrintModeSessions() || !isPrintModeTranscript(path))
    && !isActualSubagentTranscript(path);
}

function isHistoricalBackfillCandidate(db, transcriptPath, wantFacts) {
  try {
    if (!existsSync(transcriptPath)) return false;
    if (!isHarvestableTranscript(transcriptPath)) return false;
    const text = extractTranscriptText(readFileSync(transcriptPath, 'utf-8'));
    if (text.length < MIN_TEXT_CHARS) return false;
    return !hasCompleteCoverage(db, transcriptPath, text, wantFacts);
  } catch {
    return false;
  }
}

function historicalBackfillRows(db) {
  try {
    return db.prepare(`
      SELECT transcript_path, mtime
      FROM harvest_log
      ORDER BY harvested_at, transcript_path
      LIMIT ?
    `).all(MAX_LEGACY_BACKFILL_CANDIDATES);
  } catch {
    return [];
  }
}

function compareCandidate(a, b) {
  return a.mtime - b.mtime || a.path.localeCompare(b.path);
}

function readHarvestCursor(db) {
  const value = db.prepare('SELECT value FROM meta WHERE key = ?').get(HARVEST_CURSOR_META_KEY)?.value;
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed?.path === 'string' && Number.isFinite(parsed.mtime)) return parsed;
  } catch {
    // Older installs stored only the path. Fall back to exact-path rotation.
  }
  return { path: value, mtime: null };
}

function rotateAfterCursor(items, cursor) {
  if (!cursor) return items;
  if (Number.isFinite(cursor.mtime)) {
    const successor = items.findIndex(candidate => compareCandidate(candidate, cursor) > 0);
    return successor >= 0
      ? [...items.slice(successor), ...items.slice(0, successor)]
      : items;
  }
  const cursorIndex = items.findIndex(candidate => candidate.path === cursor.path);
  return cursorIndex >= 0
    ? [...items.slice(cursorIndex + 1), ...items.slice(0, cursorIndex + 1)]
    : items;
}

function historicalBackfillMetadata(db, seenPaths, discovered = []) {
  const rows = new Map();
  for (const row of historicalBackfillRows(db)) rows.set(row.transcript_path, row);
  for (const item of discovered) {
    if (!seenPaths.has(item.path)) rows.set(item.path, item);
  }
  return [...rows.values()].flatMap(row => {
    const transcriptPath = row.transcript_path || row.path;
    if (seenPaths.has(transcriptPath)) return [];
    try {
      const mtime = statSync(transcriptPath).mtimeMs;
      if (isInFlight(mtime) || !isHarvestableTranscript(transcriptPath)) return [];
      return [{ path: transcriptPath, mtime, historicalBackfill: true }];
    } catch {
      return [];
    }
  });
}

function selectHarvestWork(db, recentCandidates, historicalCandidates, wantFacts, { dryRun = false } = {}) {
  const ordered = [...recentCandidates, ...historicalCandidates].sort(compareCandidate);
  if (ordered.length <= MAX_SESSIONS_PER_RUN && historicalCandidates.length === 0) {
    return { work: ordered, pending: ordered.length };
  }

  const work = [];
  const historicalPending = [];
  let checkedHistorical = 0;
  let cursorCandidate = null;
  let cursorLockedToHistorical = false;
  for (const candidate of rotateAfterCursor(ordered, readHarvestCursor(db))) {
    if (work.length >= MAX_SESSIONS_PER_RUN) break;
    if (candidate.historicalBackfill) {
      if (checkedHistorical >= MAX_SESSIONS_PER_RUN) continue;
      checkedHistorical++;
      cursorCandidate = candidate;
      cursorLockedToHistorical = true;
      if (!isHistoricalBackfillCandidate(db, candidate.path, wantFacts)) continue;
      historicalPending.push(candidate);
    } else {
      if (!cursorLockedToHistorical) cursorCandidate = candidate;
    }
    work.push(candidate);
  }

  if (!dryRun && cursorCandidate) {
    setMeta(HARVEST_CURSOR_META_KEY, JSON.stringify({ path: cursorCandidate.path, mtime: cursorCandidate.mtime }));
  }
  return { work: work.sort(compareCandidate), pending: recentCandidates.length + historicalPending.length };
}

// --- per-session harvest ----------------------------------------------------

async function harvestTranscript(path, mtime, { vaultPath, dryRun, facts: wantFacts, db = getDb() }) {
  const text = extractTranscriptText(readFileSync(path, 'utf-8'));
  if (text.length < MIN_TEXT_CHARS) {
    return {
      skipped: 'too_short', facts: 0, notes: 0, coverageComplete: true, coveragePending: 0, partialProgress: false,
    };
  }

  // The prefix is what caps every note this pass writes at the lowest tier —
  // see src/tiers.js, which owns it.
  const source = `${HARVEST_SOURCE_PREFIX}${basename(path, '.jsonl')}`;

  let facts = 0, chunkErrors = 0, factsUnread = 0, contested = 0;
  if (wantFacts) {
    const observationDate = new Date(mtime).toISOString().split('T')[0];
    // The instant, not just the day: a transcript from this morning must not
    // overwrite a fact a session recorded this afternoon.
    const observedAt = sqlTimestamp(new Date(mtime));

    const factChunks = chunkTextWithIdentity(text, { size: CHUNK_CHARS });
    const chunks = pendingChunks(db, path, 'facts', factChunks).slice(0, MAX_CHUNKS);

    for (const chunk of chunks) {
      try {
        const res = await kbExtract(chunk.text, { source, observationDate, observedAt, dryRun });
        facts += dryRun ? (res.candidates?.length || 0) : (res.added?.length || 0);
        // A pair the chunk gave two values for is left unretired for a human to
        // settle. This runs unattended, so the count is the only place it
        // surfaces at all.
        contested += res.conflicts?.length || 0;
        if (!dryRun) recordChunkComplete(db, { transcriptPath: path, pass: 'facts', chunk, facts: dryRun ? (res.candidates?.length || 0) : (res.added?.length || 0) });
      } catch {
        chunkErrors++; // one bad chunk shouldn't sink the transcript
      }
    }
    factsUnread = pendingChunks(db, path, 'facts', factChunks).reduce((n, chunk) => n + (chunk.end - chunk.start), 0);
  }

  let written = 0, lessonErrors = 0;
  const lessonChunks = chunkTextWithIdentity(text, { size: LESSON_CHARS });
  const lessonsToRead = pendingChunks(db, path, 'lessons', lessonChunks).slice(0, MAX_LESSON_CHUNKS_PER_RUN);
  for (const chunk of lessonsToRead) {
    const lessonsPrompt = buildLessonsPrompt(chunk.text);
    let notes = [];
    let ok = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        ({ notes = [] } = await runClaudeJSON(lessonsPrompt, { timeout: 120000, caller: 'harvest' }));
        ok = true;
        break;
      } catch (err) {
        console.error(`  lessons pass attempt ${attempt} failed: ${err.message}`); // transient CLI exits happen unattended
      }
    }
    if (!ok) {
      lessonErrors++;
      continue;
    }

    let chunkWritten = 0;
    for (const n of notes.slice(0, 3)) {
      if (!n?.title || !n?.content) continue;
      if (dryRun) { chunkWritten++; continue; }
      const tags = [n.tags, 'auto-debrief'].filter(Boolean).join(',');
      const res = await writeNote(vaultPath, {
        title: n.title,
        content: n.content,
        type: ['lesson', 'decision', 'workflow', 'idea', 'fix'].includes(n.type) ? n.type : 'lesson',
        tags,
        project: n.project || undefined,
        source,
      });
      if (!res.skipped) chunkWritten++;
    }
    written += chunkWritten;
    if (!dryRun) recordChunkComplete(db, { transcriptPath: path, pass: 'lessons', chunk, notes: chunkWritten });
  }

  const lessonsUnread = pendingChunks(db, path, 'lessons', lessonChunks).reduce((n, chunk) => n + (chunk.end - chunk.start), 0);
  const coveragePending = lessonsUnread + factsUnread;
  return {
    facts,
    notes: written,
    chunkErrors,
    lessonErrors,
    contested,
    unreadByLessons: lessonsUnread,
    unreadByFacts: factsUnread,
    coverageComplete: coveragePending === 0,
    coveragePending,
    partialProgress: (lessonsToRead.length > 0 || (wantFacts && factsUnread > 0)) && coveragePending > 0,
  };
}

// --- orchestrator -----------------------------------------------------------

// The watermark is per pass, not per transcript: a session harvested for
// lessons alone has no facts yet, so a later run with extraction enabled must
// see it again. Keying only on mtime would make turning the flag on a no-op
// for everything already swept.
export function stillPending(db, candidates, wantFacts) {
  const seen = db.prepare('SELECT mtime, facts_added FROM harvest_log WHERE transcript_path = ?');
  return candidates.filter(c => {
    const row = seen.get(c.path);
    if (!row || row.mtime < c.mtime) return true;
    return wantFacts && row.facts_added === null;
  });
}

// Drain in arrival order. Taking the newest starves the tail permanently:
// sessions arrive faster than the cap, and one that ages out of the discovery
// window stops being a candidate at all, so it is never harvested by anything.
// Sorts rather than trusting the caller — the guarantee belongs here.
export const selectWork = candidates =>
  [...candidates].sort((a, b) => a.mtime - b.mtime).slice(0, MAX_SESSIONS_PER_RUN);

export async function runHarvest({ sinceHours = 26, dryRun = false, onlyPath = null, facts, searchRoots, sessionId = null, recordOutcomes = null, maintenance = true, runMaintenance = null, harvestOne = harvestTranscript } = {}) {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH || join(homedir(), '.claude', 'kb-index');
  const db = getDb();
  const wantFacts = factsRequested({ facts });

  // An explicit --path is an instruction, not a sweep: run it whatever the
  // watermark says, and whatever wrote it.
  let candidates, work = null, pending = 0, printModeCalls = 0, inFlight = 0;
  if (onlyPath) {
    candidates = [{ path: onlyPath, mtime: statSync(onlyPath).mtimeMs, sessionId }];
  } else {
    const sinceMs = Date.now() - sinceHours * 3600 * 1000;
    const allFound = findTranscripts({ searchRoots });
    const found = allFound.filter(t => t.mtime >= sinceMs);
    const userSessions = found.filter(t => !isActualSubagentTranscript(t.path));
    const sessions = userSessions.filter(t => harvestsPrintModeSessions() || !isPrintModeTranscript(t.path));
    printModeCalls = userSessions.length - sessions.length;
    const quiet = sessions.filter(t => !isInFlight(t.mtime));
    inFlight = sessions.length - quiet.length;
    candidates = stillPending(db, quiet, wantFacts);
    const seenPaths = new Set([...found.map(t => t.path), ...candidates.map(t => t.path)]);
    const historical = historicalBackfillMetadata(db, seenPaths, allFound.filter(t => t.mtime < sinceMs));
    ({ work, pending } = selectHarvestWork(db, candidates, historical, wantFacts, { dryRun }));
  }

  if (work === null) {
    work = selectWork(candidates);
    pending = candidates.length;
  }

  const summary = { sessions: 0, facts: 0, notes: 0, errors: 0, transcriptErrors: 0, chunkErrors: 0, lessonErrors: 0, pending, tooShort: 0, partial: 0, contested: 0,
    unreadByLessons: 0, unreadByFacts: 0, coverageComplete: true, coveragePending: 0, partialProgress: false,
    notReached: pending - work.length, printModeCalls, inFlight };
  for (const { path, mtime, sessionId: candidateSessionId = null } of work) {
    try {
      const r = await harvestOne(path, mtime, { vaultPath, dryRun, facts: wantFacts, db });
      if (r.skipped) {
        summary.tooShort++;
        // Watermark short sessions too — no point re-reading them nightly.
        if (!dryRun) db.prepare('INSERT OR REPLACE INTO harvest_log (transcript_path, mtime) VALUES (?, ?)').run(path, mtime);
        continue;
      }
      summary.sessions++;
      summary.facts += r.facts;
      summary.notes += r.notes;
      summary.chunkErrors += r.chunkErrors || 0;
      summary.lessonErrors += r.lessonErrors || 0;
      const recoverableErrors = (r.chunkErrors || 0) + (r.lessonErrors || 0);
      summary.errors += recoverableErrors;
      if (!dryRun && r.coverageComplete && recoverableErrors === 0) {
        // NULL facts_added means extraction did not run, which is what lets a
        // later --facts pass pick this transcript up again. 0 means it ran and
        // found none, and is final.
        const notesAdded = completedChunkTotal(db, path, 'lessons', 'notes_added');
        const factsAdded = wantFacts ? completedChunkTotal(db, path, 'facts', 'facts_added') : null;
        db.prepare(
          'INSERT OR REPLACE INTO harvest_log (transcript_path, mtime, facts_added, notes_added) VALUES (?, ?, ?, ?)'
        ).run(path, mtime, factsAdded, notesAdded);
        try {
          const outcomeRecorder = recordOutcomes || (await import('./retrieval-outcomes.js')).recordRetrievalOutcomesForSession;
          await outcomeRecorder({ sessionId: candidateSessionId, transcriptPath: path, transcriptMtime: mtime });
        } catch (err) {
          if (err.code !== 'ERR_MODULE_NOT_FOUND') console.error(`retrieval outcome feedback failed: ${err.message}`);
        }
      }
      const gaps = [
        r.unreadByLessons && `${r.unreadByLessons.toLocaleString('en-US')} chars unread by the lessons pass`,
        r.unreadByFacts && `${r.unreadByFacts.toLocaleString('en-US')} chars unread by the fact pass`,
      ].filter(Boolean);
      if (gaps.length) summary.partial++;
      summary.unreadByLessons += r.unreadByLessons;
      summary.unreadByFacts += r.unreadByFacts;
      summary.coverageComplete &&= !!r.coverageComplete;
      summary.coveragePending += r.coveragePending || 0;
      summary.partialProgress ||= !!r.partialProgress;

      // Say "facts" only when they were asked for, so a run with the extraction
      // off cannot read as one that looked and found nothing.
      const factPart = wantFacts ? `${r.facts} facts, ` : '';
      summary.contested += r.contested;
      console.log(`${basename(path)}: ${factPart}${r.notes} notes${gaps.map(g => `, ${g}`).join('')}${r.contested ? `, ${r.contested} contested pairs` : ''}${r.chunkErrors ? `, ${r.chunkErrors} chunk errors` : ''}${r.lessonErrors ? ', lessons extraction failed' : ''}${dryRun ? ' (dry run)' : ''}`);
    } catch (err) {
      summary.transcriptErrors++;
      summary.errors++;
      console.error(`${basename(path)}: ${err.message}`);
      // No watermark update — retried next run.
    }
  }

  const doneFacts = wantFacts ? `${summary.facts} facts, ` : 'fact extraction off, ';
  console.log(`Harvest done: ${summary.sessions} sessions, ${doneFacts}${summary.notes} notes, ${summary.errors} errors (${summary.transcriptErrors} transcript, ${summary.chunkErrors} chunk, ${summary.lessonErrors} lessons)`);
  // Everything the run passed over, so the totals account for the whole queue.
  if (summary.tooShort) console.log(`${summary.tooShort} sessions too short to harvest`);
  if (summary.partial) console.log(`${summary.partial} sessions were only partly read — see the per-session lines above`);
  if (summary.contested) console.log(`${summary.contested} pairs were given two values in one call and left unretired — kb_fact_query them and retire the dead ones`);
  if (summary.notReached) console.log(`Backlog: ${summary.notReached} of ${summary.pending} pending sessions not reached this run`);
  if (summary.printModeCalls) console.log(`Skipped ${summary.printModeCalls} print-mode (SDK) transcripts — set KB_HARVEST_SDK_SESSIONS=1 to harvest them`);
  if (summary.inFlight) console.log(`Left ${summary.inFlight} sessions still in progress for the next run`);

  // Fold any fresh session notes into their workstream state notes so state
  // stays current nightly without a separate job. Capture-only lifecycle calls
  // pass maintenance=false because their caller only needs this transcript's
  // coverage result and receipt state.
  if (!dryRun) {
    setMeta('last_harvest', String(summary.sessions));
    setMeta('last_harvest_errors', String(summary.errors));
  }
  if (!dryRun && maintenance) {
    if (runMaintenance) {
      await runMaintenance({ vaultPath });
    } else {
      try {
        const { runConsolidateState } = await import('./state.js');
        await runConsolidateState({ vaultPath });
      } catch (err) {
        console.error(`state consolidation failed: ${err.message}`);
      }
      // Summaries have no other scheduled writer — sweep the stragglers nightly
      // so kb_context briefings never regress to raw snippets again.
      try {
        const { summarizeUnsummarized } = await import('./classify/summarizer.js');
        const s = await summarizeUnsummarized(vaultPath, { limit: 60 });
        if (s.total) console.log(`summaries: ${s.summarized}/${s.total} backfilled`);
      } catch (err) {
        console.error(`summary sweep failed: ${err.message}`);
      }
    }
  }
  return summary;
}

export async function runHarvestCli(args) {
  const dryRun = args.includes('--dry-run');
  const sinceFlag = args.find(a => a.startsWith('--since-hours='));
  const pathFlag = args.find(a => a.startsWith('--path='));
  // Both spellings, so a single run can override the env var either way; last one wins.
  const factFlags = args.filter(a => a === '--facts' || a === '--no-facts');
  const facts = factFlags.length ? factFlags.at(-1) === '--facts' : undefined;
  await runHarvest({
    sinceHours: sinceFlag ? parseInt(sinceFlag.split('=')[1], 10) : 26,
    dryRun,
    facts,
    onlyPath: pathFlag ? pathFlag.split('=')[1] : null,
  });
}
