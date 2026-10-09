import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import {
  chmodSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs';
import { dirname, resolve } from 'path';
import {
  configureKnowledgeBaseConnection,
  IDENTITY_REPAIR_STATUS,
  MIGRATIONS,
} from './db.js';
import { DB_PATH } from './paths.js';
import { hasColumn, hasTable, pendingMigrations } from './schema.js';
import { normalizeVaultPath } from './vault/vault-path.js';

export const IDENTITY_REPAIR_REPORT_VERSION = 1;
export const DEFAULT_IDENTITY_REPAIR_BATCH_SIZE = 100;
export const MAX_IDENTITY_REPAIR_BATCH_SIZE = 1000;
const MIN_BACKUP_SCHEMA_VERSION = 29;
const REQUIRED_BACKUP_COLUMNS = Object.freeze({
  documents: ['id', 'content', 'source', 'superseded_at', 'superseded_by', 'superseded_reason'],
  vault_files: ['vault_path', 'document_id', 'content_hash'],
  retrievals: ['id', 'doc_id'],
  write_decisions: ['id', 'doc_id', 'nearest_id'],
});
const REPAIR_TARGET = Object.freeze({
  RETRIEVAL_DOC: 'retrievals.doc_id',
  WRITE_DOC: 'write_decisions.doc_id',
  WRITE_NEAREST: 'write_decisions.nearest_id',
  SUPERSESSION: 'documents.supersession',
});
const ATTRIBUTION_LINEAGE_COLUMNS = Object.freeze({
  retrievals: ['surface', 'query', 'session', 'created_at', 'event_id', 'is_test', 'agent', 'doc_version'],
  write_decisions: [
    'nearest_score', 'threshold', 'refused', 'session', 'agent', 'source', 'created_at',
  ],
});

export class IdentityRepairRefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IdentityRepairRefusedError';
  }
}

export class IdentityRepairInterruptedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IdentityRepairInterruptedError';
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolveStream, reject) => {
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolveStream);
  });
  return hash.digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]),
  );
}

function canonicalHash(value) {
  return sha256(JSON.stringify(canonical(value)));
}

function isVaultBacked(document) {
  return document.paths.length > 0;
}

function identityHash(mappings) {
  const rows = [...mappings.entries()]
    .map(([oldId, value]) => [oldId, value.currentDocumentId, value.method])
    .sort((left, right) => left[0] - right[0]);
  return canonicalHash(rows);
}

function assertRegularDatabase(path, label, { allowSidecars = false } = {}) {
  const absolute = resolve(path);
  const info = lstatSync(absolute);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new IdentityRepairRefusedError(`${label} must be a regular file, not a symlink`);
  }
  if (label === 'backup') {
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      throw new IdentityRepairRefusedError('backup must be owned by the current user');
    }
    if ((info.mode & 0o222) !== 0) {
      throw new IdentityRepairRefusedError('backup must be immutable for this run (remove write bits)');
    }
  }
  if (!allowSidecars && (existsSync(`${absolute}-wal`) || existsSync(`${absolute}-shm`))) {
    throw new IdentityRepairRefusedError(
      `${label} must be a standalone SQLite backup without WAL/SHM sidecars`,
    );
  }
  return absolute;
}

function schemaVersion(db) {
  let version = 0;
  for (const migration of MIGRATIONS) {
    try {
      if (migration.applied(db)) version = Math.max(version, migration.version);
    } catch {
      // A later migration may inspect a table absent from an old backup.
    }
  }
  return version;
}

function assertIntegrity(db, label) {
  const rows = db.pragma('quick_check');
  if (rows.length !== 1 || rows[0].quick_check !== 'ok') {
    throw new IdentityRepairRefusedError(`${label} failed SQLite quick_check`);
  }
  if (db.pragma('foreign_key_check').length > 0) {
    throw new IdentityRepairRefusedError(`${label} failed SQLite foreign_key_check`);
  }
}

function assertBackupSchema(db) {
  for (const [table, columns] of Object.entries(REQUIRED_BACKUP_COLUMNS)) {
    if (!hasTable(db, table)) {
      throw new IdentityRepairRefusedError(`backup schema is missing table ${table}`);
    }
    for (const column of columns) {
      if (!hasColumn(db, table, column)) {
        throw new IdentityRepairRefusedError(`backup schema is missing ${table}.${column}`);
      }
    }
  }
  const version = schemaVersion(db);
  if (version < MIN_BACKUP_SCHEMA_VERSION) {
    throw new IdentityRepairRefusedError(
      `backup schema version ${version} is older than required version ${MIN_BACKUP_SCHEMA_VERSION}`,
    );
  }
  return version;
}

function assertLiveSchema(db) {
  const pending = pendingMigrations(db, MIGRATIONS);
  if (pending.length > 0) {
    throw new IdentityRepairRefusedError(
      `live database is behind by migrations ${pending.map(migration => migration.version).join(', ')}; run kb migrate`,
    );
  }
  for (const table of ['identity_repair_runs', 'identity_repair_ledger']) {
    if (!hasTable(db, table)) {
      throw new IdentityRepairRefusedError(`live schema is missing table ${table}`);
    }
  }
  return schemaVersion(db);
}

