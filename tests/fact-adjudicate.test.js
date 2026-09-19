import './helpers/tmp-kb.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { getDb, MIGRATIONS } from '../src/db.js';
import {
  FactReviewError,
  factReviewState,
  reviewFactGroup,
} from '../src/fact-reviews.js';
import { addFact, mergeEntity } from '../src/facts.js';
import { runFactAdjudicateCli } from '../src/cli/fact-adjudicate.js';
import { factConflicts } from '../src/cli/fact-conflicts.js';
import { applyMigrations, hasTable, pendingMigrations } from '../src/schema.js';

const db = getDb();
let sequence = 0;

function resetFacts() {
  db.exec('DELETE FROM facts; DELETE FROM entity_aliases; DELETE FROM entities;');
  sequence += 1;
}

const subject = label => `review_${sequence}_${label}`;

function addStatuses(name, values) {
  return values.map((value, index) => addFact(name, 'status', value, {
    source: `harvest:review-${sequence}-${index}`,
  }));
}

function review(name, facts, decisions, extra = {}) {
  return reviewFactGroup(db, {
    subject: name,
    predicate: 'status',
    reviewer: 'test-reviewer',
    items: decisions.map((decision, index) => ({ fact_id: facts[index].id, ...decision })),
    ...extra,
  });
}

describe('migration 24 — append-only fact reviews', () => {
  it('adds the two tables and all immutability/validation triggers to an existing database', () => {
    const fixture = new Database(':memory:');
    applyMigrations(fixture, MIGRATIONS.filter(migration => migration.version < 24));
    assert.deepStrictEqual(pendingMigrations(fixture, MIGRATIONS).map(migration => migration.version), [24, 25, 26]);

    applyMigrations(fixture, MIGRATIONS);

    assert.ok(hasTable(fixture, 'fact_reviews'));
    assert.ok(hasTable(fixture, 'fact_review_items'));
    const triggers = fixture.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'fact_review%' ORDER BY name"
    ).pluck().all();
    assert.deepStrictEqual(triggers, [
      'fact_review_items_capacity',
      'fact_review_items_no_delete',
      'fact_review_items_no_update',
      'fact_review_items_require_current_target',
      'fact_review_items_require_live_member',
      'fact_reviews_no_delete',
      'fact_reviews_no_update',
    ]);
    assert.deepStrictEqual(pendingMigrations(fixture, MIGRATIONS), []);
    fixture.close();
  });
});

