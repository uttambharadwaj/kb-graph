// The predicate registry and the one canonicaliser every write path folds
// through. Its own module rather than a corner of extract.js because three
// layers need it and two of them sit below extract: facts.js normalises the
// predicate at the single INSERT, and db.js's migration 12 replays the same fold
// over rows already stored. Importing extract.js from either would close the
// cycle extract -> facts -> db. Nothing here touches the database.
import { readFileSync } from 'fs';
import { join } from 'path';
import { KB_DIR } from './paths.js';

const readJSON = path => {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    // A missing override file is the normal case; a malformed one would otherwise
    // disable an install's cardinality config with no signal at all.
    if (err.code !== 'ENOENT') console.error(`kb predicates: ignoring unreadable ${path}: ${err.message}`);
    return null;
  }
};

const BUILTIN_PATH = new URL('./predicates.json', import.meta.url);
const builtin = readJSON(BUILTIN_PATH);
const override = readJSON(join(KB_DIR, 'predicates.json'));

// Every predicate that may be stored. `preferred` is the older name for this
// key and still merges in, so an install that set one keeps working.
const declared = source => [...(source?.vocabulary || []), ...(source?.preferred || [])];
export const PREFERRED = [...declared(builtin), ...declared(override)];

// Own keys only. These maps are keyed by whatever the extractor emitted, and a
// plain object answers `toString` and `constructor` with a function — which
// normPred would then return in place of the predicate.
const lookup = (map, key) => (Object.hasOwn(map, key) ? map[key] : undefined);

// A superset of the predicate normalization facts.js used to do inline
// (lowercase, whitespace to underscore), so a stored row always matches the
// spelling computed here.
// The rest is spelling variance that carries no meaning, so folding it needs no
// list and an unseen phrasing converges like a known one: the extractor writes
// source_of_truth_for on one call and is_source_of_truth_for on the next.
// Trailing underscores are already gone when this runs, so it can never empty
// the predicate — it needs one after the copula.
const COPULA = /^(?:is|are|was|were|be|been|being)_/;
const rawPred = p => String(p).toLowerCase()
  .replace(/['’]/g, '')
  .replace(/[\s-]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .replace(COPULA, '');

// Then the two list-driven folds, cheapest first: an exact synonym, else an
// inflection of a name predicates.json registers.
export const canonicalPredicate = (p) => {
  const raw = rawPred(p);
  return lookup(PREDICATE_ALIASES, raw) ?? lookup(CANONICAL_BY_LEMMA, lemmaKey(raw)) ?? raw;
};

// A configured entity-shape pattern, named so an install that supplies a bad
// one is told which key was dropped.
const compilePattern = (key, pattern) => {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch (err) {
    console.error(`kb predicates: ignoring invalid ${key} ${JSON.stringify(pattern)}: ${err.message}`);
    return null;
  }
};

// Both patterns fall back to matching nothing, which is the do-no-harm
// direction for each: no retirement, and no re-pointing of a relationship.
const configuredPattern = key => compilePattern(key, override?.[key])
  ?? compilePattern(key, builtin?.[key])
  ?? /^$/;

// A fold whose target is itself folded never converges: canonicalTriple would
// need a second pass to finish, and the migration would rewrite the same rows on
// every run. Both a cycle (a -> b -> a) and a chain (a -> b -> c) have that
// shape, so drop the pair and fold neither — no folding is the old behaviour, a
// half-applied fold is corruption.
const withoutChains = (kind, entries) => {
  const sources = new Set(entries.map(([from]) => from));
  return entries.filter(([from, to]) => {
    if (!sources.has(to)) return true;
    console.error(`kb predicates: ignoring ${kind} ${from} -> ${to}: ${to} is itself folded, which would never converge`);
    return false;
  });
};

// This map and CANONICAL_BY_LEMMA below are both defined before the first
// canonicalPredicate() call — it reads them in that order.
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
// Alias-resolved rather than canonicalPredicate-resolved because the inflection
// map below is built from this and cannot resolve its own input. That costs
// nothing: the two agree, since nothing single-valued is inflectable.
export const SINGLE_VALUED = new Set(
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
// covers its own inflections too and canonicalPredicate still needs a single hop.
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
    console.error(`kb predicates: not folding inflections of "${key}": ${held} and ${canonical} both claim it`);
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
    // canonicalPredicate, not rawPred: canonicalTriple looks up an alias-resolved
    // predicate, so a raw key an alias rewrites could never match. It also keeps
    // an aliased target from slipping past the single-valued check below —
    // `assigned` reads as many-valued until the alias resolves it to assigned_to.
    .map(([from, to]) => [canonicalPredicate(from), canonicalPredicate(to)])
    // Folding a single-valued predicate would move the retirement it drives onto
    // a different subject, which is the failure this whole map exists to stop.
    // An install that configures one gets told, not silently un-retired.
    .filter(([from, to]) => {
      const bad = [from, to].filter(p => SINGLE_VALUED.has(p));
      if (bad.length) console.error(`kb predicates: ignoring inverse ${from} -> ${to}: ${bad.join(', ')} is single-valued`);
      return !bad.length;
    }),
));

// The direction a stored predicate folds to, or undefined if it is already
// canonical. Takes the raw spelling: a row written before an alias was
// registered still carries the old one, and it folds just the same.
export const inverseTargetOf = predicate => lookup(PREDICATE_INVERSES, canonicalPredicate(predicate));

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
  [...(builtin?.work_item_object || []), ...(override?.work_item_object || [])].map(canonicalPredicate),
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

// Not bus/config.js's getTicketRegex — that finds a ticket reference inside free
// text; this asks whether the whole subject is one.
const SINGLE_ENTITY = configuredPattern('single_valued_subjects');

// Whether a new object for this triple retires the old one. Shared, because the
// intra-call conflict check has to ask the same question consolidate does — two
// spellings of the rule would let a conflict go undetected and then be retired
// by the loop anyway, which is the failure this pair exists to stop.
export const retiresOnContradiction = f =>
  SINGLE_VALUED.has(f.predicate) && SINGLE_ENTITY.test(String(f.subject).trim());

// The triple as it will be stored: canonical predicate, canonical direction.
export function canonicalTriple(f) {
  const pred = canonicalPredicate(f.predicate);
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