function openReadonly(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  return db;
}

function rowsById(db, table) {
  const rows = new Map();
  for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY id`).iterate()) {
    rows.set(row.id, row);
  }
  return rows;
}

function attributionLineageHash(table, row) {
  return canonicalHash(Object.fromEntries(
    ATTRIBUTION_LINEAGE_COLUMNS[table].map(column => [column, row[column]]),
  ));
}

function loadDocuments(db) {
  const byId = new Map();
  const byPath = new Map();
  const byHash = new Map();
  const storedHash = hasColumn(db, 'vault_files', 'detached_content_hash')
    ? 'COALESCE(vf.detached_content_hash, vf.content_hash)'
    : 'vf.content_hash';
  for (const row of db.prepare(`
    SELECT d.id, d.source, d.superseded_at, d.superseded_by,
           d.superseded_reason, vf.vault_path, ${storedHash} AS content_hash
    FROM documents d
    LEFT JOIN vault_files vf ON vf.document_id = d.id
    ORDER BY d.id, vf.vault_path
  `).iterate()) {
    let document = byId.get(row.id);
    if (!document) {
      document = {
        id: row.id,
        source: row.source,
        superseded_at: row.superseded_at,
        superseded_by: row.superseded_by,
        superseded_reason: row.superseded_reason,
        hashes: [],
        paths: [],
      };
      byId.set(row.id, document);
    }
    if (row.vault_path != null) {
      // A backup can predate migration 32 and still hold `\` spellings.
      document.paths.push(normalizeVaultPath(row.vault_path));
      document.hashes.push(row.content_hash);
    }
  }

  for (const document of byId.values()) {
    if (document.paths.length !== 1) continue;
    const [path] = document.paths;
    const [contentHash] = document.hashes;
    const pathMatches = byPath.get(path) || [];
    pathMatches.push(document.id);
    byPath.set(path, pathMatches);
    if (/^[0-9a-f]{64}$/i.test(contentHash)) {
      document.content_hash = contentHash.toLowerCase();
      const hashMatches = byHash.get(document.content_hash) || [];
      hashMatches.push(document.id);
      byHash.set(document.content_hash, hashMatches);
    }
  }
  return { byId, byPath, byHash };
}

function tombstoneEvidence(db) {
  if (!hasTable(db, 'document_tombstones')) return { paths: new Set(), hashes: new Set() };
  const paths = new Set();
  const hashes = new Set();
  for (const row of db.prepare(
    'SELECT vault_path, content_hash FROM document_tombstones'
  ).iterate()) {
    if (row.vault_path != null) paths.add(normalizeVaultPath(row.vault_path));
    if (row.content_hash != null) hashes.add(row.content_hash.toLowerCase());
  }
  return { paths, hashes };
}

function buildIdentityMap(backup, live, tombstones) {
  const mappings = new Map();
  const claims = new Map();
  const collisions = [];
  const unresolved = {
    ambiguous_hash: 0,
    ambiguous_vault_paths: 0,
    irrecoverable_tombstone: 0,
    missing_current_identity: 0,
    no_vault_identity: 0,
  };
  const methods = { content_hash: 0, vault_path: 0 };

  for (const oldDocument of backup.byId.values()) {
    if (!isVaultBacked(oldDocument)) {
      unresolved.no_vault_identity += 1;
      continue;
    }
    if (oldDocument.paths.length !== 1) {
      unresolved.ambiguous_vault_paths += 1;
      continue;
    }

    const pathCandidates = new Set(live.byPath.get(oldDocument.paths[0]) || []);
    const backupHashIds = oldDocument.content_hash
      ? backup.byHash.get(oldDocument.content_hash) || []
      : [];
    const liveHashIds = oldDocument.content_hash
      ? live.byHash.get(oldDocument.content_hash) || []
      : [];
    const hashCandidate = backupHashIds.length === 1 && liveHashIds.length === 1
      ? liveHashIds[0]
      : null;
    const pathCandidate = pathCandidates.size === 1 ? [...pathCandidates][0] : null;

    if (
      pathCandidates.size > 1
      || (pathCandidate != null && hashCandidate != null && pathCandidate !== hashCandidate)
    ) {
      collisions.push({ old_document_id: oldDocument.id, kind: 'identity_disagreement' });
      continue;
    }

    const currentDocumentId = pathCandidate ?? hashCandidate;
    if (currentDocumentId == null) {
      if (backupHashIds.length > 1 || liveHashIds.length > 1) {
        unresolved.ambiguous_hash += 1;
      } else if (
        tombstones.paths.has(oldDocument.paths[0])
        || (oldDocument.content_hash && tombstones.hashes.has(oldDocument.content_hash))
      ) {
        unresolved.irrecoverable_tombstone += 1;
      } else {
        unresolved.missing_current_identity += 1;
      }
      continue;
    }

    const claimedBy = claims.get(currentDocumentId);
    if (claimedBy != null && claimedBy !== oldDocument.id) {
      collisions.push({
        old_document_id: oldDocument.id,
        current_document_id: currentDocumentId,
        kind: 'many_to_one_identity',
      });
      mappings.delete(claimedBy);
      continue;
    }

    const method = pathCandidate != null ? 'vault_path' : 'content_hash';
    claims.set(currentDocumentId, oldDocument.id);
    mappings.set(oldDocument.id, { currentDocumentId, method });
    methods[method] += 1;
  }
  return { mappings, collisions, unresolved, methods };
}

function actionKey(action) {
  return `${action.target}:${action.row_id}`;
}

function repairEvidence(oldDocumentId, identity) {
  return {
    old_document_id: oldDocumentId,
    current_document_id: identity.currentDocumentId,
    method: identity.method,
  };
}

function foreignKeyActions(backupDb, liveDb, identities, counts, collisions) {
  const actions = [];
  const targets = [
    { table: 'retrievals', column: 'doc_id', target: REPAIR_TARGET.RETRIEVAL_DOC },
    { table: 'write_decisions', column: 'doc_id', target: REPAIR_TARGET.WRITE_DOC },
    { table: 'write_decisions', column: 'nearest_id', target: REPAIR_TARGET.WRITE_NEAREST },
  ];

  for (const { table, column, target } of targets) {
    const backupRows = rowsById(backupDb, table);
    for (const liveRow of liveDb.prepare(`SELECT * FROM ${table} ORDER BY id`).iterate()) {
      const backupRow = backupRows.get(liveRow.id);
      const backupValue = backupRow?.[column];
      if (liveRow[column] != null) {
        counts.preserved_non_null += 1;
        continue;
      }
      if (backupValue == null) continue;
      const lineageHash = attributionLineageHash(table, liveRow);
      if (lineageHash !== attributionLineageHash(table, backupRow)) {
        collisions.push({
          kind: 'attribution_lineage_mismatch',
          target,
          row_id: liveRow.id,
        });
        continue;
      }
      const identity = identities.mappings.get(backupValue);
      if (!identity) {
        counts.unresolved_foreign_keys += 1;
        continue;
      }
      actions.push({
        target,
        row_id: liveRow.id,
        old_document_id: backupValue,
        evidence: [repairEvidence(backupValue, identity)],
        lineage_hash: lineageHash,
        before: { value: null },
        after: { value: identity.currentDocumentId },
        match_method: identity.method,
      });
    }
  }
  return actions;
}

function supersessionActions(backup, live, identities, counts) {
  const actions = [];
  for (const oldDocument of backup.byId.values()) {
    if (oldDocument.superseded_by == null) continue;
    const sourceIdentity = identities.mappings.get(oldDocument.id);
    const targetIdentity = identities.mappings.get(oldDocument.superseded_by);
    if (!sourceIdentity || !targetIdentity) {
      counts.unresolved_supersessions += 1;
      continue;
    }
    const current = live.byId.get(sourceIdentity.currentDocumentId);
    if (!current) {
      counts.unresolved_supersessions += 1;
      continue;
    }
    const isEmpty = current.superseded_by == null
      && current.superseded_at == null
      && current.superseded_reason == null;
    const isProvenStaleTarget = current.superseded_by === oldDocument.superseded_by
      && current.superseded_by !== targetIdentity.currentDocumentId;
    if (!isEmpty && !isProvenStaleTarget) {
      counts.preserved_non_null += 1;
      continue;
    }
    actions.push({
      target: REPAIR_TARGET.SUPERSESSION,
      row_id: current.id,
      old_document_id: oldDocument.id,
      evidence: [
        repairEvidence(oldDocument.id, sourceIdentity),
        repairEvidence(oldDocument.superseded_by, targetIdentity),
      ],
      before: {
        superseded_by: current.superseded_by,
        superseded_at: current.superseded_at,
        superseded_reason: current.superseded_reason,
      },
      after: {
        superseded_by: targetIdentity.currentDocumentId,
        superseded_at: oldDocument.superseded_at,
        superseded_reason: oldDocument.superseded_reason,
      },
      match_method: `path_supersession:${sourceIdentity.method}+${targetIdentity.method}`,
    });
  }
  return actions;
}

function missingOutcomeCount(backupDb, liveDb) {
  if (!hasTable(backupDb, 'retrieval_outcomes') || !hasTable(liveDb, 'retrieval_outcomes')) return 0;
  const liveIds = new Set(liveDb.prepare('SELECT id FROM retrieval_outcomes').pluck().iterate());
  let count = 0;
  for (const id of backupDb.prepare('SELECT id FROM retrieval_outcomes').pluck().iterate()) {
    if (!liveIds.has(id)) count += 1;
  }
  return count;
}

function buildPlan(backupDb, liveDb) {
  const backup = loadDocuments(backupDb);
  const live = loadDocuments(liveDb);
  const identities = buildIdentityMap(backup, live, tombstoneEvidence(liveDb));
  const counts = {
    collisions: identities.collisions.length,
    irrecoverable_outcomes: missingOutcomeCount(backupDb, liveDb),
    preserved_non_null: 0,
    unresolved_foreign_keys: 0,
    unresolved_supersessions: 0,
    ...identities.methods,
    ...identities.unresolved,
  };
  const actions = [
    ...foreignKeyActions(backupDb, liveDb, identities, counts, identities.collisions),
    ...supersessionActions(backup, live, identities, counts),
  ].sort((left, right) => actionKey(left).localeCompare(actionKey(right)));
  const seen = new Set();
  for (const action of actions) {
    const key = actionKey(action);
    if (seen.has(key)) {
      identities.collisions.push({ kind: 'duplicate_action', target: action.target, row_id: action.row_id });
    }
    seen.add(key);
  }
  counts.collisions = identities.collisions.length;
  counts.actions = actions.length;
  counts.actions_by_target = Object.fromEntries(
    Object.values(REPAIR_TARGET).map(target => [
      target,
      actions.filter(action => action.target === target).length,
    ]),
  );
  return {
    actions,
    counts,
    collision_buckets: identities.collisions.reduce((buckets, collision) => {
      buckets[collision.kind] = (buckets[collision.kind] || 0) + 1;
      return buckets;
    }, {}),
    identity_hash: identityHash(identities.mappings),
  };
}

function actionTarget(action) {
  const [table, ...columnParts] = action.target.split('.');
  return { table, column: columnParts.join('.') };
}

function actionState(db, action) {
  if (action.target === REPAIR_TARGET.SUPERSESSION) {
    return db.prepare(`
      SELECT superseded_by, superseded_at, superseded_reason
      FROM documents WHERE id = ?
    `).get(action.row_id) || null;
  }
  const { table, column } = actionTarget(action);
  const row = db.prepare(`SELECT ${column} AS value FROM ${table} WHERE id = ?`).get(action.row_id);
  return row || null;
}

function evidenceDocuments(db, documentIds) {
  if (documentIds.length === 0) return new Map();
  const storedHash = hasColumn(db, 'vault_files', 'detached_content_hash')
    ? 'COALESCE(vf.detached_content_hash, vf.content_hash)'
    : 'vf.content_hash';
  const placeholders = documentIds.map(() => '?').join(', ');
  const documents = new Map();
  for (const row of db.prepare(`
    SELECT d.id, vf.vault_path, ${storedHash} AS content_hash
    FROM documents d
    LEFT JOIN vault_files vf ON vf.document_id = d.id
    WHERE d.id IN (${placeholders})
    ORDER BY d.id, vf.vault_path
  `).iterate(...documentIds)) {
    const document = documents.get(row.id) || { paths: [], hashes: [] };
    if (row.vault_path != null) {
      document.paths.push(normalizeVaultPath(row.vault_path));
      document.hashes.push(row.content_hash?.toLowerCase());
    }
    documents.set(row.id, document);
  }
  return documents;
}

function storedHashCounts(db, hashes) {
  if (hashes.length === 0) return new Map();
  const storedHash = hasColumn(db, 'vault_files', 'detached_content_hash')
    ? 'LOWER(COALESCE(detached_content_hash, content_hash))'
    : 'LOWER(content_hash)';
  const placeholders = hashes.map(() => '?').join(', ');
  return new Map(db.prepare(`
    SELECT ${storedHash} AS content_hash, COUNT(DISTINCT document_id) AS count
    FROM vault_files
    WHERE ${storedHash} IN (${placeholders})
    GROUP BY ${storedHash}
  `).all(...hashes).map(row => [row.content_hash, row.count]));
}

function validateBatchEvidence(backupDb, liveDb, actions) {
  const evidence = actions.flatMap(action => action.evidence);
  const backupIds = [...new Set(evidence.map(item => item.old_document_id))];
  const currentIds = [...new Set(evidence.map(item => item.current_document_id))];
  const backupDocuments = evidenceDocuments(backupDb, backupIds);
  const currentDocuments = evidenceDocuments(liveDb, currentIds);
  const hashes = [];

  for (const item of evidence) {
    const backup = backupDocuments.get(item.old_document_id);
    const current = currentDocuments.get(item.current_document_id);
    if (!backup || backup.paths.length !== 1 || !current || current.paths.length !== 1) {
      throw new IdentityRepairRefusedError('identity evidence no longer has one vault path per document');
    }
    if (item.method === 'vault_path') {
      if (backup.paths[0] !== current.paths[0]) {
        throw new IdentityRepairRefusedError('vault-path identity evidence changed before apply');
      }
      continue;
    }
    if (item.method !== 'content_hash') {
      throw new IdentityRepairRefusedError(`unsupported identity evidence method ${item.method}`);
    }
    const backupHash = backup.hashes[0];
    const currentHash = current.hashes[0];
    if (
      !/^[0-9a-f]{64}$/.test(backupHash)
      || backupHash !== currentHash
    ) {
      throw new IdentityRepairRefusedError('exact content-hash identity evidence changed before apply');
    }
    hashes.push(backupHash);
  }

  const uniqueHashes = [...new Set(hashes)];
  const backupCounts = storedHashCounts(backupDb, uniqueHashes);
  const currentCounts = storedHashCounts(liveDb, uniqueHashes);
  for (const hash of uniqueHashes) {
    if (backupCounts.get(hash) !== 1 || currentCounts.get(hash) !== 1) {
      throw new IdentityRepairRefusedError('content-hash identity evidence is no longer unique');
    }
  }

  for (const action of actions) {
    if (action.target === REPAIR_TARGET.SUPERSESSION) {
      if (action.after.superseded_by !== action.evidence[1]?.current_document_id) {
        throw new IdentityRepairRefusedError('supersession replacement evidence does not match the report');
      }
    } else {
      if (action.after.value !== action.evidence[0]?.current_document_id) {
        throw new IdentityRepairRefusedError('foreign-key identity evidence does not match the report');
      }
      const table = action.target.split('.')[0];
      const currentRow = liveDb.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(action.row_id);
      if (!currentRow || attributionLineageHash(table, currentRow) !== action.lineage_hash) {
        throw new IdentityRepairRefusedError('attribution row lineage changed before apply');
      }
    }
  }
}

function sameState(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function updateAction(db, action, from, to) {
  if (action.target === REPAIR_TARGET.SUPERSESSION) {
    return db.prepare(`
      UPDATE documents
      SET superseded_by = ?, superseded_at = ?, superseded_reason = ?
      WHERE id = ?
        AND superseded_by IS ?
        AND superseded_at IS ?
        AND superseded_reason IS ?
    `).run(
      to.superseded_by,
      to.superseded_at,
      to.superseded_reason,
      action.row_id,
      from.superseded_by,
      from.superseded_at,
      from.superseded_reason,
    ).changes;
  }
  const { table, column } = actionTarget(action);
  return db.prepare(`
    UPDATE ${table} SET ${column} = ? WHERE id = ? AND ${column} IS ?
  `).run(to.value, action.row_id, from.value).changes;
}

function validateBatchSize(batchSize) {
  if (
    !Number.isSafeInteger(batchSize)
    || batchSize < 1
    || batchSize > MAX_IDENTITY_REPAIR_BATCH_SIZE
  ) {
    throw new IdentityRepairRefusedError(
      `batch size must be between 1 and ${MAX_IDENTITY_REPAIR_BATCH_SIZE}`,
    );
  }
}

function reportPlanCore(report) {
  return {
    version: report.version,
    backup_sha256: report.backup_sha256,
    backup_schema_version: report.backup_schema_version,
    live_baseline_sha256: report.live_baseline_sha256,
    live_schema_version: report.live_schema_version,
    identity_hash: report.identity_hash,
    actions: report.actions,
    counts: report.counts,
    collision_buckets: report.collision_buckets,
  };
}

function reportPayload({ backupPath, backupSha256, backupSchemaVersion, liveSha256, liveSchemaVersion, plan }) {
  const planCore = {
    version: IDENTITY_REPAIR_REPORT_VERSION,
    backup_sha256: backupSha256,
    backup_schema_version: backupSchemaVersion,
    live_baseline_sha256: liveSha256,
    live_schema_version: liveSchemaVersion,
    identity_hash: plan.identity_hash,
    actions: plan.actions,
    counts: plan.counts,
    collision_buckets: plan.collision_buckets,
  };
  const planHash = canonicalHash(planCore);
  return {
    ...planCore,
    run_id: `identity-${planHash.slice(0, 24)}`,
    plan_hash: planHash,
    backup_file: backupPath.split('/').at(-1),
    can_apply: plan.counts.collisions === 0,
  };
}

function writeOwnerOnlyJson(path, value) {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentInfo = statSync(parent);
  if ((parentInfo.mode & 0o077) !== 0) {
    throw new IdentityRepairRefusedError('report directory must be owner-only (mode 0700)');
  }
  if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
    throw new IdentityRepairRefusedError('report path must not be a symlink');
  }
  const temporary = `${absolute}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, absolute);
  chmodSync(absolute, 0o600);
  return absolute;
}

