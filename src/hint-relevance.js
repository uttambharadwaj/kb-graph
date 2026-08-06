// Which notes, if any, is a whole user prompt actually about?
//
// Not a search: a query is terms the user picked, a prompt is everything they
// typed (median ~240 content words here, often a pasted transcript). bm25 sums a
// contribution per matched term, so scoring a prompt with it measures prompt
// length — 93% of results cleared the old fixed rank cut-off and no prompt ever
// came back empty.
//
// The bar here is therefore read from the note's side: how much of THIS note's
// identity — title, tags and vetted alias tokens (filterAliases below) — does
// the prompt cover, and how distinctive is it? That denominator is short and
// uniform across notes, which a prompt's is not.
import { getDb, STOP_WORDS } from './db.js';

// One shared word is a coincidence — a prompt naming a person matched a meeting
// note on the name alone, "style of speaking" matched a code-style note.
const MIN_COVERED_TERMS = 2;

// ...and must together carry the information of one term appearing in ~0.25% of
// notes, summed as ln(N/df). A fraction of ln(N) rather than a constant: a
// constant tuned on thousands of notes silences a store that holds twenty.
// Chosen on a judged sample of real prompts — precision 57% -> 76%.
const MIN_COVERED_MASS_RATIO = 0.78;

// Terms in almost no notes are one-off identifiers (commit hashes, paths); terms
// in a large fraction of them carry no signal. The floor applies only once the
// store is big enough for a topic word to recur — below that all terms are rare.
const MIN_DF_LARGE = 2;
const LARGE_CORPUS = 200;
const MAX_DF_RATIO = 0.15;

// Ceilings on the FTS work, since this runs synchronously on every prompt.
const MAX_QUERY_TERMS = 40;
const MAX_CANDIDATES = 40;

// Prefix matching bounded to inflection: unbounded, "work" covers "workflow" and
// "workstream", which are different subjects. The shared prefix itself must be
// at least MIN_PREFIX_LEN, so three-letter terms match exactly and nothing else
// — "log" is not evidence for "logic".
const MIN_PREFIX_LEN = 4;
const MAX_INFLECTION = 2;

// Splits as FTS5's unicode61 does — every non-letter/non-digit, diacritics
// folded — because these terms are looked up in that index. Deliberately not
// shared with `searchDocuments`, which splits on whitespace: right for a typed
// query, but here it leaves "bot-triage" unmatchable by "triage" and asks for
// "caf" where the index holds "cafe". The length/stop-word filters are ours.
export function tokenize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length >= 3 && !STOP_WORDS.has(t));
}

function covered(term, promptTerms, prefixable) {
  if (promptTerms.has(term)) return true;
  return prefixable.some(p => {
    const [stem, full] = p.length <= term.length ? [p, term] : [term, p];
    return stem.length >= MIN_PREFIX_LEN
      && full.startsWith(stem)
      && full.length - stem.length <= MAX_INFLECTION;
  });
}

// df for many terms in one statement; terms absent from the index are absent
// from the result and stay unscored.
function documentFrequencies(db, terms) {
  if (!terms.length) return new Map();
  const rows = db.prepare(
    `SELECT term, doc FROM documents_fts_vocab WHERE term IN (${terms.map(() => '?').join(',')})`
  ).all(...terms);
  return new Map(rows.filter(r => r.doc > 0).map(r => [r.term, r.doc]));
}

// A note may also carry alias tokens — subject words its body uses but its
// title does not ("indexer" for a note titled by what the indexer does). They
// widen identity, and identity is title-and-tags-only for a measured reason:
// bodies are ordinary working English, and scoring them as identity took the
// live fire rate from 49% to 91%, almost all of it conversational filler. So
// admission is the narrow part: a token must be the note's OWN vocabulary —
// a proposed synonym the note never uses is the fabrication class the
// grounding filter exists for — and rare enough corpus-wide to be a subject
// word rather than a working one. Rarest survive the cap, since distinctive
// is the entire value here. Callers store the result; proposals never reach
// the scorer.
const MAX_ALIAS_TOKENS = 8;

