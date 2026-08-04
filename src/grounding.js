// Grounding: the extractor asserts things its source text never states —
// entities the text never names, and event dates it invents. Prompt rules do
// not hold (measured ~16% compliance on this class), so the guarantee is this
// deterministic filter, run over the parsed triples before consolidation ever
// sees them. Nothing is dropped silently: every rejection and every date
// override is reported on the `skipped` channel the caller already reads.

// One normalizer, used on both sides of every comparison. Case, separators
// (space / underscore / hyphen / dot / slash) and punctuation — including the
// '#' of a ticket id — carry no meaning here, and the extractor rewrites all of
// them freely. Letters and digits of any script survive.
export const normalizeForGrounding = s =>
  String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// English inflection, folded on both sides of the comparison — the extractor
// nominalises the text's verbs when it coins a name ("points at the sandbox"
// becomes ..._pointing). Stemming both sides means an over-eager fold can only
// ever accept more, never drop a name the text really used. Short tokens are
// left alone: "ga" and "ids" have nothing to strip and everything to lose.
const stemToken = (t) => {
  if (t.length < 5) return t;
  const base = t.replace(/(?:ing|ed|es|s)$/, '');
  return (base.length >= 3 ? base : t).replace(/e$/, '');
};

const tokensOf = s => normalizeForGrounding(s).split(' ').filter(Boolean).map(stemToken);

// Skip reasons, spelled once: tests and any downstream filter share these
// prefixes rather than re-typing them. Both are about grounding, so neither can
// be confused with a chunk failure or a vocabulary rejection.
export const UNGROUNDED_REASON_PREFIX = 'ungrounded: ';
export const DATE_OVERRIDE_REASON_PREFIX = 'date_ungrounded: ';

// The references a string carries — "#3865", a ticket id, a commit SHA. The
// extractor qualifies and un-qualifies these at will ("fde94d6" written back as
// "commit fde94d6", "PR #3865" as "web-app PR #3865"), so for those names it is
// the reference, not the phrasing, that the text has to state. The SHA arm
// needs a digit: English words are hexadecimal more often than you would like
// ("deface").
const REFERENCE = /#\s*(\d+)|\b([a-z]{2,6}-\d+)\b|\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g;
const referencesIn = (s) => {
  const out = new Set();
  for (const m of String(s ?? '').toLowerCase().matchAll(REFERENCE)) out.add(m[1] ? `#${m[1]}` : (m[2] || m[0]));
  return out;
};

// A quantity is legitimately reworded on the way out — "three times" becomes 3,
// "one point one" becomes v1.1 — so a value-shaped object is exempt from the
// text check. The ceiling that buys: a fabricated count or version survives.
// Dates are NOT exempt — they go through dateStatedIn below, which reads every
// spelling a date is written in, so an invented one is still caught.
const VALUE_SHAPED = /^v?\d+(?:\.\d+)*\s*(?:%|x|ms|s|m|h|d|k|kb|mb|gb)?$/i;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// The one shape a per-fact date may take. Consolidation asks this too, of facts
// that never came through this filter (kb_fact_add, a direct consolidate call),
// so the store can only ever receive a date this module would have accepted.
export const isIsoDate = v => ISO_DATE.test(String(v ?? ''));

const MONTHS = [
  ['january', 'jan'], ['february', 'feb'], ['march', 'mar'], ['april', 'apr'],
  ['may'], ['june', 'jun'], ['july', 'jul'], ['august', 'aug'],
  ['september', 'sept', 'sep'], ['october', 'oct'], ['november', 'nov'], ['december', 'dec'],
];

/**
 * Whether `text` states the date `iso` (YYYY-MM-DD), in any of the spellings
 * people actually write: 2026-07-28, 2026/7/28, July 28, Jul. 28th, 28 July,
 * 7/28. Year-less spellings ground the month and day only — "July 28" in a
 * transcript from 2026 grounds a 2025-07-28 claim too, which is the generous
 * direction and the stated ceiling.
 */
export function dateStatedIn(text, iso) {
  const m = ISO_DATE.exec(String(iso ?? ''));
  if (!m) return false;
  const [, year, mm, dd] = m;
  const month = Number(mm), day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const names = MONTHS[month - 1].join('|');
  const d = `0?${day}`, mo = `0?${month}`, ord = '(?:st|nd|rd|th)?';
  return [
    `\\b${year}[-/.]${mo}[-/.]${d}\\b`,             // 2026-07-28, 2026/7/28
    `\\b(?:${names})\\.?\\s+${d}${ord}\\b`,         // July 28, Jul. 28th
    `\\b${d}${ord}\\s+(?:of\\s+)?(?:${names})\\b`,  // 28 July, 28th of July
    `\\b${mo}[/-]${d}(?![0-9])`,                    // 7/28, 07-28, 7/28/2026
  ].some(p => new RegExp(p, 'i').test(String(text ?? '')));
}