function readReport(path) {
  const absolute = resolve(path);
  const info = lstatSync(absolute);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new IdentityRepairRefusedError('repair report must be a regular file');
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new IdentityRepairRefusedError('repair report must be owned by the current user');
  }
  if ((info.mode & 0o077) !== 0) {
    throw new IdentityRepairRefusedError('repair report must be owner-only');
  }
  const report = JSON.parse(readFileSync(absolute, 'utf8'));
  if (report.version !== IDENTITY_REPAIR_REPORT_VERSION) {
    throw new IdentityRepairRefusedError(`unsupported identity repair report version ${report.version}`);
  }
  const expectedHash = canonicalHash(reportPlanCore(report));
  if (report.plan_hash !== expectedHash || report.run_id !== `identity-${expectedHash.slice(0, 24)}`) {
    throw new IdentityRepairRefusedError('repair report hash verification failed');
  }
  return report;
}

async function inspectDatabases({ backupPath, livePath = DB_PATH, writable = false }) {
  const backupAbsolute = assertRegularDatabase(backupPath, 'backup');
  const liveAbsolute = assertRegularDatabase(livePath, 'live database', { allowSidecars: true });
  if (backupAbsolute === liveAbsolute) {
    throw new IdentityRepairRefusedError('backup and live database paths must differ');
  }
  const backupDb = openReadonly(backupAbsolute);
  const liveDb = writable
    ? new Database(liveAbsolute, { fileMustExist: true })
    : openReadonly(liveAbsolute);
  if (writable) {
    configureKnowledgeBaseConnection(liveDb);
    liveDb.pragma('foreign_keys = ON');
    liveDb.pragma('busy_timeout = 5000');
  }
  try {
    assertIntegrity(backupDb, 'backup');
    assertIntegrity(liveDb, 'live database');
    const backupSchemaVersion = assertBackupSchema(backupDb);
    const liveSchemaVersion = assertLiveSchema(liveDb);
    const [backupSha256, liveSha256] = await Promise.all([
      sha256File(backupAbsolute),
      sha256File(liveAbsolute),
    ]);
    return {
      backupAbsolute,
      backupDb,
      backupSchemaVersion,
      backupSha256,
      liveAbsolute,
      liveDb,
      liveSchemaVersion,
      liveSha256,
    };
  } catch (error) {
    backupDb.close();
    liveDb.close();
    throw error;
  }
}

