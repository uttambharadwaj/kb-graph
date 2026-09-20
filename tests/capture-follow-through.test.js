import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initSchema } from '../src/db.js';
import { AGENT } from '../src/process-ancestry.js';
import {
  CAPTURE_COHORT,
  CAPTURE_STATE,
  captureFollowThroughReport,
} from '../src/cli/capture-follow-through.js';
import {
  CHECKPOINT_DECLINE_REASON,
  CHECKPOINT_REASON,
} from '../src/cli/checkpoint-hook.js';
import { MAINTENANCE_TOOL } from '../src/tool-names.js';
import { WRITE_DECISION_SOURCE } from '../src/write-meter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const KB_BIN = join(HERE, '..', 'bin', 'kb.js');

function freshDb() {
  const db = new Database(':memory:');
  initSchema(db);
  return db;
}

function writeCandidates(dir, rows) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'candidates-2026-09-01.jsonl'),
    `${rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n')}\n`,
  );
}

function candidate({
  ts,
  agent = AGENT.CLAUDE,
  session,
  reason = CHECKPOINT_REASON.COMMIT_OR_MERGE,
  emitted = true,
  declineReason = null,
}) {
  return {
    ts,
    agent,
    session,
    reason,
    permission_mode: 'default',
    emitted,
    decline_reason: declineReason,
  };
}

function insertTool(db, {
  tool = MAINTENANCE_TOOL.WRITE,
  ok = 1,
  session,
  agent,
  at,
}) {
  db.prepare(`
    INSERT INTO tool_calls (tool, ok, duration_ms, session, agent, created_at)
    VALUES (?, ?, 1, ?, ?, ?)
  `).run(tool, ok, session, agent, at);
}

function insertWrite(db, {
  refused,
  docId = null,
  session,
  agent,
  source = WRITE_DECISION_SOURCE.MCP,
  at,
}) {
  db.prepare(`
    INSERT INTO write_decisions
      (threshold, refused, doc_id, session, agent, source, created_at)
    VALUES (0.9, ?, ?, ?, ?, ?, ?)
  `).run(refused, docId, session, agent, source, at);
}

function insertDoc(db, {
  source = null,
  createdAt,
  supersededAt = null,
}) {
  const id = db.prepare(`
    INSERT INTO documents
      (title, content, doc_type, source, created_at, superseded_at)
    VALUES ('synthetic', 'synthetic', 'note', ?, ?, ?)
  `).run(source, createdAt, supersededAt).lastInsertRowid;
  return Number(id);
}

function sum(values) {
  return Object.values(values).reduce((total, value) => total + value, 0);
}

