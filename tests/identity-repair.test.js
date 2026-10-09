import './helpers/tmp-kb.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  configureKnowledgeBaseConnection,
  IDENTITY_REPAIR_STATUS,
  MIGRATIONS,
} from '../src/db.js';
import {
  applyIdentityRepair,
  IdentityRepairInterruptedError,
  IdentityRepairRefusedError,
  planIdentityRepair,
  undoIdentityRepair,
} from '../src/identity-repair.js';
import { applyMigrations } from '../src/schema.js';
import { parseIdentityRepairArgs } from '../src/cli/repair-cli.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

function vaultHash(content) {
  return sha256(`---\ntitle: fixture\n---\n${content}`);
}

function createDatabase(path, migrations = MIGRATIONS) {
  const db = new Database(path);
  configureKnowledgeBaseConnection(db);
  db.pragma('foreign_keys = ON');
  applyMigrations(db, migrations);
  return db;
}

function insertDocument(
  db,
  {
    id,
    path,
    content,
    contentHash = vaultHash(content),
    supersededBy = null,
    supersededAt = null,
    reason = null,
  },
) {
  db.prepare(`
    INSERT INTO documents (
      id, title, content, source, doc_type, tags,
      superseded_at, superseded_by, superseded_reason
    ) VALUES (?, ?, ?, ?, 'lesson', '', ?, ?, ?)
  `).run(id, `Document ${id}`, content, `vault:${path}`, supersededAt, supersededBy, reason);
  db.prepare(`
    INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type)
    VALUES (?, ?, ?, ?, 'lesson')
  `).run(path, contentHash, id, `Document ${id}`);
}

function insertRetrieval(db, id, docId) {
  db.prepare(`
    INSERT INTO retrievals (id, doc_id, surface, query, created_at)
    VALUES (?, ?, 'search', 'fixture', '2026-01-01 00:00:00')
  `).run(id, docId);
}

function insertDecision(db, { id, docId, nearestId }) {
  db.prepare(`
    INSERT INTO write_decisions (
      id, nearest_id, nearest_score, threshold, refused, doc_id, created_at
    ) VALUES (?, ?, 0.7, 0.85, 0, ?, '2026-01-01 00:00:00')
  `).run(id, nearestId, docId);
}

function buildRepairFixture() {
  const root = mkdtempSync(join(tmpdir(), 'kb-identity-repair-'));
  const backupPath = join(root, 'backup.db');
  const livePath = join(root, 'live.db');
  const reportDir = join(root, 'report');
  const reportPath = join(reportDir, 'identity-report.json');
  mkdirSync(reportDir, { mode: 0o700 });

  const backup = createDatabase(
    backupPath,
    MIGRATIONS.filter(migration => migration.version < 30),
  );
  insertDocument(backup, { id: 10, path: 'alpha.md', content: 'alpha content' });
  insertDocument(backup, {
    id: 11,
    path: 'beta.md',
    content: 'beta content',
    supersededBy: 10,
    supersededAt: '2026-01-02 03:04:05',
    reason: 'alpha replaced beta',
  });
  insertDocument(backup, {
    id: 12,
    path: 'gamma.md',
    content: 'gamma content',
    supersededBy: 10,
    supersededAt: '2026-01-03 03:04:05',
    reason: 'alpha replaced gamma',
  });
  insertDocument(backup, { id: 13, path: 'missing.md', content: 'missing content' });
  insertDocument(backup, { id: 14, path: 'tombstoned.md', content: 'tombstoned content' });
  insertDocument(backup, {
    id: 15,
    path: 'hash-mismatch-old.md',
    content: 'same parsed body',
    contentHash: sha256('backup raw markdown'),
  });
  insertRetrieval(backup, 100, 10);
  insertRetrieval(backup, 101, 13);
  insertDecision(backup, { id: 200, docId: 11, nearestId: 10 });
  insertDecision(backup, { id: 201, docId: 12, nearestId: 10 });
  backup.prepare(`
    INSERT INTO retrieval_outcomes (
      id, retrieval_id, doc_id, doc_version, outcome,
      evidence_kind, evidence_ref, source
    ) VALUES (300, 100, 10, 'v1', 'helped', 'fixture', 'evt-300', 'test')
  `).run();
  backup.close();
  chmodSync(backupPath, 0o400);

  const live = createDatabase(livePath);
  live.prepare(`
    INSERT INTO documents (id, title, content, doc_type, tags)
    VALUES (10, 'Reused numeric ID', 'unrelated live document', 'lesson', '')
  `).run();
  insertDocument(live, { id: 110, path: 'alpha.md', content: 'alpha content' });
  insertDocument(live, { id: 111, path: 'beta-renamed.md', content: 'beta content' });
  insertDocument(live, {
    id: 112,
    path: 'gamma.md',
    content: 'gamma content',
    supersededBy: 10,
  });
  insertDocument(live, { id: 113, path: 'unrelated.md', content: 'unrelated content' });
  insertDocument(live, {
    id: 114,
    path: 'hash-mismatch-new.md',
    content: 'same parsed body',
    contentHash: sha256('current raw markdown'),
  });
  insertRetrieval(live, 100, null);
  insertRetrieval(live, 101, null);
  insertDecision(live, { id: 200, docId: null, nearestId: null });
  insertDecision(live, { id: 201, docId: 113, nearestId: null });
  live.prepare(`
    INSERT INTO document_tombstones (
      document_id, vault_path, content_hash, detached_at, reason
    ) VALUES (14, 'tombstoned.md', ?, NULL, 'detached_grace_expired')
  `).run(vaultHash('tombstoned content'));
  live.close();

  function cleanup() {
    rmSync(root, { recursive: true, force: true });
  }

  return {
    backupPath,
    livePath,
    reportPath,
    root,
    cleanup,
  };
}

