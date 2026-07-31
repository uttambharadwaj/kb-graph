import { getDb } from './db.js';

export function initFactSchema() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'unknown',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Alias -> canonical entity id, for what spelling alone cannot fold:
    -- renames (old-name -> new-name) and synonyms. Separator and case variants
    -- need no row here — canonicalEntityId collapses those on the way in.
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

// created_at defaults to SQLite's CURRENT_TIMESTAMP, which is UTC
// 'YYYY-MM-DD HH:MM:SS'. Anything compared against it has to be formatted the
// same way, and the format lives here because this is where the column does.
export const sqlTimestamp = (d = new Date()) => d.toISOString().replace('T', ' ').slice(0, 19);

// The separators an identifier can be spelled with, all of them carrying the
// same nothing: "auth-service", "auth_service", "auth service",
// "gateway.py", "v2/contracts/list". Folding them is what stops a second
// spelling of one concept minting a sibling entity no query for the first will
// ever see. Nothing else folds — '#', '+' and non-ASCII carry meaning ("c#" is
// not "c"), and merging two entities that are genuinely different corrupts the
// graph in a way leaving one split does not.
const SEPARATORS = /[\s_./-]+/g;

export function canonicalEntityId(name) {
  const bare = name.toLowerCase().replace(/'/g, '');
  const folded = bare.replace(SEPARATORS, '_').replace(/^_+|_+$/g, '');
  // A name that is nothing but separators ("..", "-") folds to the empty
  // string, which would put every one of them on a single node. Keep it whole:
  // an under-merge is recoverable and a wrong merge is not.
  return folded || bare.trim();
}

// Resolve an entity id through the alias table (single hop — merges rewrite
// old facts, so chains never form). The stored target is re-canonicalized
// because an alias recorded before the separator fold points at a spelling that
// is no longer where the facts live.
function resolveEntity(eid) {
  const row = getDb().prepare('SELECT canonical FROM entity_aliases WHERE alias = ?').get(eid);
  return row ? canonicalEntityId(row.canonical) : eid;
}

// The row identity of a name: spelling collapsed, then merges followed. Every
// read and write here goes through it, and so must anything outside that groups
// by subject — a second spelling of this rule is a group that misses a
// collision, and following only half of it misses the merged half.
export const entityKey = name => resolveEntity(canonicalEntityId(name));

// One aggressive fold past canonical: punctuation dropped outright, a regular
// plural ignored. Not safe to merge on — it maps "c#" onto "c" and "profile"
// onto "profiles", which are sometimes different things — but it is what a
// caller means by "the same thing", so a query that cannot reach those ids has
// to name them instead of returning a clean-looking subset. Irregular plurals
// ("index"/"indexes") go unreported, which is the safe direction for a hint.
const looseKey = eid => eid.toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/s$/, '');

// The entities a query for `entityName` does not reach but the caller probably
// meant. Excludes the qualifier ids queryFact's prefix match already covers, and
// entities holding no facts, which are nothing to miss.
export function nearbyEntities(entityName) {
  const db = getDb();
  const eid = entityKey(entityName);
  const target = looseKey(eid);
  if (!target) return [];

  // Every id, because no SQL predicate expresses the loose key and a second
  // spelling of it in a WHERE clause is the drift this change exists to stop.
  // Plucked: on a graph of this size the ids alone are a few milliseconds and
  // the rows around them are not.
  const detail = db.prepare('SELECT name, (SELECT COUNT(*) FROM facts WHERE subject = e.id OR object = e.id) AS facts FROM entities e WHERE id = ?');
  const out = [];
  for (const id of db.prepare('SELECT id FROM entities').pluck().all()) {
    if (id === eid || id.startsWith(`${eid}_`) || looseKey(id) !== target) continue;
    const row = detail.get(id);
    if (row.facts > 0) out.push({ id, name: row.name, facts: row.facts });
  }
  return out.sort((a, b) => b.facts - a.facts || a.id.localeCompare(b.id));
}

// Merge entity `from` into `to`: rewrite all facts, record the alias so
// future writes and queries using the old name land on the canonical node.
export function mergeEntity(fromName, toName) {
  const db = getDb();
  const from = entityKey(fromName);
  const to = entityKey(toName);
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
  const subId = entityKey(subject);
  const objId = entityKey(object);
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
  const eid = entityKey(entityName);
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
        recorded_at: row.created_at,
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
        recorded_at: row.created_at,
      });
    }
  }

  return results;
}

export function invalidateFact(subject, predicate, object, { ended } = {}) {
  const db = getDb();
  const subId = entityKey(subject);
  const objId = entityKey(object);
  const pred = predicate.toLowerCase().replace(/\s+/g, '_');
  const endDate = ended || new Date().toISOString().split('T')[0];

  // valid_to < valid_from is an interval of negative length. queryFact's as-of
  // clause (valid_from <= asOf AND valid_to >= asOf) can never match it, so the
  // row would be neither current nor historical — it would just vanish.
  // Refuses rather than throws: the caller is consolidate, iterating a batch,
  // where an exception would abandon every fact queued behind this one.
  // MAX, not an arbitrary row: mergeEntity can collapse two entities into one
  // triple with several live rows, and the UPDATE below hits all of them. The
  // latest start is the one that decides whether any interval would invert.
  const row = db.prepare(
    'SELECT MAX(valid_from) AS valid_from FROM facts WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL'
  ).get(subId, pred, objId);
  if (row?.valid_from && row.valid_from > endDate) {
    return { invalidated: 0, ended: endDate, refused: 'ended_before_valid_from', valid_from: row.valid_from };
  }

  const result = db.prepare(
    'UPDATE facts SET valid_to = ? WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL'
  ).run(endDate, subId, pred, objId);

  return { invalidated: result.changes, ended: endDate };
}

export function factTimeline(entityName) {
  const db = getDb();
  let sql, params;

  if (entityName) {
    const eid = entityKey(entityName);
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
