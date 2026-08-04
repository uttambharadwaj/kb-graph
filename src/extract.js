import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { addFact, queryFact, invalidateFact, sqlTimestamp, entityKey } from './facts.js';
import { runClaudeJSON } from './claude-cli.js';
import { KB_DIR } from './paths.js';
import { hashInput, logExtraction } from './extract-meter.js';

// Auto-capture: turn a raw work conversation / session transcript into durable
// subject-predicate-object facts, with consolidation (dedup + retire-on-contradiction).
// The facts table already gives us dedup (addFact) and temporal invalidation, which is
// exactly mem0's consolidation step — so v1 targets triples, not prose notes.

// The predicate registry, read at the top of the file rather than beside the
// maps it feeds: the prompt below renders its vocabulary from it, and a module
// const cannot be used before it is initialised.
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
const builtin = readJSON(new URL('./predicates.json', import.meta.url));
const override = readJSON(join(KB_DIR, 'predicates.json'));

// The vocabulary the prompt asks for. predicates.json owns the names — spelling
// them again here would let the list the model is given drift from the list the
// canonicaliser folds onto, which is the fragmentation this whole file exists to
// stop.
const PREFERRED = [...(builtin?.preferred || []), ...(override?.preferred || [])];

export const EXTRACT_PROMPT = `You are a Memory Extractor for an engineering knowledge base. Read a work conversation or session transcript and extract durable facts as subject-predicate-object triples for a temporal knowledge graph.

Return ONLY valid JSON (no markdown fencing):
{"facts": [{"subject": "...", "predicate": "...", "object": "...", "category": "decision|architecture|gotcha|ownership|status|incident"}], "skipped": [{"assertion": "...", "reason": "..."}]}

What to extract:
- architecture: component/service relationships and protocols — (my-app, calls_over_http, auth-service)
- ownership: who owns a repo/service/area — (alice, owns, auth-service)
- status: lifecycle changes — (sso_login, status, ga)
- decision: a chosen approach + what it replaced — (backend, chose, drizzle)
- gotcha / incident: a failure mode and its cause — (1password_bare_domains, drops, credentials)

Rules:
- One triple per distinct fact. Predicate is a short snake_case relationship.
- Facts the text STATES come first. Generalisations you infer are welcome, but never in place of a stated fact — emit every stated one, then the inferences.
- PR numbers, commit SHAs, workflow run ids, ticket ids and repo names are entities, not prose — (pr #539, merged_via, commit fde94d6).
- Capture the CORRECTED state when the conversation revises itself. If someone says "not SQS, it's HTTP", emit the HTTP fact only — never the retracted one.
- A COMPLETED transition ("was fixed", "no longer", "migrated from X to Y", "renamed to") asserts the state AFTER the change. Emit that state; never the pre-change state as if it were current.
- Past tense ends a state even when nothing names the replacement: "used to", "was declared in", "previously", "before the fix", "the cause was". If the text says what replaced it, emit only the replacement. If it does not, emit nothing for that state and put it in skipped. Text reaches you in fragments, so the sentence describing the fix is often not in front of you — every fact you emit is dated today and claims to be true now. A past EVENT is still emittable — (nightly_job, caused, backlog) — it is the past STATE that is not.
- Work still in flight ("moving", "migrating", "is proposing", "an open PR that will") has NOT happened. Emit the proposal — (wallet_identity, migration_proposed_in, pr_stack) — never the completed form (migrated_to). Open, unmerged, in review and planned all mean not yet.
- Describe, do not judge. Use a neutral predicate unless the text itself states the judgment: points_at, configured_to, depends_on — not misconfigured_to, broken_by, violates. A qualifier like "temporary, tracked for revert" makes something a deliberate choice, so an evaluative predicate would assert the opposite of what the text says.
- Subject and object must be concrete entities (services, repos, people, features) — never pronouns.
- Skip acknowledgments, unresolved speculation, and anything that just restates code or an existing rule.
- Prefer these predicates when one fits, so the same relationship is always the same edge: ${PREFERRED.join(', ')}. Invent one only when none of them says it.
- A ticket assigned to a person is (ticket, assigned_to, person) — the ticket is the subject, never the person. Written the other way round a later reassignment cannot supersede it, so the old assignee stays true forever.
- A ticket or issue is the thing implemented, never the implementer: (pr #12, implements, tkt-99), never (tkt-99, implements, the_thing_built). A ticket can target a problem — (tkt-99, fixes, version_skew) is right — but it cannot build code. Both roles are real entities either way round, so the reversed one reads as a sentence and is still backwards.
- One object per fact. Several objects means several rows — never "pr #1, pr #2" in one object.
- status is one variable — the subject's lifecycle state — and takes ONE value per subject in your response. Review, CI and merge-queue standing are separate variables: (pr #12, review_state, approved), (pr #12, ci_state, green), (pr #12, status, queued_for_merge). Three "statuses" for one PR means you have flattened three predicates onto one name, and only one of them will survive.
- Every assertion you decide not to emit goes in "skipped" with a one-line reason. Return "skipped": [] only when you emitted every assertion you found.
- If nothing durable is present, return {"facts": [], "skipped": [...]}.

Example
Input: "My-App was 401ing against auth-service — turned out 1Password bare domains silently drop creds. Fixed with a domain-normalization step. Alice owns auth-service. And My-App calls auth-service over HTTP, not SQS."
Output: {"facts":[{"subject":"1password bare domains","predicate":"drops","object":"credentials","category":"gotcha"},{"subject":"alice","predicate":"owns","object":"auth-service","category":"ownership"},{"subject":"my-app","predicate":"calls_over_http","object":"auth-service","category":"architecture"}],"skipped":[]}

Example
Input: "PR #539 in billing-api was squash-merged to main as fde94d6, approved by dana. The merge deployed the frontend to production. parseAmount in web-app was fixed for negative decimals."
Output: {"facts":[{"subject":"pr #539","predicate":"merged_via","object":"commit fde94d6","category":"status"},{"subject":"pr #539","predicate":"approved_by","object":"dana","category":"ownership"},{"subject":"pr #539","predicate":"deployed_to","object":"production","category":"status"},{"subject":"billing-api","predicate":"merge_to_main_deploys_to","object":"production","category":"architecture"},{"subject":"parseamount","predicate":"handles","object":"negative decimals","category":"status"}],"skipped":[]}

Example
Input: "Production billing points at the sandbox provider, which is temporary and tracked by TICKET-42 for revert. Alice owns an 8-PR stack moving user identity onto the accounts row; all eight are still open. The nightly job used to read its own output as input, which caused the backlog."
Output: {"facts":[{"subject":"production_billing","predicate":"deliberately_points_at","object":"sandbox_provider","category":"architecture"},{"subject":"ticket-42","predicate":"tracks_revert_of","object":"production_billing_sandbox_pointing","category":"status"},{"subject":"alice","predicate":"owns","object":"user_identity_pr_stack","category":"ownership"},{"subject":"user_identity","predicate":"migration_proposed_in","object":"user_identity_pr_stack","category":"decision"},{"subject":"nightly_job","predicate":"caused","object":"backlog","category":"incident"}],"skipped":[{"assertion":"the nightly job reads its own output as input","reason":"past tense — the state ended and no replacement is stated"}]}`;

