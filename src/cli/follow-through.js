// `kb follow-through` — does anyone act on what gets pushed at them?
//
// Read-only over the retrievals table (plus the trigger-hook's JSONL fire
// log, which has no DB row at all). Never touches the write path.
//
// UNIT = event, not row. A hint prompt writes up to MAX_HINTS doc rows (or one
// null-doc decline row); a briefing SessionStart writes one row per state
// note; a kb_search/kb_context/kb_tunnels call writes one row per result.
// Every one of those write sites now stamps a shared event_id at call time
// (see retrieval.js's logRetrievalResults doc comment); rows written before
// that carry event_id NULL and are reconstructed from (session, surface,
// created_at, query) — the same batching every pre-event_id caller already
// used, since one call's rows are inserted in a single synchronous loop and
// land on the same DB-side timestamp with the same query string. query is
// folded into the legacy key (not just session/surface/timestamp) because two
// DIFFERENT calls in the same session in the same second are otherwise
// indistinguishable from one call with several results. Rows from one real
// call always share one query, so this can only ever separate two calls that
// were wrongly merged before — it can never split a real call's own rows
// apart. It is not a complete fix: two different calls in the same second
// with the identical query string still merge, which is the residual risk
// event_id at write time is the actual fix for. A surface that only ever
// writes one row per call (kb_read) gets one-row groups for free from the
// same key, so nothing surface-specific is needed to handle it.
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getDb } from '../db.js';
import { isTestSession, READ_SURFACES, SURFACE } from '../retrieval.js';
import { TRIGGERS_LOG_DIR } from './trigger-hook.js';
import { acceptFlags } from './flags.js';

const WINDOW_MS = 30 * 60 * 1000;
// Task notifications and subagent reports can land in the `query` column when
// a prompt-hint run raced the HARNESS_ENVELOPE guard in an older build (or
// pre-dates it) — see prompt-hint.js. Only checked against hint rows: query
// on every other surface is a deliberate search string, not a harness-shaped
// prompt.
const ENVELOPE_RE = /^<(agent-message|task-notification)/;

const pct = (n, of) => (of > 0 ? `${((n / of) * 100).toFixed(1)}%` : 'n/a');

// SQLite's CURRENT_TIMESTAMP writes "YYYY-MM-DD HH:MM:SS" with no timezone
// marker, which is UTC. Fixture rows (and the trigger JSONL log) use
// toISOString()'s "YYYY-MM-DDTHH:MM:SS.sssZ". Normalizing the first shape
// into the second, rather than letting Date() guess, keeps window math
// identical to production and to `node --test` regardless of the box's local
// timezone.
function toMs(ts) {
  if (ts == null) return null;
  const iso = ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}

// One key per decision: event_id when the row has one, else the
// (session, surface, created_at, query) quadruple every legacy caller already
// batched on — query included because same-second parallel calls on a
// multi-row surface are otherwise indistinguishable (see the file header).
// Rows with no session collapse together under this key regardless of
// surface/time/query — harmless, since NULL-session events are reported as
// unattributable and excluded from every rate below, never joined.
function eventKey(row) {
  return row.event_id != null ? `id:${row.event_id}` : `ts:${row.session}|${row.surface}|${row.created_at}|${row.query}`;
}

function groupEvents(rows) {
  const events = new Map();
  for (const row of rows) {
    const key = eventKey(row);
    let ev = events.get(key);
    if (!ev) {
      ev = { session: row.session, surface: row.surface, query: row.query, createdAt: row.created_at, docIds: new Set(), isTest: false };
      events.set(key, ev);
    }
    if (row.doc_id != null) ev.docIds.add(row.doc_id);
    if (row.is_test) ev.isTest = true;
    if (row.created_at < ev.createdAt) ev.createdAt = row.created_at;
  }
  return [...events.values()];
}

// Excludes each event under exactly one reason (checked in this order) so
// counts partition the total instead of double-counting an event that could
// match more than one.
function classify(event) {
  if (event.session == null) return 'unattributable';
  if (event.isTest || isTestSession(event.session)) return 'test';
  if (event.surface === SURFACE.HINT && ENVELOPE_RE.test(event.query || '')) return 'envelope';
  return null;
}

