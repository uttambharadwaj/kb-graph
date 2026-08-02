// Epistemic tier: how much standing a note has earned. Without it a conclusion
// a model inferred from a transcript enters the store beside a finding whose
// fix landed, and both are injected into later sessions as context to act on.
//
// Every surface that renders or gates a tier goes through this module — the
// value appears in hints, briefings, kb_read, kb_search ranking and the vault
// frontmatter, and per-surface copies of the condition drift.

export const TIER = {
  VERIFIED: 'verified',   // a fix landed or a test proves it — requires a reference
  OBSERVED: 'observed',   // an agent directly saw the behaviour
  INFERRED: 'inferred',   // an unconfirmed model conclusion
};

// Weakest first: the index is the rank, so comparisons and the "is this a
// promotion" test both read off this one ordering.
export const TIERS = [TIER.INFERRED, TIER.OBSERVED, TIER.VERIFIED];

// What a caller gets when it says nothing, and what an unsupported claim falls
// back to. The floor is the safe answer: over-claiming defeats the feature,
// under-claiming is recoverable through kb_promote.
export const DEFAULT_TIER = TIER.INFERRED;

export const TIER_MEANING = {
  [TIER.VERIFIED]: 'a fix landed or a test proves it',
  [TIER.OBSERVED]: 'an agent directly saw this behaviour',
  [TIER.INFERRED]: 'an unconfirmed model conclusion — verify before acting on it',
};

// Only the floor is marked. A tier is printed on every surface, so marking the
// two that need no warning would make the mark meaningless.
const TIER_MARK = {
  [TIER.VERIFIED]: '',
  [TIER.OBSERVED]: '',
  [TIER.INFERRED]: '⚠ ',
};

export const tierRank = (tier) => TIERS.indexOf(coerceTier(tier));

// An unrecognised or missing tier reads as the floor rather than as an error:
// this runs on every rendered row, and a row with no tier is exactly the
// unlabelled note the feature exists to remove.
export function coerceTier(tier) {
  return TIERS.includes(tier) ? tier : DEFAULT_TIER;
}

// The inline form, for one-line surfaces (hints, briefings, list rows).
export const tierLabel = (tier) => {
  const t = coerceTier(tier);
  return `${TIER_MARK[t]}${t}`;
};

// The kb_read form: the same gating, plus the evidence and when it was recorded.
export function tierBanner({ tier, tier_ref, tier_at } = {}) {
  const t = coerceTier(tier);
  const ref = tier_ref ? ` [${tier_ref}]` : '';
  const at = t !== DEFAULT_TIER && tier_at ? ` as of ${String(tier_at).slice(0, 10)}` : '';
  return `${TIER_MARK[t]}${t.toUpperCase()}${ref}${at} — ${TIER_MEANING[t]}`;
}

// --- provenance -------------------------------------------------------------

// The nightly transcript sweep stamps this on everything it writes. Pinned here
// rather than in harvest.js because the ceiling below and the backfill both
// have to recognise it, and harvest.js imports the whole DB layer.
export const HARVEST_SOURCE_PREFIX = 'harvest:';
const UNATTENDED_PREFIXES = [HARVEST_SOURCE_PREFIX];

// An unattended pass reads transcripts and reports what a model concluded from
// them. It never watched anything run, so nothing it writes can claim to have.
export const isUnattendedSource = (source) =>
  typeof source === 'string' &&
  UNATTENDED_PREFIXES.some(p => source.trim().toLowerCase().startsWith(p));

// The provenance families the store actually contains, and the tier each one
// proves on its own. Every one of them is the floor, and that is the finding,
// not a placeholder: none of these sources shows that an agent watched the
// behaviour, and a source that does not prove observation is an inference. A
// family that later earns more than the floor changes one row here.
export const SOURCE_FAMILY_TIERS = {
  harvest: TIER.INFERRED,   // unattended transcript sweep — a model's reading of a session
  manual: TIER.INFERRED,    // hand-entered: says who typed it, not what they saw
  web: TIER.INFERRED,       // a third party's claim, captured verbatim
  session: TIER.INFERRED,   // free-text "session <date>" provenance
  file: TIER.INFERRED,      // migrated in from a markdown file
  none: TIER.INFERRED,      // no source recorded — in-session writes and debriefs
};

