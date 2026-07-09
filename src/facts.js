import { getDb } from './db.js';

export function initFactSchema() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'unknown',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Alias -> canonical entity id. Extraction mints freeform ids; aliases
    -- fold renames (old-name -> new-name) and spelling variants into one node.
    CREATE TABLE IF NOT EXISTS entity_aliases (
      alias TEXT PRIMARY KEY,
      canonical TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      valid_from TEXT,
      valid_to TEXT,
      source TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (subject) REFERENCES entities(id),
      FOREIGN KEY (object) REFERENCES entities(id)
    );

    CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject);
    CREATE INDEX IF NOT EXISTS idx_facts_object ON facts(object);
    CREATE INDEX IF NOT EXISTS idx_facts_predicate ON facts(predicate);
    CREATE INDEX IF NOT EXISTS idx_facts_valid ON facts(valid_from, valid_to);
  `);
}

function entityId(name) {
  return name.toLowerCase().replace(/\s+/g, '_').replace(/'/g, '');
}

// Resolve an entity id through the alias table (single hop — merges rewrite
// old facts, so chains never form).
function resolveEntity(eid) {
  const row = getDb().prepare('SELECT canonical FROM entity_aliases WHERE alias = ?').get(eid);
  return row ? row.canonical : eid;
}

// Merge entity `from` into `to`: rewrite all facts, record the alias so
// future writes and queries using the old name land on the canonical node.
export function mergeEntity(fromName, toName) {
  const db = getDb();
  const from = resolveEntity(entityId(fromName));
  const to = resolveEntity(entityId(toName));
  if (from === to) return { merged: false, reason: 'same entity' };

  db.prepare('INSERT OR IGNORE INTO entities (id, name) VALUES (?, ?)').run(to, toName);
  const subs = db.prepare('UPDATE facts SET subject = ? WHERE subject = ?').run(to, from).changes;
  const objs = db.prepare('UPDATE facts SET object = ? WHERE object = ?').run(to, from).changes;
  db.prepare('INSERT OR REPLACE INTO entity_aliases (alias, canonical) VALUES (?, ?)').run(from, to);
  // Repoint any aliases that targeted the old id, then drop its entity row.
  db.prepare('UPDATE entity_aliases SET canonical = ? WHERE canonical = ?').run(to, from);
  db.prepare('DELETE FROM entities WHERE id = ?').run(from);

  return { merged: true, from, to, facts_rewritten: subs + objs };
}

export function addFact(subject, predicate, object, { validFrom, source } = {}) {
  const db = getDb();
  const subId = resolveEntity(entityId(subject));
  const objId = resolveEntity(entityId(object));
  const pred = predicate.toLowerCase().replace(/\s+/g, '_');

  // Auto-create entities
  db.prepare('INSERT OR IGNORE INTO entities (id, name) VALUES (?, ?)').run(subId, subject);
  db.prepare('INSERT OR IGNORE INTO entities (id, name) VALUES (?, ?)').run(objId, object);

  // Check for existing identical active fact
  const existing = db.prepare(
    'SELECT id FROM facts WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL'
  ).get(subId, pred, objId);

  if (existing) return { id: existing.id, already_exists: true };

  const id = `f_${subId}_${pred}_${objId}_${Date.now().toString(36)}`;
  db.prepare(
    'INSERT INTO facts (id, subject, predicate, object, valid_from, source) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, subId, pred, objId, validFrom || null, source || null);

  return { id, subject, predicate: pred, object, valid_from: validFrom || null };
}

// Extraction produces freeform entity ids ("auth-service_sandbox", "auth-service_prod_image"),
// so an exact match on "auth-service" misses most of what we know. Match the entity itself
// plus any id that extends it with an underscore-separated qualifier.
function prefixPattern(eid) {
  return eid.replace(/([%_\\])/g, '\\$1') + '\\_%';
}

export function queryFact(entityName, { asOf, direction = 'both', exact = false } = {}) {
  const db = getDb();
  const eid = resolveEntity(entityId(entityName));
  // exact=true restores strict matching — consolidation uses it so an
  // "auth-service" fact never reads as contradicting an "auth-service_sandbox" one.
  const like = exact ? eid : prefixPattern(eid);
  const results = [];

  if (direction === 'outgoing' || direction === 'both') {
    let sql = `
      SELECT f.*, s.name as sub_name, o.name as obj_name FROM facts f
      JOIN entities s ON f.subject = s.id
      JOIN entities o ON f.object = o.id
      WHERE (f.subject = ? OR f.subject LIKE ? ESCAPE '\\')
    `;
    const params = [eid, like];
    if (asOf) {
      sql += ' AND (f.valid_from IS NULL OR f.valid_from <= ?) AND (f.valid_to IS NULL OR f.valid_to >= ?)';
      params.push(asOf, asOf);
    }
    for (const row of db.prepare(sql).all(...params)) {
      results.push({
        direction: 'outgoing',
        subject: row.sub_name,
        predicate: row.predicate,
        object: row.obj_name,
        valid_from: row.valid_from,
        valid_to: row.valid_to,
        current: row.valid_to === null,
        source: row.source,
      });
    }
  }

  if (direction === 'incoming' || direction === 'both') {
    let sql = `
      SELECT f.*, s.name as sub_name, o.name as obj_name FROM facts f
      JOIN entities s ON f.subject = s.id
      JOIN entities o ON f.object = o.id
      WHERE (f.object = ? OR f.object LIKE ? ESCAPE '\\')
    `;
    const params = [eid, like];
    if (asOf) {
      sql += ' AND (f.valid_from IS NULL OR f.valid_from <= ?) AND (f.valid_to IS NULL OR f.valid_to >= ?)';
      params.push(asOf, asOf);
    }
    for (const row of db.prepare(sql).all(...params)) {
      results.push({
        direction: 'incoming',
        subject: row.sub_name,
        predicate: row.predicate,
        object: row.obj_name,
        valid_from: row.valid_from,
        valid_to: row.valid_to,
        current: row.valid_to === null,
        source: row.source,
      });
    }
  }

  return results;
}

export function invalidateFact(subject, predicate, object, { ended } = {}) {
  const db = getDb();
  const subId = resolveEntity(entityId(subject));
  const objId = resolveEntity(entityId(object));
  const pred = predicate.toLowerCase().replace(/\s+/g, '_');
  const endDate = ended || new Date().toISOString().split('T')[0];

  const result = db.prepare(
    'UPDATE facts SET valid_to = ? WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL'
  ).run(endDate, subId, pred, objId);

  return { invalidated: result.changes, ended: endDate };
}

export function factTimeline(entityName) {
  const db = getDb();
  let sql, params;

  if (entityName) {
    const eid = resolveEntity(entityId(entityName));
    sql = `
      SELECT f.*, s.name as sub_name, o.name as obj_name
      FROM facts f
      JOIN entities s ON f.subject = s.id
      JOIN entities o ON f.object = o.id
      WHERE f.subject = ? OR f.object = ?
      ORDER BY f.valid_from ASC NULLS LAST
      LIMIT 100
    `;
    params = [eid, eid];
  } else {
    sql = `
      SELECT f.*, s.name as sub_name, o.name as obj_name
      FROM facts f
      JOIN entities s ON f.subject = s.id
      JOIN entities o ON f.object = o.id
      ORDER BY f.valid_from ASC NULLS LAST
      LIMIT 100
    `;
    params = [];
  }

  return db.prepare(sql).all(...params).map(r => ({
    subject: r.sub_name,
    predicate: r.predicate,
    object: r.obj_name,
    valid_from: r.valid_from,
    valid_to: r.valid_to,
    current: r.valid_to === null,
    source: r.source,
  }));
}

export function factStats() {
  const db = getDb();
  const entities = db.prepare('SELECT COUNT(*) as count FROM entities').get().count;
  const total = db.prepare('SELECT COUNT(*) as count FROM facts').get().count;
  const current = db.prepare('SELECT COUNT(*) as count FROM facts WHERE valid_to IS NULL').get().count;
  const predicates = db.prepare('SELECT DISTINCT predicate FROM facts ORDER BY predicate').all().map(r => r.predicate);

  return { entities, total_facts: total, current_facts: current, expired_facts: total - current, relationship_types: predicates };
}