// One window, named once — harvest.js sizes its chunks from this too, so a
// change here cannot silently start truncating there. extractFacts cuts to it
// and reports the remainder; the slice below is belt-and-braces on an exported
// function and must never be the first place text goes missing.
export const MAX_EXTRACT_CHARS = 12000;

/**
 * The prompt for one chunk, with its neighbours attached as read-only context.
 *
 * Tense is the only thing distinguishing "was X and still is" from "was X and
 * no longer is", and English simple past says both. The sentence that
 * disambiguates — the one naming what replaced the old state — is usually the
 * *next* sentence, which the ~250-char split routinely puts in a different
 * chunk. Extracted alone the fragment is genuinely ambiguous, and the extractor
 * resolves it by dating the dead state today. Showing the neighbours costs
 * about a tenth of a call and is what makes the modality rules above decidable.
 */
export function buildExtractPrompt(text, { before = '', after = '' } = {}) {
  const context = (before || after)
    ? `\n\n# Surrounding text (context only — do NOT extract facts from this)\n${before}\n[…the section to extract from goes here…]\n${after}\n# End of surrounding text`
    : '';
  // Task restated after the transcript so dialogue in the text can't lure the
  // model into replying to the conversation instead of extracting from it.
  return `${EXTRACT_PROMPT}${context}\n\n# Transcript\n${text.slice(0, MAX_EXTRACT_CHARS)}\n\n# End of transcript\nYou are the Memory Extractor, not a participant in the conversation above. Extract only from the Transcript section; the surrounding text is there to tell you whether a state is still current, not to be mined. Return ONLY the {"facts": [...], "skipped": [...]} JSON object now.`;
}

// The fan-out bounds the RESPONSE, and that is what makes it load-bearing.
// Asking for a whole 12,000-char window in one call returns nothing at all 2 of
// 3 times — 0 facts in ~11s, far too fast to be the timeout — because the reply
// carries every fact found. A narrow chunk keeps each reply small enough to come
// back, and a chunk that does fail costs an eighth of the window instead of all
// of it. Measured 2026-07-30 on 240 stated facts, same result on haiku-4.5 and
// sonnet-5, so it is a payload limit and not a model capability.
// Widening this to save the per-call prompt overhead is the obvious-looking
// optimisation and it does not work: each chunk re-sends the ~5.5k prompt, but
// buying that back costs whole sessions.
// Latency, measured on a 10-assertion paragraph (2026-07-29): 120.4s in one
// call, 36-107s in four, 166.6s sequential.
// The wide per-call spread on same-size chunks was read as API variance. It is
// not: input is fixed at ~36,800 tokens per call while generated tokens swing
// 1,821-10,163, and the wall time follows them. Almost all of that is thinking,
// which claude-cli.js now caps — see the note on MAX_THINKING_TOKENS there
// before reaching for chunk width again.
const TARGET_CHUNK_CHARS = 250;
const MAX_CONCURRENT_CALLS = 8; // each is a `claude` subprocess; long input widens chunks, not fan-out

