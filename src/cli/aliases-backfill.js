// `kb aliases-backfill` — propose retrieval aliases for notes that have never
// been asked, write the proposals into frontmatter, and reindex so the vetted
// tokens land in the scorer's column.
//
// The classifier now proposes aliases for every NEW note; this covers the
// corpus that predates it. "Never been asked" is read from the frontmatter —
// an `aliases` key, even an empty list, means a pass already happened — so the
// run is resumable and a note whose every proposal was filtered out is not
// re-billed on the next invocation.
//
// One model call per note, so the default batch is small and the summary says
// what it cost. The filter (src/hint-relevance.js filterAliases) is what
// stands between a helpful model and the scorer; this command only carries
// proposals to it.
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import matter from 'gray-matter';
import { getDb } from '../db.js';
import { runClaudeJSON } from '../claude-cli.js';
import { indexVaultFile } from '../vault/indexer.js';
import { filterAliases } from '../hint-relevance.js';
import { UsageError, acceptFlags, readFlagValue } from './flags.js';

const USAGE = 'Usage: kb aliases-backfill [--limit <N>] [--doc <id>] [--dry-run] [--revet]';
const DEFAULT_LIMIT = 20;

const ALIAS_PROMPT = `You suggest retrieval aliases for a knowledge-base note: the words a person's QUESTION would use when this note is the answer.

Return ONLY valid JSON (no markdown fencing, no explanation): {"aliases": ["...", ...]} with 0 to 6 entries.

Rules:
- Imagine the questions this note answers; each alias is the subject of one, phrased as the question would say it — usually a one-to-three-word phrase ("harvest job", "vault indexer").
- Every alias must be a word or phrase the note's own text uses. Never invent a synonym the note does not contain.
- Prefer the plain name a person would say over a code identifier; include an identifier only when someone would ask by it.
- Do not propose a generic working word on its own (run, check, fix, issue) — though one may appear inside a subject phrase.
- Duplication against the title is fine; a filter removes what the title already covers.`;

// The resumability marker: a frontmatter key — even an empty list — means a
// pass already ran, so the note is never re-billed. `key` parameterizes this
// for triggers-backfill.js, which shares this exact check against a
// different frontmatter field; every existing caller here keeps the
// 'aliases' default.
export function neverAsked(filePath, key = 'aliases') {
  try {
    const { data: fm } = matter(readFileSync(filePath, 'utf-8'));
    return !(key in fm);
  } catch {
    return false; // vault file gone or unreadable — the indexer's problem, not this one's
  }
}

// Re-run the deterministic filter over every stored proposal — no model
// calls, no frontmatter writes. The reindex path cannot do this: it skips a
// file whose content hash is unchanged, and a filter change (a tightened
// ceiling, a bigger corpus) changes no file. This is how the stored column
// catches up with the filter as it stands today.
export function revetAliases() {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH || join(homedir(), '.claude', 'kb-index');
  const db = getDb();
  const rows = db.prepare(`
    SELECT vf.vault_path, vf.document_id, d.title, d.tags, d.content, d.aliases
    FROM vault_files vf JOIN documents d ON d.id = vf.document_id
    WHERE d.superseded_at IS NULL AND d.doc_type != 'archive'
    ORDER BY vf.document_id
  `).all();
  const update = db.prepare('UPDATE documents SET aliases = ? WHERE id = ?');
  let seen = 0, changed = 0;
  for (const row of rows) {
    let fm;
    try {
      ({ data: fm } = matter(readFileSync(join(vaultPath, row.vault_path), 'utf-8')));
    } catch {
      continue;
    }
    if (!('aliases' in fm)) continue;
    seen += 1;
    const vetted = filterAliases(fm.aliases, { title: row.title, tags: row.tags, content: row.content }) || null;
    if (vetted !== row.aliases) {
      changed += 1;
      update.run(vetted, row.document_id);
      console.log(`#${row.document_id} ${row.title}\n  "${row.aliases || ''}" -> "${vetted || ''}"`);
    }
  }
  console.log(`\n${seen} notes re-vetted, ${changed} changed.`);
  return { seen, changed };
}

export async function runAliasesBackfillCli(args = []) {
  if (!acceptFlags(args, { usage: USAGE, value: ['--limit', '--doc'], boolean: ['--dry-run', '--revet'] })) return;
  if (args.includes('--revet')) { revetAliases(); return; }
  const docRaw = readFlagValue(args, '--doc');
  const doc = docRaw === undefined ? undefined : Number(docRaw);
  if (docRaw !== undefined && !Number.isInteger(doc)) {
    throw new UsageError(`--doc must be a document id, got: ${docRaw}`, USAGE);
  }
  const limitRaw = readFlagValue(args, '--limit');
  const limit = limitRaw === undefined ? DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new UsageError(`--limit must be a positive integer, got: ${limitRaw}`, USAGE);
  }
  const dryRun = args.includes('--dry-run');
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH || join(homedir(), '.claude', 'kb-index');

  // Live notes only: proposing aliases for a superseded note spends a model
  // call on something retrieval will never return.
  const rows = getDb().prepare(`
    SELECT vf.vault_path, vf.document_id, d.title, d.tags
    FROM vault_files vf JOIN documents d ON d.id = vf.document_id
    WHERE d.superseded_at IS NULL AND d.doc_type != 'archive'
      ${doc === undefined ? '' : 'AND d.id = ?'}
    ORDER BY vf.document_id
  `).all(...(doc === undefined ? [] : [doc]));

  const unasked = rows.filter(row => neverAsked(join(vaultPath, row.vault_path)));
  const candidates = unasked.slice(0, limit);
  const remaining = unasked.length - candidates.length;

  if (dryRun) {
    for (const c of candidates) console.log(`#${c.document_id} ${c.title}`);
    console.log(`${candidates.length} of ${unasked.length} unasked notes would be asked this run (${rows.length} live).`);
    return;
  }

  let asked = 0, kept = 0;
  for (const c of candidates) {
    const filePath = join(vaultPath, c.vault_path);
    const { data: fm, content: body } = matter(readFileSync(filePath, 'utf-8'));
    let proposal;
    try {
      proposal = await runClaudeJSON(
        `${ALIAS_PROMPT}\n\n---\nTitle: ${c.title}\nTags: ${c.tags}\n---\n\n${body.slice(0, 4000)}`,
        { caller: 'aliases-backfill' },
      );
    } catch (err) {
      console.log(`#${c.document_id} ${c.title}\n  model call failed: ${err.message}`);
      continue; // no frontmatter write — the next run asks again
    }
    asked += 1;
    const proposed = Array.isArray(proposal?.aliases) ? proposal.aliases.map(String) : [];
    // The empty list is written too: it is the "asked, nothing to add" marker
    // that makes the run resumable.
    fm.aliases = proposed;
    writeFileSync(filePath, matter.stringify(body, fm));
    const result = await indexVaultFile(vaultPath, c.vault_path);
    const stored = getDb().prepare('SELECT aliases FROM documents WHERE id = ?').get(c.document_id)?.aliases;
    if (stored) kept += 1;
    const errs = result.errors?.length ? ` (index: ${result.errors.join('; ')})` : '';
    console.log(`#${c.document_id} ${c.title}\n  proposed [${proposed.join(', ')}] -> kept "${stored || ''}"${errs}`);
  }

  console.log(`\n${asked} notes asked, ${kept} gained aliases; ${remaining} live notes still unasked.`);
}
