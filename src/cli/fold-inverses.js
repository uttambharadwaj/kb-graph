// One-time (re-runnable) migration for rows written before inverse folding.
// consolidate() now stores one direction per relationship, but a row already in
// the minority direction is invisible to its dedup, which looks at the subject
// position only. So the next mention of that relationship lands as a second live
// row — the fold creates the very pair it exists to prevent until this has run.
import { getDb } from '../db.js';
import { inverseTargetOf } from '../extract.js';

export function foldInverses({ apply = false } = {}) {
  const db = getDb();

  const swap = db.prepare('UPDATE facts SET subject = ?, predicate = ?, object = ? WHERE id = ?');
  const backdate = db.prepare('UPDATE facts SET valid_from = ? WHERE id = ?');
  const drop = db.prepare('DELETE FROM facts WHERE id = ?');
  const twinOf = db.prepare(
    'SELECT id, valid_from FROM facts WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL',
  );

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

    // Two configured sources can fold onto one predicate, and neither is
    // canonical yet, so no twin lookup finds the other. Claiming the
    // destination catches the second one — and it has to, because once both are
    // folded neither uses a source predicate and a re-run cannot merge them.
    const claimed = new Map();
    const plan = [];
    for (const row of rows) {
      const predicate = inverseTargetOf(row.predicate);
      if (!predicate) continue;
      const key = `${row.object}\0${predicate}\0${row.subject}`;
      // Retired rows are history, not competing assertions: they get the
      // direction rewritten but are never merged away, or the record of when
      // the relationship stopped being stated that way goes with them.
      const twin = row.valid_to === null
        ? twinOf.get(row.object, predicate, row.subject) || claimed.get(key)
        : null;
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
