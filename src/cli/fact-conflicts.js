import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';
import { getDb } from '../db.js';
import { factReviewStates } from '../fact-reviews.js';
import { entityKey } from '../facts.js';
import { extractTranscriptText } from '../harvest.js';
import { canonicalPredicate } from '../predicates.js';
import { HARVEST_SOURCE_PREFIX } from '../tiers.js';
import { redactSecrets } from '../capture/terminal.js';
import { UsageError, readFlagValue } from './flags.js';

const DEFAULT_PREDICATE = 'status';
const DEFAULT_HUMAN_LIMIT = 25;
const EVIDENCE_EXCERPT_CHARS = 800;
const HARVEST_SESSION_ID = /^[A-Za-z0-9._-]{1,200}$/;
const USAGE = 'Usage: kb fact-conflicts [--predicate <name>] [--subject <name>] [--limit <N>] [--json] [--evidence]';

function harvestSources(db) {
  const sources = new Map();
  for (const { transcript_path: path } of db.prepare('SELECT transcript_path FROM harvest_log').all()) {
    if (typeof path !== 'string' || !path.endsWith('.jsonl')) continue;
    sources.set(basename(path, '.jsonl'), path);
  }
  return sources;
}

function resolveSource(source, harvestPaths) {
  if (source === null || source === '') return { status: 'absent', mapped: false, available: false };
  if (!source.startsWith(HARVEST_SOURCE_PREFIX)) {
    return { status: 'unsupported', mapped: false, available: false };
  }

  const sessionId = source.slice(HARVEST_SOURCE_PREFIX.length);
  if (!HARVEST_SESSION_ID.test(sessionId)) {
    return { status: 'unmapped', mapped: false, available: false };
  }

  const transcriptPath = harvestPaths.get(sessionId);
  if (!transcriptPath) return { status: 'unmapped', mapped: false, available: false };
  if (!existsSync(transcriptPath)) {
    return { status: 'missing', mapped: true, available: false, transcript_path: transcriptPath };
  }
  return { status: 'available', mapped: true, available: true, transcript_path: transcriptPath };
}

const FALLBACK_WORDS = new Set(['with', 'from', 'into', 'over', 'under', 'status', 'state']);

