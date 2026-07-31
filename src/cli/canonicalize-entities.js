// One-time (re-runnable) migration for entities stored under a spelling
// entityKey has since moved. It now folds every separator run — space, hyphen,
// underscore, dot, slash — to one underscore, so "auth-service" and
// "auth service" name one node. Rows written before that fold still
// carry their original spelling, and a query for any other one cannot see them:
// each spelling answers with a confident fraction of what is stored. New writes
// land on the canonical id from here, so without this back-fill the graph keeps
// both halves apart forever — which makes the migration part of the change,
// not a follow-up to it.
//
// Not a loop over mergeEntity, which is the hand tool for one rename: it would
// record an alias row per spelling that canonicalEntityId already folds, keep
// whichever name the caller happened to pass rather than the one the facts use,
// and leave behind the duplicate live triples a merge creates.
import { getDb } from '../db.js';
import { canonicalEntityId, entityKey, dedupeLiveFacts } from '../facts.js';

// The triple identity a merge can collide on, for predicting what
// dedupeLiveFacts will collapse. Retired rows are excluded there and here: a
// retired row is history, and dropping it loses the record of when the
// relationship stopped being stated that way.
const tripleKey = f => `${f.subject}\0${f.predicate}\0${f.object}`;

// The spelling the graph actually uses, so the merged node displays the name
// most of its facts were written under. Ties break on the id for determinism —
// a migration whose output depends on row order is not one you can dry-run.
function survivorOf(members) {
  return members.reduce((best, m) => (m.facts > best.facts
    || (m.facts === best.facts && m.id < best.id) ? m : best));
}

// Group every entity by where entityKey now sends it. Not by canonicalEntityId
// alone: the alias table is the other half of that resolution, and a group
// built from only the spelling half would leave an aliased entity's facts
// stranded under an id reads no longer resolve to.
function planMerges(db) {
  const facts = db.prepare('SELECT subject, object FROM facts').all();
  const factCount = new Map();
  for (const f of facts) {
    factCount.set(f.subject, (factCount.get(f.subject) || 0) + 1);
    if (f.object !== f.subject) factCount.set(f.object, (factCount.get(f.object) || 0) + 1);
  }

  const groups = new Map();
  for (const e of db.prepare('SELECT id, name, type, created_at FROM entities').all()) {
    const target = entityKey(e.id);
    if (!groups.has(target)) groups.set(target, []);
    groups.get(target).push({ ...e, facts: factCount.get(e.id) || 0 });
  }

  return [...groups.entries()]
    .filter(([target, members]) => members.length > 1 || members[0].id !== target)
    .map(([target, members]) => ({ target, members, survivor: survivorOf(members) }))
    .sort((a, b) => b.members.reduce((n, m) => n + m.facts, 0) - a.members.reduce((n, m) => n + m.facts, 0));
}

// Aliases recorded before the fold point at a spelling that is no longer where
// the facts live, and their own keys are not canonical either. Rewriting both
// ends is what stops a rename alias resolving to a dead id. A row whose two
// ends fold together says nothing — the spelling rule already merges them — so
// it goes rather than lingering as a self-loop.
function planAliases(db) {
  const rewrites = [], drops = [];
  for (const row of db.prepare('SELECT alias, canonical FROM entity_aliases').all()) {
    const alias = canonicalEntityId(row.alias);
    const canonical = canonicalEntityId(row.canonical);
    if (alias === canonical) drops.push(row);
    else if (alias !== row.alias || canonical !== row.canonical) rewrites.push({ row, alias, canonical });
  }
  return { rewrites, drops };
}

export function canonicalizeEntities({ apply = false, verbose = false } = {}) {
  const db = getDb();

  const upsert = db.prepare(`
    INSERT INTO entities (id, name, type, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type, created_at = excluded.created_at
  `);
  const moveSubjects = db.prepare('UPDATE facts SET subject = ? WHERE subject = ?');
  const moveObjects = db.prepare('UPDATE facts SET object = ? WHERE object = ?');
  const dropEntity = db.prepare('DELETE FROM entities WHERE id = ?');
  const dropAlias = db.prepare('DELETE FROM entity_aliases WHERE alias = ?');
  const putAlias = db.prepare('INSERT OR REPLACE INTO entity_aliases (alias, canonical) VALUES (?, ?)');

  // Every read and every write in one transaction. ~13 MCP subprocesses share
  // this DB, so a plan computed outside it can be written against rows another
  // process has already moved.
  const run = db.transaction((write) => {
    const merges = planMerges(db);
    const aliases = planAliases(db);
    const moved = merges.reduce((n, g) => n + g.members.filter(m => m.id !== g.target).length, 0);
    // Replayed in memory rather than written and rolled back, and computed in
    // both modes: reporting a merge count while staying silent about the rows
    // it would delete is the omission this whole change is about.
    const { rows, collapsed } = countRewrite(db, merges);

    if (!write) return { merges, aliases, moved, rows, collapsed };

    for (const { target, members, survivor } of merges) {
      // A node is as old as its oldest spelling. A null created_at is not a
      // date to compare against, so it never wins the fold.
      const oldest = members.reduce((a, m) => (m.created_at && (!a || m.created_at < a) ? m.created_at : a), null);
      const typed = members.find(m => m.type && m.type !== 'unknown');
      // The canonical row has to exist before a fact can point at it: facts
      // carries a foreign key to entities and better-sqlite3 enforces it.
      upsert.run(target, survivor.name, typed ? typed.type : survivor.type, oldest);
      for (const m of members) {
        if (m.id === target) continue;
        moveSubjects.run(target, m.id);
        moveObjects.run(target, m.id);
        dropEntity.run(m.id);
      }
    }

    for (const row of aliases.drops) dropAlias.run(row.alias);
    for (const { row, alias, canonical } of aliases.rewrites) {
      dropAlias.run(row.alias);
      putAlias.run(alias, canonical);
    }

    // After the rewrite, not before: two rows that named one relationship in
    // two spellings are now the same triple, and addFact refuses to create that
    // pair, so leaving it would put state in the graph no writer can produce.
    const written = dedupeLiveFacts();
    return { merges, aliases, moved, rows, collapsed: written };
  });

  const result = run(apply);
  report(result, { apply, verbose });
  return {
    groups: result.merges.length,
    entities_moved: result.moved,
    fact_rows_rewritten: result.rows,
    duplicates_collapsed: result.collapsed,
    aliases_rewritten: result.aliases.rewrites.length,
    aliases_dropped: result.aliases.drops.length,
  };
}