const slicesOf = (text, size) => {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

export function chunkForExtract(text) {
  const sentences = text.split(/(?<=[.!?])\s+/);

  const build = size => {
    const chunks = [];
    let cur = '';
    // Sentence boundaries are the preferred cut, but a transcript of code, JSON
    // or bullet lists has none — then one "sentence" is the whole window, and
    // the fan-out stops bounding anything. Cut those on width instead.
    for (const sentence of sentences.flatMap(s => (s.length > size ? slicesOf(s, size) : [s]))) {
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

// 120s: 60s was killing calls during slow API windows (observed 2026-07-07,
// exit 143). This is a deadline per chunk, not for the whole call, and the two
// numbers being equal is why a timed-out chunk can never report in time: chunks
// run concurrently, so a chunk reaching this deadline means the call has
// already spent the same 120s an MCP client gives the whole tool, and it gets
// backgrounded before the failure row reaches the caller.
const CHUNK_TIMEOUT_MS = 120000;

// A second attempt, as the lessons pass in harvest.js already does. It cannot
// rescue the interactive contract — a retry only starts once the first attempt
// has consumed the entire call budget, so the call is backgrounded either way.
// It is for the facts: a chunk that dies takes everything it covered with it,
// and short input is a single chunk, where that is the whole extraction.
const CHUNK_ATTEMPTS = 2;

// Shared with kbExtract's meter below, which filters skipped entries by this
// same prefix to count chunks that died for good — one spelling so the two
// can't drift apart.
const CHUNK_FAILED_REASON_PREFIX = 'chunk_failed: ';

// I/O: ask the LLM for candidate facts, one call per chunk, all in flight together.
export async function extractFacts(text) {
  const examined = text.slice(0, MAX_EXTRACT_CHARS);
  const dropped = text.length - examined.length;
  const chunks = chunkForExtract(examined);
  const results = await Promise.all(chunks.map(async (chunk, i) => {
    const prompt = buildExtractPrompt(chunk, { before: chunks[i - 1] ?? '', after: chunks[i + 1] ?? '' });
    let failure;
    for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
      try {
        // One result per chunk however many attempts it took: a failed attempt
        // rejects without a value (runClaude drops stdout unless the exit was
        // clean), so no partial output survives to be batched alongside the
        // retry's and read as a single-valued conflict.
        // Also lands a row in model_calls (model-meter.js) per chunk call;
        // logExtraction below aggregates the extract-specific shape that
        // generic table doesn't carry (input hash, per-chunk chars, conflicts).
        return await runClaudeJSON(prompt, { timeout: CHUNK_TIMEOUT_MS, caller: 'extract' });
      } catch (err) {
        failure = err;
        console.error(`kb_extract: chunk ${i + 1}/${chunks.length} attempt ${attempt}/${CHUNK_ATTEMPTS} failed: ${err.message}`);
      }
    }
    // A dead chunk is input nobody looked at. Silently returning the other
    // chunks' facts would report partial coverage as complete.
    return { facts: [], skipped: [{ assertion: chunk.slice(0, 120), reason: `${CHUNK_FAILED_REASON_PREFIX}${failure.message}` }] };
  }));

  return {
    facts: results.flatMap(r => (Array.isArray(r?.facts) ? r.facts : [])),
    // Per-chunk character counts, for kbExtract's meter (extract-meter.js) to
    // log verbatim — the shape actually sent, not a second computation of it.
    chunkChars: chunks.map(c => c.length),
    // A response with no usable skipped list has told us nothing about what it
    // passed over. Coercing that to [] would restate the silent-omission bug
    // this accounting exists to expose, so say the accounting is missing.
    skipped: [
      // Truncation is not a model decision, so nothing downstream would ever
      // report it. Text nobody read is the same omission as a fact nobody
      // emitted, and belongs in the same channel.
      ...(dropped ? [{
        assertion: text.slice(MAX_EXTRACT_CHARS, MAX_EXTRACT_CHARS + 120),
        reason: `input_truncated: ${dropped.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters not examined`,
      }] : []),
      ...results.flatMap(r => (Array.isArray(r?.skipped)
        ? r.skipped
        : [{ assertion: null, reason: 'extractor_returned_no_skipped_list' }])),
    ],
  };
}

// A superset of facts.js's predicate normalization (lowercase, whitespace to
// underscore), so a stored row always matches the spelling computed here even
// though the reverse does not hold — consolidate hands addFact the canonical
// predicate and hands invalidateFact the raw stored one, which is the only pair
// of directions that has to line up.
// The rest is spelling variance that carries no meaning, so folding it needs no
// list and an unseen phrasing converges like a known one: the extractor writes
// source_of_truth_for on one call and is_source_of_truth_for on the next.
// Trailing underscores are already gone when this runs, so it can never empty
// the predicate — it needs one after the copula.
const COPULA = /^(?:is|are|was|were|be|been|being)_/;
const rawPred = p => p.toLowerCase()
  .replace(/['’]/g, '')
  .replace(/[\s-]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .replace(COPULA, '');

// Then the two list-driven folds, cheapest first: an exact synonym, else an
// inflection of a name predicates.json registers.
const normPred = (p) => {
  const raw = rawPred(p);
  return lookup(PREDICATE_ALIASES, raw) ?? lookup(CANONICAL_BY_LEMMA, lemmaKey(raw)) ?? raw;
};
const normEntity = s => s.toLowerCase().trim().replace(/\s+/g, ' ');

// The reference an entity string carries, if any: "#3865", a ticket id, a commit
// SHA. The SHA arm needs a digit — English words are hexadecimal more often than
// you would like ("deface").
const REFERENCE = /#\s*(\d+)|\b([a-z]{2,6}-\d+)\b|\b(?=[0-9a-f]*\d)([0-9a-f]{7,40})\b/;
const referenceOf = s => {
  const m = normEntity(s).match(REFERENCE);
  return m ? (m[1] ? `#${m[1]}` : m[2] || m[3]) : null;
};

// Two spellings of one reference — "web-app PR #3865" and "pr #3865" — are the
// same fact, and treating them as different retires a row in favour of itself.
// Requiring one to be a suffix of the other keeps "web-app PR #539" and
// "billing-api PR #539" apart: same number, different PRs.
export function sameEntity(a, b) {
  const [x, y] = [normEntity(a), normEntity(b)];
  if (x === y) return true;
  const ref = referenceOf(x);
  return !!ref && ref === referenceOf(y) && (x.endsWith(y) || y.endsWith(x));
}

// A configured entity-shape pattern, named so an install that supplies a bad
// one is told which key was dropped.
const compilePattern = (key, pattern) => {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch (err) {
    console.error(`kb_extract: ignoring invalid ${key} ${JSON.stringify(pattern)}: ${err.message}`);
    return null;
  }
};

// Both patterns fall back to matching nothing, which is the do-no-harm
// direction for each: no retirement, and no re-pointing of a relationship.
const configuredPattern = key => compilePattern(key, override?.[key])
  ?? compilePattern(key, builtin?.[key])
  ?? /^$/;

// Own keys only. These maps are keyed by whatever the extractor emitted, and a
// plain object answers `toString` and `constructor` with a function — which
// normPred would then return in place of the predicate.
const lookup = (map, key) => (Object.hasOwn(map, key) ? map[key] : undefined);

// A fold whose target is itself folded never converges: canonicalTriple would
// need a second pass to finish, and the migration would rewrite the same rows on
// every run. Both a cycle (a -> b -> a) and a chain (a -> b -> c) have that
// shape, so drop the pair and fold neither — no folding is the old behaviour, a
// half-applied fold is corruption.
const withoutChains = (kind, entries) => {
  const sources = new Set(entries.map(([from]) => from));
  return entries.filter(([from, to]) => {
    if (!sources.has(to)) return true;
    console.error(`kb_extract: ignoring ${kind} ${from} -> ${to}: ${to} is itself folded, which would never converge`);
    return false;
  });
};

// This map and CANONICAL_BY_LEMMA below are both defined before the first
// normPred() call — it reads them in that order.
const PREDICATE_ALIASES = Object.fromEntries(withoutChains(
  'alias',
  Object.entries({ ...builtin?.aliases, ...override?.aliases })
    .map(([from, to]) => [rawPred(from), rawPred(to)]),
));

// English inflection on the leading verb, which is the only token that carries
// it: merged_via / merges_via / merge_via are one relationship, and the
// extractor picks among them per call. Trailing tokens are left alone because
// they are not verbs and their plurals are meaning — calls_over_https is not
// calls_over_http.
function stem(token) {
  const base = inflectionOf(token);
  // The suffix rules disagree about the silent e — merges loses only the s while
  // merged loses the whole ed — so drop a trailing e from every stem and let
  // them meet. This is a grouping key, never a stored predicate, so merg is as
  // good a key as merge, and it is what makes a separate -es rule unnecessary:
  // fixes -> fixe -> fix reaches the same place.
  return base.replace(/e$/, '');
}
function inflectionOf(token) {
  if (/(?:ss|us|is)$/.test(token)) return token;              // status, focus — not a plural
  if (/[^aeiou]ies$/.test(token)) return `${token.slice(0, -3)}y`;
  if (/[a-z]s$/.test(token)) return token.slice(0, -1);
  if (/[^aeiou]ied$/.test(token)) return `${token.slice(0, -3)}y`;
  if (/([^aeiou])\1ed$/.test(token)) return token.slice(0, -3);  // shipped -> ship
  if (/ed$/.test(token)) return token.replace(/e?d$/, '');
  return token;                                               // -ing is left: missing is not missed
}
const lemmaKey = (p) => {
  const cut = p.indexOf('_');
  return cut === -1 ? stem(p) : stem(p.slice(0, cut)) + p.slice(cut);
};

// Only single-valued predicates auto-retire a prior object. Many-valued ones
// (owns, blocked_by, depends_on) say nothing about their siblings, and a wrong
// retirement is silent and unrecoverable where a duplicate is merely visible —
// so unknown predicates default to many-valued.
// Alias-resolved rather than normPred-resolved because the inflection map below
// is built from this and cannot resolve its own input. That costs nothing: the
// two agree, since nothing single-valued is inflectable.
const SINGLE_VALUED = new Set(
  [...(builtin?.single_valued || []), ...(override?.single_valued || [])]
    .map(p => lookup(PREDICATE_ALIASES, rawPred(p)) ?? rawPred(p)),
);
for (const p of override?.many_valued || []) {
  SINGLE_VALUED.delete(lookup(PREDICATE_ALIASES, rawPred(p)) ?? rawPred(p));
}

// Which canonical spelling an inflected one folds onto. Anchored to the names
// predicates.json already registers, so morphology can only ever merge two
// spellings of a predicate this file has taken a position on — an unregistered
// pair like missing/missed is left alone, where a general-purpose lemmatiser
// would merge it on a shared stem and lose the distinction.
// Alias sources are included, mapped to what they resolve to, so one entry
// covers its own inflections too and normPred still needs a single hop.
// Single-valued predicates are excluded, as they already are from the inverse
// map and for the same reason: an inflection of a lifecycle noun is usually a
// verb that means something else. "tkt-42 states that retries must be bounded"
// is a document quoting a requirement, and folding `states` onto `state` retires
// the ticket's real lifecycle value to store it.
const CANONICAL_BY_LEMMA = Object.create(null);
for (const name of [
  ...PREFERRED,
  ...Object.keys(PREDICATE_ALIASES),
  ...Object.values({ ...builtin?.aliases, ...override?.aliases }),
  ...Object.values({ ...builtin?.inverses, ...override?.inverses }),
  ...(builtin?.work_item_object || []), ...(override?.work_item_object || []),
].map(rawPred)) {
  if (SINGLE_VALUED.has(name)) continue;
  const canonical = lookup(PREDICATE_ALIASES, name) ?? name;
  const key = lemmaKey(name);
  const held = lookup(CANONICAL_BY_LEMMA, key);
  if (held === undefined) CANONICAL_BY_LEMMA[key] = canonical;
  else if (held !== canonical) {
    // Two registered names sharing a stem: nothing here can say which an
    // inflected third spelling meant, so fold neither and leave both exact.
    console.error(`kb_extract: not folding inflections of "${key}": ${held} and ${canonical} both claim it`);
    CANONICAL_BY_LEMMA[key] = null;
  }
}

// The extractor picks a direction per call, so one relationship arrives as
// (a, blocks, b) today and (b, blocked_by, a) tomorrow — both live, retiring
// independently, so a change phrased one way leaves the other stale and true.
// Unlike an alias, an inverse also swaps subject and object.
// Overrides merge by source key, so an install choosing the opposite direction
// of a built-in leaves both — blocks -> blocked_by and blocked_by -> blocks —
// and canonicalTriple then toggles a spelling instead of converging it, while
// the migration flips those rows on every run. withoutChains drops that pair,
// and the chain it also catches, for the same reason.
export const PREDICATE_INVERSES = Object.fromEntries(withoutChains(
  'inverse',
  Object.entries({ ...builtin?.inverses, ...override?.inverses })
    // normPred, not rawPred: canonicalTriple looks up an alias-resolved
    // predicate, so a raw key an alias rewrites could never match. It also keeps
    // an aliased target from slipping past the single-valued check below —
    // `assigned` reads as many-valued until the alias resolves it to assigned_to.
    .map(([from, to]) => [normPred(from), normPred(to)])
    // Folding a single-valued predicate would move the retirement it drives onto
    // a different subject, which is the failure this whole map exists to stop.
    // An install that configures one gets told, not silently un-retired.
    .filter(([from, to]) => {
      const bad = [from, to].filter(p => SINGLE_VALUED.has(p));
      if (bad.length) console.error(`kb_extract: ignoring inverse ${from} -> ${to}: ${bad.join(', ')} is single-valued`);
      return !bad.length;
    }),
));

// The direction a stored predicate folds to, or undefined if it is already
// canonical. Takes the raw spelling: a row written before an alias was
// registered still carries the old one, and it folds just the same.
export const inverseTargetOf = predicate => lookup(PREDICATE_INVERSES, normPred(predicate));

// implements, fixes and their siblings are asymmetric in their ROLES rather than
// their spelling: the work item is what gets built, so it belongs in the object.
// "pr #45 (tkt-99, the config client) merged" hands the extractor a ticket and
// an artefact side by side with only world knowledge to order them, and the
// reversed triple still scans as a sentence — which is what carries it past
// review, while asserting that a ticket built something and leaving "what
// implements tkt-99" unanswered. Swapping is not a guess about intent: two
// entities under one asymmetric predicate have exactly one arrangement that is
// not backwards. Two work items are a real ticket-to-ticket relationship with
// nothing in the shape to order them, so that case is left alone.
const WORK_ITEM_OBJECT = new Set(
  [...(builtin?.work_item_object || []), ...(override?.work_item_object || [])].map(normPred),
);
// One configured token shape, anchored two ways. A subject has to BE a work item
// exactly, since a compound id (tkt-19-repo-pr-277) names a pull request and
// would otherwise read as one. An object only has to START with one, because a
// work item carrying a label after it (tkt-19_step_1_save_back) still makes this
// a relationship between two work items, and those are left alone. Both
// looseness and strictness point the same way here: away from swapping.
const WORK_ITEM_TOKEN = configuredPattern('work_item_pattern').source;
const IS_WORK_ITEM = new RegExp(`^(?:${WORK_ITEM_TOKEN})$`, 'i');
const NAMES_WORK_ITEM = new RegExp(`^(?:${WORK_ITEM_TOKEN})(?![0-9a-z])`, 'i');

// The triple as it will be stored: canonical predicate, canonical direction.
export function canonicalTriple(f) {
  const pred = normPred(f.predicate);
  const inverse = lookup(PREDICATE_INVERSES, pred);
  const t = inverse
    ? { ...f, subject: f.object, predicate: inverse, object: f.subject }
    : { ...f, predicate: pred };
  // After the inverse fold, not before: the predicate an install spells one way
  // and the graph another has to reach its canonical name before the role rule
  // can recognise it.
  return WORK_ITEM_OBJECT.has(t.predicate)
    && IS_WORK_ITEM.test(String(t.subject).trim())
    && !NAMES_WORK_ITEM.test(String(t.object).trim())
    ? { ...t, subject: t.object, object: t.subject }
    : t;
}

// Cardinality belongs to (subject, predicate), not to the predicate. `status` is
// exactly right for a ticket — in_review then done is a real transition — and a
// junk drawer for a repo, where "v1.1-complete" and "deploy branch in sync" are
// both true and neither supersedes the other. So single-valued applies only to
// subjects naming one state-bearing thing: an id ending in digits (tkt-4821,
// pr_#412, svc-api#59), never a bare name (web-app, sso_login).
// Not bus/config.js's getTicketRegex — that finds a ticket reference inside free
// text; this asks whether the whole subject is one.
const SINGLE_ENTITY = configuredPattern('single_valued_subjects');

// Whether a new object for this triple retires the old one. Shared, because the
// intra-call conflict check has to ask the same question consolidate does — two
// spellings of the rule would let a conflict go undetected and then be retired
// by the loop anyway, which is the failure this pair exists to stop.
const retiresOnContradiction = f =>
  SINGLE_VALUED.has(f.predicate) && SINGLE_ENTITY.test(String(f.subject).trim());

// One row per object. A comma-joined object ("pr #3835, pr #3849, pr #3851") is
// unqueryable — kb_fact_query("pr #3849") never matches it — so split it into
// siblings. Only when every part carries a reference of its own, which keeps
// prose objects ("recharge_to, minus current balance") whole.
export function splitListObject(fact) {
  const parts = String(fact?.object ?? '')
    .split(/\s*,\s*|\s+and\s+/)
    .map(p => p.replace(/^and\s+/, '').trim()) // ", and pr #4" splits on the comma first
    .filter(Boolean);
  if (parts.length < 2 || !parts.every(referenceOf)) return [fact];
  return parts.map(object => ({ ...fact, object }));
}

// The store's own identity for a subject, so a group is contested on exactly
// the terms the facts table would collide on. Both halves matter: "PR #48" and
// "pr #48" are one subject there, and so are two names an entity merge has
// since folded together.
const conflictKey = f => `${entityKey(f.subject)}\0${f.predicate}`;

// One value, however it is spelled: a variant carrying the same reference, or a
// name an entity merge has since folded onto another. The store keeps one row
// for either, so a comparison that splits them retires a row in favour of
// itself and reports a contradiction that does not exist.
const sameValue = (a, b) => sameEntity(a, b) || entityKey(a) === entityKey(b);

/**
 * The (subject, predicate) pairs this one batch gives two or more objects for,
 * where a new object retires the old one.
 *
 * Three `status` rows for one PR in a single response are not a transition.
 * Nothing in the input orders them, so the last one the loop happens to reach
 * wins and the earlier two get a valid_to stamped the moment they are written —
 * a retirement that reads afterwards as a state change that never happened, and
 * the batch contradicts itself in both directions when a chunk repeats a value.
 * The usual shape behind it is one predicate doing three jobs: `open` is
 * lifecycle, `approved` is review, `queued_for_merge` is the merge queue.
 *
 * With no basis to choose, the group retires nothing and is reported instead. A
 * duplicate is visible on the next query and repairable; a wrong retirement is
 * neither.
 */
function findSingleValuedConflicts(facts) {
  const groups = new Map();
  for (const raw of facts.flatMap(splitListObject)) {
    if (!raw?.subject || !raw?.predicate || !raw?.object) continue;
    const f = canonicalTriple(raw);
    if (!retiresOnContradiction(f)) continue;
    const key = conflictKey(f);
    const group = groups.get(key) || { subject: f.subject, predicate: f.predicate, objects: [] };
    if (!group.objects.some(o => sameValue(o, f.object))) group.objects.push(f.object);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter(g => g.objects.length > 1)
    .map(g => ({
      ...g,
      reason: 'single_valued_conflict_within_call',
      resolution: 'all kept, none retired — one call cannot order them. Split them onto separate predicates, or retire the dead ones with kb_fact_invalidate.',
    }));
}

// recorded_at is compared as a raw string, so an ISO instant ("...T12:00:00Z")
// sorts above every same-day SQL timestamp — 'T' > ' ' — and the staleness
// guard below fails open on the exact input it exists to reject. Anything not
// already in SQL shape goes through Date, which also fixes the offset on a
// local-time instant. Left as-is when it already matches, because Date parses
// "YYYY-MM-DD HH:MM:SS" as local time and would shift a correct UTC value.
const SQL_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function normalizeObservedAt(value) {
  if (!value) return null;
  if (SQL_TIMESTAMP.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`observed_at is not a date: ${value}`);
  return sqlTimestamp(parsed);
}

// Apply extracted facts to the facts table with consolidation:
//   - identical triple already present  -> skipped (duplicate)
//   - same object spelled differently   -> skipped (the graph's spelling wins)
//   - single-valued predicate, different object, currently valid -> retire old, add new
//   - two objects for one single-valued pair in this same batch -> add both, retire nothing
//   - otherwise -> add
// Pure over the facts table (no LLM) — this is the deterministic, testable core.
export function consolidate(facts, { source, observationDate, observedAt } = {}) {
  const added = [], invalidated = [], skipped = [];
  const validFrom = observationDate || new Date().toISOString().split('T')[0];
  const observedAtTs = normalizeObservedAt(observedAt) || sqlTimestamp();
  const conflicts = findSingleValuedConflicts(facts);
  const contested = new Set(conflicts.map(conflictKey));

  for (const raw of facts.flatMap(splitListObject)) {
    if (!raw?.subject || !raw?.predicate || !raw?.object) {
      skipped.push({ fact: raw, reason: 'incomplete_triple' });
      continue;
    }
    // Skip reports carry the folded triple, since that is what was attempted.
    const f = canonicalTriple(raw);
    const { subject, predicate: pred, object } = f;

    // exact: prefix-matched qualifier entities (subject_qualifier) are NOT contradictions.
    // normPred on the stored predicate too: rows written before an alias was
    // registered still carry the old spelling, and comparing raw would leave a
    // merged_as row unmatched by an incoming merged_via — no dedup, no
    // retirement, two live rows on a single-valued predicate.
    const held = queryFact(subject, { direction: 'outgoing', exact: true })
      .filter(r => r.current && normPred(r.predicate) === pred);

    // The currently-valid facts with this subject+predicate that this value
    // contradicts. Computed before the spelling check below: a live object this
    // value genuinely contradicts must still be found, even when a variant of
    // the value is also held — kb_fact_add writes without consolidating, so both
    // can coexist.
    const contradicted = retiresOnContradiction(f)
      ? held.filter(r => !sameValue(r.object, object))
      : [];

    // An assertion observed before a fact we already hold is older news, not a
    // contradiction: a caller passing observation_date is replaying text from
    // the past against whatever the graph has learned since. valid_from is a
    // date, so it can only order across days — observed_at carries the instant
    // and catches the same-day case, 10am text replayed against a 4pm
    // correction. A caller that passes neither is speaking for now and skips
    // both tests, which is right.
    // Read from `contradicted`, not from what will actually be retired: a batch
    // that disagrees with itself still loses to what the graph learned after it,
    // and gating this on the retirement decision would write a replay of old
    // text as current the moment the batch happened to be contested.
    const newer = contradicted.find(r => (r.valid_from && r.valid_from > validFrom)
      || (r.recorded_at && r.recorded_at > observedAtTs));
    if (newer) {
      skipped.push({
        fact: f,
        reason: 'stale_observation',
        existing: newer.object,
        existing_since: newer.valid_from,
        existing_recorded_at: newer.recorded_at,
      });
      continue;
    }

    // A pair this batch cannot agree on has no value to supersede anything with,
    // so it retires nothing at all — not its siblings here, and not what the
    // graph already holds.
    const retiring = contested.has(conflictKey(f)) ? [] : contradicted;

    for (const stale of retiring) {
      // Report the retirement only if it happened. The guard above means
      // invalidateFact won't refuse, but the row can still be gone: the ~13 MCP
      // subprocesses share one DB, so another can retire it between this read
      // and this write.
      const res = invalidateFact(subject, stale.predicate, stale.object, { ended: validFrom });
      if (res.invalidated) {
        invalidated.push({
          subject,
          predicate: pred,
          object: stale.object,
          reason: 'single_valued_predicate_took_new_object',
          superseded_by: object,
        });
      } else {
        skipped.push({
          fact: f,
          reason: `retire_failed: ${res.refused || 'no_current_row'}`,
          existing: stale.object,
        });
      }
    }

    // The same fact spelled differently. Keep the spelling already in the graph —
    // writing the variant leaves two live rows that never converge, and every
    // re-run of the extract churns them again. Byte-identical repeats fall
    // through to addFact, which reports them as duplicates.
    // held is predicate-normalised; addFact is not — it looks up the canonical
    // edge only, so a row written under a pre-alias spelling is invisible to it
    // and the same fact lands twice, once per spelling. Catch both here.
    const existing = held.find(r => sameValue(r.object, object));
    if (existing) {
      const sameSpelling = normEntity(existing.object) === normEntity(object);
      skipped.push({
        fact: f,
        reason: sameSpelling ? 'duplicate' : 'equivalent_spelling_of_existing',
        existing: existing.object,
      });
      continue;
    }

    // pred, not predicate: the row must carry the canonical edge, or the alias
    // only ever applies to the compare and the graph keeps both spellings.
    const res = addFact(subject, pred, object, { validFrom, source });
    if (res.already_exists) skipped.push({ fact: f, reason: 'duplicate' });
    else added.push(res);
  }

  return { added, invalidated, skipped, conflicts };
}

// A dry run is only a preview if the commit writes what was previewed. Generation
// is not reproducible — the same input yields different predicates and different
// decompositions call to call — so the commit replays the previewed candidates
// instead of asking again. It also skips a second 60-100s model call.
// In-process, so a preview and its commit must come from one server process:
// they do when both are tool calls in one session, which is the flow /debrief uses.
const PREVIEW_TTL_MS = 60 * 60 * 1000;
const PREVIEW_LIMIT = 8;
const previews = new Map();

const previewKey = (text, source, observationDate) =>
  createHash('sha256').update(`${text}\0${source ?? ''}\0${observationDate ?? ''}`).digest('hex').slice(0, 16);

function rememberPreview(key, value) {
  previews.set(key, { ...value, at: Date.now() });
  for (const [k, v] of previews) {
    if (previews.size <= PREVIEW_LIMIT && Date.now() - v.at < PREVIEW_TTL_MS) break;
    previews.delete(k); // Map iterates in insertion order, so this drops the oldest first
  }
}

function recallPreview(key) {
  const hit = previews.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at >= PREVIEW_TTL_MS) {
    previews.delete(key);
    return null;
  }
  previews.delete(key); // one commit per preview; a re-run extracts fresh
  return hit;
}

// Orchestrator behind the kb_extract tool. Every call — success, dry run, or
// one that throws — logs one row via logExtraction (see extract-meter.js) so
// a recall bug reported weeks from now can be matched back to the call that
// produced it. The metered fields are seeded before the try so a call that
// fails before extraction even starts (e.g. non-string input) still logs
// what it can, rather than going dark.
export async function kbExtract(text, { source, observationDate, observedAt, dryRun = false } = {}) {
  const started = Date.now();
  let inputHash = null, inputChars = 0, chunkChars = [];
  let emittedCount = 0, skippedCount = 0, chunkFailures = 0, failed = false, fromPreview = false;
  try {
    inputHash = hashInput(text);
    inputChars = text.length;

    const key = previewKey(text, source, observationDate);
    const previewed = dryRun ? null : recallPreview(key);
    // One binding for both the row and the return value below — the two must
    // never disagree about whether this call replayed a preview.
    fromPreview = !!previewed;
    const { facts, skipped, chunkChars: shape } = previewed || await extractFacts(text);
    // The shape actually sent — a fresh call's own extractFacts call, or (on a
    // replay) the shape the ORIGINAL dry run sent, carried forward by
    // rememberPreview below. Never recomputed independently: a second
    // chunkForExtract call over the same text agrees today because the
    // function is pure, but would silently drift the moment extractFacts
    // changes how it slices or splits.
    chunkChars = shape;
    emittedCount = facts.length;
    skippedCount = skipped.length;
    // A chunk that died and stayed dead after CHUNK_ATTEMPTS retries — visible
    // here even when the call as a whole reports facts added, which is exactly
    // the silent-partial-failure shape this meter exists to catch.
    chunkFailures = skipped.filter(s => s?.reason?.startsWith(CHUNK_FAILED_REASON_PREFIX)).length;
    // The extractor's own skips ride along with consolidation's, so an empty
    // `skipped` beside an input full of triples is a claim the caller can trust.
    const notExtracted = skipped.map(s => ({ ...s, reason: s?.reason || 'not_extracted' }));

    if (dryRun) {
      rememberPreview(key, { facts, skipped, chunkChars: shape });
      // Candidates are shown post-split, post-alias and post-direction, since that is the triple
      // consolidation will write — previewing the raw predicate would disagree
      // with the commit for exactly the drift this preview exists to expose.
      const candidates = facts.flatMap(splitListObject)
        .map(f => (f?.subject && f?.predicate && f?.object ? canonicalTriple(f) : f));
      // Previewed too: the whole point of a self-contradicting batch is that its
      // retirements land invisibly at commit time, and a preview that showed only
      // the candidates would be the last place to catch it before they do.
      return {
        dry_run: true,
        candidates,
        conflicts: findSingleValuedConflicts(facts),
        skipped: notExtracted,
        preview_key: key,
      };
    }

    const res = consolidate(facts, { source, observationDate, observedAt });
    return { ...res, skipped: [...res.skipped, ...notExtracted], from_preview: fromPreview };
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    logExtraction({
      inputHash, inputChars, chunkChars, emittedCount, skippedCount, chunkFailures,
      dryRun, failed, fromPreview, durationMs: Date.now() - started, source: source ?? null,
    });
  }
}
