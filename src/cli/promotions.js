// `kb promotions` — applies the promotion the follow-through join can now
// support: a session followed a hint or trigger push and wasn't corrected.
// "Followed, not corrected" is the only confirmation signal retrieval logging
// captures, and it proves exactly the observed bar — an agent saw the note
// act out — not the verified one, which needs a landed fix or test this loop
// has no way to name. Briefing is deliberately excluded: mechanical exposure
// at SessionStart is not an act of reliance the way opening a specific
// pushed doc is.
//
// Applies by default through promoteDocumentTier (the same path kb_promote
// uses, including the vault-file rewrite) — `--dry-run` logs only, like the
// old behavior. A pre-cutoff trigger fire (basis.caveat set — see
// followedFireEvents) is also logged only, never applied: its read-side join
// may be under-counted, so it waits for human review. The jsonl log below is
// the audit trail either way.
import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getDb, promoteDocumentTier } from '../db.js';
import { LOGS_DIR } from '../paths.js';
import { SURFACE } from '../retrieval.js';
import { REF_MAX_CHARS, TIER } from '../tiers.js';
import { setNoteTier } from '../write-note.js';
import { indexVaultFile } from '../vault/indexer.js';
import { followedFireEvents, toMs } from './follow-through.js';
import { acceptFlags } from './flags.js';

function getVaultPath() {
  return process.env.OBSIDIAN_VAULT_PATH || join(homedir(), '.claude', 'kb-index');
}

export const PROMOTIONS_LOG_DIR = join(LOGS_DIR, 'promotions');
export const WOULD_PROMOTE_LOG = join(PROMOTIONS_LOG_DIR, 'would-promote.jsonl');

// The only rank this dry-run ever proposes — see the file header for why.
const WOULD_BECOME = TIER.OBSERVED;

// One line per doc_id ever, across every run this log has seen — a doc
// re-followed later does not re-append. Malformed lines (a partial write
// from a crashed run) are skipped rather than failing the whole read, same
// tolerance follow-through.js's readTriggerFires uses for its own jsonl.
function readLoggedDocIds(path = WOULD_PROMOTE_LOG) {
  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return new Set();
  }
  const ids = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.doc_id != null) ids.add(row.doc_id);
    } catch {
      // skip
    }
  }
  return ids;
}