describe('per-fact adjudication reviews', () => {
  beforeEach(resetFacts);

  it('projects one current fact while retaining synonymous raw assertions', () => {
    const name = subject('synonyms');
    const facts = addStatuses(name, ['deprecated removal T11', 'deprecated']);
    const created = review(name, facts, [
      { disposition: 'current' },
      { disposition: 'synonym', target_fact_id: facts[0].id },
    ]);

    const state = factReviewState(db, { subject: name, predicate: 'status' });
    assert.strictEqual(state.state, 'adjudicated');
    assert.strictEqual(state.projection, 'available');
    assert.deepStrictEqual(state.current.map(fact => fact.id), [facts[0].id]);
    assert.strictEqual(state.items.find(item => item.fact_id === facts[1].id).target_fact_id, facts[0].id);
    assert.strictEqual(created.items[0].evidence_ref.startsWith('harvest:'), true);
  });

  it('represents mixed groups and suppresses projection while any item abstains', () => {
    const name = subject('mixed');
    const facts = addStatuses(name, ['ga', 'pilot', 'general availability', 'misattributed', 'unknown']);
    review(name, facts, [
      { disposition: 'current' },
      { disposition: 'superseded', target_fact_id: facts[0].id },
      { disposition: 'synonym', target_fact_id: facts[0].id },
      { disposition: 'rejected', reason: 'Evidence discusses a different feature.' },
      { disposition: 'abstain', reason: 'Retained evidence does not support a judgment.' },
    ]);

    const state = factReviewState(db, { subject: name, predicate: 'status' });
    assert.strictEqual(state.state, 'adjudicated');
    assert.strictEqual(state.projection, 'abstained');
    assert.strictEqual(state.current, null);
    assert.deepStrictEqual(
      new Set(state.items.map(item => item.disposition)),
      new Set(['current', 'superseded', 'synonym', 'rejected', 'abstain']),
    );
  });

  it('rejects unknown, duplicate, and incomplete membership atomically', () => {
    const name = subject('coverage');
    const facts = addStatuses(name, ['one', 'two']);
    const before = db.prepare('SELECT COUNT(*) count FROM fact_reviews').get().count;

    assert.throws(
      () => reviewFactGroup(db, {
        subject: name,
        predicate: 'status',
        reviewer: 'tester',
        items: [
          { fact_id: facts[0].id, disposition: 'current' },
          { fact_id: 'invented-fact', disposition: 'current' },
          { fact_id: facts[0].id, disposition: 'current' },
        ],
      }),
      error => error instanceof FactReviewError
        && /missing:/.test(error.message)
        && /unknown:/.test(error.message)
        && /duplicate:/.test(error.message),
    );
    assert.strictEqual(db.prepare('SELECT COUNT(*) count FROM fact_reviews').get().count, before);
  });

  it('requires targeted dispositions to point at a current item in the same review', () => {
    const name = subject('targets');
    const facts = addStatuses(name, ['one', 'two']);
    assert.throws(
      () => review(name, facts, [
        { disposition: 'rejected', reason: 'bad extraction' },
        { disposition: 'synonym', target_fact_id: facts[0].id },
      ]),
      /must target a current fact/,
    );
    assert.throws(
      () => review(name, facts, [
        { disposition: 'current', target_fact_id: facts[1].id },
        { disposition: 'current' },
      ]),
      /must not set target_fact_id/,
    );
  });

  it('requires reasons for rejected/abstain and provenance for every asserted disposition', () => {
    const name = subject('provenance');
    const sourced = addFact(name, 'status', 'known', { source: 'harvest:known' });
    const unsourced = addFact(name, 'status', 'unknown');
    assert.throws(
      () => review(name, [sourced, unsourced], [
        { disposition: 'current' },
        { disposition: 'rejected' },
      ]),
      /rejected requires a reason/,
    );
    assert.throws(
      () => review(name, [sourced, unsourced], [
        { disposition: 'current' },
        { disposition: 'rejected', reason: 'unsupported' },
      ]),
      /has no provenance source; use abstain/,
    );
    assert.doesNotThrow(() => review(name, [sourced, unsourced], [
      { disposition: 'current' },
      { disposition: 'abstain', reason: 'No source was recorded.' },
    ]));
  });

  it('abstains when membership drifts and names added and removed fact ids', () => {
    const name = subject('stale');
    const facts = addStatuses(name, ['one', 'two']);
    review(name, facts, [
      { disposition: 'current' },
      { disposition: 'synonym', target_fact_id: facts[0].id },
    ]);
    const added = addFact(name, 'status', 'three', { source: 'harvest:added' });
    db.prepare('DELETE FROM facts WHERE id = ?').run(facts[1].id);

    const state = factReviewState(db, { subject: name, predicate: 'status' });
    assert.strictEqual(state.state, 'stale');
    assert.strictEqual(state.projection, 'abstained');
    assert.strictEqual(state.current, null);
    assert.deepStrictEqual(state.drift.added, [added.id]);
    assert.deepStrictEqual(state.drift.removed, [facts[1].id]);

    db.prepare('DELETE FROM facts WHERE subject = ?').run(name);
    const fullyRemoved = factReviewState(db, { subject: name, predicate: 'status' });
    assert.strictEqual(fullyRemoved.state, 'stale');
    assert.deepStrictEqual(new Set(fullyRemoved.drift.removed), new Set(facts.map(fact => fact.id)));
  });

  it('enforces append-only rows and rejects direct SQL that bypasses group validation', () => {
    const name = subject('immutable');
    const [fact] = addStatuses(name, ['one']);
    const created = review(name, [fact], [{ disposition: 'current' }]);

    assert.throws(
      () => db.prepare('UPDATE fact_reviews SET reviewer = ? WHERE id = ?').run('other', created.id),
      /append-only/,
    );
    assert.throws(
      () => db.prepare('DELETE FROM fact_reviews WHERE id = ?').run(created.id),
      /append-only/,
    );
    assert.throws(
      () => db.prepare('UPDATE fact_review_items SET disposition = ? WHERE review_id = ?').run('rejected', created.id),
      /append-only/,
    );
    assert.throws(
      () => db.prepare('DELETE FROM fact_review_items WHERE review_id = ?').run(created.id),
      /append-only/,
    );

    const header = db.prepare(`
      INSERT INTO fact_reviews (subject, predicate, reviewer, fact_count)
      VALUES (?, 'status', 'direct-sql', 1)
    `).run(name);
    assert.throws(
      () => db.prepare(`
        INSERT INTO fact_review_items (review_id, fact_id, disposition, evidence_ref)
        VALUES (?, 'invented', 'current', 'invented-source')
      `).run(header.lastInsertRowid),
      /live fact in the reviewed group/,
    );
  });

  it('keeps review history, uses the latest decision, and refuses an identical repeat', () => {
    const name = subject('history');
    const facts = addStatuses(name, ['one', 'two']);
    review(name, facts, [
      { disposition: 'current' },
      { disposition: 'synonym', target_fact_id: facts[0].id },
    ]);
    const second = review(name, facts, [
      { disposition: 'synonym', target_fact_id: facts[1].id },
      { disposition: 'current' },
    ]);

    assert.deepStrictEqual(
      factReviewState(db, { subject: name, predicate: 'status' }).current.map(fact => fact.id),
      [facts[1].id],
    );
    assert.strictEqual(
      db.prepare('SELECT COUNT(*) count FROM fact_reviews WHERE subject = ?').get(name).count,
      2,
    );
    assert.throws(
      () => review(name, facts, [
        { disposition: 'synonym', target_fact_id: facts[1].id },
        { disposition: 'current' },
      ]),
      new RegExp(`no decision change since review #${second.id}`),
    );
  });

  it('follows entity aliases and becomes stale only when a merge changes membership', () => {
    const oldName = subject('old_name');
    const newName = subject('new_name');
    const facts = addStatuses(oldName, ['one', 'two']);
    review(oldName, facts, [
      { disposition: 'current' },
      { disposition: 'synonym', target_fact_id: facts[0].id },
    ]);

    mergeEntity(oldName, newName);
    assert.strictEqual(
      factReviewState(db, { subject: newName, predicate: 'status' }).state,
      'adjudicated',
    );
    addFact(newName, 'status', 'three', { source: 'harvest:merge-added' });
    assert.strictEqual(
      factReviewState(db, { subject: newName, predicate: 'status' }).state,
      'stale',
    );
  });

  it('never projects an unreviewed group and annotates conflict output after review', () => {
    const name = subject('report');
    const facts = addStatuses(name, ['one', 'two']);
    assert.strictEqual(factReviewState(db, { subject: name, predicate: 'status' }).current, null);

    review(name, facts, [
      { disposition: 'current' },
      { disposition: 'synonym', target_fact_id: facts[0].id },
    ]);
    const report = factConflicts(db, { subject: name });
    assert.deepStrictEqual(report.adjudication, {
      adjudicated: 1,
      stale: 0,
      unadjudicated: 0,
      projection_available: 1,
      projection_abstained: 0,
    });
    assert.deepStrictEqual(
      report.groups[0].assertions.map(assertion => assertion.adjudication.disposition).sort(),
      ['current', 'synonym'],
    );
  });

  it('records an atomic review through the JSON-file CLI contract', () => {
    const name = subject('cli');
    const facts = addStatuses(name, ['one', 'two']);
    const dir = mkdtempSync(join(tmpdir(), 'kb-fact-review-cli-'));
    const path = join(dir, 'items.json');
    writeFileSync(path, JSON.stringify([
      { fact_id: facts[0].id, disposition: 'current' },
      { fact_id: facts[1].id, disposition: 'synonym', target_fact_id: facts[0].id },
    ]));
    const lines = [];
    const originalLog = console.log;
    console.log = value => lines.push(value);
    try {
      runFactAdjudicateCli([
        '--subject', name,
        '--predicate', 'status',
        '--reviewer', 'cli-reviewer',
        '--items', path,
        '--json',
      ]);
    } finally {
      console.log = originalLog;
      rmSync(dir, { recursive: true, force: true });
    }

    const output = JSON.parse(lines.join('\n'));
    assert.strictEqual(output.subject, name);
    assert.strictEqual(output.fact_count, 2);
    assert.strictEqual(db.prepare('SELECT COUNT(*) count FROM facts WHERE subject = ?').get(name).count, 2);
  });
});
