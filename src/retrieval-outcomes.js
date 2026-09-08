import { basename } from 'path';
import { readFileSync } from 'fs';
import { getDb } from './db.js';
import { hasColumn, hasTable } from './schema.js';
import {
  CORRECTED_OUTCOME_ADJUSTMENT,
  HELPED_OUTCOME_ADJUSTMENT,
  OUTCOME,
  outcomeAdjustmentForDoc,
} from './outcome-ranking.js';

export { CORRECTED_OUTCOME_ADJUSTMENT, HELPED_OUTCOME_ADJUSTMENT, OUTCOME };

export const OUTCOME_SEMANTICS = Object.freeze({
  helped: 'attributed successful use of the retrieved note/version; proxy signal, not causal proof',
});

const READ_SURFACES = new Set(['kb_read', 'rest_read']);
const REQUIRED_OUTCOME_COLUMNS = ['retrieval_id', 'doc_id', 'doc_version', 'session', 'outcome', 'evidence_kind', 'evidence_ref', 'source'];

function outcomesReady(db) {
  return hasTable(db, 'retrieval_outcomes')
    && REQUIRED_OUTCOME_COLUMNS.every(column => hasColumn(db, 'retrieval_outcomes', column));
}

export function retrievalOutcomesReady(db = getDb()) {
  return outcomesReady(db);
}

function normalizeTime(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? (value < 100000000000 ? value * 1000 : value) : null;
  // SQLite CURRENT_TIMESTAMP is UTC despite omitting a timezone marker.
  const normalized = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

function eventTime(obj, fallback) {
  const value = [obj?.timestamp, obj?.created_at, obj?.time, obj?.payload?.timestamp, obj?.payload?.created_at]
    .find(candidate => candidate != null);
  // Missing timestamps retain line-order fallback; explicit invalid ones do not.
  return value === undefined
    ? { at: fallback, hasTimestamp: false }
    : { at: normalizeTime(value), hasTimestamp: true };
}

function collectStrings(value, out = []) {
  if (out.length > 200 || value == null) return out;
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (/^(text|content|output|stdout|stderr|cmd|command|name|tool_name|type|input|tool_input|exit_code|exitCode|status|isError|is_error)$/i.test(key)) {
        out.push(key);
        collectStrings(child, out);
      } else if (key === 'payload' || key === 'message' || key === 'result' || key === 'args' || key === 'arguments') {
        collectStrings(child, out);
      }
    }
  }
  return out;
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function textFrom(value) {
  return collectStrings(parseMaybeJson(value)).join(' ').replace(/\s+/g, ' ').trim();
}

function resultFailed(value) {
  const parsed = parseMaybeJson(value);
  const values = [];
  const walk = (child, depth = 0) => {
    if (child == null || values.length > 100 || depth > 8) return;
    if (typeof child === 'string') {
      if (child.length > 20000) return;
      const decoded = parseMaybeJson(child);
      if (decoded !== child) walk(decoded, depth + 1);
      return;
    }
    if (typeof child === 'number' || typeof child === 'boolean') return;
    if (Array.isArray(child)) {
      child.forEach(item => walk(item, depth + 1));
      return;
    }
    if (typeof child === 'object') {
      for (const [key, nested] of Object.entries(child)) {
        if (/^(isError|is_error|failed|error)$/i.test(key) && nested === true) values.push(true);
        if (/^(exit_code|exitCode|code)$/i.test(key) && nested != null && Number(nested) !== 0) values.push(`exit:${nested}`);
        if (/^(status)$/i.test(key) && typeof nested === 'string' && !/^(0|ok|success|successful|passed)$/i.test(nested)) values.push(`status:${nested}`);
        walk(nested, depth + 1);
      }
    }
  };
  walk(parsed);
  return values.length > 0;
}

function eventFrom({ parsed, fallback, index, kind = 'text', callId = null, value, failed = false }) {
  const text = textFrom(value);
  return text ? { ...eventTime(parsed, fallback), text, index, kind, callId, failed } : null;
}

function pushEvent(out, event) {
  if (event) out.push(event);
}

