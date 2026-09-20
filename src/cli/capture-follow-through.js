// Aggregate checkpoint outcomes without exposing the session-level evidence
// used to correlate them. Time joins are observational correlations only.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDb } from '../db.js';
import { AGENT } from '../process-ancestry.js';
import { isTestSession } from '../retrieval.js';
import {
  MAINTENANCE_TOOL,
  WRITE_BACKED_MAINTENANCE_TOOLS,
} from '../tool-names.js';
import { WRITE_DECISION_SOURCE } from '../write-meter.js';
import {
  CHECKPOINT_DECLINE_REASON,
  CHECKPOINT_LOG_DIR,
  CHECKPOINT_REASON,
  decideCheckpoint,
} from './checkpoint-hook.js';
import { acceptFlags, readFlagValue } from './flags.js';
import { measurementWindow, toMs } from './follow-through.js';

export const CAPTURE_COHORT = Object.freeze({
  REMINDER_EMITTED: 'reminder_emitted',
  LOG_ONLY: 'log_only',
});

export const CAPTURE_STATE = Object.freeze({
  IMMEDIATE_CAPTURE: 'immediate_capture',
  DUPLICATE_ATTEMPT: 'duplicate_attempt',
  LATER_DUPLICATE_OUTCOME: 'later_duplicate_outcome',
  DELAYED_SALVAGE: 'delayed_salvage',
  NO_CORRELATED_CAPTURE: 'no_correlated_capture',
  UNATTRIBUTABLE: 'unattributable',
  AGENT_ONLY_UNATTRIBUTED: 'agent_only_unattributed',
});

export const CHECKPOINT_REPLAY_LABEL = Object.freeze({
  POSITIVE: 'positive',
  DELIBERATE_SILENCE: 'deliberate_silence',
  SECRET_INJECTION: 'secret_injection',
  DUPLICATE: 'duplicate',
  DELAYED_SALVAGE: 'delayed_salvage',
});

export const CAPTURE_AGENT = Object.freeze({
  CLAUDE: AGENT.CLAUDE,
  CODEX: AGENT.CODEX,
  CURSOR: AGENT.CURSOR,
  UNKNOWN: 'unknown',
});
export const CAPTURE_REASON = Object.freeze({
  ...CHECKPOINT_REASON,
  UNKNOWN: 'unknown',
});
const REPORT_DECLINE_REASON = Object.freeze({
  EMITTED: 'emitted',
  ...CHECKPOINT_DECLINE_REASON,
  UNKNOWN: 'unknown',
});
const EVIDENCE_SOURCE = Object.freeze({
  ...WRITE_DECISION_SOURCE,
  UNKNOWN: 'unknown',
});
const CANDIDATE_FILE = /^candidates-.*\.jsonl$/;
const REPLAY_PATH = fileURLToPath(
  new URL('../../eval/checkpoint-replay-v1.json', import.meta.url),
);
const FOLLOW_WINDOW_MINUTES = 30;
const FOLLOW_WINDOW_MS = FOLLOW_WINDOW_MINUTES * 60 * 1000;
const USAGE = 'Usage: kb capture-follow-through [--json] [--since <ISO-8601>] [--through <ISO-8601>] [--log-dir <path>]';
const REPLAY_UNAVAILABLE = Object.freeze({
  available: false,
  version: null,
  cases: 0,
  tp: 0,
  fp: 0,
  fn: 0,
  tn: 0,
  precision: null,
  recall: null,
  unsafe_capture: 0,
});

function emptyPartition(vocabulary) {
  return Object.fromEntries(Object.values(vocabulary).map(value => [value, 0]));
}

function knownOr(value, vocabulary) {
  return Object.values(vocabulary).includes(value) ? value : vocabulary.UNKNOWN;
}

function parseCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ts = typeof value.ts === 'string' ? value.ts : null;
  const at = ts === null ? null : toMs(ts);
  let agent = CAPTURE_AGENT.UNKNOWN;
  if (value.agent != null) {
    if (typeof value.agent !== 'string') return null;
    agent = knownOr(value.agent, CAPTURE_AGENT);
  }
  let session = null;
  if (value.session != null) {
    if (typeof value.session !== 'string') return null;
    if (
      value.session
      && value.session.length <= 200
      && value.session === value.session.trim()
    ) session = value.session;
  }
  if (
    !Number.isFinite(at)
    || typeof value.reason !== 'string'
    || typeof value.emitted !== 'boolean'
  ) return null;
  return {
    ts,
    at,
    agent,
    session,
    reason: knownOr(value.reason, CAPTURE_REASON),
    emitted: value.emitted,
    declineReason: value.emitted
      ? REPORT_DECLINE_REASON.EMITTED
      : knownOr(value.decline_reason, REPORT_DECLINE_REASON),
  };
}

export function readCheckpointCandidates(logDir = CHECKPOINT_LOG_DIR) {
  let names;
  try {
    names = readdirSync(logDir);
  } catch {
    return { rows: [], malformedLines: 0 };
  }

  const rows = [];
  let malformedLines = 0;
  for (const name of names) {
    if (!CANDIDATE_FILE.test(name)) continue;
    let text;
    try {
      text = readFileSync(join(logDir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = parseCandidate(JSON.parse(line));
        if (row) rows.push(row);
        else malformedLines += 1;
      } catch {
        malformedLines += 1;
      }
    }
  }
  return { rows, malformedLines };
}

function exactKey(agent, session) {
  return `${agent}\0${session}`;
}

function groupByIdentity(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (row.session == null || row.agent == null) continue;
    const key = exactKey(row.agent, row.session);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
}

function inRange(row, start, end) {
  const at = toMs(row.created_at);
  return at !== null && at >= start && at <= end;
}

function harvestBasenameMatches(source, session) {
  if (typeof source !== 'string' || !source.startsWith('harvest:')) return false;
  const transcript = basename(source.slice('harvest:'.length));
  return transcript === session || transcript.endsWith(`-${session}`);
}

function loadEvidence(db, candidates, throughMs) {
  const firstAt = candidates.reduce(
    (earliest, row) => Math.min(earliest, row.at),
    Number.POSITIVE_INFINITY,
  );
  const since = new Date(firstAt).toISOString();
  const through = new Date(throughMs).toISOString();
  const tools = Object.values(MAINTENANCE_TOOL);
  const toolRows = db.prepare(`
    SELECT tool, ok, session, agent, created_at
    FROM tool_calls
    WHERE tool IN (${tools.map(() => '?').join(', ')})
      AND datetime(created_at) >= datetime(?)
      AND datetime(created_at) <= datetime(?)
  `).all(...tools, since, through);
  const writeRows = db.prepare(`
    SELECT refused, doc_id, session, agent, source, created_at
    FROM write_decisions
    WHERE datetime(created_at) >= datetime(?)
      AND datetime(created_at) <= datetime(?)
  `).all(since, through);
  const docIds = [...new Set(
    writeRows.map(row => row.doc_id).filter(id => id !== null),
  )];
  const documentRows = db.prepare(`
    SELECT id, source, created_at, superseded_at
    FROM documents
    WHERE datetime(created_at) <= datetime(?)
      AND (
        source LIKE 'harvest:%'
        OR ${docIds.length ? `id IN (${docIds.map(() => '?').join(', ')})` : '0'}
      )
  `).all(through, ...docIds);
  return { toolRows, writeRows, documentRows };
}

function classifyCandidate(candidate, evidence, throughMs) {
  if (candidate.agent === AGENT.CURSOR) {
    return {
      state: CAPTURE_STATE.AGENT_ONLY_UNATTRIBUTED,
      duplicateAttempt: false,
    };
  }
  if (![AGENT.CLAUDE, AGENT.CODEX].includes(candidate.agent) || !candidate.session) {
    return {
      state: CAPTURE_STATE.UNATTRIBUTABLE,
      duplicateAttempt: false,
    };
  }

  const key = exactKey(candidate.agent, candidate.session);
  const immediateEnd = candidate.at + FOLLOW_WINDOW_MS;
  const tools = evidence.toolsByIdentity.get(key) ?? [];
  const writes = evidence.writesByIdentity.get(key) ?? [];
  const immediateTools = tools.filter(row =>
    row.ok
    && !WRITE_BACKED_MAINTENANCE_TOOLS.includes(row.tool)
    && inRange(row, candidate.at, immediateEnd));
  const immediateWrites = writes.filter(row =>
    inRange(row, candidate.at, immediateEnd));
  const refused = immediateWrites.filter(row => row.refused);
  const accepted = immediateWrites.filter(row => !row.refused);
  const immediateAuthored = immediateTools.length > 0 || accepted.length > 0;

  const laterDuplicate = accepted.some((row) => {
    if (row.doc_id == null) return false;
    const doc = evidence.documentsById.get(row.doc_id);
    const supersededAt = toMs(doc?.superseded_at);
    return supersededAt !== null
      && supersededAt > toMs(row.created_at)
      && supersededAt <= throughMs;
  });
  if (laterDuplicate) {
    return {
      state: CAPTURE_STATE.LATER_DUPLICATE_OUTCOME,
      duplicateAttempt: refused.length > 0,
    };
  }
  if (immediateAuthored) {
    return {
      state: CAPTURE_STATE.IMMEDIATE_CAPTURE,
      duplicateAttempt: refused.length > 0,
    };
  }

  const harvestDecision = writes.some(row =>
    !row.refused
    && row.source === WRITE_DECISION_SOURCE.HARVEST
    && inRange(row, immediateEnd + 1, throughMs));
  const harvestProvenance = evidence.harvestDocuments.some(row =>
    harvestBasenameMatches(row.source, candidate.session)
    && inRange(row, immediateEnd + 1, throughMs));
  if (harvestDecision || harvestProvenance) {
    return {
      state: CAPTURE_STATE.DELAYED_SALVAGE,
      duplicateAttempt: refused.length > 0,
    };
  }
  if (refused.length > 0) {
    return {
      state: CAPTURE_STATE.DUPLICATE_ATTEMPT,
      duplicateAttempt: true,
    };
  }
  return {
    state: CAPTURE_STATE.NO_CORRELATED_CAPTURE,
    duplicateAttempt: false,
  };
}

function publicWindow(window) {
  return {
    since: window.since,
    through: window.through,
    eligibleEventThrough: window.eligibleEventThrough,
    followWindowMinutes: FOLLOW_WINDOW_MINUTES,
    bounds: 'inclusive',
  };
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function finalizeCohort(cohort) {
  const immediateAuthored = cohort.byState[CAPTURE_STATE.IMMEDIATE_CAPTURE]
    + cohort.byState[CAPTURE_STATE.LATER_DUPLICATE_OUTCOME];
  const delayedSalvage = cohort.byState[CAPTURE_STATE.DELAYED_SALVAGE];
  const unattributable = cohort.byState[CAPTURE_STATE.UNATTRIBUTABLE]
    + cohort.byState[CAPTURE_STATE.AGENT_ONLY_UNATTRIBUTED];
  const attributable = cohort.total - unattributable;
  return {
    ...cohort,
    attributable,
    immediateAuthored,
    delayedSalvage,
    correlatedCapture: immediateAuthored + delayedSalvage,
    immediateCorrelationRate: ratio(immediateAuthored, attributable),
    overallCorrelationRate: ratio(immediateAuthored + delayedSalvage, attributable),
  };
}

function summarizeEvidence(loaded, {
  toolTestExcluded = 0,
  writeTestExcluded = 0,
} = {}) {
  const maintenanceToolCalls = {
    total: loaded.toolRows.length,
    testExcluded: toolTestExcluded,
    byAgent: emptyPartition(CAPTURE_AGENT),
  };
  for (const row of loaded.toolRows) {
    maintenanceToolCalls.byAgent[knownOr(row.agent, CAPTURE_AGENT)] += 1;
  }

  const writeDecisions = {
    total: loaded.writeRows.length,
    testExcluded: writeTestExcluded,
    byAgent: emptyPartition(CAPTURE_AGENT),
    bySource: emptyPartition(EVIDENCE_SOURCE),
  };
  for (const row of loaded.writeRows) {
    writeDecisions.byAgent[knownOr(row.agent, CAPTURE_AGENT)] += 1;
    writeDecisions.bySource[knownOr(row.source, EVIDENCE_SOURCE)] += 1;
  }
  return { maintenanceToolCalls, writeDecisions };
}

function emptyEvidence() {
  return summarizeEvidence({ toolRows: [], writeRows: [] });
}

function excludeTestEvidence(loaded) {
  const toolRows = loaded.toolRows.filter(row => !isTestSession(row.session));
  const writeRows = loaded.writeRows.filter(row => !isTestSession(row.session));
  return {
    filtered: { ...loaded, toolRows, writeRows },
    toolTestExcluded: loaded.toolRows.length - toolRows.length,
    writeTestExcluded: loaded.writeRows.length - writeRows.length,
  };
}

export function evaluateCheckpointReplay(path = REPLAY_PATH) {
  const corpus = JSON.parse(readFileSync(path, 'utf8'));
  const labels = new Set(Object.values(CHECKPOINT_REPLAY_LABEL));
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let unsafeCapture = 0;
  for (const testCase of corpus.cases) {
    if (!labels.has(testCase.label)) {
      throw new Error(`unknown checkpoint replay label "${testCase.label}"`);
    }
    const decision = decideCheckpoint(testCase.input, {
      agent: testCase.agent,
      enabled: true,
      seen: testCase.seen,
    });
    const predicted = decision?.emit === true;
    const expected = testCase.expected_emit === true;
    if (predicted && expected) tp += 1;
    else if (predicted) fp += 1;
    else if (expected) fn += 1;
    else tn += 1;
    if (testCase.sensitive === true && predicted) unsafeCapture += 1;
  }
  return {
    version: corpus.version,
    cases: corpus.cases.length,
    tp,
    fp,
    fn,
    tn,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    unsafe_capture: unsafeCapture,
  };
}

function reportReplay(path) {
  try {
    return evaluateCheckpointReplay(path);
  } catch {
    return { ...REPLAY_UNAVAILABLE };
  }
}

export function captureFollowThroughReport(db = getDb(), {
  logDir = CHECKPOINT_LOG_DIR,
  since = null,
  through = new Date().toISOString(),
  replayPath = REPLAY_PATH,
} = {}) {
  const window = measurementWindow({ since, through });
  const { rows, malformedLines } = readCheckpointCandidates(logDir);
  const inWindow = rows.filter(row =>
    (window.sinceMs === null || row.at >= window.sinceMs)
    && row.at <= window.throughMs);
  const mature = inWindow.filter(row => row.at <= window.eligibleEventThroughMs);
  const testExcluded = mature.filter(row => isTestSession(row.session));
  const eligible = mature.filter(row => !isTestSession(row.session));
  const immature = inWindow.length - mature.length;

  const partitions = {
    reason: emptyPartition(CAPTURE_REASON),
    state: emptyPartition(CAPTURE_STATE),
    agent: emptyPartition(CAPTURE_AGENT),
    declineReason: emptyPartition(REPORT_DECLINE_REASON),
  };
  const cohorts = {
    [CAPTURE_COHORT.REMINDER_EMITTED]: {
      total: 0,
      byState: emptyPartition(CAPTURE_STATE),
    },
    [CAPTURE_COHORT.LOG_ONLY]: {
      total: 0,
      byState: emptyPartition(CAPTURE_STATE),
    },
  };

  let duplicateAttempts = 0;
  let evidenceSummary = emptyEvidence();
  if (mature.length > 0) {
    const loaded = loadEvidence(db, mature, window.throughMs);
    const {
      filtered,
      toolTestExcluded,
      writeTestExcluded,
    } = excludeTestEvidence(loaded);
    evidenceSummary = summarizeEvidence(filtered, {
      toolTestExcluded,
      writeTestExcluded,
    });
    const evidence = {
      toolsByIdentity: groupByIdentity(filtered.toolRows),
      writesByIdentity: groupByIdentity(filtered.writeRows),
      documentsById: new Map(filtered.documentRows.map(row => [row.id, row])),
      harvestDocuments: filtered.documentRows.filter(row =>
        typeof row.source === 'string' && row.source.startsWith('harvest:')),
    };
    for (const candidate of eligible) {
      const outcome = classifyCandidate(candidate, evidence, window.throughMs);
      const cohortName = candidate.emitted
        ? CAPTURE_COHORT.REMINDER_EMITTED
        : CAPTURE_COHORT.LOG_ONLY;
      partitions.reason[candidate.reason] += 1;
      partitions.state[outcome.state] += 1;
      partitions.agent[candidate.agent] += 1;
      partitions.declineReason[candidate.declineReason] += 1;
      cohorts[cohortName].total += 1;
      cohorts[cohortName].byState[outcome.state] += 1;
      if (outcome.duplicateAttempt) duplicateAttempts += 1;
    }
  }
  for (const name of Object.values(CAPTURE_COHORT)) {
    cohorts[name] = finalizeCohort(cohorts[name]);
  }

  return {
    measurementWindow: publicWindow(window),
    attribution: {
      timeJoin: 'correlation, not causation: exact agent/session and bounded event time',
      cursor: 'agent-only candidate counts; Cursor session joins are not inferred',
    },
    malformedLines,
    candidates: {
      parsed: rows.length,
      inWindow: inWindow.length,
      outsideWindow: rows.length - inWindow.length,
      eligible: eligible.length,
      testExcluded: testExcluded.length,
      immature,
    },
    cohorts,
    partitions,
    evidence: evidenceSummary,
    signals: { duplicateAttempts },
    replay: reportReplay(replayPath),
  };
}

export function printCaptureFollowThroughReport(report) {
  console.log('KB Capture Follow-Through Report');
  console.log('================================');
  console.log(
    `measurement: ${report.measurementWindow.since ?? 'beginning'} through `
    + `${report.measurementWindow.through}; mature checkpoints through `
    + report.measurementWindow.eligibleEventThrough,
  );
  console.log(report.attribution.timeJoin);
  console.log(report.attribution.cursor);
  console.log(
    `candidates: ${report.candidates.eligible} eligible, `
    + `${report.candidates.testExcluded} test excluded, `
    + `${report.candidates.immature} immature, ${report.malformedLines} malformed lines`,
  );
  for (const [name, cohort] of Object.entries(report.cohorts)) {
    console.log(
      `${name}: ${cohort.total} total; ${cohort.attributable} attributable rate denominator`,
    );
    console.log(
      `  states: ${Object.entries(cohort.byState).map(([state, n]) => `${state}=${n}`).join(', ')}`,
    );
    console.log(
      `  immediate correlation rate: ${cohort.immediateCorrelationRate ?? 'n/a'}; `
      + `overall correlation rate: ${cohort.overallCorrelationRate ?? 'n/a'}`,
    );
  }
  console.log(
    `evidence maintenance tool calls: ${report.evidence.maintenanceToolCalls.total}; `
    + `${report.evidence.maintenanceToolCalls.testExcluded} test excluded; `
    + `by agent ${Object.entries(report.evidence.maintenanceToolCalls.byAgent)
      .map(([agent, n]) => `${agent}=${n}`).join(', ')}`,
  );
  console.log(
    `evidence write decisions: ${report.evidence.writeDecisions.total}; `
    + `${report.evidence.writeDecisions.testExcluded} test excluded; `
    + `by agent ${Object.entries(report.evidence.writeDecisions.byAgent)
      .map(([agent, n]) => `${agent}=${n}`).join(', ')}; `
    + `by source ${Object.entries(report.evidence.writeDecisions.bySource)
      .map(([source, n]) => `${source}=${n}`).join(', ')}`,
  );
  const replay = report.replay;
  if (replay.available === false) console.log('replay: unavailable');
  else {
    console.log(
      `replay v${replay.version}: TP=${replay.tp} FP=${replay.fp} FN=${replay.fn} `
      + `TN=${replay.tn} precision=${replay.precision ?? 'n/a'} `
      + `recall=${replay.recall ?? 'n/a'} unsafe_capture=${replay.unsafe_capture}`,
    );
  }
}

export function runCaptureFollowThroughCli(args = []) {
  if (!acceptFlags(args, {
    usage: USAGE,
    value: ['--since', '--through', '--log-dir'],
    boolean: ['--json'],
  })) return;
  const report = captureFollowThroughReport(getDb(), {
    since: readFlagValue(args, '--since') ?? null,
    through: readFlagValue(args, '--through') ?? new Date().toISOString(),
    logDir: readFlagValue(args, '--log-dir') ?? CHECKPOINT_LOG_DIR,
  });
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else printCaptureFollowThroughReport(report);
}