function uniqueTerms(terms) {
  const seen = new Set();
  return terms.filter(term => {
    const key = term?.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function occurrences(text, term) {
  const found = [];
  const needle = term.toLowerCase();
  let from = 0;
  while (from < text.length) {
    const index = text.indexOf(needle, from);
    if (index === -1) break;
    const before = text[index - 1];
    const after = text[index + needle.length];
    if ((!before || !/[a-z0-9]/i.test(before)) && (!after || !/[a-z0-9]/i.test(after))) {
      found.push(index);
    }
    from = index + Math.max(needle.length, 1);
  }
  return found;
}

function closestEvidencePair(text, subjectTerms, objectTerms, maxSpan) {
  let best = null;
  for (const subjectTerm of subjectTerms) {
    for (const subjectAt of occurrences(text, subjectTerm)) {
      for (const objectTerm of objectTerms) {
        for (const objectAt of occurrences(text, objectTerm)) {
          const start = Math.min(subjectAt, objectAt);
          const end = Math.max(subjectAt + subjectTerm.length, objectAt + objectTerm.length);
          const span = end - start;
          if (span <= maxSpan && (!best || span < best.span)) {
            best = { subjectTerm, objectTerm, start, end, span };
          }
        }
      }
    }
  }
  return best;
}

function excerptFor(text, assertion, maxChars = EVIDENCE_EXCERPT_CHARS) {
  const subjectTerms = uniqueTerms([
    assertion.subject_name,
    assertion.subject.replaceAll('_', ' '),
  ]);
  const objectPhrases = uniqueTerms([
    assertion.object_name,
    assertion.object.replaceAll('_', ' '),
  ]);
  const lower = text.toLowerCase();
  let pair = closestEvidencePair(lower, subjectTerms, objectPhrases, maxChars);
  if (!pair) {
    const subjectWords = new Set(subjectTerms.flatMap(term => term.toLowerCase().split(/[^a-z0-9]+/)));
    const fallback = uniqueTerms(objectPhrases
      .flatMap(term => term.split(/[^A-Za-z0-9]+/))
      .filter(term => term.length >= 2 && !FALLBACK_WORDS.has(term.toLowerCase()) && !subjectWords.has(term.toLowerCase()))
      .sort((a, b) => b.length - a.length));
    pair = closestEvidencePair(lower, subjectTerms, fallback, maxChars);
  }
  if (!pair) return { match: 'not_found', excerpt: null };

  const padding = Math.floor((maxChars - pair.span) / 2);
  const start = Math.max(0, pair.start - padding);
  const end = Math.min(text.length, Math.max(pair.end + padding, start + maxChars));
  const raw = `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
  return { match: `${pair.subjectTerm} + ${pair.objectTerm}`, excerpt: redactSecrets(raw) };
}

function withExcerpt(evidence, assertion, transcriptCache) {
  if (evidence.status !== 'available') return evidence;
  let text = transcriptCache.get(evidence.transcript_path);
  if (text === undefined) {
    try {
      text = extractTranscriptText(readFileSync(evidence.transcript_path, 'utf8'));
      transcriptCache.set(evidence.transcript_path, text);
    } catch (error) {
      return { ...evidence, status: 'unreadable', available: false, error: error.code || error.message };
    }
  }
  return { ...evidence, ...excerptFor(text, assertion) };
}

function provenanceSummary(assertions) {
  const bySource = new Map();
  for (const assertion of assertions) {
    if (assertion.source !== null && assertion.source !== '' && !bySource.has(assertion.source)) {
      bySource.set(assertion.source, assertion.evidence);
    }
  }
  const count = (status, rows = assertions.map(row => row.evidence)) =>
    rows.filter(row => row.status === status).length;
  const distinct = [...bySource.values()];
  return {
    source_present: assertions.length - count('absent'),
    source_missing: count('absent'),
    resolution: 'evaluated',
    mapped: assertions.filter(row => row.evidence.mapped).length,
    evidence_available: count('available'),
    evidence_missing: count('missing'),
    unreadable: count('unreadable'),
    unmapped: count('unmapped'),
    unsupported: count('unsupported'),
    distinct_sources: {
      total: distinct.length,
      mapped: distinct.filter(row => row.mapped).length,
      evidence_available: count('available', distinct),
      evidence_missing: count('missing', distinct),
      unreadable: count('unreadable', distinct),
      unmapped: count('unmapped', distinct),
      unsupported: count('unsupported', distinct),
    },
  };
}

// Multiple current objects are candidates for adjudication, not proof that the
// rows contradict. A repo can accumulate true statements under a predicate a
// ticket uses as lifecycle state. This report deliberately preserves every raw
// row and its provenance so a later policy can make that distinction from the
// evidence instead of from the count alone.
export function factConflicts(db = getDb(), {
  predicate = DEFAULT_PREDICATE,
  subject = null,
  includeEvidence = false,
} = {}) {
  const canonical = canonicalPredicate(predicate);
  const subjectId = subject ? entityKey(subject) : null;
  const subjectFilter = subjectId ? 'AND subject = ?' : '';
  const params = subjectId ? [canonical, subjectId, canonical] : [canonical, canonical];
  const rows = db.prepare(`
    WITH contested AS (
      SELECT subject
      FROM facts
      WHERE predicate = ? AND valid_to IS NULL ${subjectFilter}
      GROUP BY subject
      HAVING COUNT(DISTINCT object) > 1
    )
    SELECT
      f.id,
      f.subject,
      s.name AS subject_name,
      f.object,
      o.name AS object_name,
      f.valid_from,
      f.source,
      f.created_at AS recorded_at
    FROM facts f
    JOIN contested c ON c.subject = f.subject
    JOIN entities s ON s.id = f.subject
    JOIN entities o ON o.id = f.object
    WHERE f.predicate = ? AND f.valid_to IS NULL
    ORDER BY f.subject, COALESCE(f.valid_from, ''), f.created_at, f.id
  `).all(...params);

  // One review query and one item query for the whole report. Per-group reads
  // would turn the 215-subject live report into an avoidable N+1 path.
  const reviewStates = factReviewStates(db, { predicate: canonical, currentFacts: rows });
  const paths = harvestSources(db);
  const transcriptCache = new Map();
  const resolvedBySource = new Map();
  const bySubject = new Map();
  for (const row of rows) {
    let group = bySubject.get(row.subject);
    if (!group) {
      group = { subject: row.subject, subject_name: row.subject_name, assertions: [] };
      bySubject.set(row.subject, group);
    }
    const assertion = {
      id: row.id,
      subject: row.subject,
      subject_name: row.subject_name,
      object: row.object,
      object_name: row.object_name,
      source: row.source,
      valid_from: row.valid_from,
      recorded_at: row.recorded_at,
    };
    let evidence = resolvedBySource.get(row.source);
    if (!evidence) {
      evidence = resolveSource(row.source, paths);
      if (row.source !== null && row.source !== '') resolvedBySource.set(row.source, evidence);
    }
    assertion.evidence = includeEvidence
      ? withExcerpt(evidence, assertion, transcriptCache)
      : evidence;
    group.assertions.push(assertion);
  }

  const groups = [...bySubject.values()]
    .map(group => {
      const review = reviewStates.get(group.subject);
      const items = new Map(review.items.map(item => [item.fact_id, item]));
      for (const assertion of group.assertions) {
        const item = items.get(assertion.id);
        assertion.adjudication = item ? {
          review_id: review.review_id,
          disposition: item.disposition,
          target_fact_id: item.target_fact_id,
          evidence_ref: item.evidence_ref,
          reason: item.reason,
        } : null;
      }
      return {
        ...group,
        distinct_objects: new Set(group.assertions.map(row => row.object)).size,
        adjudication: {
          state: review.state,
          projection: review.projection,
          review_id: review.review_id,
          reviewed_at: review.reviewed_at,
          reviewer: review.reviewer,
          policy: review.policy,
          note: review.note,
          current_fact_ids: review.current?.map(fact => fact.id) ?? null,
          ...(review.drift ? { drift: review.drift } : {}),
        },
      };
    })
    .sort((a, b) => b.distinct_objects - a.distinct_objects || a.subject.localeCompare(b.subject));

  const assertions = groups.flatMap(group => group.assertions);
  const countReview = state => groups.filter(group => group.adjudication.state === state).length;
  return {
    predicate: canonical,
    subject: subjectId,
    contested_subjects: groups.length,
    contested_assertions: rows.length,
    provenance: provenanceSummary(assertions),
    adjudication: {
      adjudicated: countReview('adjudicated'),
      stale: countReview('stale'),
      unadjudicated: countReview('unadjudicated'),
      projection_available: groups.filter(group => group.adjudication.projection === 'available').length,
      projection_abstained: groups.filter(group => group.adjudication.projection === 'abstained').length,
    },
    groups,
  };
}

const shownReport = (report, limit) => {
  const groups = limit === null ? report.groups : report.groups.slice(0, limit);
  return { ...report, shown_subjects: groups.length, groups };
};

export function formatFactConflicts(report, { limit = DEFAULT_HUMAN_LIMIT } = {}) {
  const shown = shownReport(report, limit);
  const lines = [
    'Current Fact Conflict Candidates',
    '================================',
    `Predicate: ${shown.predicate}`,
    ...(shown.subject ? [`Subject: ${shown.subject}`] : []),
    `Contested subjects: ${shown.contested_subjects}`,
    `Assertions in contested groups: ${shown.contested_assertions}`,
    `Source field present: ${shown.provenance.source_present}/${shown.contested_assertions}`,
    `Evidence assertions: ${shown.provenance.evidence_available} available, ${shown.provenance.evidence_missing} missing, ${shown.provenance.unreadable} unreadable, ${shown.provenance.unmapped} unmapped, ${shown.provenance.unsupported} unsupported, ${shown.provenance.source_missing} absent`,
    `Distinct sources: ${shown.provenance.distinct_sources.evidence_available} available, ${shown.provenance.distinct_sources.evidence_missing} missing, ${shown.provenance.distinct_sources.unreadable} unreadable, ${shown.provenance.distinct_sources.unmapped} unmapped, ${shown.provenance.distinct_sources.unsupported} unsupported`,
    `Adjudication: ${shown.adjudication.adjudicated} reviewed, ${shown.adjudication.stale} stale, ${shown.adjudication.unadjudicated} unreviewed; ${shown.adjudication.projection_available} projections available`,
    'Caution: multiple current objects require evidence review; they do not prove contradiction.',
  ];

  if (shown.shown_subjects < shown.contested_subjects) {
    lines.push(`Showing ${shown.shown_subjects}/${shown.contested_subjects} subjects (use --limit to change).`);
  }

  for (const group of shown.groups) {
    const label = group.subject_name === group.subject
      ? group.subject
      : `${group.subject_name} [${group.subject}]`;
    const review = group.adjudication;
    const drift = review.drift
      ? `, +${review.drift.added.length}/-${review.drift.removed.length} facts`
      : '';
    lines.push(
      '',
      `${label}: ${group.distinct_objects} current objects`,
      `  adjudication=${review.state} projection=${review.projection}`
        + `${review.review_id ? ` review=#${review.review_id}` : ''}${drift}`,
    );
    for (const assertion of group.assertions) {
      const object = assertion.object_name === assertion.object
        ? assertion.object
        : `${assertion.object_name} [${assertion.object}]`;
      lines.push(
        `  - ${object}`,
        `    fact=${assertion.id} source=${assertion.source ?? '(none)'} evidence=${assertion.evidence.status} disposition=${assertion.adjudication?.disposition ?? '(unreviewed)'} valid_from=${assertion.valid_from ?? '(unbounded)'} recorded_at=${assertion.recorded_at}`,
      );
      if (assertion.adjudication?.target_fact_id) {
        lines.push(`    target=${assertion.adjudication.target_fact_id}`);
      }
      if (assertion.adjudication?.reason) lines.push(`    review_reason=${assertion.adjudication.reason}`);
      if (assertion.evidence.transcript_path) lines.push(`    transcript=${assertion.evidence.transcript_path}`);
      if (assertion.evidence.excerpt) lines.push(`    excerpt=${assertion.evidence.excerpt.replaceAll('\n', '\n      ')}`);
    }
  }
  return lines.join('\n');
}

export function runFactConflictsCli(args = []) {
  const predicate = readFlagValue(args, '--predicate') ?? DEFAULT_PREDICATE;
  const subject = readFlagValue(args, '--subject') ?? null;
  const includeEvidence = args.includes('--evidence');
  if (!String(predicate).trim()) {
    throw new UsageError('--predicate must not be empty', USAGE);
  }
  if (subject !== null && !String(subject).trim()) {
    throw new UsageError('--subject must not be empty', USAGE);
  }
  if (includeEvidence && !subject) {
    throw new UsageError('--evidence requires --subject to keep transcript reads bounded', USAGE);
  }

  const limitRaw = readFlagValue(args, '--limit');
  const limit = limitRaw === undefined ? null : Number(limitRaw);
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
    throw new UsageError(`--limit must be a positive integer, got: ${limitRaw}`, USAGE);
  }

  const report = factConflicts(getDb(), { predicate, subject, includeEvidence });
  if (args.includes('--json')) {
    console.log(JSON.stringify(shownReport(report, limit), null, 2));
    return;
  }
  console.log(formatFactConflicts(report, { limit: limit ?? DEFAULT_HUMAN_LIMIT }));
}