export function filterAliases(aliases, { title, tags, content }) {
  const proposed = Array.isArray(aliases) ? aliases
    : typeof aliases === 'string' ? [aliases] : [];
  if (!proposed.length) return '';
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) c FROM documents').get().c;
  const own = new Set([...tokenize(title), ...tokenize(tags)]);
  const note = [...new Set(tokenize(`${title} ${tags} ${content}`))];
  const noteSet = new Set(note);
  const prefixable = note.filter(t => t.length >= MIN_PREFIX_LEN);
  const candidates = [...new Set(proposed.flatMap(a => tokenize(a)))]
    .filter(t => !own.has(t) && covered(t, noteSet, prefixable));
  if (!candidates.length) return '';
  // df of 0 means the note is not indexed yet — filter after the write, so
  // the note's own words count themselves. The ceiling mirrors the query's:
  // a term too common to carry signal there carries none as identity either.
  const df = documentFrequencies(db, candidates);
  const maxDf = Math.max(total * MAX_DF_RATIO, MIN_DF_LARGE);
  return candidates
    .filter(t => (df.get(t) || 0) > 0 && df.get(t) <= maxDf)
    .sort((a, b) => df.get(a) - df.get(b))
    .slice(0, MAX_ALIAS_TOKENS)
    .join(' ');
}

/**
 * Notes the prompt is plausibly about, best first. Empty is a real answer and
 * the common one — most prompts are not about anything the store holds.
 */
export function relevantNotes(prompt, { limit = 3 } = {}) {
  const db = getDb();
  // Every indexed document, because that is the universe vocab's df counts over.
  // An N from a smaller population makes ln(N/df) negative for common terms — a
  // shared word that lowers a note's score. Live/archive filtering is retrieval.
  const total = db.prepare('SELECT COUNT(*) c FROM documents').get().c;
  if (!total) return [];

  const termFreq = new Map();
  for (const t of tokenize(prompt)) termFreq.set(t, (termFreq.get(t) || 0) + 1);
  const promptTerms = [...termFreq.keys()];
  if (promptTerms.length < MIN_COVERED_TERMS) return [];

  // df of 0 means "looked up, absent from the index" — cached so a term shared
  // by several candidate titles costs one lookup, not one per title.
  const dfOf = new Map();
  const load = (terms) => {
    const unknown = [...new Set(terms)].filter(t => !dfOf.has(t));
    if (!unknown.length) return;
    const found = documentFrequencies(db, unknown);
    for (const t of unknown) dfOf.set(t, found.get(t) || 0);
  };
  const idf = (t) => (dfOf.get(t) ? Math.log(total / dfOf.get(t)) : 0);
  load(promptTerms);

  // Bound the FTS query to the prompt's most informative terms. Repetition is
  // what separates a topic from an aside, so weight idf by in-prompt frequency.
  const minDf = total >= LARGE_CORPUS ? MIN_DF_LARGE : 1;
  // Keep the window non-empty however small the store is.
  const maxDf = Math.max(total * MAX_DF_RATIO, minDf);
  const query = promptTerms
    .filter(t => dfOf.get(t) >= minDf && dfOf.get(t) <= maxDf)
    .map(t => ({ term: t, weight: (1 + Math.log(termFreq.get(t))) * idf(t) }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_QUERY_TERMS);
  if (!query.length) return [];

  const candidates = db.prepare(`
    SELECT d.id, d.title, d.doc_type, d.tags, d.tier, d.aliases
    FROM documents_fts f
    JOIN documents d ON d.id = f.rowid
    WHERE documents_fts MATCH ?
      AND d.superseded_at IS NULL
      AND d.doc_type != 'archive'
    ORDER BY bm25(documents_fts, 10.0, 1.0, 5.0)
    LIMIT ?
  `).all(query.map(q => `"${q.term}" *`).join(' OR '), MAX_CANDIDATES);

  const identities = candidates.map(c => [...new Set([...tokenize(c.title), ...tokenize(c.tags), ...tokenize(c.aliases)])]);
  load(identities.flat());

  const minMass = MIN_COVERED_MASS_RATIO * Math.log(total);
  const promptSet = new Set(promptTerms);
  const prefixable = promptTerms.filter(t => t.length >= MIN_PREFIX_LEN);
  const hits = [];
  candidates.forEach((doc, i) => {
    const matched = identities[i].filter(w => dfOf.get(w) > 0 && covered(w, promptSet, prefixable));
    if (matched.length < MIN_COVERED_TERMS) return;
    const mass = matched.reduce((sum, w) => sum + idf(w), 0);
    if (mass < minMass) return;
    hits.push({ id: doc.id, title: doc.title, doc_type: doc.doc_type, tier: doc.tier, mass });
  });

  hits.sort((a, b) => b.mass - a.mass);
  return hits.slice(0, limit);
}
