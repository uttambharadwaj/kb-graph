// Replay every prompt the hint has actually been asked about, against the
// scorer as it stands now.
//
// A fixture cannot settle a scoring change. Its off-topic probes are *topical*
// misses ("what is the weather forecast"), while the prompts that must decline
// in real use are conversational filler — "ok let's pin this and move on" —
// which shares vocabulary with note prose and with nothing in note titles. Two
// widenings have now looked free on the fixture and cost 15 and 8 false fires
// here. So the meter is the corpus: it already stores the prompt text and
// whether the hint fired, which makes it a replayable evaluation set nobody had
// to build.
//
// The report is deliberately one stable line per prompt: run it, change the
// scorer, run it again, diff the two. That is the whole workflow, and it needs
// no baseline file and no second code path to go stale.
import { getDb } from '../db.js';
import { relevantNotes } from '../hint-relevance.js';
import { SURFACE } from '../retrieval.js';

const MAX_HINTS = 3;

// Enough to tell two prompts apart on one line without wrapping a terminal.
const PROMPT_EXCERPT = 64;

const excerpt = (prompt) => prompt.replace(/\s+/g, ' ').trim().slice(0, PROMPT_EXCERPT);

export function hintProbe(db = getDb()) {
  const prompts = db.prepare(
    'SELECT DISTINCT query FROM retrievals WHERE surface = ? AND query IS NOT NULL ORDER BY query'
  ).pluck().all(SURFACE.HINT);

  const rows = prompts.map(prompt => ({
    prompt: excerpt(prompt),
    hits: relevantNotes(prompt, { limit: MAX_HINTS }).map(n => ({ id: n.id, title: n.title })),
  }));

  return { total: rows.length, fired: rows.filter(r => r.hits.length).length, rows };
}

export function runHintProbeCli() {
  const { total, fired, rows } = hintProbe();
  if (!total) {
    console.log('No prompts recorded yet — the hint surface has not been asked anything.');
    return;
  }

  for (const row of rows) {
    const ids = row.hits.length ? row.hits.map(h => `#${h.id}`).join(' ') : 'DECLINE';
    console.log(`${ids.padEnd(20)} ${row.prompt}`);
    for (const hit of row.hits) console.log(`${' '.repeat(20)}   #${hit.id} ${hit.title}`);
  }

  const pct = Math.round((fired / total) * 100);
  console.log(`\n${fired} of ${total} prompts fire (${pct}%), ${total - fired} decline.`);
  console.log('Diff this against a run from before a scoring change — a widening that looks');
  console.log('free on the fixture is what this is for.');
}