// A surface form is grounded when every token of it appears somewhere in the
// text, or when the references it carries all do. Token-wise rather than
// contiguous because the prompt asks the extractor to coin compound names for
// concepts ("user_identity_pr_stack" out of "an 8-PR stack moving user
// identity") — requiring the coinage verbatim would drop the inferences the
// prompt exists to collect, while a name built from words the text never used
// is still rejected. That is the ceiling: this catches an invented ENTITY, not
// an invented relationship between two entities the text does name.
const isGrounded = (value, { textTokens, textRefs }) => {
  const refs = referencesIn(value);
  if (refs.size && [...refs].every(r => textRefs.has(r))) return true;
  const tokens = tokensOf(value);
  return tokens.length > 0 && tokens.every(t => textTokens.has(t));
};

// The object side takes two extra rules the subject side does not: a bare
// quantity is exempt, and a bare ISO date must be stated as a date rather than
// as three separate numbers that happen to appear ("2026" and "28" from an
// unrelated PR number would otherwise ground an invented 2026-07-28).
const isObjectGrounded = (value, ctx) => {
  const raw = String(value ?? '').trim();
  if (isIsoDate(raw)) return dateStatedIn(ctx.text, raw);
  if (VALUE_SHAPED.test(raw)) return true;
  return isGrounded(raw, ctx);
};

const assertionOf = f => `${f.subject} ${f.predicate} ${f.object}`;

/**
 * The date this fact starts, checked against the text.
 *
 * The extractor stamps the observation date onto events the text dates itself
 * ("merged on July 28", read on August 4), so the interval is wrong from birth
 * and every temporal query inherits it. A date it emits is therefore kept only
 * when the text states it; otherwise the fact falls back to the observation
 * date — and the fallback is reported, because a silent correction is a new
 * invisible behaviour, which is the disease this filter exists to treat.
 */
function groundValidFrom(claimed, text, observationDate) {
  if (claimed === undefined || claimed === null || claimed === '') return { grounded: true };
  const value = String(claimed);
  if (value === observationDate) return { grounded: true };
  if (isIsoDate(value) && dateStatedIn(text, value)) return { grounded: true };
  const why = isIsoDate(value) ? 'text does not state it' : 'not a YYYY-MM-DD date';
  return {
    grounded: false,
    reason: `${DATE_OVERRIDE_REASON_PREFIX}model claimed ${value}, ${why}, used observation date ${observationDate}`,
  };
}

/**
 * Filter parsed triples down to the ones the source text supports.
 *
 * Returns the survivors in input order plus one skip entry per rejection and
 * per date override — an ungrounded triple never reaches the store, and an
 * ungrounded valid_from is stripped so consolidation falls back to the
 * observation date on its own.
 */
export function groundTriples(facts, text, { observationDate } = {}) {
  const ctx = {
    text: String(text ?? ''),
    textTokens: new Set(tokensOf(text)),
    textRefs: referencesIn(text),
  };
  const fallbackDate = observationDate || new Date().toISOString().split('T')[0];
  const kept = [], skipped = [];

  for (const fact of Array.isArray(facts) ? facts : []) {
    // An incomplete triple is consolidation's to report — calling it ungrounded
    // here would rename a different failure and hide the real one.
    if (!fact?.subject || !fact?.predicate || !fact?.object) {
      kept.push(fact);
      continue;
    }

    const ungrounded = [];
    if (!isGrounded(fact.subject, ctx)) ungrounded.push(`subject "${fact.subject}"`);
    if (!isObjectGrounded(fact.object, ctx)) ungrounded.push(`object "${fact.object}"`);
    if (ungrounded.length) {
      skipped.push({
        assertion: assertionOf(fact),
        fact,
        reason: `${UNGROUNDED_REASON_PREFIX}${ungrounded.join(' and ')} not in source text`,
      });
      continue;
    }

    const date = groundValidFrom(fact.valid_from, ctx.text, fallbackDate);
    if (date.grounded) {
      kept.push(fact);
      continue;
    }
    skipped.push({ assertion: assertionOf(fact), fact, reason: date.reason });
    const corrected = { ...fact };
    delete corrected.valid_from;
    kept.push(corrected);
  }

  return { facts: kept, skipped };
}

// The wiring shape: an extraction result in, the same result with its triples
// grounded and its skips extended, out. One expression at the call site, so the
// filter cannot be half-applied.
export function groundExtraction(extraction, text, options = {}) {
  const { facts, skipped } = groundTriples(extraction?.facts, text, options);
  return {
    ...extraction,
    facts,
    skipped: [...(Array.isArray(extraction?.skipped) ? extraction.skipped : []), ...skipped],
  };
}
