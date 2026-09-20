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
// The report keeps one stable line and one machine-readable row per prompt.
// compareHintProbeRows is the canonical way to pair saved baseline/candidate
// rows without duplicating scoring or mistaking a display excerpt for identity.
import { createHash } from 'crypto';
import { getDb } from '../db.js';
import { relevantNotes } from '../hint-relevance.js';
import { SURFACE } from '../retrieval.js';

const MAX_HINTS = 3;

// Enough to tell two prompts apart on one line without wrapping a terminal.
const PROMPT_EXCERPT = 64;
const PROMPT_SHA256 = /^[0-9a-f]{64}$/;

export const HINT_PROBE_STATUS = Object.freeze({
  ADDED: 'added',
  CHANGED: 'changed',
  REMOVED: 'removed',
  UNCHANGED: 'unchanged',
});

const excerpt = (prompt) => prompt.replace(/\s+/g, ' ').trim().slice(0, PROMPT_EXCERPT);
const promptDigest = prompt => createHash('sha256').update(prompt).digest('hex');
const hitIds = row => row.hits.map(hit => hit.id);

function indexRowsByPromptIdentity(rows, label) {
  const indexed = new Map();
  for (const row of rows) {
    if (!PROMPT_SHA256.test(row.prompt_sha256)) {
      throw new Error(`${label} row has invalid prompt_sha256`);
    }
    if (indexed.has(row.prompt_sha256)) {
      throw new Error(`${label} contains duplicate prompt identity ${row.prompt_sha256}`);
    }
    indexed.set(row.prompt_sha256, row);
  }
  return indexed;
}

function comparisonStatus(before, after) {
  if (after === null) return HINT_PROBE_STATUS.REMOVED;
  return JSON.stringify(hitIds(before)) === JSON.stringify(hitIds(after))
    ? HINT_PROBE_STATUS.UNCHANGED
    : HINT_PROBE_STATUS.CHANGED;
}

export function compareHintProbeRows(baselineRows, candidateRows) {
  const baseline = indexRowsByPromptIdentity(baselineRows, 'baseline');
  const candidate = indexRowsByPromptIdentity(candidateRows, 'candidate');
  const compared = [...baseline].map(([prompt_sha256, before]) => {
    const after = candidate.get(prompt_sha256) ?? null;
    candidate.delete(prompt_sha256);
    return {
      prompt_sha256,
      prompt: before.prompt,
      status: comparisonStatus(before, after),
      before,
      after,
    };
  });
  for (const [prompt_sha256, after] of [...candidate].sort(([a], [b]) => (
    a < b ? -1 : a > b ? 1 : 0
  ))) {
    compared.push({
      prompt_sha256,
      prompt: after.prompt,
      status: HINT_PROBE_STATUS.ADDED,
      before: null,
      after,
    });
  }
  return compared;
}

export function hintProbe(db = getDb(), { explain = false } = {}) {
  const prompts = db.prepare(
    'SELECT DISTINCT query FROM retrievals WHERE surface = ? AND query IS NOT NULL ORDER BY query'
  ).pluck().all(SURFACE.HINT);

  const rows = prompts.map(prompt => ({
    prompt_sha256: promptDigest(prompt),
    prompt: excerpt(prompt),
    hits: relevantNotes(prompt, { limit: MAX_HINTS, explain }).map(n => ({
      id: n.id,
      title: n.title,
      ...(explain ? { evidence: n.evidence } : {}),
    })),
  }));

  return { total: rows.length, fired: rows.filter(r => r.hits.length).length, rows };
}

export function runHintProbeCli(args = []) {
  const explain = args.includes('--explain');
  const report = hintProbe(undefined, { explain });
  const { total, fired, rows } = report;
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (!total) {
    console.log('No prompts recorded yet — the hint surface has not been asked anything.');
    return;
  }

  for (const row of rows) {
    const ids = row.hits.length ? row.hits.map(h => `#${h.id}`).join(' ') : 'DECLINE';
    console.log(`${ids.padEnd(20)} [${row.prompt_sha256.slice(0, 12)}] ${row.prompt}`);
    for (const hit of row.hits) {
      console.log(`${' '.repeat(20)}   #${hit.id} ${hit.title}`);
      if (explain) {
        const families = hit.evidence.families
          .map(family => `${family.terms.join('/')}[${family.sources.join('+')}]=${family.mass.toFixed(2)}`)
          .join(' + ');
        console.log(`${' '.repeat(20)}      ${families} => ${hit.evidence.total_mass.toFixed(2)} (min ${hit.evidence.min_mass.toFixed(2)})`);
      }
    }
  }

  const pct = Math.round((fired / total) * 100);
  console.log(`\n${fired} of ${total} prompts fire (${pct}%), ${total - fired} decline.`);
  console.log('Diff this against a run from before a scoring change — a widening that looks');
  console.log('free on the fixture is what this is for.');
}
