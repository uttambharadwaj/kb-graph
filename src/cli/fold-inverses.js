// One-time (re-runnable) migration for rows written before inverse folding.
// consolidate() now stores one direction per relationship, but a row already in
// the minority direction is invisible to its dedup, which looks at the subject
// position only. So the next mention of that relationship lands as a second live
// row — the fold creates the very pair it exists to prevent until this has run.
import { getDb } from '../db.js';
import { canonicalTriple, inverseTargetOf } from '../extract.js';

// One identity for a row however it was spelled: canonicalTriple folds a
// minority-direction predicate and resolves an aliased one, so a twin written
// under an alias of the canonical predicate lands on the same key.
const identityOf = row => {
  const t = canonicalTriple({ subject: row.subject, predicate: row.predicate, object: row.object });
  return `${t.subject}\0${t.predicate}\0${t.object}`;
};

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
    const rows = db.prepare(
      'SELECT id, subject, predicate, object, valid_from, valid_to FROM facts ORDER BY valid_from',
    ).all();

    // Rows already in the canonical direction, by identity. Comparing the stored
    // predicate exactly would miss one written under an alias of the canonical
    // spelling, and the duplicate that creates is permanent — neither row is a
    // fold source afterwards, so a re-run cannot merge them.
    const canonical = new Map();
    for (const row of rows) {
      if (row.valid_to !== null || inverseTargetOf(row.predicate)) continue;
      canonical.set(identityOf(row), { id: row.id, valid_from: row.valid_from });
    }

    // Two configured sources can fold onto one predicate, and neither is
    // canonical yet, so neither is in the map above. Claiming the destination
    // catches the second one, for the same permanence reason.
    const claimed = new Map();
    const plan = [];
    for (const row of rows) {
      const predicate = inverseTargetOf(row.predicate);
      if (!predicate) continue;
      const key = identityOf(row);
      // Retired rows are history, not competing assertions: they get the
      // direction rewritten but are never merged away, or the record of when
      // the relationship stopped being stated that way goes with them.
      const twin = row.valid_to === null ? canonical.get(key) || claimed.get(key) : null;
      if (row.valid_to === null && !twin) claimed.set(key, { id: row.id, valid_from: row.valid_from });
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
