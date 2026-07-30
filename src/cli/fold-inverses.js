// One-time (re-runnable) migration for rows written before inverse folding.
// consolidate() now stores one direction per relationship, but a row already in
// the minority direction is invisible to its dedup, which looks at the subject
// position only. So the next mention of that relationship lands as a second live
// row — the fold creates the very pair it exists to prevent until this has run.
import { getDb } from '../db.js';
import { PREDICATE_INVERSES } from '../extract.js';

export function foldInverses({ apply = false } = {}) {
  const db = getDb();
  const sources = Object.keys(PREDICATE_INVERSES);
  if (!sources.length) {
    console.log('No inverse predicates configured — nothing to fold.');
    return { folded: 0, merged: 0 };
  }

  const rows = db.prepare(`
    SELECT id, subject, predicate, object, valid_from, valid_to FROM facts
    WHERE predicate IN (${sources.map(() => '?').join(',')})
    ORDER BY valid_from
  `).all(...sources);

  const twinOf = db.prepare(
    'SELECT id, valid_from FROM facts WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL',
  );

  const swap = db.prepare('UPDATE facts SET subject = ?, predicate = ?, object = ? WHERE id = ?');
  const backdate = db.prepare('UPDATE facts SET valid_from = ? WHERE id = ?');
  const drop = db.prepare('DELETE FROM facts WHERE id = ?');

  // Plan and write in one transaction. ~13 MCP subprocesses share this DB, so a
  // twin read outside it can be retired before the delete lands — which would
  // drop the minority row and leave the relationship with no current assertion
  // at all. A dry run takes the same transaction for a consistent count.
  const run = db.transaction((write) => {
    // Retired rows are history, not competing assertions: they get the direction
    // rewritten but are never merged away, or the record of when the relationship
    // stopped being stated that way goes with them.
    const plan = rows.map(row => {
      const predicate = PREDICATE_INVERSES[row.predicate];
      return {
        row,
        predicate,
        twin: row.valid_to === null ? twinOf.get(row.object, predicate, row.subject) : null,
      };
    });
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