function eventsFromContentBlocks(parsed, index, fallback) {
  const content = parsed?.message?.content ?? parsed?.content ?? parsed?.payload?.message?.content;
  if (!Array.isArray(content)) return [];
  const events = [];
  for (const block of content) {
    if (typeof block === 'string') {
      pushEvent(events, eventFrom({ parsed, fallback, index, value: block }));
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    const type = String(block.type || '').toLowerCase();
    if (type === 'text') {
      pushEvent(events, eventFrom({ parsed, fallback, index, value: block.text ?? block.content }));
    } else if (type === 'tool_use') {
      pushEvent(events, eventFrom({
        parsed,
        fallback,
        index,
        kind: 'tool_call',
        callId: block.id ?? block.tool_use_id ?? null,
        value: { name: block.name, input: block.input ?? block.tool_input ?? block.arguments },
      }));
    } else if (type === 'tool_result') {
      pushEvent(events, eventFrom({
        parsed,
        fallback,
        index,
        kind: 'tool_result',
        callId: block.tool_use_id ?? block.id ?? null,
        value: { content: block.content, output: block.output, stdout: block.stdout, stderr: block.stderr, status: block.status, isError: block.isError ?? block.is_error },
        failed: resultFailed({ status: block.status, isError: block.isError ?? block.is_error, content: block.content, output: block.output, stdout: block.stdout, stderr: block.stderr }),
      }));
    }
  }
  return events;
}

function eventsFromCodexCall(parsed, index, fallback) {
  const type = String(parsed?.type || parsed?.payload?.type || '').toLowerCase();
  if (type === 'function_call') {
    return [eventFrom({
      parsed,
      fallback,
      index,
      kind: 'tool_call',
      callId: parsed.call_id ?? parsed.callId ?? parsed.id ?? null,
      value: { name: parsed.name, arguments: parsed.arguments ?? parsed.args },
    })].filter(Boolean);
  }
  if (type === 'function_call_output') {
    return [eventFrom({
      parsed,
      fallback,
      index,
      kind: 'tool_result',
      callId: parsed.call_id ?? parsed.callId ?? parsed.id ?? null,
      value: { output: parsed.output ?? parsed.result, status: parsed.status, isError: parsed.isError ?? parsed.is_error, exit_code: parsed.exit_code ?? parsed.exitCode },
      failed: resultFailed({ output: parsed.output ?? parsed.result, status: parsed.status, isError: parsed.isError ?? parsed.is_error, exit_code: parsed.exit_code ?? parsed.exitCode }),
    })].filter(Boolean);
  }
  return [];
}

export function parseTranscriptEvents(raw) {
  const events = [];
  const lines = String(raw || '').split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = { text: trimmed };
    }
    const structured = [...eventsFromContentBlocks(parsed, index, index), ...eventsFromCodexCall(parsed, index, index)];
    if (structured.length) {
      events.push(...structured);
      return;
    }
    const text = textFrom(parsed);
    if (!text) return;
    events.push({ ...eventTime(parsed, index), text, index, kind: 'text', callId: null });
  });
  return events;
}

function sameOrAfter(event, retrieval) {
  const retrievalTime = normalizeTime(retrieval.created_at);
  if (event.at == null || retrievalTime == null) return false;
  // Plain-text or reduced JSONL fixtures have only line order. They can prove
  // attribution after the row is selected by session, but their synthetic index
  // should not be compared to a wall-clock SQLite timestamp.
  if (!event.hasTimestamp) return true;
  return event.at >= retrievalTime;
}

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function namesDocUse(text, doc) {
  const id = String(doc.id);
  const idRef = new RegExp(String.raw`\b(?:kb_read\s*\(?\s*#?${id}\s*\)?|(?:KB|note)\s*#${id})\b`, 'i');
  if (idRef.test(text)) return true;
  if (!doc.title) return false;
  return new RegExp(String.raw`\b(?:used|using|based on|per|from|following|because of|according to|applied)\b.{0,80}\b${escapeRegex(doc.title)}\b`, 'i').test(text);
}