// Eligible docs: currently `inferred`, not superseded. Fetched with a direct
// SELECT — never through getDocument/searchDocuments, which log a retrieval
// as a side effect — so this stays a command that only ever reads.
function inferredLiveDocs(db, ids) {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT id, title, tier, superseded_at FROM documents WHERE id IN (${placeholders})`
  ).all(...ids);
  const byId = new Map();
  for (const row of rows) {
    if (row.tier === TIER.INFERRED && row.superseded_at == null) byId.set(row.id, row);
  }
  return byId;
}

// A followed event names one doc actually acted on (event.followingRead),
// not every doc a hint happened to push alongside it — see
// followedFireEvents' doc comment in follow-through.js. Two events in one run
// can name the same doc (hint and trigger both followed it, or the same
// surface twice); the earliest confirmation wins, since that's the one that
// would have promoted first in a live run.
function earliestPerDoc(events) {
  const byDoc = new Map();
  for (const ev of events) {
    const docId = ev.followingRead.doc_id;
    const existing = byDoc.get(docId);
    if (!existing || toMs(ev.followingRead.created_at) < toMs(existing.followingRead.created_at)) {
      byDoc.set(docId, ev);
    }
  }
  return byDoc;
}

function toDecision(ev, doc, decidedAt) {
  const readLatencyS = Math.round((toMs(ev.followingRead.created_at) - toMs(ev.createdAt)) / 1000);
  const basis = {
    event_id: ev.key,
    session: ev.session,
    followed_at: new Date(toMs(ev.followingRead.created_at)).toISOString(),
    read_latency_s: readLatencyS,
  };
  // Only trigger events carry preCutoff (see followedFireEvents in
  // follow-through.js); a pre-cutoff trigger fire's read-side join may be
  // under-counted, so a human reviewing the dry-run log before any flip to
  // live needs that flagged on the line, not silently dropped.
  if (ev.preCutoff) {
    basis.caveat = 'pre-honest-session-id fire — read-side join may be miscounted';
  }
  return {
    doc_id: doc.id,
    title: doc.title,
    current_tier: doc.tier,
    would_become: WOULD_BECOME,
    basis,
    decided_at: decidedAt,
  };
}

// Read-only: computes this run's candidates and partitions them against
// what's already logged. Exported separately from the CLI so a test can
// assert zero DB/FS writes without going through appendDecisions.
export function computePromotionDecisions(db = getDb(), { decidedAt = new Date().toISOString(), loggedIds = readLoggedDocIds() } = {}) {
  const { hint, trigger } = followedFireEvents(db);
  const byDoc = earliestPerDoc([...hint, ...trigger]);
  const eligible = inferredLiveDocs(db, [...byDoc.keys()]);

  const candidates = [];
  const skipped = [];
  for (const [docId, ev] of byDoc) {
    const doc = eligible.get(docId);
    if (!doc) continue; // not inferred, superseded, or no longer exists
    const decision = toDecision(ev, doc, decidedAt);
    (loggedIds.has(docId) ? skipped : candidates).push(decision);
  }
  return { candidates, skipped };
}

function appendDecisions(decisions, path = WOULD_PROMOTE_LOG) {
  if (decisions.length === 0) return;
  mkdirSync(PROMOTIONS_LOG_DIR, { recursive: true });
  appendFileSync(path, decisions.map(d => JSON.stringify(d)).join('\n') + '\n');
}

// The event_id's own prefix says which surface produced it — "trigger:" for
// a trigger fire (triggerEvents' key), "id:"/"ts:" for a hint (eventKey) —
// so this needs no extra field threaded through basis. Trigger fires have no
// SURFACE entry of their own (they never hit the retrievals table — see
// triggerEvents' comment in follow-through.js), so that half stays a literal.
function surfaceOf(eventId) {
  return eventId.startsWith('trigger:') ? 'trigger' : SURFACE.HINT;
}

// A legacy hint key embeds the full retrieval query verbatim (eventKey in
// follow-through.js: `ts:${session}|${surface}|${created_at}|${query}`), so
// a long prompt can push confirmed_by past REF_MAX_CHARS — normalizeRef
// refuses rather than truncates it (src/tiers.js), which would otherwise
// throw promoteDocumentTier for every candidate whose query happened to be
// long. Only the event_id's own tail is clipped; session, followed_at and
// read_latency_s are never touched, so a pathological value in one of those
// can still overflow — that is a real failure and is left to the
// per-candidate isolation in runPromotionsCli rather than papered over here.
function buildConfirmedBy(basis) {
  const prefix = `Follow-through join: ${surfaceOf(basis.event_id)} event `;
  const suffix = `, session ${basis.session}, followed ${basis.followed_at} ` +
    `(read latency ${basis.read_latency_s}s); auto-applied by kb promotions`;
  const budget = Math.max(0, REF_MAX_CHARS - prefix.length - suffix.length);
  const eventId = basis.event_id.length > budget
    ? `${basis.event_id.slice(0, Math.max(0, budget - 1))}…`
    : basis.event_id;
  return `${prefix}${eventId}${suffix}`;
}

// The same tier-promotion path kb_promote uses (src/tools.js), including the
// vault-file rewrite. Once promoteDocumentTier lands the DB write, a vault
// failure past that point (I/O, embeddings) must not be reported as a failed
// promotion or abort the batch — same tolerance kb_promote's own
// indexVaultForResponse helper gives the reindex half. promoteDocumentTier
// itself is left to throw here: the caller's per-candidate try/catch is what
// isolates that from the rest of the run.
//
// Exported so a test can assert its outcome contract directly — in
// particular that a doc gone by apply time (deleted, or promoted out from
// under this run some other way) reports applied:false with a reason,
// never a bare success a caller could mistake for one.
export async function applyDecision(d) {
  const doc = promoteDocumentTier(d.doc_id, { tier: d.would_become, confirmedBy: buildConfirmedBy(d.basis) });
  if (!doc) return { applied: false, error: 'document gone since the decision was computed' };

  const vf = getDb().prepare('SELECT vault_path FROM vault_files WHERE document_id = ?').get(d.doc_id);
  if (!vf) return { applied: true }; // no vault file for this note — recorded in the index only, same as kb_promote

  try {
    const vaultPath = getVaultPath();
    setNoteTier(vaultPath, vf.vault_path, { tier: doc.tier, ref: doc.tier_ref });
    await indexVaultFile(vaultPath, vf.vault_path);
    return { applied: true };
  } catch (error) {
    return { applied: true, error: `vault file not updated: ${error.message}` };
  }
}

function printDecision(d) {
  const tag = d.applied ? 'applied' : 'logged only';
  const err = d.error ? ` ERROR: ${d.error}` : '';
  console.log(`  #${d.doc_id} "${d.title}": ${d.current_tier} -> ${d.would_become} [${tag}]${err} (session ${d.basis.session}, followed ${d.basis.followed_at}, latency ${d.basis.read_latency_s}s, event ${d.basis.event_id})`);
}

const USAGE = 'Usage: kb promotions [--json] [--dry-run]';

export async function runPromotionsCli(args = []) {
  if (!acceptFlags(args, { usage: USAGE, boolean: ['--json', '--dry-run'] })) return;
  const asJson = args.includes('--json');
  const dryRun = args.includes('--dry-run');

  const { candidates, skipped } = computePromotionDecisions();

  const decisions = [];
  let appliedCount = 0;
  for (const d of candidates) {
    const preCutoff = d.basis.caveat != null;
    let outcome = { applied: false };
    if (!dryRun && !preCutoff) {
      try {
        outcome = await applyDecision(d);
      } catch (error) {
        // One bad candidate (confirmed_by still over REF_MAX_CHARS despite
        // clamping, or any other apply-time failure) must not stall every
        // candidate behind it in the same run — this is the batch's own
        // crash isolation, not just the audit trail's.
        outcome = { applied: false, error: error.message };
      }
      if (outcome.applied) appliedCount += 1;
    }
    const decision = outcome.error ? { ...d, applied: outcome.applied, error: outcome.error } : { ...d, applied: outcome.applied };
    decisions.push(decision);
    appendDecisions([decision]); // one line per candidate, immediately — a crash mid-batch loses at most the in-flight line
  }

  if (asJson) {
    console.log(JSON.stringify({
      candidates: candidates.length + skipped.length,
      new: candidates.length,
      applied: appliedCount,
      skippedAlreadyLogged: skipped.length,
      decisions,
    }, null, 2));
    return;
  }

  console.log(`kb promotions: ${candidates.length + skipped.length} candidates, ${appliedCount} applied, ${candidates.length - appliedCount} dry-run/pre-cutoff/failed logged only, ${skipped.length} skipped (already logged)`);
  if (decisions.length) {
    console.log('\nDecisions this run:');
    for (const d of decisions) printDecision(d);
  }
}