function partitionExclusions(events) {
  const excluded = { test: 0, envelope: 0, unattributable: 0 };
  const kept = [];
  for (const ev of events) {
    const reason = classify(ev);
    if (reason) excluded[reason] += 1;
    else kept.push(ev);
  }
  return { kept, excluded };
}

// All read-surface rows, grouped by session, for the follow-through join —
// loaded once and shared across every push/pull surface's join instead of one
// query per event.
function readsBySession(db, excludeSessions) {
  const bySession = new Map();
  const rows = readRows(db, READ_SURFACES, excludeSessions).filter(r => r.doc_id != null && r.session != null);
  for (const row of rows) {
    if (!bySession.has(row.session)) bySession.set(row.session, []);
    bySession.get(row.session).push(row);
  }
  return bySession;
}

// A fire event is followed if ANY of its docs was read, same session, at or
// after the event and within WINDOW_MS (canonical) — unbounded is the same
// join with no upper bound, printed alongside as the secondary column the
// window's cost is measured against. A read at exactly the window edge counts
// as inside it.
function markFollowed(event, reads) {
  let followedUnbounded = false;
  let followed30 = false;
  const t0 = toMs(event.createdAt);
  for (const r of reads) {
    if (!event.docIds.has(r.doc_id)) continue;
    const t1 = toMs(r.created_at);
    if (t1 < t0) continue;
    followedUnbounded = true;
    if (t1 - t0 <= WINDOW_MS) { followed30 = true; break; }
  }
  event.followed30 = followed30;
  event.followedUnbounded = followedUnbounded;
}

function readRows(db, surfaces, excludeSessions) {
  const placeholders = surfaces.map(() => '?').join(', ');
  let sql = `SELECT doc_id, surface, query, session, event_id, is_test, created_at FROM retrievals WHERE surface IN (${placeholders})`;
  const params = [...surfaces];
  if (excludeSessions.length) {
    sql += ` AND (session IS NULL OR session NOT IN (${excludeSessions.map(() => '?').join(', ')}))`;
    params.push(...excludeSessions);
  }
  return db.prepare(sql).all(...params);
}

// Shared shape for every push/pull surface: total events, why some were
// excluded, and — among what's left — how many fired vs. declined (fire-only
// surfaces report declines as 0/0) and how many of the fires were followed.
function surfaceStats(rows, reads, { declines = false } = {}) {
  const events = groupEvents(rows);
  const { kept, excluded } = partitionExclusions(events);

  const fireEvents = declines ? kept.filter(e => e.docIds.size > 0) : kept;
  const declineEvents = declines ? kept.filter(e => e.docIds.size === 0) : [];

  for (const ev of fireEvents) markFollowed(ev, reads.get(ev.session) || []);

  const followed30 = fireEvents.filter(e => e.followed30).length;
  const followedUnbounded = fireEvents.filter(e => e.followedUnbounded).length;

  return {
    events: events.length,
    excluded,
    fires: fireEvents.length,
    declines: declineEvents.length,
    followed30,
    followedUnbounded,
    rate30: pct(followed30, fireEvents.length),
    rateUnbounded: pct(followedUnbounded, fireEvents.length),
    declineRate: declines ? pct(declineEvents.length, fireEvents.length + declineEvents.length) : null,
    fireEvents,
  };
}

// Tiny LCG (Numerical Recipes constants) instead of Math.random so the same
// seed reproduces the same resample sequence run to run and machine to
// machine — Math.random gives neither.
function makeLcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const CI_SEED = 42;
const CI_ITERATIONS = 2000;