test('identity repair dry-run is deterministic, privacy-safe, and writes no database rows', async () => {
  const fixture = buildRepairFixture();
  try {
    const beforeLive = fileSha256(fixture.livePath);
    const beforeBackup = fileSha256(fixture.backupPath);
    const report = await planIdentityRepair(fixture);
    assert.equal(fileSha256(fixture.livePath), beforeLive);
    assert.equal(fileSha256(fixture.backupPath), beforeBackup);
    assert.equal(report.can_apply, true);
    assert.equal(report.backup_schema_version, 29);
    assert.equal(report.live_schema_version, 32);
    assert.equal(report.counts.actions, 6);
    assert.deepStrictEqual(report.counts.actions_by_target, {
      'documents.supersession': 2,
      'retrievals.doc_id': 1,
      'write_decisions.doc_id': 1,
      'write_decisions.nearest_id': 2,
    });
    assert.equal(report.counts.vault_path, 2);
    assert.equal(report.counts.content_hash, 1);
    assert.equal(report.counts.missing_current_identity, 2);
    assert.equal(report.counts.irrecoverable_tombstone, 1);
    assert.equal(report.counts.irrecoverable_outcomes, 1);
    assert.equal(report.counts.unresolved_foreign_keys, 1);
    assert.equal(report.counts.preserved_non_null, 1);
    assert.ok(
      report.actions.every(action => !action.evidence.some(
        evidence => evidence.current_document_id === 114,
      )),
      'equal parsed bodies with different full vault hashes must not establish identity',
    );
    const saved = readFileSync(fixture.reportPath, 'utf8');
    assert.doesNotMatch(saved, /alpha\.md|beta content|gamma\.md|tombstoned\.md/);
    assert.equal(statSync(fixture.reportPath).mode & 0o777, 0o600);

    const secondPath = join(fixture.root, 'report', 'identity-report-second.json');
    const second = await planIdentityRepair({ ...fixture, reportPath: secondPath });
    assert.equal(second.plan_hash, report.plan_hash);
    assert.equal(second.run_id, report.run_id);
    assert.deepStrictEqual(second.counts, report.counts);
  } finally {
    fixture.cleanup();
  }
});

