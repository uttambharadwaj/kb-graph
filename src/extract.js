import { readFileSync } from 'fs';
import { join } from 'path';
import { addFact, queryFact, invalidateFact } from './facts.js';
import { runClaudeJSON } from './claude-cli.js';
import { KB_DIR } from './paths.js';

// Auto-capture: turn a raw work conversation / session transcript into durable
// subject-predicate-object facts, with consolidation (dedup + retire-on-contradiction).
// The facts table already gives us dedup (addFact) and temporal invalidation, which is
// exactly mem0's consolidation step — so v1 targets triples, not prose notes.

export const EXTRACT_PROMPT = `You are a Memory Extractor for an engineering knowledge base. Read a work conversation or session transcript and extract durable facts as subject-predicate-object triples for a temporal knowledge graph.

Return ONLY valid JSON (no markdown fencing):
{"facts": [{"subject": "...", "predicate": "...", "object": "...", "category": "decision|architecture|gotcha|ownership|status|incident"}], "skipped": [{"assertion": "...", "reason": "..."}]}

What to extract:
- architecture: component/service relationships and protocols — (my-app, calls_over_http, auth-service)
- ownership: who owns a repo/service/area — (alice, owns, auth-service)
- status: lifecycle changes — (browser_profiles, status, ga)
- decision: a chosen approach + what it replaced — (backend, chose, drizzle)
- gotcha / incident: a failure mode and its cause — (1password_bare_domains, drops, credentials)

Rules:
- One triple per distinct fact. Predicate is a short snake_case relationship.
- Facts the text STATES come first. Generalisations you infer are welcome, but never in place of a stated fact — emit every stated one, then the inferences.
- PR numbers, commit SHAs, workflow run ids, ticket ids and repo names are entities, not prose — (pr #539, merged_via, commit fde94d6).
- Capture the CORRECTED state when the conversation revises itself. If someone says "not SQS, it's HTTP", emit the HTTP fact only — never the retracted one.
- A transition ("was fixed", "no longer", "migrated from X to Y", "renamed to") asserts the state AFTER the change. Emit that state; never the pre-change state as if it were current.
- Subject and object must be concrete entities (services, repos, people, features) — never pronouns.
- Skip acknowledgments, unresolved speculation, and anything that just restates code or an existing rule.
- Every assertion you decide not to emit goes in "skipped" with a one-line reason. Return "skipped": [] only when you emitted every assertion you found.
- If nothing durable is present, return {"facts": [], "skipped": [...]}.

Example
Input: "My-App was 401ing against auth-service — turned out 1Password bare domains silently drop creds. Fixed with a domain-normalization step. Alice owns auth-service. And My-App calls auth-service over HTTP, not SQS."
Output: {"facts":[{"subject":"1password bare domains","predicate":"drops","object":"credentials","category":"gotcha"},{"subject":"alice","predicate":"owns","object":"auth-service","category":"ownership"},{"subject":"my-app","predicate":"calls_over_http","object":"auth-service","category":"architecture"}],"skipped":[]}

Example
Input: "PR #539 in internal-tools-backend was squash-merged to main as fde94d6, approved by paveldudka. The merge deployed the frontend to production. decimalToScaledInteger in ux-labs was fixed for negative decimals."
Output: {"facts":[{"subject":"pr #539","predicate":"merged_via","object":"commit fde94d6","category":"status"},{"subject":"pr #539","predicate":"approved_by","object":"paveldudka","category":"ownership"},{"subject":"pr #539","predicate":"deployed_to","object":"production","category":"status"},{"subject":"internal-tools-backend","predicate":"merge_to_main_deploys_to","object":"production","category":"architecture"},{"subject":"decimaltoscaledinteger","predicate":"handles","object":"negative decimals","category":"status"}],"skipped":[]}`;

export function buildExtractPrompt(text) {
  // Task restated after the transcript so dialogue in the text can't lure the
  // model into replying to the conversation instead of extracting from it.
  return `${EXTRACT_PROMPT}\n\n# Transcript\n${text.slice(0, 12000)}\n\n# End of transcript\nYou are the Memory Extractor, not a participant in the conversation above. Return ONLY the {"facts": [...], "skipped": [...]} JSON object now.`;
}