const ACTION_STOP_WORDS = new Set([
  'used', 'using', 'based', 'following', 'because', 'according', 'applied',
  'with', 'from', 'that', 'this', 'these', 'those', 'then', 'when', 'while',
  'run', 'ran', 'test', 'tests', 'testing', 'fix', 'fixed', 'change', 'changed',
  'update', 'updated', 'implement', 'implemented', 'check', 'checked', 'verify',
  'verified', 'targeted', 'note', 'read', 'kbr', 'the', 'and', 'for', 'into',
]);

function actionTokens(text) {
  return [...new Set(String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_.\/-]+/i)
    .map(token => token.replace(/^[-_.\/]+|[-_.\/]+$/g, ''))
    .filter(token => token.length >= 3 && !ACTION_STOP_WORDS.has(token))
    .flatMap(token => [token, ...token.split(/[\/_.-]+/)])
    .map(token => token.replace(/^[-_.\/]+|[-_.\/]+$/g, ''))
    .filter(token => token.length >= 3 && !ACTION_STOP_WORDS.has(token)))];
}

function tokenMatches(a, b) {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 5 && longer.startsWith(shorter);
}

function extractAttributedAction(text, doc) {
  if (!namesDocUse(text, doc)) return null;
  const attribution = /\b(?:used|using|based on|per|from|following|because of|according to|applied)\b.{0,160}?\b(?:to|for|when|while|then|run|test|fix|implement|change|update|merge|check|verify)\b(?<action>.{0,160})/i.exec(text);
  if (!attribution) return null;
  const tokens = actionTokens(attribution.groups?.action || text);
  return tokens.length ? { tokens } : null;
}

function tokensOverlap(left, right) {
  return left.some(token => right.some(other => tokenMatches(token, other)));
}

function toolResultMatchesCall(event, call) {
  return event.kind === 'tool_result'
    && event.at != null
    && event.callId
    && event.callId === call.callId
    && !event.failed
    && isIndependentSuccess(event.text);
}

function isIndependentSuccess(text) {
  return /\b[1-9]\d*\s+(?:passing|passed)\b/i.test(text)
    || /\b(?:exit code|exit_code|status)\s*[:=]?\s*0\b/i.test(text)
    || /\b(?:MERGED|merged pull request|checks? (?:passed|green|successful))\b/i.test(text)
    || /"isError"\s*:\s*false/i.test(text);
}

function evidenceRef(prefix, transcriptPath, event) {
  return `${prefix}:${basename(transcriptPath || 'transcript')}:${event?.index ?? 'row'}`;
}