function closeInspection(inspection) {
  inspection.backupDb.close();
  inspection.liveDb.close();
}

export async function planIdentityRepair({ backupPath, reportPath, livePath = DB_PATH }) {
  const inspection = await inspectDatabases({ backupPath, livePath });
  try {
    const plan = buildPlan(inspection.backupDb, inspection.liveDb);
    const report = reportPayload({
      backupPath: inspection.backupAbsolute,
      backupSha256: inspection.backupSha256,
      backupSchemaVersion: inspection.backupSchemaVersion,
      liveSha256: inspection.liveSha256,
      liveSchemaVersion: inspection.liveSchemaVersion,
      plan,
    });
    const savedTo = writeOwnerOnlyJson(reportPath, report);
    return { ...report, report_path: savedTo };
  } finally {
    closeInspection(inspection);
  }
}

function runRecord(db, runId) {
  return db.prepare('SELECT * FROM identity_repair_runs WHERE run_id = ?').get(runId) || null;
}

function assertRunMatches(run, report) {
  if (
    run.plan_hash !== report.plan_hash
    || run.backup_sha256 !== report.backup_sha256
    || run.live_schema_version !== report.live_schema_version
    || run.backup_schema_version !== report.backup_schema_version
  ) {
    throw new IdentityRepairRefusedError('existing repair run does not match the report');
  }
}