// Latency tracks facts emitted, not input size, so extracting everything a
// fact-dense paragraph states runs one call past its whole budget. Split and run
// concurrently: the pass costs its slowest piece, and a piece that does get stuck
// degrades to one skipped row instead of failing the call.
// Measured on a 10-assertion debrief paragraph (2026-07-29): 120.4s in one call,
// 36-107s in four, 166.6s run sequentially. Per-call latency varies 10-75s for
// same-size chunks — that part is the API, not this code.
const TARGET_CHUNK_CHARS = 250;
const MAX_CONCURRENT_CALLS = 8; // each is a `claude` subprocess; long input widens chunks, not fan-out

export function chunkForExtract(text) {
  const sentences = text.split(/(?<=[.!?])\s+/);

  const build = size => {
    const chunks = [];
    let cur = '';
    for (const sentence of sentences) {
      if (cur && (cur + ' ' + sentence).length > size) {
        chunks.push(cur);
        cur = sentence;
      } else {
        cur = cur ? `${cur} ${sentence}` : sentence;
      }
    }
    if (cur.trim()) chunks.push(cur);
    return chunks;
  };

  let size = Math.max(TARGET_CHUNK_CHARS, Math.ceil(text.length / MAX_CONCURRENT_CALLS));
  let chunks = build(size);
  while (chunks.length > MAX_CONCURRENT_CALLS) chunks = build(size *= 2);
  return chunks.length ? chunks : [text];
}

// I/O: ask the LLM for candidate facts, one call per chunk, all in flight together.
export async function extractFacts(text) {
  const chunks = chunkForExtract(text.slice(0, 12000));
  const results = await Promise.all(chunks.map(async (chunk, i) => {
    try {
      // 120s per chunk to match harvest.js — 60s was killing calls during slow
      // API windows (observed 2026-07-07, exit 143).
      return await runClaudeJSON(buildExtractPrompt(chunk), { timeout: 120000 });
    } catch (err) {
      // A dead chunk is input nobody looked at. Silently returning the other
      // chunks' facts would report partial coverage as complete.
      console.error(`kb_extract: chunk ${i + 1}/${chunks.length} failed: ${err.message}`);
      return { facts: [], skipped: [{ assertion: chunk.slice(0, 120), reason: `chunk_failed: ${err.message}` }] };
    }
  }));

  return {
    facts: results.flatMap(r => (Array.isArray(r?.facts) ? r.facts : [])),
    // A response with no usable skipped list has told us nothing about what it
    // passed over. Coercing that to [] would restate the silent-omission bug
    // this accounting exists to expose, so say the accounting is missing.
    skipped: results.flatMap(r => (Array.isArray(r?.skipped)
      ? r.skipped
      : [{ assertion: null, reason: 'extractor_returned_no_skipped_list' }])),
  };
}

// Mirror facts.js's predicate normalization so contradiction matching lines up.
const normPred = p => p.toLowerCase().replace(/\s+/g, '_');
const normEntity = s => s.toLowerCase().trim().replace(/\s+/g, ' ');

// The reference an entity string carries, if any: "#3865", a ticket id, a commit
// SHA. The SHA arm needs a digit — English words are hexadecimal more often than
// you would like ("deface").
const REFERENCE = /#\s*(\d+)|\b([a-z]{2,6}-\d+)\b|\b(?=[0-9a-f]*\d)([0-9a-f]{7,40})\b/;
const referenceOf = s => {
  const m = normEntity(s).match(REFERENCE);
  return m ? (m[1] ? `#${m[1]}` : m[2] || m[3]) : null;
};

