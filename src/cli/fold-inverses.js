// One-time (re-runnable) migration for rows stored under a spelling
// canonicalisation has since moved: a mirrored predicate (blocks / blocked_by),
// a work item stored as the subject of implements, a synonym or an inflection
// (merged_into / merged_to, deploys_to / deployed_to).
// consolidate() now stores one triple per relationship, but a row on any older
// spelling is invisible to its dedup, which matches subject and canonical
// predicate. So the next mention of that relationship lands as a second live
// row — canonicalisation creates the very pair it exists to prevent until this
// has run. That makes the migration part of the change, not a follow-up to it.
import { getDb } from '../db.js';
import { canonicalTriple, sameEntity } from '../extract.js';

// The triple as it will be stored: canonicalTriple folds a minority-direction
// predicate and resolves an aliased one.
const canonicalise = row =>
  canonicalTriple({ subject: row.subject, predicate: row.predicate, object: row.object });

// A row is stale when canonicalisation would store it differently — in the other
// direction, or under another predicate. Asking canonicalTriple rather than the
// inverse map is what makes the second case visible: an alias or an inflection
// leaves the subject where it is and only rewrites the predicate, so a check
// built from inverseTargetOf walks straight past every synonym fold and
// back-fills none of them.
const needsFold = (row, canonical) =>
  canonical.subject !== row.subject || canonical.predicate !== row.predicate;

// Rows sharing a subject and predicate, which is as far as an exact key can go.
// consolidate matches its subject exactly and its object through sameEntity, so
// the object comparison has to happen inside the bucket or this migration would
// split a fact the writer treats as one.
const bucketKey = t => `${t.subject}\0${t.predicate}`;

// null sorts before every date here, matching queryFact's as-of test
// (valid_from IS NULL OR valid_from <= ?) and SQLite's NULLS FIRST ordering.
const startsEarlier = (a, b) => (a == null ? b != null : b != null && a < b);

export function foldInverses({ apply = false } = {}) {
  const db = getDb();

  const swap = db.prepare('UPDATE facts SET subject = ?, predicate = ?, object = ? WHERE id = ?');
  // source travels with valid_from: they describe one observation, and taking
  // the date without it leaves the survivor citing a source that never saw the
  // fact that early.
  const backdate = db.prepare('UPDATE facts SET valid_from = ?, source = ? WHERE id = ?');
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
      'SELECT id, subject, predicate, object, valid_from, valid_to, source FROM facts ORDER BY valid_from',
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
      const canonical = canonicalise(row);
      if (row.valid_to !== null || needsFold(row, canonical)) continue;
      bucketOf(canonical).push({ id: row.id, valid_from: row.valid_from, object: canonical.object });
    }

    const plan = [];
    for (const row of rows) {
      const t = canonicalise(row);
      if (!needsFold(row, t)) continue;
      // Retired rows are history, not competing assertions: they get the
      // direction rewritten but are never merged away, or the record of when
      // the relationship stopped being stated that way goes with them.
      const twin = row.valid_to === null
        ? bucketOf(t).find(c => sameEntity(c.object, t.object))
        : null;
      if (row.valid_to === null && !twin) {
        bucketOf(t).push({ id: row.id, valid_from: row.valid_from, object: t.object });
      }
      plan.push({ row, canonical: t, twin });
    }

    const merges = plan.filter(p => p.twin);
    const folds = plan.filter(p => !p.twin);

    if (write) {
      // From the canonical triple, not from a swap of the stored one: a row that
      // folds twice — inverse then roles — lands back on its own subject with
      // only the predicate rewritten, and a blind swap would undo that.
      for (const { row, canonical } of folds) {
        swap.run(canonical.subject, canonical.predicate, canonical.object, row.id);
      }
      for (const { row, twin } of merges) {
        // Keep the earlier valid_from, so a merge never makes a fact look
        // younger. A null one is not missing — as-of queries read it as valid
        // before any date, so it is the earliest start there is, and dropping
        // it would hide the relationship before the survivor's date.
        if (startsEarlier(row.valid_from, twin.valid_from)) {
          backdate.run(row.valid_from ?? null, row.source ?? null, twin.id);
        }
        drop.run(row.id);
      }
    }
    return { folded: folds.length, merged: merges.length };
  });

  const { folded, merged } = run(apply);
  const verb = apply ? ['Folded', 'merged'] : ['Would fold', 'would merge'];
  console.log(`${verb[0]} ${folded} rows onto the canonical triple; ${verb[1]} ${merged} into a row that already holds the relationship.`);
  if (!apply) console.log('Dry run. Pass --apply to write.');
  return { folded, merged };
}

export function runFoldInversesCli(argv = process.argv.slice(3)) {
  foldInverses({ apply: argv.includes('--apply') });
}