// Cluster (session) bootstrap rather than a per-event binomial CI: events
// from the same session are not independent draws (one session's prompts
// share a topic, a mood, whether the reader was in a hurry), so treating each
// event as its own Bernoulli trial understates the true uncertainty. Resample
// sessions with replacement, not events.
function clusterBootstrapCI(fireEvents, { seed = CI_SEED, iterations = CI_ITERATIONS } = {}) {
  const bySession = new Map();
  for (const ev of fireEvents) {
    if (!bySession.has(ev.session)) bySession.set(ev.session, { followed: 0, total: 0 });
    const c = bySession.get(ev.session);
    c.total += 1;
    if (ev.followed30) c.followed += 1;
  }
  const clusters = [...bySession.values()];
  if (clusters.length === 0) return null;

  const rng = makeLcg(seed);
  const rates = new Array(iterations);
  for (let i = 0; i < iterations; i += 1) {
    let followed = 0;
    let total = 0;
    for (let j = 0; j < clusters.length; j += 1) {
      const c = clusters[Math.floor(rng() * clusters.length)];
      followed += c.followed;
      total += c.total;
    }
    rates[i] = total > 0 ? followed / total : 0;
  }
  rates.sort((a, b) => a - b);
  const lo = rates[Math.floor(0.025 * iterations)];
  const hi = rates[Math.min(iterations - 1, Math.ceil(0.975 * iterations) - 1)];
  return { nEvents: fireEvents.length, nClusters: clusters.length, lo, hi, seed, iterations };
}

const FIRES_FILE_RE = /^fires-.*\.jsonl$/;

// No shared parser exists for fires-*.jsonl elsewhere: trigger-hook.js only
// ever writes it, and trigger-hook.test.js's reads are test-local. This stays
// local rather than growing a shared module for one reader.
function readTriggerFires(dir = TRIGGERS_LOG_DIR) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const lines = [];
  for (const name of names) {
    if (!FIRES_FILE_RE.test(name)) continue;
    let text;
    try {
      text = readFileSync(join(dir, name), 'utf-8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        // A partial write from a crashed hook — skip rather than fail the report.
      }
    }
  }
  return lines;
}

// A trigger "event" is a delivered warning: emitted:true rows only (a
// candidate that matched but didn't fire, because the session was already at
// MAX_SESSION_WARNINGS, told the reader nothing and can't be followed
// through on). The fired note is `matched[0]` — decideAndRecord in
// trigger-hook.js picks the same index off the same array before logging it.
function triggerEvents(excludeSessions) {
  const excluded = new Set(excludeSessions);
  const events = [];
  for (const row of readTriggerFires()) {
    if (!row.emitted || !row.session) continue;
    if (isTestSession(row.session)) continue;
    if (excluded.has(row.session)) continue;
    const firedId = row.matched?.[0]?.id;
    if (firedId == null) continue;
    events.push({ session: row.session, createdAt: row.ts, docIds: new Set([firedId]) });
  }
  return events;
}

// kb-graph PR #87 (merged 2026-08-10 04:46:50 UTC) fixed session identity for
// MCP-surface reads (kb_read/rest_read): before it, those rows could carry a
// stale session id frozen at server-spawn time, while trigger-hook always had
// the current one straight off hook stdin. A trigger fire from before the cut
// can join against a read whose logged session no longer matches its own —
// an honest under-count, not a bug in this file, but one the reader can't see
// without being told. Hard-coded to the fix's landing time rather than
// derived, since it names a point in history, not a property of the data.
const HONEST_SESSION_ID_CUTOFF_MS = Date.parse('2026-08-10T04:46:50Z');

export function followThroughReport(db = getDb(), { excludeSessions = [] } = {}) {
  const reads = readsBySession(db, excludeSessions);

  const hint = surfaceStats(readRows(db, [SURFACE.HINT], excludeSessions), reads, { declines: true });
  const briefing = surfaceStats(readRows(db, [SURFACE.BRIEFING], excludeSessions), reads, { declines: false });
  const pull = surfaceStats(readRows(db, [SURFACE.SEARCH], excludeSessions), reads, { declines: true });

  const trigger = triggerEvents(excludeSessions);
  for (const ev of trigger) markFollowed(ev, reads.get(ev.session) || []);
  const triggerFollowed30 = trigger.filter(e => e.followed30).length;
  const preCutoff = trigger.some(e => toMs(e.createdAt) < HONEST_SESSION_ID_CUTOFF_MS);

  const uncertainty = clusterBootstrapCI(hint.fireEvents);

  // fireEvents is an internal working set (Sets, back-references) that never
  // belongs in the printed/JSON report — drop it here so both output paths
  // read off the same plain-data shape.
  const strip = ({ fireEvents: _drop, ...rest }) => rest;

  return {
    windowNote: `window: ${WINDOW_MS / 60000}min canonical; unbounded is shown alongside for continuity with earlier ad hoc measurements, which were unbounded — expect the canonical rate to read a few points below it, not as a regression`,
    hint: strip(hint),
    briefing: strip(briefing),
    pullBenchmark: strip(pull),
    trigger: {
      events: trigger.length,
      followed30: triggerFollowed30,
      followedUnbounded: trigger.filter(e => e.followedUnbounded).length,
      rate30: pct(triggerFollowed30, trigger.length),
      preCutoffCaveat: preCutoff
        ? 'includes fire(s) from before the honest-session-id fix (kb-graph #87, 2026-08-10 04:46 UTC) — the read side of the join for those may be under-counted, see source comment'
        : null,
    },
    uncertainty: uncertainty && { nEvents: uncertainty.nEvents, nClusters: uncertainty.nClusters, lo: uncertainty.lo, hi: uncertainty.hi, seed: uncertainty.seed, iterations: uncertainty.iterations },
  };
}