export function sourceFamily(source) {
  const s = typeof source === 'string' ? source.trim() : '';
  if (!s) return 'none';
  if (isUnattendedSource(s)) return 'harvest';
  if (/^https?:\/\//i.test(s) || s.toLowerCase() === 'web') return 'web';
  if (s.toLowerCase() === 'manual') return 'manual';
  if (/^session\b/i.test(s)) return 'session';
  if (/\.md$/i.test(s)) return 'file';
  return 'other';
}

// Unrecognised provenance is an inference like everything else — a new source
// has to argue its way above the floor, not inherit a pass by being unknown.
export const tierForSource = (source) => SOURCE_FAMILY_TIERS[sourceFamily(source)] ?? DEFAULT_TIER;

// --- references -------------------------------------------------------------

// A reference is stored and rendered on a single line, so it is flattened
// before it is judged: everything below tests the stored form, not the input.
export const REF_MAX_CHARS = 500;

const LABELLED_SHA = /^(?:commit|sha|git)[:=][0-9a-f]{7,40}$/i;
const BARE_SHA = /^[0-9a-f]{7,40}$/i;
const PR_URL = /\/(?:pull|pulls|merge_requests|pull-requests)\/[1-9]\d*/i;
const PR_NUMBER = /^(?:[\w.-]+\/[\w.-]+)?#[1-9]\d*$/;
const FILE_PATH = /^[\w./-]+\.[a-z]{1,5}$/i;
const TEST_PART = /(?:^|[/._-])(?:tests?|specs?|__tests__)(?:[/._-]|$)/i;
const TOKEN_EDGES = /^[("'`<[]+|[)"'`>\].,;:!?]+$/g;

export function normalizeRef(ref) {
  if (typeof ref !== 'string') return null;
  const flat = ref.replace(/\s+/g, ' ').trim();
  // Over-length is refused, not truncated: a clipped reference points nowhere.
  return flat.length > 0 && flat.length <= REF_MAX_CHARS ? flat : null;
}

function tokenIsReference(token) {
  const t = token.replace(TOKEN_EDGES, '');
  if (!t) return false;
  if (LABELLED_SHA.test(t)) return true;
  // An unlabelled run of digits is a date, a ticket number or a count far more
  // often than a sha, so a bare sha has to contain a hex letter to count.
  if (BARE_SHA.test(t) && /[a-f]/i.test(t)) return true;
  if (PR_URL.test(t)) return true;
  if (PR_NUMBER.test(t)) return true;
  return FILE_PATH.test(t) && TEST_PART.test(t);
}

// The normalized reference if it names a commit, a pull/merge request or a test
// file; null otherwise. Prose about having checked is not a reference.
export function referenceIn(ref) {
  const flat = normalizeRef(ref);
  if (!flat) return null;
  return flat.split(' ').some(tokenIsReference) ? flat : null;
}

// --- resolution -------------------------------------------------------------

/**
 * The tier a row actually gets, given what it claims.
 *
 * The reference requirement is a property of the claim itself, so it holds
 * wherever the claim came from — this is the last gate before a row lands and
 * it never throws, because it also runs over hand-edited vault frontmatter,
 * where refusing would cost a whole reindex over one bad file.
 */
export function resolveTier({ tier, ref = null } = {}) {
  const want = coerceTier(tier);
  // Kept even when the claim is refused — it is still where the claim came from.
  const text = normalizeRef(ref);
  // An unsupported claim tells us nothing, so it falls to the floor rather than
  // to the tier below it: "said verified, showed nothing" is not "observed".
  if (want === TIER.VERIFIED && !referenceIn(text)) return { tier: DEFAULT_TIER, ref: text };
  return { tier: want, ref: text };
}

/**
 * The same rules stated out loud, plus the one rule that is about the writer
 * rather than the claim: an unattended pass may only assert the floor.
 *
 * That ceiling lives here and not in `resolveTier` because it is a fact about
 * who is speaking at write time, which a stored row no longer records. A note
 * the sweep wrote is the single most likely thing a later session confirms —
 * 36% of the store arrived that way — so kb_promote must be able to raise it.
 */
export function assertTier({ tier, ref = null, provenance = null } = {}) {
  if (tier != null && !TIERS.includes(tier)) {
    throw new Error(`Unknown tier "${tier}" — expected one of ${TIERS.join(', ')}.`);
  }
  if (isUnattendedSource(provenance) && coerceTier(tier) !== DEFAULT_TIER) {
    throw new Error(
      `Source "${provenance}" is an unattended sweep, which may only write ${DEFAULT_TIER}. ` +
      `Confirm the note in a later session with kb_promote instead.`
    );
  }
  const resolved = resolveTier({ tier, ref });
  if (tier != null && resolved.tier !== tier) {
    throw new Error(
      `Tier "${TIER.VERIFIED}" requires a reference to a commit, a pull request or a test ` +
      `(e.g. "abc1234", "#42", "tests/thing.test.js"). ` +
      `${normalizeRef(ref) ? `Got: ${normalizeRef(ref)}` : 'None given'}.`
    );
  }
  return resolved;
}