// What the merges above do to the facts table: how many rows change an end, and
// how many live rows then name a triple another row already names. Counted per
// row, because a fact whose subject and object both move is still one row.
function countRewrite(db, merges) {
  const target = new Map();
  for (const g of merges) for (const m of g.members) target.set(m.id, g.target);
  const at = id => target.get(id) ?? id;

  const seen = new Set();
  let rows = 0, collapsed = 0;
  for (const f of db.prepare('SELECT subject, predicate, object, valid_to FROM facts').all()) {
    const subject = at(f.subject), object = at(f.object);
    if (subject !== f.subject || object !== f.object) rows++;
    if (f.valid_to !== null) continue;
    const key = tripleKey({ subject, predicate: f.predicate, object });
    if (seen.has(key)) collapsed++;
    else seen.add(key);
  }
  return { rows, collapsed };
}


function report({ merges, aliases, moved, rows, collapsed }, { apply, verbose }) {
  const collisions = merges.filter(g => g.members.length > 1);
  const said = apply
    ? { moved: 'Moved', merged: 'merged', collapsed: 'Collapsed', rewrote: 'Rewrote', dropped: 'dropped' }
    : { moved: 'Would move', merged: 'would merge', collapsed: 'Would collapse', rewrote: 'Would rewrite', dropped: 'would drop' };

  console.log(`${said.moved} ${moved} entities onto their canonical id, ${said.merged} ${collisions.length} groups of two or more spellings into one node; ${rows} fact rows change an end.`);
  console.log(`${said.collapsed} ${collapsed} live rows that the merge leaves as duplicate triples.`);
  console.log(`${said.rewrote} ${aliases.rewrites.length} alias rows and ${said.dropped} ${aliases.drops.length} that the spelling rule now folds on its own.`);

  const listed = verbose ? collisions : collisions.slice(0, 10);
  for (const g of listed) {
    const from = g.members.filter(m => m.id !== g.target).map(m => `${m.id} (${m.facts})`).join(', ');
    console.log(`  ${g.target} <- ${from}`);
  }
  if (!verbose && collisions.length > listed.length) {
    console.log(`  ... and ${collisions.length - listed.length} more groups. Pass --verbose to list them all.`);
  }
  if (!apply) console.log('Dry run. Pass --apply to write.');
}

/**
 * What the stored rows say, asked without reference to the migration's own
 * bookkeeping. A migration re-run that reports no work only proves it agrees
 * with itself; these are the properties the graph has to hold afterwards, read
 * straight off the tables.
 */
export function auditCanonicalEntities() {
  const db = getDb();
  const entities = db.prepare('SELECT id FROM entities').all().map(r => r.id);
  const subjects = db.prepare('SELECT DISTINCT subject AS id FROM facts UNION SELECT DISTINCT object FROM facts').all().map(r => r.id);
  const aliases = db.prepare('SELECT alias, canonical FROM entity_aliases').all();

  return {
    non_canonical_entities: entities.filter(id => id !== canonicalEntityId(id)),
    non_canonical_fact_ends: subjects.filter(id => id !== canonicalEntityId(id)),
    orphan_fact_ends: db.prepare(
      'SELECT DISTINCT subject AS id FROM facts WHERE subject NOT IN (SELECT id FROM entities) UNION SELECT DISTINCT object FROM facts WHERE object NOT IN (SELECT id FROM entities)',
    ).all().map(r => r.id),
    duplicate_live_triples: db.prepare(
      'SELECT subject, predicate, object, COUNT(*) AS n FROM facts WHERE valid_to IS NULL GROUP BY 1, 2, 3 HAVING n > 1',
    ).all(),
    unresolved_aliases: aliases.filter(a => a.alias !== canonicalEntityId(a.alias)
      || a.canonical !== canonicalEntityId(a.canonical)
      || a.alias === a.canonical),
  };
}

export function runCanonicalizeEntitiesCli(argv = process.argv.slice(3)) {
  // --dry-run beats --apply. Someone who passes both wants to be shown, not
  // obeyed, and this is the one command here that rewrites most of the graph.
  const apply = argv.includes('--apply') && !argv.includes('--dry-run');
  const result = canonicalizeEntities({ apply, verbose: argv.includes('--verbose') });
  if (!apply) return result;

  const audit = auditCanonicalEntities();
  const failures = Object.entries(audit).filter(([, v]) => v.length > 0);
  if (!failures.length) {
    console.log('Audit: every entity id, fact end and alias is canonical; no duplicate live triples.');
    return result;
  }
  for (const [check, rows] of failures) {
    console.error(`Audit FAILED — ${check}: ${rows.length}, e.g. ${JSON.stringify(rows.slice(0, 3))}`);
  }
  process.exitCode = 1;
  return result;
}