test('apply resumes in bounded transactions, is idempotent, preserves non-null values, and repairs dangling supersession', async () => {
  const fixture = buildRepairFixture();
  try {
    const report = await planIdentityRepair(fixture);
    await assert.rejects(
      applyIdentityRepair({
        ...fixture,
        confirm: report.plan_hash,
        batchSize: 1,
        stopAfterBatches: 1,
      }),
      IdentityRepairInterruptedError,
    );

    const resumed = await applyIdentityRepair({
      ...fixture,
      confirm: report.plan_hash,
      batchSize: 1,
    });
    assert.equal(resumed.applied, 5);
    const repeated = await applyIdentityRepair({
      ...fixture,
      confirm: report.plan_hash,
      batchSize: 1,
    });
    assert.equal(repeated.already_applied, true);

    const live = new Database(fixture.livePath, { readonly: true });
    assert.equal(live.prepare('SELECT doc_id FROM retrievals WHERE id = 100').get().doc_id, 110);
    assert.equal(live.prepare('SELECT doc_id FROM retrievals WHERE id = 101').get().doc_id, null);
    assert.deepStrictEqual(
      live.prepare('SELECT doc_id, nearest_id FROM write_decisions WHERE id = 200').get(),
      { doc_id: 111, nearest_id: 110 },
    );
    assert.deepStrictEqual(
      live.prepare('SELECT doc_id, nearest_id FROM write_decisions WHERE id = 201').get(),
      { doc_id: 113, nearest_id: 110 },
      'a non-null attribution is never overwritten',
    );
    assert.deepStrictEqual(
      live.prepare(`
        SELECT superseded_by, superseded_at, superseded_reason
        FROM documents WHERE id = 111
      `).get(),
      {
        superseded_by: 110,
        superseded_at: '2026-01-02 03:04:05',
        superseded_reason: 'alpha replaced beta',
      },
    );
    assert.equal(
      live.prepare('SELECT superseded_by FROM documents WHERE id = 112').get().superseded_by,
      110,
      'a path-proven stale old target is remapped even when its numeric ID was reused',
    );
    assert.equal(
      live.prepare('SELECT status FROM identity_repair_runs').get().status,
      IDENTITY_REPAIR_STATUS.APPLIED,
    );
    assert.equal(
      live.prepare('SELECT COUNT(*) AS count FROM identity_repair_ledger').get().count,
      6,
    );
    live.close();
  } finally {
    fixture.cleanup();
  }
});

test('undo resumes, restores null and dangling values, and is idempotent', async () => {
  const fixture = buildRepairFixture();
  try {
    const report = await planIdentityRepair(fixture);
    await applyIdentityRepair({ ...fixture, confirm: report.plan_hash, batchSize: 2 });
    await assert.rejects(
      undoIdentityRepair({
        ...fixture,
        confirm: report.run_id,
        batchSize: 1,
        stopAfterBatches: 1,
      }),
      IdentityRepairInterruptedError,
    );
    const resumed = await undoIdentityRepair({
      ...fixture,
      confirm: report.run_id,
      batchSize: 1,
    });
    assert.equal(resumed.undone, 5);
    const repeated = await undoIdentityRepair({
      ...fixture,
      confirm: report.run_id,
      batchSize: 1,
    });
    assert.equal(repeated.already_undone, true);

    const live = new Database(fixture.livePath, { readonly: true });
    assert.equal(live.prepare('SELECT doc_id FROM retrievals WHERE id = 100').get().doc_id, null);
    assert.deepStrictEqual(
      live.prepare('SELECT doc_id, nearest_id FROM write_decisions WHERE id = 200').get(),
      { doc_id: null, nearest_id: null },
    );
    assert.deepStrictEqual(
      live.prepare('SELECT doc_id, nearest_id FROM write_decisions WHERE id = 201').get(),
      { doc_id: 113, nearest_id: null },
    );
    assert.equal(live.prepare('SELECT superseded_by FROM documents WHERE id = 111').get().superseded_by, null);
    assert.equal(live.prepare('SELECT superseded_by FROM documents WHERE id = 112').get().superseded_by, 10);
    assert.equal(
      live.prepare('SELECT status FROM identity_repair_runs').get().status,
      IDENTITY_REPAIR_STATUS.UNDONE,
    );
    live.close();
  } finally {
    fixture.cleanup();
  }
});

test('an applying run can be undone when a later batch can no longer resume', async () => {
  const fixture = buildRepairFixture();
  try {
    const report = await planIdentityRepair(fixture);
    await assert.rejects(
      applyIdentityRepair({
        ...fixture,
        confirm: report.plan_hash,
        batchSize: 1,
        stopAfterBatches: 1,
      }),
      IdentityRepairInterruptedError,
    );
    const live = new Database(fixture.livePath);
    live.prepare('UPDATE write_decisions SET nearest_id = 113 WHERE id = 200').run();
    live.close();
    await assert.rejects(
      applyIdentityRepair({ ...fixture, confirm: report.plan_hash, batchSize: 1 }),
      /changed before apply/,
    );
    const partial = new Database(fixture.livePath, { readonly: true });
    const appliedBeforeUndo = partial.prepare(
      'SELECT COUNT(*) AS count FROM identity_repair_ledger'
    ).get().count;
    partial.close();
    const undone = await undoIdentityRepair({
      ...fixture,
      confirm: report.run_id,
      batchSize: 1,
    });
    assert.equal(undone.undone, appliedBeforeUndo);

    const check = new Database(fixture.livePath, { readonly: true });
    assert.equal(check.prepare('SELECT doc_id FROM retrievals WHERE id = 100').get().doc_id, null);
    assert.equal(
      check.prepare('SELECT status FROM identity_repair_runs').get().status,
      IDENTITY_REPAIR_STATUS.UNDONE,
    );
    check.close();
  } finally {
    fixture.cleanup();
  }
});