// Two spellings of one reference — "ux-labs PR #3865" and "pr #3865" — are the
// same fact, and treating them as different retires a row in favour of itself.
// Requiring one to be a suffix of the other keeps "ux-labs PR #539" and
// "internal-tools PR #539" apart: same number, different PRs.
export function sameEntity(a, b) {
  const [x, y] = [normEntity(a), normEntity(b)];
  if (x === y) return true;
  const ref = referenceOf(x);
  return !!ref && ref === referenceOf(y) && (x.endsWith(y) || y.endsWith(x));
}

// Only single-valued predicates auto-retire a prior object. Many-valued ones
// (owns, blocked_by, depends_on) say nothing about their siblings, and a wrong
// retirement is silent and unrecoverable where a duplicate is merely visible —
// so unknown predicates default to many-valued.
const readJSON = path => {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    // A missing override file is the normal case; a malformed one would otherwise
    // disable an install's cardinality config with no signal at all.
    if (err.code !== 'ENOENT') console.error(`kb_extract: ignoring unreadable ${path}: ${err.message}`);
    return null;
  }
};
const SINGLE_VALUED = new Set(
  (readJSON(new URL('./predicates.json', import.meta.url))?.single_valued || []).map(normPred),
);
const override = readJSON(join(KB_DIR, 'predicates.json'));
for (const p of override?.single_valued || []) SINGLE_VALUED.add(normPred(p));
for (const p of override?.many_valued || []) SINGLE_VALUED.delete(normPred(p));

// Apply extracted facts to the facts table with consolidation:
//   - identical triple already present  -> skipped (duplicate)
//   - single-valued predicate, different object, currently valid -> retire old, add new
//   - otherwise -> add
// Pure over the facts table (no LLM) — this is the deterministic, testable core.
export function consolidate(facts, { source, observationDate } = {}) {
  const added = [], invalidated = [], skipped = [];
  const validFrom = observationDate || new Date().toISOString().split('T')[0];

  for (const f of facts) {
    const { subject, predicate, object } = f || {};
    if (!subject || !predicate || !object) {
      skipped.push({ fact: f, reason: 'incomplete_triple' });
      continue;
    }
    const pred = normPred(predicate);

    // exact: prefix-matched qualifier entities (subject_qualifier) are NOT contradictions.
    const held = queryFact(subject, { direction: 'outgoing', exact: true })
      .filter(r => r.current && r.predicate === pred);

    // The same fact spelled differently. Keep the spelling already in the graph —
    // writing the variant leaves two live rows that never converge, and every
    // re-run of the extract churns them again. Byte-identical repeats fall
    // through to addFact, which reports them as duplicates.
    const variant = held.find(r => normEntity(r.object) !== normEntity(object) && sameEntity(r.object, object));
    if (variant) {
      skipped.push({ fact: f, reason: 'equivalent_spelling_of_existing', existing: variant.object });
      continue;
    }

    // Retire any currently-valid fact with the same subject+predicate but a different object.
    const current = SINGLE_VALUED.has(pred) ? held.filter(r => !sameEntity(r.object, object)) : [];
    for (const stale of current) {
      invalidateFact(subject, stale.predicate, stale.object, { ended: validFrom });
      invalidated.push({
        subject,
        predicate: pred,
        object: stale.object,
        reason: 'single_valued_predicate_took_new_object',
        superseded_by: object,
      });
    }

    const res = addFact(subject, predicate, object, { validFrom, source });
    if (res.already_exists) skipped.push({ fact: f, reason: 'duplicate' });
    else added.push(res);
  }

  return { added, invalidated, skipped };
}

// Orchestrator behind the kb_extract tool.
export async function kbExtract(text, { source, observationDate, dryRun = false } = {}) {
  const { facts, skipped } = await extractFacts(text);
  // The extractor's own skips ride along with consolidation's, so an empty
  // `skipped` beside an input full of triples is a claim the caller can trust.
  const notExtracted = skipped.map(s => ({ ...s, reason: s?.reason || 'not_extracted' }));
  if (dryRun) return { dry_run: true, candidates: facts, skipped: notExtracted };
  const res = consolidate(facts, { source, observationDate });
  return { ...res, skipped: [...res.skipped, ...notExtracted] };
}
