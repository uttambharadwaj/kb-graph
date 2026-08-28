import './helpers/tmp-kb.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../src/db.js';
import { applyMigrations, hasColumn, pendingMigrations } from '../src/schema.js';

function preGroundingCountsFixture() {
  const db = new Database(':memory:');
  applyMigrations(db, MIGRATIONS.filter(migration => migration.version < 21));
  db.exec(`
    CREATE TABLE extractions_old AS SELECT id, input_hash, input_chars, chunk_count,
      chunk_chars, emitted_count, skipped_count, chunk_failures, dry_run, failed,
      from_preview, duration_ms, source, created_at FROM extractions;
    DROP TABLE extractions;
    ALTER TABLE extractions_old RENAME TO extractions;
  `);
  return db;
}

describe('migration 21 — grounding rejection counts on extractions', () => {
  it('adds all counters to an existing extraction meter', () => {
    const db = preGroundingCountsFixture();
    assert.ok(pendingMigrations(db, MIGRATIONS).some(migration => migration.version === 21));

    applyMigrations(db, MIGRATIONS);

    for (const column of ['entity_rejections', 'claim_rejections', 'date_overrides']) {
      assert.ok(hasColumn(db, 'extractions', column));
    }
    assert.deepStrictEqual(pendingMigrations(db, MIGRATIONS), []);
    db.close();
  });

  it('resumes safely when one column already exists', () => {
    const db = preGroundingCountsFixture();
    db.exec('ALTER TABLE extractions ADD COLUMN entity_rejections INTEGER NOT NULL DEFAULT 0');

    applyMigrations(db, MIGRATIONS);

    for (const column of ['entity_rejections', 'claim_rejections', 'date_overrides']) {
      assert.ok(hasColumn(db, 'extractions', column));
    }
    db.close();
  });

  it('is already applied on a fresh database', () => {
    const db = new Database(':memory:');
    applyMigrations(db, MIGRATIONS);
    assert.deepStrictEqual(pendingMigrations(db, MIGRATIONS), []);
    db.close();
  });
});

function preDispositionCountsFixture() {
  const db = new Database(':memory:');
  applyMigrations(db, MIGRATIONS.filter(migration => migration.version < 22));
  db.exec(`
    CREATE TABLE extractions_old AS SELECT id, input_hash, input_chars, chunk_count,
      chunk_chars, emitted_count, skipped_count, chunk_failures,
      entity_rejections, claim_rejections, date_overrides,
      dry_run, failed, from_preview, duration_ms, source, created_at FROM extractions;
    DROP TABLE extractions;
    ALTER TABLE extractions_old RENAME TO extractions;
  `);
  return db;
}

describe('migration 22 — extraction disposition reconciliation counts', () => {
  it('adds both counters to an existing extraction meter', () => {
    const db = preDispositionCountsFixture();
    assert.ok(pendingMigrations(db, MIGRATIONS).some(migration => migration.version === 22));

    applyMigrations(db, MIGRATIONS);

    for (const column of ['duplicate_skips', 'accepted_skip_conflicts']) {
      assert.ok(hasColumn(db, 'extractions', column));
    }
    assert.deepStrictEqual(pendingMigrations(db, MIGRATIONS), []);
    db.close();
  });

  it('resumes safely when one counter already exists', () => {
    const db = preDispositionCountsFixture();
    db.exec('ALTER TABLE extractions ADD COLUMN duplicate_skips INTEGER NOT NULL DEFAULT 0');

    applyMigrations(db, MIGRATIONS);

    for (const column of ['duplicate_skips', 'accepted_skip_conflicts']) {
      assert.ok(hasColumn(db, 'extractions', column));
    }
    db.close();
  });
});

function preTimingCountsFixture() {
  const db = new Database(':memory:');
  applyMigrations(db, MIGRATIONS.filter(migration => migration.version < 23));
  db.exec(`
    CREATE TABLE extractions_old AS SELECT id, input_hash, input_chars, chunk_count,
      chunk_chars, emitted_count, skipped_count, chunk_failures,
      entity_rejections, claim_rejections, date_overrides,
      duplicate_skips, accepted_skip_conflicts,
      dry_run, failed, from_preview, duration_ms, source, created_at FROM extractions;
    DROP TABLE extractions;
    ALTER TABLE extractions_old RENAME TO extractions;
  `);
  return db;
}

describe('migration 23 — extraction phase timing and attempt counts', () => {
  it('adds privacy-safe timing counters to an existing extraction meter', () => {
    const db = preTimingCountsFixture();
    assert.ok(pendingMigrations(db, MIGRATIONS).some(migration => migration.version === 23));

    applyMigrations(db, MIGRATIONS);

    for (const column of ['attempt_count', 'model_duration_ms', 'consolidation_duration_ms']) {
      assert.ok(hasColumn(db, 'extractions', column));
    }
    assert.deepStrictEqual(pendingMigrations(db, MIGRATIONS), []);
    db.close();
  });

  it('resumes safely when one timing counter already exists', () => {
    const db = preTimingCountsFixture();
    db.exec('ALTER TABLE extractions ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0');

    applyMigrations(db, MIGRATIONS);

    for (const column of ['attempt_count', 'model_duration_ms', 'consolidation_duration_ms']) {
      assert.ok(hasColumn(db, 'extractions', column));
    }
    db.close();
  });
});