test('identity collisions refuse apply without writing a run', async () => {
  const fixture = buildRepairFixture();
  try {
    const live = new Database(fixture.livePath);
    configureKnowledgeBaseConnection(live);
    live.prepare('UPDATE vault_files SET content_hash = ? WHERE document_id = 110')
      .run(vaultHash('beta content'));
    live.prepare('UPDATE vault_files SET content_hash = ? WHERE document_id = 111')
      .run(vaultHash('different content'));
    live.close();
    const report = await planIdentityRepair(fixture);
    assert.equal(report.can_apply, false);
    assert.ok(report.counts.collisions > 0);
    await assert.rejects(
      applyIdentityRepair({ ...fixture, confirm: report.plan_hash }),
      IdentityRepairRefusedError,
    );
    const check = new Database(fixture.livePath, { readonly: true });
    assert.equal(check.prepare('SELECT COUNT(*) AS count FROM identity_repair_runs').get().count, 0);
    check.close();
  } finally {
    fixture.cleanup();
  }
});

test('coincident telemetry row IDs require matching immutable lineage', async () => {
  const fixture = buildRepairFixture();
  try {
    const live = new Database(fixture.livePath);
    live.prepare("UPDATE retrievals SET query = 'different lineage' WHERE id = 100").run();
    live.close();
    const report = await planIdentityRepair(fixture);
    assert.equal(report.can_apply, false);
    assert.equal(report.collision_buckets.attribution_lineage_mismatch, 1);
    assert.equal(
      report.actions.some(
        action => action.target === 'retrievals.doc_id' && action.row_id === 100,
      ),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test('apply revalidates changed live rows instead of overwriting them', async () => {
  const fixture = buildRepairFixture();
  try {
    const report = await planIdentityRepair(fixture);
    const live = new Database(fixture.livePath);
    live.prepare('UPDATE retrievals SET doc_id = 113 WHERE id = 100').run();
    live.close();
    await assert.rejects(
      applyIdentityRepair({ ...fixture, confirm: report.plan_hash }),
      /live database changed since the dry run/,
    );
    const check = new Database(fixture.livePath, { readonly: true });
    assert.equal(check.prepare('SELECT doc_id FROM retrievals WHERE id = 100').get().doc_id, 113);
    assert.equal(check.prepare('SELECT COUNT(*) AS count FROM identity_repair_runs').get().count, 0);
    check.close();
  } finally {
    fixture.cleanup();
  }
});

test('each apply batch revalidates identity evidence inside its write transaction', async () => {
  const fixture = buildRepairFixture();
  try {
    const report = await planIdentityRepair(fixture);
    await assert.rejects(
      applyIdentityRepair({
        ...fixture,
        confirm: report.plan_hash,
        batchSize: 1,
        beforeBatch: ({ batchIndex }) => {
          if (batchIndex !== 0) return;
          const concurrent = new Database(fixture.livePath);
          configureKnowledgeBaseConnection(concurrent);
          concurrent.prepare('UPDATE vault_files SET content_hash = ? WHERE document_id = 111')
            .run(sha256('concurrent raw markdown'));
          concurrent.close();
        },
      }),
      /content-hash identity evidence changed/,
    );
    const check = new Database(fixture.livePath, { readonly: true });
    assert.equal(check.prepare('SELECT superseded_by FROM documents WHERE id = 111').get().superseded_by, null);
    assert.equal(check.prepare('SELECT COUNT(*) AS count FROM identity_repair_ledger').get().count, 0);
    check.close();
  } finally {
    fixture.cleanup();
  }
});

test('each apply batch revalidates attribution row lineage', async () => {
  const fixture = buildRepairFixture();
  try {
    const report = await planIdentityRepair(fixture);
    let mutated = false;
    await assert.rejects(
      applyIdentityRepair({
        ...fixture,
        confirm: report.plan_hash,
        batchSize: 1,
        beforeBatch: ({ batch }) => {
          if (mutated || batch[0].target !== 'retrievals.doc_id') return;
          mutated = true;
          const concurrent = new Database(fixture.livePath);
          concurrent.prepare("UPDATE retrievals SET query = 'changed concurrently' WHERE id = 100").run();
          concurrent.close();
        },
      }),
      /attribution row lineage changed/,
    );
    const check = new Database(fixture.livePath, { readonly: true });
    assert.equal(check.prepare('SELECT doc_id FROM retrievals WHERE id = 100').get().doc_id, null);
    check.close();
  } finally {
    fixture.cleanup();
  }
});

test('concurrent undo prevents later apply batches from creating a mixed state', async () => {
  const fixture = buildRepairFixture();
  try {
    const report = await planIdentityRepair(fixture);
    await assert.rejects(
      applyIdentityRepair({
        ...fixture,
        confirm: report.plan_hash,
        batchSize: 1,
        beforeBatch: async ({ batchIndex }) => {
          if (batchIndex !== 1) return;
          await undoIdentityRepair({
            ...fixture,
            confirm: report.run_id,
            batchSize: 1,
          });
        },
      }),
      /repair run changed to undone during apply/,
    );
    const check = new Database(fixture.livePath, { readonly: true });
    assert.equal(
      check.prepare('SELECT status FROM identity_repair_runs').get().status,
      IDENTITY_REPAIR_STATUS.UNDONE,
    );
    assert.equal(
      check.prepare(`
        SELECT COUNT(*) AS count
        FROM identity_repair_ledger
        WHERE undone_at IS NULL
      `).get().count,
      0,
    );
    assert.equal(check.prepare('SELECT superseded_by FROM documents WHERE id = 111').get().superseded_by, null);
    check.close();
  } finally {
    fixture.cleanup();
  }
});

test('dry-run refuses a writable backup', async () => {
  const fixture = buildRepairFixture();
  try {
    chmodSync(fixture.backupPath, 0o600);
    await assert.rejects(
      planIdentityRepair(fixture),
      /backup must be immutable/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('report hash covers the live baseline and apply rechecks owner-only mode', async () => {
  const fixture = buildRepairFixture();
  try {
    const report = await planIdentityRepair(fixture);
    const live = new Database(fixture.livePath);
    live.prepare(`
      INSERT INTO meta (key, value) VALUES ('unrelated-concurrent-write', 'changed')
    `).run();
    live.close();
    const tampered = JSON.parse(readFileSync(fixture.reportPath, 'utf8'));
    tampered.live_baseline_sha256 = fileSha256(fixture.livePath);
    writeFileSync(fixture.reportPath, JSON.stringify(tampered), { mode: 0o600 });
    await assert.rejects(
      applyIdentityRepair({ ...fixture, confirm: report.plan_hash }),
      /report hash verification failed/,
    );

    await planIdentityRepair(fixture);
    chmodSync(fixture.reportPath, 0o644);
    await assert.rejects(
      applyIdentityRepair({ ...fixture, confirm: report.plan_hash }),
      /report must be owner-only/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('dry-run refuses databases with foreign-key violations', async () => {
  const fixture = buildRepairFixture();
  try {
    const live = new Database(fixture.livePath);
    live.pragma('foreign_keys = OFF');
    insertRetrieval(live, 999, 999);
    live.close();
    await assert.rejects(
      planIdentityRepair(fixture),
      /live database failed SQLite foreign_key_check/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('identity repair CLI requires explicit backup, report, and confirmations', () => {
  assert.throws(() => parseIdentityRepairArgs(['identity']), /--backup is required/);
  assert.throws(
    () => parseIdentityRepairArgs(['identity', '--backup=x', '--report=y', '--apply']),
    /--confirm is required/,
  );
  assert.throws(
    () => parseIdentityRepairArgs([
      'identity', '--backup=x', '--report=y', '--apply', '--undo=identity-1', '--confirm=x',
    ]),
    /cannot be used together/,
  );
  assert.deepStrictEqual(
    parseIdentityRepairArgs([
      'identity', '--backup=x', '--report=y', '--undo=identity-1', '--confirm=identity-1',
      '--batch-size=17',
    ]),
    {
      apply: false,
      backupPath: 'x',
      batchSize: 17,
      confirm: 'identity-1',
      reportPath: 'y',
      undoRunId: 'identity-1',
    },
  );
});
