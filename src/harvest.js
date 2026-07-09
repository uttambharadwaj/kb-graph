// Nightly auto-debrief: sweep agent session transcripts (Claude Code, and
// Codex where parseable) and extract durable knowledge without anyone typing
// /debrief. Facts go through kb_extract's consolidation (dedup +
// retire-on-contradiction); lessons go through writeNote (embedding dedup +
// related-links), tagged auto-debrief with the session as provenance.
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { getDb } from './db.js';
import { kbExtract } from './extract.js';
import { runClaudeJSON } from './claude-cli.js';
import { writeNote } from './write-note.js';

const CHUNK_CHARS = 12000;          // matches kb_extract's input window
const HEAD_CHUNKS = 4;              // long sessions: keep the setup...
const MAX_CHUNKS = 20;              // ...and the last 16 chunks (conclusions live at the end)
const MIN_TEXT_CHARS = 4000;        // below this a session taught us nothing durable
const MAX_SESSIONS_PER_RUN = 30;

export const LESSONS_PROMPT = `You are the auto-debrief for an engineering knowledge base. Read a work-session transcript and extract at most 3 durable knowledge notes.

Return ONLY valid JSON (no fencing):
{"notes": [{"title": "...", "type": "lesson|decision|workflow|idea|fix", "content": "...", "tags": "comma,separated", "project": "repo-name-or-empty"}]}

Keep a note ONLY if at least one is true:
- A future agent will hit this exact problem and waste time without it
- It is a non-obvious gotcha that contradicts reasonable assumptions
- It is a reusable pattern across repos, not a one-off
- A decision was made with reasoning that future work must respect

Drop: exploratory reads, transient back-and-forth, anything already obvious from code or docs, session-specific choices that won't matter next time.

Content must be self-contained markdown: what happened, why it matters, how to apply it. Title states the insight, not the activity ("X silently drops Y", not "Debugged X"). Use lowercase base repo names for project (e.g. my-app, backend, infra). If nothing qualifies, return {"notes": []}.`;

// --- transcript discovery ---------------------------------------------------

function* walkJsonl(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(full);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield full;
  }
}