describe('captureFollowThroughReport', () => {
  it('registers the CLI with timezone bounds and an injectable log directory', () => {
    const output = execFileSync(process.execPath, [
      KB_BIN,
      'capture-follow-through',
      '--help',
    ], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    assert.match(output, /--since <value>/);
    assert.match(output, /--through <value>/);
    assert.match(output, /--log-dir <value>/);

    assert.throws(
      () => captureFollowThroughReport(freshDb(), {
        logDir: join(process.env.KB_DIR, 'report-invalid-window'),
        since: '2026-09-01',
        through: '2026-09-02T00:00:00Z',
      }),
      /timezone/,
    );
  });

  it('separates emitted and log-only cohorts and reconciles closed partitions', () => {
    const db = freshDb();
    const logDir = join(process.env.KB_DIR, 'report-main');
    const superseded = insertDoc(db, {
      createdAt: '2026-09-01T10:09:00Z',
      supersededAt: '2026-09-01T11:30:00Z',
    });

    writeCandidates(logDir, [
      candidate({ ts: '2026-09-01T10:00:00Z', session: 'session-a' }),
      candidate({
        ts: '2026-09-01T10:05:00Z',
        agent: AGENT.CODEX,
        session: 'session-b',
        reason: CHECKPOINT_REASON.FULL_VERIFICATION,
        emitted: false,
        declineReason: CHECKPOINT_DECLINE_REASON.DISABLED,
      }),
      candidate({
        ts: '2026-09-01T10:10:00Z',
        agent: AGENT.CURSOR,
        session: 'conversation-c',
        reason: CHECKPOINT_REASON.RELEASE_OR_DEPLOY,
        emitted: false,
        declineReason: CHECKPOINT_DECLINE_REASON.UNSUPPORTED_AGENT,
      }),
      candidate({
        ts: '2026-09-01T10:20:00Z',
        session: 'session-d',
        emitted: false,
        declineReason: CHECKPOINT_DECLINE_REASON.DISABLED,
      }),
      candidate({ ts: '2026-09-01T11:45:00Z', session: 'session-immature' }),
      '{malformed',
    ]);

    insertTool(db, {
      session: 'session-a',
      agent: AGENT.CLAUDE,
      at: '2026-09-01T10:10:00Z',
    });
    insertWrite(db, {
      refused: 0,
      docId: superseded,
      session: 'session-a',
      agent: AGENT.CLAUDE,
      at: '2026-09-01T10:09:00Z',
    });
    insertWrite(db, {
      refused: 1,
      session: 'session-b',
      agent: AGENT.CODEX,
      at: '2026-09-01T10:15:00Z',
    });
    insertWrite(db, {
      refused: 0,
      session: 'session-b',
      agent: AGENT.CODEX,
      source: WRITE_DECISION_SOURCE.HARVEST,
      at: '2026-09-01T11:00:00Z',
    });
    // Cursor rows must never be session-joined, even if they appear to match.
    insertTool(db, {
      session: 'conversation-c',
      agent: AGENT.CURSOR,
      at: '2026-09-01T10:11:00Z',
    });
    insertTool(db, {
      tool: MAINTENANCE_TOOL.PROMOTE,
      session: 'meter-only',
      agent: null,
      at: '2026-09-01T10:12:00Z',
    });
    insertWrite(db, {
      refused: 0,
      session: 'meter-only',
      agent: null,
      source: WRITE_DECISION_SOURCE.REST,
      at: '2026-09-01T10:13:00Z',
    });
    insertWrite(db, {
      refused: 0,
      session: 'meter-only-source',
      agent: AGENT.CLAUDE,
      source: null,
      at: '2026-09-01T10:14:00Z',
    });

    const report = captureFollowThroughReport(db, {
      logDir,
      since: '2026-09-01T10:00:00Z',
      through: '2026-09-01T12:00:00Z',
    });

    assert.equal(report.malformedLines, 1);
    assert.equal(report.candidates.eligible, 4);
    assert.equal(report.candidates.immature, 1);
    assert.equal(
      report.candidates.inWindow,
      report.candidates.eligible + report.candidates.immature,
    );
    assert.equal(
      report.candidates.parsed,
      report.candidates.inWindow + report.candidates.outsideWindow,
    );
    assert.equal(report.cohorts[CAPTURE_COHORT.REMINDER_EMITTED].total, 1);
    assert.equal(report.cohorts[CAPTURE_COHORT.LOG_ONLY].total, 3);
    assert.equal(
      report.cohorts[CAPTURE_COHORT.REMINDER_EMITTED].overallCorrelationRate,
      1,
    );
    assert.equal(
      report.cohorts[CAPTURE_COHORT.LOG_ONLY].overallCorrelationRate,
      1 / 2,
    );
    assert.equal(report.cohorts[CAPTURE_COHORT.LOG_ONLY].attributable, 2);
    assert.deepEqual(report.partitions.state, {
      [CAPTURE_STATE.IMMEDIATE_CAPTURE]: 0,
      [CAPTURE_STATE.DUPLICATE_ATTEMPT]: 0,
      [CAPTURE_STATE.LATER_DUPLICATE_OUTCOME]: 1,
      [CAPTURE_STATE.DELAYED_SALVAGE]: 1,
      [CAPTURE_STATE.NO_CORRELATED_CAPTURE]: 1,
      [CAPTURE_STATE.UNATTRIBUTABLE]: 0,
      [CAPTURE_STATE.AGENT_ONLY_UNATTRIBUTED]: 1,
    });
    assert.deepEqual(report.evidence.maintenanceToolCalls, {
      total: 3,
      byAgent: { claude: 1, codex: 0, cursor: 1, unknown: 1 },
    });
    assert.deepEqual(report.evidence.writeDecisions, {
      total: 5,
      byAgent: { claude: 2, codex: 2, cursor: 0, unknown: 1 },
      bySource: { mcp: 2, rest: 1, harvest: 1, unknown: 1 },
    });
    assert.equal(
      sum(report.evidence.maintenanceToolCalls.byAgent),
      report.evidence.maintenanceToolCalls.total,
    );
    assert.equal(
      sum(report.evidence.writeDecisions.byAgent),
      report.evidence.writeDecisions.total,
    );
    assert.equal(
      sum(report.evidence.writeDecisions.bySource),
      report.evidence.writeDecisions.total,
    );
    assert.equal(report.signals.duplicateAttempts, 1);
    assert.equal(sum(report.partitions.reason), report.candidates.eligible);
    assert.equal(sum(report.partitions.state), report.candidates.eligible);
    assert.equal(sum(report.partitions.agent), report.candidates.eligible);
    assert.equal(
      Object.values(report.cohorts).reduce((total, cohort) => total + cohort.total, 0),
      report.candidates.eligible,
    );
    assert.match(report.attribution.timeJoin, /correlation/i);
    assert.match(report.attribution.cursor, /agent-only/i);
    assert.doesNotMatch(JSON.stringify(report), /session-a|conversation-c|kb_write/);
  });

  it('excludes missing and unsupported identities from cohort rate denominators', () => {
    const db = freshDb();
    const logDir = join(process.env.KB_DIR, 'report-unattributable');
    writeCandidates(logDir, [
      candidate({ ts: '2026-09-01T08:00:00Z', session: null }),
      candidate({
        ts: '2026-09-01T08:01:00Z',
        agent: AGENT.CODEX,
        session: null,
        emitted: false,
        declineReason: CHECKPOINT_DECLINE_REASON.MISSING_IDENTITY,
      }),
      candidate({
        ts: '2026-09-01T08:02:00Z',
        agent: 'unsupported',
        session: 'opaque',
        emitted: false,
        declineReason: CHECKPOINT_DECLINE_REASON.UNSUPPORTED_AGENT,
      }),
      candidate({
        ts: '2026-09-01T08:02:30Z',
        agent: null,
        session: 'missing-agent',
        emitted: false,
        declineReason: CHECKPOINT_DECLINE_REASON.UNSUPPORTED_AGENT,
      }),
      candidate({
        ts: '2026-09-01T08:03:00Z',
        agent: AGENT.CURSOR,
        session: 'cursor-opaque',
        emitted: false,
        declineReason: CHECKPOINT_DECLINE_REASON.UNSUPPORTED_AGENT,
      }),
    ]);

    const report = captureFollowThroughReport(db, {
      logDir,
      through: '2026-09-01T10:00:00Z',
    });

    assert.equal(report.partitions.state[CAPTURE_STATE.UNATTRIBUTABLE], 4);
    assert.equal(report.partitions.state[CAPTURE_STATE.AGENT_ONLY_UNATTRIBUTED], 1);
    assert.equal(report.cohorts[CAPTURE_COHORT.REMINDER_EMITTED].total, 1);
    assert.equal(report.cohorts[CAPTURE_COHORT.REMINDER_EMITTED].attributable, 0);
    assert.equal(
      report.cohorts[CAPTURE_COHORT.REMINDER_EMITTED].overallCorrelationRate,
      null,
    );
    assert.equal(report.cohorts[CAPTURE_COHORT.LOG_ONLY].total, 4);
    assert.equal(report.cohorts[CAPTURE_COHORT.LOG_ONLY].attributable, 0);
    assert.equal(report.cohorts[CAPTURE_COHORT.LOG_ONLY].immediateCorrelationRate, null);
  });

  it('uses exact agent/session/time joins and includes the exact 30-minute edge', () => {
    const db = freshDb();
    const logDir = join(process.env.KB_DIR, 'report-exact');
    writeCandidates(logDir, [
      candidate({ ts: '2026-09-01T10:00:00Z', session: 'edge' }),
      candidate({ ts: '2026-09-01T10:00:00Z', session: 'wrong-agent' }),
      candidate({ ts: '2026-09-01T10:00:00Z', session: 'too-late' }),
    ]);
    insertTool(db, {
      session: 'edge',
      agent: AGENT.CLAUDE,
      at: '2026-09-01T10:30:00Z',
    });
    insertTool(db, {
      session: 'wrong-agent',
      agent: AGENT.CODEX,
      at: '2026-09-01T10:05:00Z',
    });
    insertTool(db, {
      session: 'too-late',
      agent: AGENT.CLAUDE,
      at: '2026-09-01T10:30:00.001Z',
    });

    const report = captureFollowThroughReport(db, {
      logDir,
      through: '2026-09-01T11:00:00Z',
    });

    assert.equal(report.partitions.state[CAPTURE_STATE.IMMEDIATE_CAPTURE], 1);
    assert.equal(report.partitions.state[CAPTURE_STATE.NO_CORRELATED_CAPTURE], 2);
  });

  it('attributes delayed harvest provenance only by the exact transcript basename rule', () => {
    const db = freshDb();
    const logDir = join(process.env.KB_DIR, 'report-provenance');
    writeCandidates(logDir, [
      candidate({ ts: '2026-09-01T08:00:00Z', session: 'alpha' }),
      candidate({ ts: '2026-09-01T08:00:00Z', session: 'beta' }),
    ]);
    insertDoc(db, {
      source: 'harvest:synthetic-alpha',
      createdAt: '2026-09-01T09:00:00Z',
    });
    insertDoc(db, {
      source: 'harvest:synthetic-betax',
      createdAt: '2026-09-01T09:00:00Z',
    });

    const report = captureFollowThroughReport(db, {
      logDir,
      through: '2026-09-01T10:00:00Z',
    });

    assert.equal(report.partitions.state[CAPTURE_STATE.DELAYED_SALVAGE], 1);
    assert.equal(report.partitions.state[CAPTURE_STATE.NO_CORRELATED_CAPTURE], 1);
  });

  it('bounds later-duplicate and salvage outcomes at report through time', () => {
    const db = freshDb();
    const logDir = join(process.env.KB_DIR, 'report-through');
    const docId = insertDoc(db, {
      createdAt: '2026-09-01T08:05:00Z',
      supersededAt: '2026-09-01T12:00:01Z',
    });
    writeCandidates(logDir, [
      candidate({ ts: '2026-09-01T08:00:00Z', session: 'bounded' }),
    ]);
    insertTool(db, {
      session: 'bounded',
      agent: AGENT.CLAUDE,
      at: '2026-09-01T08:05:00Z',
    });
    insertWrite(db, {
      refused: 0,
      docId,
      session: 'bounded',
      agent: AGENT.CLAUDE,
      at: '2026-09-01T08:05:00Z',
    });
    insertWrite(db, {
      refused: 0,
      session: 'bounded',
      agent: AGENT.CLAUDE,
      source: WRITE_DECISION_SOURCE.HARVEST,
      at: '2026-09-01T12:00:01Z',
    });

    const report = captureFollowThroughReport(db, {
      logDir,
      through: '2026-09-01T12:00:00Z',
    });

    assert.equal(report.partitions.state[CAPTURE_STATE.IMMEDIATE_CAPTURE], 1);
    assert.equal(report.partitions.state[CAPTURE_STATE.LATER_DUPLICATE_OUTCOME], 0);
    assert.equal(report.partitions.state[CAPTURE_STATE.DELAYED_SALVAGE], 0);
  });

  it('loads bounded tool/write/document rows once instead of querying per candidate', () => {
    const db = freshDb();
    const logDir = join(process.env.KB_DIR, 'report-query-count');
    writeCandidates(logDir, [
      candidate({ ts: '2026-09-01T08:00:00Z', session: 'one' }),
      candidate({ ts: '2026-09-01T08:01:00Z', session: 'two' }),
      candidate({ ts: '2026-09-01T08:02:00Z', session: 'three' }),
    ]);
    let prepares = 0;
    const countedDb = {
      prepare(sql) {
        prepares += 1;
        return db.prepare(sql);
      },
    };

    captureFollowThroughReport(countedDb, {
      logDir,
      through: '2026-09-01T10:00:00Z',
    });

    assert.equal(prepares, 3);
  });
});