function ledgerRecord(db, runId, action) {
  const { table, column } = actionTarget(action);
  return db.prepare(`
    SELECT * FROM identity_repair_ledger
    WHERE run_id = ? AND target_table = ? AND target_column = ? AND row_id = ?
  `).get(
    runId,
    table,
    column,
    action.row_id,
  ) || null;
}

function recordAppliedAction(db, report, sequence, action) {
  const { table, column } = actionTarget(action);
  db.prepare(`
    INSERT INTO identity_repair_ledger (
      run_id, sequence, target_table, target_column, row_id,
      before_json, after_json, match_method
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    report.run_id,
    sequence,
    table,
    column,
    action.row_id,
    JSON.stringify(action.before),
    JSON.stringify(action.after),
    action.match_method,
  );
}

function verifyReportAgainstInspection(report, inspection, { allowChangedLive, verifyIdentity = true }) {
  if (report.backup_sha256 !== inspection.backupSha256) {
    throw new IdentityRepairRefusedError('backup changed since the dry run');
  }
  if (report.backup_schema_version !== inspection.backupSchemaVersion) {
    throw new IdentityRepairRefusedError('backup schema changed since the dry run');
  }
  if (report.live_schema_version !== inspection.liveSchemaVersion) {
    throw new IdentityRepairRefusedError('live schema changed since the dry run');
  }
  if (!allowChangedLive && report.live_baseline_sha256 !== inspection.liveSha256) {
    throw new IdentityRepairRefusedError('live database changed since the dry run; generate a new report');
  }
  if (!verifyIdentity) return;
  const identities = buildIdentityMap(
    loadDocuments(inspection.backupDb),
    loadDocuments(inspection.liveDb),
    tombstoneEvidence(inspection.liveDb),
  );
  if (identityHash(identities.mappings) !== report.identity_hash) {
    throw new IdentityRepairRefusedError('document identity mapping changed since the dry run');
  }
}

export async function applyIdentityRepair({
  backupPath,
  reportPath,
  confirm,
  livePath = DB_PATH,
  batchSize = DEFAULT_IDENTITY_REPAIR_BATCH_SIZE,
  stopAfterBatches = Infinity,
  beforeBatch = null,
}) {
  validateBatchSize(batchSize);
  const report = readReport(reportPath);
  if (confirm !== report.plan_hash) {
    throw new IdentityRepairRefusedError('--confirm must equal the report plan_hash');
  }
  if (!report.can_apply || report.counts.collisions > 0) {
    throw new IdentityRepairRefusedError('repair report contains identity collisions');
  }
  const inspection = await inspectDatabases({ backupPath, livePath, writable: true });
  try {
    const run = runRecord(inspection.liveDb, report.run_id);
    if (run) assertRunMatches(run, report);
    if (run?.status === IDENTITY_REPAIR_STATUS.APPLIED) {
      return { run_id: report.run_id, applied: 0, already_applied: true, remaining: 0 };
    }
    if (run && run.status !== IDENTITY_REPAIR_STATUS.APPLYING) {
      throw new IdentityRepairRefusedError(`repair run is ${run.status}, not resumable for apply`);
    }
    verifyReportAgainstInspection(report, inspection, { allowChangedLive: Boolean(run) });

    if (!run) {
      const freshPlan = buildPlan(inspection.backupDb, inspection.liveDb);
      const freshReport = reportPayload({
        backupPath: inspection.backupAbsolute,
        backupSha256: inspection.backupSha256,
        backupSchemaVersion: inspection.backupSchemaVersion,
        liveSha256: inspection.liveSha256,
        liveSchemaVersion: inspection.liveSchemaVersion,
        plan: freshPlan,
      });
      if (freshReport.plan_hash !== report.plan_hash) {
        throw new IdentityRepairRefusedError('repair plan changed since the dry run');
      }
      inspection.liveDb.prepare(`
        INSERT INTO identity_repair_runs (
          run_id, plan_hash, backup_sha256, live_schema_version,
          backup_schema_version, status
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        report.run_id,
        report.plan_hash,
        report.backup_sha256,
        report.live_schema_version,
        report.backup_schema_version,
        IDENTITY_REPAIR_STATUS.APPLYING,
      );
    }

    let applied = 0;
    let batches = 0;
    for (let start = 0; start < report.actions.length; start += batchSize) {
      const batch = report.actions.slice(start, start + batchSize);
      if (beforeBatch) await beforeBatch({ batch, batchIndex: batches });
      const changed = inspection.liveDb.transaction(() => {
        const status = inspection.liveDb.prepare(
          'SELECT status FROM identity_repair_runs WHERE run_id = ?'
        ).get(report.run_id)?.status;
        if (status !== IDENTITY_REPAIR_STATUS.APPLYING) {
          throw new IdentityRepairRefusedError(`repair run changed to ${status} during apply`);
        }
        validateBatchEvidence(inspection.backupDb, inspection.liveDb, batch);
        let batchApplied = 0;
        for (let offset = 0; offset < batch.length; offset += 1) {
          const action = batch[offset];
          const sequence = start + offset;
          const ledger = ledgerRecord(inspection.liveDb, report.run_id, action);
          const current = actionState(inspection.liveDb, action);
          if (!current) {
            throw new IdentityRepairRefusedError(
              `repair target disappeared: ${action.target} row ${action.row_id}`,
            );
          }
          if (ledger) {
            if (!sameState(current, action.after)) {
              throw new IdentityRepairRefusedError(
                `applied repair target changed: ${action.target} row ${action.row_id}`,
              );
            }
            continue;
          }
          if (!sameState(current, action.before)) {
            throw new IdentityRepairRefusedError(
              `repair target changed before apply: ${action.target} row ${action.row_id}`,
            );
          }
          if (updateAction(inspection.liveDb, action, action.before, action.after) !== 1) {
            throw new IdentityRepairRefusedError(
              `repair compare-and-set failed: ${action.target} row ${action.row_id}`,
            );
          }
          recordAppliedAction(inspection.liveDb, report, sequence, action);
          batchApplied += 1;
        }
        return batchApplied;
      }).immediate();
      applied += changed;
      batches += 1;
      if (batches >= stopAfterBatches && start + batchSize < report.actions.length) {
        throw new IdentityRepairInterruptedError('synthetic interruption after committed repair batch');
      }
    }
    const completed = inspection.liveDb.prepare(`
      UPDATE identity_repair_runs
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE run_id = ? AND status = ?
    `).run(IDENTITY_REPAIR_STATUS.APPLIED, report.run_id, IDENTITY_REPAIR_STATUS.APPLYING);
    if (completed.changes !== 1) {
      throw new IdentityRepairRefusedError('repair run status changed before apply completed');
    }
    return { run_id: report.run_id, applied, already_applied: false, remaining: 0 };
  } finally {
    closeInspection(inspection);
  }
}