export function findTranscripts({ sinceMs }) {
  const roots = [
    join(homedir(), '.claude', 'projects'),
    join(homedir(), '.codex', 'sessions'),
  ].filter(existsSync);

  const out = [];
  for (const root of roots) {
    for (const path of walkJsonl(root)) {
      try {
        const mtime = statSync(path).mtimeMs;
        if (mtime >= sinceMs) out.push({ path, mtime });
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
// lines ({type:'user'|'assistant', message:{...}}, main thread only) and
// Codex rollout lines ({payload:{type:'message', role, content}}); lines that
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
  return [...chunks.slice(0, HEAD_CHUNKS), ...chunks.slice(-(MAX_CHUNKS - HEAD_CHUNKS))];
}

// --- per-session harvest ----------------------------------------------------

async function harvestTranscript(path, mtime, { vaultPath, dryRun }) {
  const text = extractTranscriptText(readFileSync(path, 'utf-8'));
  if (text.length < MIN_TEXT_CHARS) return { skipped: 'too_short', facts: 0, notes: 0 };

  const source = `harvest:${basename(path, '.jsonl')}`;
  const observationDate = new Date(mtime).toISOString().split('T')[0];

  let facts = 0, chunkErrors = 0;
  for (const chunk of chunkText(text)) {
    try {
      const res = await kbExtract(chunk, { source, observationDate, dryRun });
      facts += dryRun ? (res.candidates?.length || 0) : (res.added?.length || 0);
    } catch {
      chunkErrors++; // one bad chunk shouldn't sink the transcript
    }
  }

  // One lessons pass per session: the opening frames the goal, the tail holds
  // the conclusions — that's where debrief-worthy material lives.
  const lessonsInput = text.length > 26000 ? text.slice(0, 6000) + '\n[...]\n' + text.slice(-20000) : text;
  // Restate the task AFTER the transcript — long USER:/ASSISTANT: dialogue
  // otherwise lures the model into continuing the conversation instead of extracting.
  const lessonsPrompt = `${LESSONS_PROMPT}\n\n# Transcript\n${lessonsInput}\n\n# End of transcript\nYou are the auto-debrief, not a participant in the conversation above. Return ONLY the {"notes": [...]} JSON object now.`;
  let notes = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      ({ notes = [] } = await runClaudeJSON(lessonsPrompt, { timeout: 120000 }));
      break;
    } catch (err) {
      console.error(`  lessons pass attempt ${attempt} failed: ${err.message}`); // transient CLI exits happen unattended
    }
  }

  let written = 0;
  for (const n of notes.slice(0, 3)) {
    if (!n?.title || !n?.content) continue;
    if (dryRun) { written++; continue; }
    const tags = [n.tags, 'auto-debrief'].filter(Boolean).join(',');
    const res = await writeNote(vaultPath, {
      title: n.title,
      content: n.content,
      type: ['lesson', 'decision', 'workflow', 'idea', 'fix'].includes(n.type) ? n.type : 'lesson',
      tags,
      project: n.project || undefined,
      source,
    });
    if (!res.skipped) written++;
  }

  return { facts, notes: written, chunkErrors };
}

// --- orchestrator -----------------------------------------------------------

export async function runHarvest({ sinceHours = 26, dryRun = false, onlyPath = null } = {}) {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH || join(homedir(), '.claude', 'kb-index');
  const db = getDb();

  let candidates = onlyPath
    ? [{ path: onlyPath, mtime: statSync(onlyPath).mtimeMs }]
    : findTranscripts({ sinceMs: Date.now() - sinceHours * 3600 * 1000 });

  // Watermark: skip transcripts we already harvested at this mtime.
  const seen = db.prepare('SELECT mtime FROM harvest_log WHERE transcript_path = ?');
  candidates = candidates.filter(c => (seen.get(c.path)?.mtime || 0) < c.mtime);

  if (candidates.length > MAX_SESSIONS_PER_RUN) {
    console.log(`Capping run to ${MAX_SESSIONS_PER_RUN} of ${candidates.length} sessions (rest picked up next run)`);
    candidates = candidates.slice(-MAX_SESSIONS_PER_RUN);
  }

  const summary = { sessions: 0, facts: 0, notes: 0, errors: 0 };
  for (const { path, mtime } of candidates) {
    try {
      const r = await harvestTranscript(path, mtime, { vaultPath, dryRun });
      if (r.skipped) {
        // Watermark short sessions too — no point re-reading them nightly.
        if (!dryRun) db.prepare('INSERT OR REPLACE INTO harvest_log (transcript_path, mtime) VALUES (?, ?)').run(path, mtime);
        continue;
      }
      summary.sessions++;
      summary.facts += r.facts;
      summary.notes += r.notes;
      if (!dryRun) {
        db.prepare(
          'INSERT OR REPLACE INTO harvest_log (transcript_path, mtime, facts_added, notes_added) VALUES (?, ?, ?, ?)'
        ).run(path, mtime, r.facts, r.notes);
      }
      console.log(`${basename(path)}: ${r.facts} facts, ${r.notes} notes${r.chunkErrors ? `, ${r.chunkErrors} chunk errors` : ''}${dryRun ? ' (dry run)' : ''}`);
    } catch (err) {
      summary.errors++;
      console.error(`${basename(path)}: ${err.message}`);
      // No watermark update — retried next run.
    }
  }

  console.log(`Harvest done: ${summary.sessions} sessions, ${summary.facts} facts, ${summary.notes} notes, ${summary.errors} errors`);

  // Fold any fresh session notes into their workstream state notes so state
  // stays current nightly without a separate job. No-ops when nothing is fresh.
  if (!dryRun) {
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
  return summary;
}

export async function runHarvestCli(args) {
  const dryRun = args.includes('--dry-run');
  const sinceFlag = args.find(a => a.startsWith('--since-hours='));
  const pathFlag = args.find(a => a.startsWith('--path='));
  await runHarvest({
    sinceHours: sinceFlag ? parseInt(sinceFlag.split('=')[1], 10) : 26,
    dryRun,
    onlyPath: pathFlag ? pathFlag.split('=')[1] : null,
  });
}
