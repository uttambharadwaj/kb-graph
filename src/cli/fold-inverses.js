// One-time (re-runnable) migration for rows written before inverse folding.
// consolidate() now stores one direction per relationship, but a row already in
// the minority direction is invisible to its dedup, which looks at the subject
// position only. So the next mention of that relationship lands as a second live
// row — the fold creates the very pair it exists to prevent until this has run.
import { getDb } from '../db.js';
import { canonicalTriple, inverseTargetOf, sameEntity } from '../extract.js';

// The triple as it will be stored: canonicalTriple folds a minority-direction
// predicate and resolves an aliased one.
const canonicalise = row =>
  canonicalTriple({ subject: row.subject, predicate: row.predicate, object: row.object });

// Rows sharing a subject and predicate, which is as far as an exact key can go.
// consolidate matches its subject exactly and its object through sameEntity, so
// the object comparison has to happen inside the bucket or this migration would
// split a fact the writer treats as one.
const bucketKey = t => `${t.subject}\0${t.predicate}`;

export function foldInverses({ apply = false } = {}) {
  const db = getDb();

  const swap = db.prepare('UPDATE facts SET subject = ?, predicate = ?, object = ? WHERE id = ?');
  const backdate = db.prepare('UPDATE facts SET valid_from = ? WHERE id = ?');
  const drop = db.prepare('DELETE FROM facts WHERE id = ?');
  // Every read and every write in one transaction. ~13 MCP subprocesses share
  // this DB, so a row read outside it can be retired before the delete lands —
  // and a stale valid_to would then classify a retired row as a live duplicate
  // and erase its history.
  const run = db.transaction((write) => {
    // ponytail: full scan. Filtering by predicate in SQL would miss rows stored
    // under an alias of a fold source, and at this table's size reading every
    // row is cheaper than being clever about which spellings to ask for.
    // ORDER BY is load-bearing, not cosmetic: buckets are filled in this order,
    // so the first sameEntity match is the oldest row, which is the one a merge
    // should keep.
    const rows = db.prepare(
      'SELECT id, subject, predicate, object, valid_from, valid_to FROM facts ORDER BY valid_from',
    ).all();

    // Every live row a fold could land on: those already canonical, plus the
    // destinations this run is about to claim. Both belong in one structure —
    // two configured sources can fold onto one predicate, and neither is
    // canonical beforehand, so nothing but the claim would catch the second.
    // Either way the duplicate would be permanent, since a folded row is no
    // longer a fold source and a re-run could not find it.
    const destinations = new Map();
    const bucketOf = (t) => {
      const k = bucketKey(t);
      if (!destinations.has(k)) destinations.set(k, []);
      return destinations.get(k);
    };
    for (const row of rows) {
      if (row.valid_to !== null || inverseTargetOf(row.predicate)) continue;
      const t = canonicalise(row);
      bucketOf(t).push({ id: row.id, valid_from: row.valid_from, object: t.object });
    }

    const plan = [];
    for (const row of rows) {
      const predicate = inverseTargetOf(row.predicate);
      if (!predicate) continue;
      const t = canonicalise(row);
      // Retired rows are history, not competing assertions: they get the
      // direction rewritten but are never merged away, or the record of when
      // the relationship stopped being stated that way goes with them.
      const twin = row.valid_to === null
        ? bucketOf(t).find(c => sameEntity(c.object, t.object))
        : null;
      if (row.valid_to === null && !twin) {
        bucketOf(t).push({ id: row.id, valid_from: row.valid_from, object: t.object });
      }
      plan.push({ row, predicate, twin });
    }

    const merges = plan.filter(p => p.twin);
    const folds = plan.filter(p => !p.twin);

    if (write) {
      for (const { row, predicate } of folds) swap.run(row.object, predicate, row.subject, row.id);
      for (const { row, twin } of merges) {
        // Keep the earlier valid_from, so a merge never makes a fact look younger.
        if (row.valid_from && (!twin.valid_from || row.valid_from < twin.valid_from)) {
          backdate.run(row.valid_from, twin.id);
        }
        drop.run(row.id);
      }
    }
    return { folded: folds.length, merged: merges.length };
  });

  const { folded, merged } = run(apply);
  const verb = apply ? ['Folded', 'merged'] : ['Would fold', 'would merge'];
  console.log(`${verb[0]} ${folded} rows onto the canonical direction; ${verb[1]} ${merged} into a row that already holds the relationship.`);
  if (!apply) console.log('Dry run. Pass --apply to write.');
  return { folded, merged };
}

export function runFoldInversesCli(argv = process.argv.slice(3)) {
  foldInverses({ apply: argv.includes('--apply') });
}