export async function undoIdentityRepair({
  backupPath,
  reportPath,
  confirm,
  livePath = DB_PATH,
  batchSize = DEFAULT_IDENTITY_REPAIR_BATCH_SIZE,
  stopAfterBatches = Infinity,
}) {
  validateBatchSize(batchSize);
  const report = readReport(reportPath);
  if (confirm !== report.run_id) {
    throw new IdentityRepairRefusedError('--confirm must equal the report run_id for undo');
  }
  const inspection = await inspectDatabases({ backupPath, livePath, writable: true });
  try {
    verifyReportAgainstInspection(
      report,
      inspection,
      { allowChangedLive: true, verifyIdentity: false },
    );
    const run = runRecord(inspection.liveDb, report.run_id);
    if (!run) throw new IdentityRepairRefusedError('repair run was not applied');
    assertRunMatches(run, report);
    if (run.status === IDENTITY_REPAIR_STATUS.UNDONE) {
      return { run_id: report.run_id, undone: 0, already_undone: true, remaining: 0 };
    }
    if (![
      IDENTITY_REPAIR_STATUS.APPLYING,
      IDENTITY_REPAIR_STATUS.APPLIED,
      IDENTITY_REPAIR_STATUS.UNDOING,
    ].includes(run.status)) {
      throw new IdentityRepairRefusedError(`repair run is ${run.status}, not undoable`);
    }
    const beganUndo = inspection.liveDb.transaction(() => inspection.liveDb.prepare(`
      UPDATE identity_repair_runs
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE run_id = ? AND status IN (?, ?, ?)
    `).run(
      IDENTITY_REPAIR_STATUS.UNDOING,
      report.run_id,
      IDENTITY_REPAIR_STATUS.APPLYING,
      IDENTITY_REPAIR_STATUS.APPLIED,
      IDENTITY_REPAIR_STATUS.UNDOING,
    )).immediate();
    if (beganUndo.changes !== 1) {
      throw new IdentityRepairRefusedError('repair run status changed before undo began');
    }

    const ledger = inspection.liveDb.prepare(`
      SELECT sequence, target_table, target_column, row_id,
             before_json, after_json, match_method, undone_at
      FROM identity_repair_ledger
      WHERE run_id = ?
      ORDER BY sequence DESC
    `).all(report.run_id);
    let undone = 0;
    let batches = 0;
    for (let start = 0; start < ledger.length; start += batchSize) {
      const batch = ledger.slice(start, start + batchSize);
      const changed = inspection.liveDb.transaction(() => {
        const status = inspection.liveDb.prepare(
          'SELECT status FROM identity_repair_runs WHERE run_id = ?'
        ).get(report.run_id)?.status;
        if (status !== IDENTITY_REPAIR_STATUS.UNDOING) {
          throw new IdentityRepairRefusedError(`repair run changed to ${status} during undo`);
        }
        let batchUndone = 0;
        for (const entry of batch) {
          const action = {
            target: `${entry.target_table}.${entry.target_column}`,
            row_id: entry.row_id,
            before: JSON.parse(entry.before_json),
            after: JSON.parse(entry.after_json),
            match_method: entry.match_method,
          };
          const current = actionState(inspection.liveDb, action);
          if (!current) {
            throw new IdentityRepairRefusedError(
              `repair target disappeared before undo: ${action.target} row ${action.row_id}`,
            );
          }
          if (entry.undone_at != null) {
            if (!sameState(current, action.before)) {
              throw new IdentityRepairRefusedError(
                `undone repair target changed: ${action.target} row ${action.row_id}`,
              );
            }
            continue;
          }
          if (!sameState(current, action.after)) {
            throw new IdentityRepairRefusedError(
              `repair target changed before undo: ${action.target} row ${action.row_id}`,
            );
          }
          if (updateAction(inspection.liveDb, action, action.after, action.before) !== 1) {
            throw new IdentityRepairRefusedError(
              `repair undo compare-and-set failed: ${action.target} row ${action.row_id}`,
            );
          }
          inspection.liveDb.prepare(`
            UPDATE identity_repair_ledger
            SET undone_at = CURRENT_TIMESTAMP
            WHERE run_id = ? AND sequence = ? AND undone_at IS NULL
          `).run(report.run_id, entry.sequence);
          batchUndone += 1;
        }
        return batchUndone;
      }).immediate();
      undone += changed;
      batches += 1;
      if (batches >= stopAfterBatches && start + batchSize < ledger.length) {
        throw new IdentityRepairInterruptedError('synthetic interruption after committed undo batch');
      }
    }
    const completed = inspection.liveDb.prepare(`
      UPDATE identity_repair_runs
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE run_id = ? AND status = ?
    `).run(IDENTITY_REPAIR_STATUS.UNDONE, report.run_id, IDENTITY_REPAIR_STATUS.UNDOING);
    if (completed.changes !== 1) {
      throw new IdentityRepairRefusedError('repair run status changed before undo completed');
    }
    return { run_id: report.run_id, undone, already_undone: false, remaining: 0 };
  } finally {
    closeInspection(inspection);
  }
}

export function publicIdentityRepairReport(report) {
  return {
    version: report.version,
    run_id: report.run_id,
    plan_hash: report.plan_hash,
    can_apply: report.can_apply,
    report_path: report.report_path,
    backup_file: report.backup_file,
    counts: report.counts,
    collision_buckets: report.collision_buckets,
  };
}