function printSurface(label, s) {
  console.log(`\n${label}: ${s.events} events (excluded: ${s.excluded.test} test, ${s.excluded.envelope} envelope, ${s.excluded.unattributable} unattributable)`);
  if (s.declineRate != null) console.log(`  fires ${s.fires}, declines ${s.declines} (decline rate ${s.declineRate})`);
  console.log(`  followed (30min): ${s.followed30}/${s.fires} (${s.rate30}) — unbounded: ${s.followedUnbounded}/${s.fires} (${s.rateUnbounded})`);
}

function printReport(report) {
  console.log('KB Follow-Through Report');
  console.log('=========================');
  console.log(report.windowNote);
  console.log('\nPush surfaces (hint fires ANY of its docs read = followed):');
  printSurface('hint', report.hint);
  printSurface('briefing', report.briefing);

  console.log('\nPull benchmark — kb_search followed by a read of a returned doc:');
  printSurface('kb_search', report.pullBenchmark);

  console.log(`\nTrigger surface (${report.trigger.events} delivered warnings — small n, read the counts not just the rate):`);
  console.log(`  followed (30min): ${report.trigger.followed30}/${report.trigger.events} (${report.trigger.rate30}) — unbounded: ${report.trigger.followedUnbounded}/${report.trigger.events}`);
  if (report.trigger.preCutoffCaveat) console.log(`  ⚠ ${report.trigger.preCutoffCaveat}`);

  if (report.uncertainty) {
    const u = report.uncertainty;
    console.log(`\nHint rate, cluster-bootstrap 95% CI: ${report.hint.rate30} [${pct(u.lo, 1)}, ${pct(u.hi, 1)}] — ${u.nEvents} events across ${u.nClusters} session clusters, seed ${u.seed}, ${u.iterations} resamples`);
  } else {
    console.log('\nHint rate, cluster-bootstrap 95% CI: n/a (no fire events)');
  }
}

const EXCLUDE_SESSION_FLAG = '--exclude-session';
const USAGE = `Usage: kb follow-through [--json] [${EXCLUDE_SESSION_FLAG} <id>]...`;

export function runFollowThroughCli(args = []) {
  if (!acceptFlags(args, { usage: USAGE, value: [EXCLUDE_SESSION_FLAG], boolean: ['--json'] })) return;

  // flags.js has no repeatable-value concept — --exclude-session can appear
  // any number of times, so it's collected here rather than via readFlagValue
  // (which only ever returns the first match). A bare trailing flag with no
  // value is dropped instead of pushed as undefined, which better-sqlite3
  // would reject as a bind parameter.
  const excludeSessions = [];
  const eqPrefix = `${EXCLUDE_SESSION_FLAG}=`;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === EXCLUDE_SESSION_FLAG && args[i + 1] != null) excludeSessions.push(args[i + 1]);
    else if (args[i].startsWith(eqPrefix)) excludeSessions.push(args[i].slice(eqPrefix.length));
  }
  const asJson = args.includes('--json');

  const report = followThroughReport(getDb(), { excludeSessions });
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
}

// Exported for direct unit testing of the pieces `followThroughReport`
// composes, rather than only through the CLI's stdout/JSON.
export { readTriggerFires, triggerEvents, clusterBootstrapCI, groupEvents, classify };