function insertOutcome(db, row) {
  db.prepare(`
    INSERT OR IGNORE INTO retrieval_outcomes
      (retrieval_id, doc_id, doc_version, session, event_id, outcome, evidence_kind, evidence_ref, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.retrieval_id,
    row.doc_id,
    row.doc_version,
    row.session,
    row.event_id ?? null,
    row.outcome,
    row.evidence_kind,
    row.evidence_ref,
    row.source,
  );
  return db.prepare('SELECT changes() AS changes').get().changes;
}

function retrievalRowsForSession(db, sessionId) {
  if (!hasTable(db, 'retrievals')) return [];
  const columns = db.prepare('PRAGMA table_info(retrievals)').all().map(c => c.name);
  const has = name => columns.includes(name);
  const docVersionSelect = has('doc_version') ? 'r.doc_version' : 'NULL AS doc_version';
  const isTestFilter = has('is_test') ? 'AND COALESCE(r.is_test, 0) = 0' : '';
  const eventIdSelect = has('event_id') ? 'r.event_id' : 'NULL AS event_id';
  return db.prepare(`
    SELECT r.id, r.doc_id, ${docVersionSelect}, r.session, ${eventIdSelect}, r.surface, r.created_at,
           d.title, d.superseded_at, d.superseded_by, d.superseded_reason
    FROM retrievals r
    JOIN documents d ON d.id = r.doc_id
    WHERE r.session = ?
      AND r.doc_id IS NOT NULL
      ${isTestFilter}
    ORDER BY r.id
  `).all(sessionId);
}

function parseSessionId(raw, transcriptPath) {
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const session = parsed.session_id ?? parsed.sessionId ?? parsed.payload?.session_id ?? parsed.payload?.sessionId;
      if (session) return session;
    } catch {}
  }
  const match = basename(transcriptPath || '').match(/([0-9a-f]{8,}(?:-[0-9a-f]{4,}){2,}|sess[-_][A-Za-z0-9_.-]+)/i);
  return match?.[1] ?? null;
}

function recordCorrectedRows(db, retrievals) {
  let recorded = 0;
  for (const row of retrievals) {
    if (!row.doc_version || !row.superseded_at) continue;
    const retrievalTime = normalizeTime(row.created_at);
    const supersededTime = normalizeTime(row.superseded_at);
    if (retrievalTime == null || supersededTime == null || supersededTime < retrievalTime) continue;
    recorded += insertOutcome(db, {
      retrieval_id: row.id,
      doc_id: row.doc_id,
      doc_version: row.doc_version,
      session: row.session,
      event_id: row.event_id,
      outcome: OUTCOME.CORRECTED,
      evidence_kind: 'document_superseded',
      evidence_ref: `superseded:${row.superseded_by ?? 'none'}:${row.superseded_reason ?? ''}`.slice(0, 240),
      source: 'harvest',
    });
  }
  return recorded;
}

function recordHelpedRows(db, retrievals, events, transcriptPath) {
  let recorded = 0;
  for (const row of retrievals) {
    if (!row.doc_version || !READ_SURFACES.has(row.surface)) continue;
    const doc = { id: row.doc_id, title: row.title };
    const attribution = events
      .map(event => ({ event, action: sameOrAfter(event, row) ? extractAttributedAction(event.text, doc) : null }))
      .find(candidate => candidate.action);
    if (!attribution) continue;
    // Helped is attributed successful use, not causal proof: the transcript has
    // to connect this retrieved version to a concrete action and a later result
    // has to succeed for that same command/test/tool target.
    const matchingCall = events.find(event => event.index > attribution.event.index
      && event.kind === 'tool_call'
      && event.at != null
      && event.callId
      && tokensOverlap(attribution.action.tokens, actionTokens(event.text)));
    if (!matchingCall) continue;
    const success = events.find(event => event.index > matchingCall.index && toolResultMatchesCall(event, matchingCall));
    if (!success) continue;
    recorded += insertOutcome(db, {
      retrieval_id: row.id,
      doc_id: row.doc_id,
      doc_version: row.doc_version,
      session: row.session,
      event_id: row.event_id,
      outcome: OUTCOME.HELPED,
      evidence_kind: 'attributed_success',
      evidence_ref: `${evidenceRef('use', transcriptPath, attribution.event)}>${evidenceRef('success', transcriptPath, success)}`,
      source: 'harvest',
    });
  }
  return recorded;
}

export async function recordRetrievalOutcomesForSession({ sessionId = null, transcriptPath, transcriptMtime = null, db = getDb(), readFile = readFileSync } = {}) {
  if (!outcomesReady(db)) return { recorded: 0, skippedReason: 'retrieval_outcomes table unavailable' };
  if (!transcriptPath) return { recorded: 0, skippedReason: 'missing transcriptPath' };
  const raw = readFile(transcriptPath, 'utf8');
  const session = sessionId ?? parseSessionId(raw, transcriptPath);
  if (!session) return { recorded: 0, skippedReason: 'missing sessionId' };
  const retrievals = retrievalRowsForSession(db, session);
  if (!retrievals.length) return { recorded: 0, sessionId: session, transcriptMtime, skippedReason: 'no retrievals' };
  const events = parseTranscriptEvents(raw);
  const recorded = recordCorrectedRows(db, retrievals) + recordHelpedRows(db, retrievals, events, transcriptPath);
  return { recorded, sessionId: session, transcriptMtime, outcomeSemantics: OUTCOME_SEMANTICS };
}

export function outcomeAdjustment(doc, db = getDb()) {
  return outcomeAdjustmentForDoc(db, doc);
}
