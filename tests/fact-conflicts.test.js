import './helpers/tmp-kb.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getDb } from '../src/db.js';
import { addFact, invalidateFact, mergeEntity } from '../src/facts.js';
import { factConflicts, formatFactConflicts, runFactConflictsCli } from '../src/cli/fact-conflicts.js';
import { UsageError } from '../src/cli/flags.js';

const db = getDb();
const tempDirs = [];

function resetFacts() {
  db.exec('DELETE FROM facts; DELETE FROM entity_aliases; DELETE FROM entities; DELETE FROM harvest_log;');
}

function setRecordedAt(id, recordedAt) {
  db.prepare('UPDATE facts SET created_at = ? WHERE id = ?').run(recordedAt, id);
}

function addTranscript(sessionId, text) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-fact-evidence-'));
  tempDirs.push(dir);
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, `${JSON.stringify({
    type: 'user',
    isSidechain: false,
    message: { content: text },
  })}\n`);
  db.prepare('INSERT INTO harvest_log (transcript_path, mtime) VALUES (?, ?)').run(path, Date.now());
  return path;
}

describe('fact conflict instrumentation', () => {
  beforeEach(resetFacts);
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reports every current assertion and its provenance for a contested subject', () => {
    const first = addFact('Mako', 'status', 'GA', {
      validFrom: '2026-07-01', source: 'linear:issue-100',
    });
    const second = addFact('Mako', 'status', 'general availability', {
      validFrom: '2026-07-21', source: 'harvest:session-2',
    });
    setRecordedAt(first.id, '2026-07-01 10:00:00');
    setRecordedAt(second.id, '2026-07-21 11:00:00');

    addFact('Quiet repo', 'status', 'active', { source: 'note:1' });
    const retired = addFact('Mako', 'status', 'approaching GA', {
      validFrom: '2026-06-01', source: 'slack:thread-3',
    });
    invalidateFact('Mako', 'status', 'approaching GA', { ended: '2026-06-30' });

    const before = db.prepare('SELECT COUNT(*) AS count FROM facts').get().count;
    const report = factConflicts(db);
    const after = db.prepare('SELECT COUNT(*) AS count FROM facts').get().count;

    assert.strictEqual(after, before, 'the report must not mutate the evidence ledger');
    assert.strictEqual(report.predicate, 'status');
    assert.strictEqual(report.contested_subjects, 1);
    assert.strictEqual(report.contested_assertions, 2);
    assert.deepStrictEqual(report.provenance, {
      source_present: 2,
      source_missing: 0,
      resolution: 'evaluated',
      mapped: 0,
      evidence_available: 0,
      evidence_missing: 0,
      unreadable: 0,
      unmapped: 1,
      unsupported: 1,
      distinct_sources: {
        total: 2,
        mapped: 0,
        evidence_available: 0,
        evidence_missing: 0,
        unreadable: 0,
        unmapped: 1,
        unsupported: 1,
      },
    });
    assert.strictEqual(report.groups.length, 1);
    assert.strictEqual(report.groups[0].subject_name, 'Mako');
    assert.strictEqual(report.groups[0].distinct_objects, 2);
    assert.deepStrictEqual(
      report.groups[0].assertions.map(row => ({
        object: row.object_name,
        source: row.source,
        valid_from: row.valid_from,
        recorded_at: row.recorded_at,
      })),
      [
        {
          object: 'GA',
          source: 'linear:issue-100',
          valid_from: '2026-07-01',
          recorded_at: '2026-07-01 10:00:00',
        },
        {
          object: 'general availability',
          source: 'harvest:session-2',
          valid_from: '2026-07-21',
          recorded_at: '2026-07-21 11:00:00',
        },
      ],
    );
    assert.ok(!report.groups[0].assertions.some(row => row.id === retired.id));
  });

  it('keeps missing provenance visible instead of silently treating it as evidence', () => {
    addFact('Browser profiles', 'status', 'working', { source: 'notion:abc' });
    addFact('Browser profiles', 'status', 'GA');

    const report = factConflicts(db);
    assert.deepStrictEqual(report.provenance, {
      source_present: 1,
      source_missing: 1,
      resolution: 'evaluated',
      mapped: 0,
      evidence_available: 0,
      evidence_missing: 0,
      unreadable: 0,
      unmapped: 0,
      unsupported: 1,
      distinct_sources: {
        total: 1,
        mapped: 0,
        evidence_available: 0,
        evidence_missing: 0,
        unreadable: 0,
        unmapped: 0,
        unsupported: 1,
      },
    });
    assert.strictEqual(report.groups[0].assertions.find(row => row.source === null).source, null);
  });

  it('canonicalizes the selected predicate but does not decide that its objects contradict', () => {
    addFact('Knowledge Base', 'status', 'deployed');
    addFact('Knowledge Base', 'status', 'daemon-backed');

    const report = factConflicts(db, { predicate: 'is status' });
    assert.strictEqual(report.predicate, 'status');
    assert.strictEqual(report.contested_subjects, 1);
    assert.match(formatFactConflicts(report), /do not prove contradiction/);
    assert.match(formatFactConflicts(report), /Evidence assertions:/);
  });

  it('resolves every provenance state and reads only an explicitly selected subject', () => {
    const retainedPath = addTranscript(
      'session-retained',
      'Mako reached general availability. api_key=supersecretvalue123 should never be printed.',
    );
    const missingPath = join(tmpdir(), 'kb-fact-evidence-missing', 'session-missing.jsonl');
    db.prepare('INSERT INTO harvest_log (transcript_path, mtime) VALUES (?, ?)').run(missingPath, Date.now());

    addFact('Mako', 'status', 'general availability', { source: 'harvest:session-retained' });
    addFact('Mako', 'status', 'pilot', { source: 'harvest:session-missing' });
    addFact('Mako', 'status', 'blocked', { source: 'harvest:session-unmapped' });
    addFact('Mako', 'status', 'monitored', { source: 'linear:issue-100' });
    addFact('Mako', 'status', 'undocumented');
    addFact('Other repo', 'status', 'alpha', { source: 'harvest:session-retained' });
    addFact('Other repo', 'status', 'beta', { source: 'harvest:session-retained' });

    const before = db.prepare('SELECT COUNT(*) AS count FROM facts').get().count;
    const report = factConflicts(db, { subject: 'Mako', includeEvidence: true });
    const after = db.prepare('SELECT COUNT(*) AS count FROM facts').get().count;

    assert.strictEqual(after, before, 'evidence drilldown must remain read-only');
    assert.strictEqual(report.subject, 'mako');
    assert.strictEqual(report.contested_subjects, 1);
    assert.strictEqual(report.contested_assertions, 5);
    assert.deepStrictEqual(report.provenance, {
      source_present: 4,
      source_missing: 1,
      resolution: 'evaluated',
      mapped: 2,
      evidence_available: 1,
      evidence_missing: 1,
      unreadable: 0,
      unmapped: 1,
      unsupported: 1,
      distinct_sources: {
        total: 4,
        mapped: 2,
        evidence_available: 1,
        evidence_missing: 1,
        unreadable: 0,
        unmapped: 1,
        unsupported: 1,
      },
    });

    const byStatus = new Map(report.groups[0].assertions.map(row => [row.evidence.status, row]));
    assert.strictEqual(byStatus.get('available').evidence.transcript_path, retainedPath);
    assert.match(byStatus.get('available').evidence.excerpt, /general availability/);
    assert.match(byStatus.get('available').evidence.excerpt, /\[REDACTED\]/);
    assert.doesNotMatch(byStatus.get('available').evidence.excerpt, /supersecretvalue123/);
    assert.ok(byStatus.get('available').evidence.excerpt.length <= 802);
    assert.strictEqual(byStatus.get('missing').evidence.transcript_path, missingPath);
    assert.strictEqual(byStatus.get('unmapped').evidence.mapped, false);
    assert.strictEqual(byStatus.get('unsupported').source, 'linear:issue-100');
    assert.strictEqual(byStatus.get('absent').source, null);
  });

  it('does not expose transcript content by default and requires a subject for evidence reads', () => {
    addTranscript('session-bounded', 'Bounded repo status is alpha.');
    addFact('Bounded repo', 'status', 'alpha', { source: 'harvest:session-bounded' });
    addFact('Bounded repo', 'status', 'beta', { source: 'harvest:session-bounded' });

    const report = factConflicts(db);
    assert.strictEqual(report.groups[0].assertions[0].evidence.status, 'available');
    assert.ok(!Object.hasOwn(report.groups[0].assertions[0].evidence, 'excerpt'));
    assert.throws(
      () => runFactConflictsCli(['--evidence']),
      error => error instanceof UsageError && /requires --subject/.test(error.message),
    );
  });

  it('resolves a subject filter through recorded entity aliases', () => {
    addFact('Canonical service', 'status', 'alpha', { source: 'linear:one' });
    addFact('Canonical service', 'status', 'beta', { source: 'linear:two' });
    mergeEntity('Former service', 'Canonical service');

    const report = factConflicts(db, { subject: 'Former service' });

    assert.strictEqual(report.subject, 'canonical_service');
    assert.strictEqual(report.contested_subjects, 1);
    assert.strictEqual(report.groups[0].subject, 'canonical_service');
  });

  it('orders the largest evidence bundles first and applies only a display limit', () => {
    for (const value of ['alpha', 'beta']) addFact('two-state', 'status', value, { source: value });
    for (const value of ['one', 'two', 'three']) addFact('three-state', 'status', value, { source: value });

    const report = factConflicts(db);
    assert.deepStrictEqual(report.groups.map(group => group.subject), ['three_state', 'two_state']);

    const rendered = formatFactConflicts(report, { limit: 1 });
    assert.match(rendered, /Showing 1\/2 subjects/);
    assert.match(rendered, /three-state/);
    assert.doesNotMatch(rendered, /two-state/);
    assert.strictEqual(report.groups.length, 2, 'formatting must not truncate the underlying report');
  });
});
