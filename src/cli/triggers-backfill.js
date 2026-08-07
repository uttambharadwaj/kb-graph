// `kb triggers-backfill` — propose command triggers for notes that have
// never been asked, write the proposals into frontmatter, and reindex so the
// vetted patterns land in documents.triggers and the hook's index.
//
// Mirror of `kb aliases-backfill` (src/cli/aliases-backfill.js): the
// classifier now proposes triggers for every NEW note; this covers the
// corpus that predates it. "Never been asked" is read from the frontmatter —
// a `triggers` key, even an empty list, means a pass already happened — so
// the run is resumable and a note whose every proposal was filtered out is
// not re-billed on the next invocation.
//
// One model call per note, so the default batch is small and the summary
// says what it cost. The filter (src/trigger-relevance.js filterTriggers) is
// what stands between a helpful model and the hook; this command only
// carries proposals to it.
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import matter from 'gray-matter';
import { getDb } from '../db.js';
import { runClaudeJSON } from '../claude-cli.js';
import { indexVaultFile } from '../vault/indexer.js';
import { filterTriggers, rebuildTriggerIndex } from '../trigger-relevance.js';
import { TRIGGER_PROPOSAL_RULES } from '../trigger-proposal-rules.js';
import { neverAsked as neverAskedKey } from './aliases-backfill.js';
import { UsageError, acceptFlags, readFlagValue } from './flags.js';

const USAGE = 'Usage: kb triggers-backfill [--limit <N>] [--doc <id>] [--dry-run] [--revet]';
const DEFAULT_LIMIT = 20;

const TRIGGERS_PROMPT = `You identify command triggers for a knowledge-base note: which commands is the note warning you about running?

Return ONLY valid JSON (no markdown fencing, no explanation): {"triggers": ["...", ...]}.

${TRIGGER_PROPOSAL_RULES}`;

// Same resumability marker aliases-backfill.js uses (an even-if-empty
// frontmatter key means a pass already ran), keyed on 'triggers' instead.
export const neverAsked = (filePath) => neverAskedKey(filePath, 'triggers');

// Re-run the deterministic filter over every stored proposal — no model
// calls, no frontmatter writes. The reindex path cannot do this: it skips a
// file whose content hash is unchanged, and a filter change (a tightened
// ceiling, a bigger corpus) changes no file. This is how the stored column
// catches up with the filter as it stands today.
export function revetTriggers() {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH || join(homedir(), '.claude', 'kb-index');
  const db = getDb();
  const rows = db.prepare(`
    SELECT vf.vault_path, vf.document_id, d.title, d.content, d.triggers
    FROM vault_files vf JOIN documents d ON d.id = vf.document_id
    WHERE d.superseded_at IS NULL AND d.doc_type != 'archive'
    ORDER BY vf.document_id
  `).all();
  const update = db.prepare('UPDATE documents SET triggers = ? WHERE id = ?');
  let seen = 0, changed = 0;
  for (const row of rows) {
    let fm;
    try {
      ({ data: fm } = matter(readFileSync(join(vaultPath, row.vault_path), 'utf-8')));
    } catch {
      continue;
    }
    if (!('triggers' in fm)) continue;
    seen += 1;
    const vetted = filterTriggers(fm.triggers, { title: row.title, content: row.content }, { pinned: !!fm.triggers_pinned }) || null;
    if (vetted !== row.triggers) {
      changed += 1;
      update.run(vetted, row.document_id);
      console.log(`#${row.document_id} ${row.title}\n  "${row.triggers || ''}" -> "${vetted || ''}"`);
    }
  }
  if (changed) rebuildTriggerIndex();
  console.log(`\n${seen} notes re-vetted, ${changed} changed.`);
  return { seen, changed };
}

export async function runTriggersBackfillCli(args = []) {
  if (!acceptFlags(args, { usage: USAGE, value: ['--limit', '--doc'], boolean: ['--dry-run', '--revet'] })) return;
  if (args.includes('--revet')) { revetTriggers(); return; }
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

  // Live notes only: proposing triggers for a superseded note spends a model
  // call on something the hook will never see fire.
  const rows = getDb().prepare(`
    SELECT vf.vault_path, vf.document_id, d.title
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

  let asked = 0, kept = 0, anyChange = false;
  // Prepared once, not once per candidate — the only read left per note is
  // the final `stored` value the log line and `kept` counter need; the
  // prior-value read is gone, because indexVaultFile now reports
  // triggersChanged itself (it already knows, having just computed it).
  const selectTriggers = getDb().prepare('SELECT triggers FROM documents WHERE id = ?');

  for (const c of candidates) {
    const filePath = join(vaultPath, c.vault_path);
    const { data: fm, content: body } = matter(readFileSync(filePath, 'utf-8'));
    let proposal;
    try {
      proposal = await runClaudeJSON(
        `${TRIGGERS_PROMPT}\n\n---\nTitle: ${c.title}\n---\n\n${body.slice(0, 4000)}`,
        { caller: 'triggers-backfill' },
      );
    } catch (err) {
      console.log(`#${c.document_id} ${c.title}\n  model call failed: ${err.message}`);
      continue; // no frontmatter write — the next run asks again
    }
    asked += 1;
    const proposed = Array.isArray(proposal?.triggers) ? proposal.triggers.map(String) : [];
    // The empty list is written too: it is the "asked, nothing to add" marker
    // that makes the run resumable.
    fm.triggers = proposed;
    writeFileSync(filePath, matter.stringify(body, fm));
    // Deferred: K candidates would otherwise cost K full-table index
    // rebuilds (one inline per changed note, via src/vault/indexer.js) on
    // top of the one this loop already does at the end.
    const result = await indexVaultFile(vaultPath, c.vault_path, { deferTriggerIndex: true });
    if (result.triggersChanged) anyChange = true;
    const stored = selectTriggers.get(c.document_id)?.triggers ?? null;
    if (stored) kept += 1;
    const errs = result.errors?.length ? ` (index: ${result.errors.join('; ')})` : '';
    console.log(`#${c.document_id} ${c.title}\n  proposed [${proposed.join(', ')}] -> kept "${stored || ''}"${errs}`);
  }

  // The only rebuild for this whole run — every per-note call above deferred
  // it, so K changed notes cost one rebuild, not K+1.
  if (anyChange) rebuildTriggerIndex();
  console.log(`\n${asked} notes asked, ${kept} gained triggers; ${remaining} live notes still unasked.`);
}
