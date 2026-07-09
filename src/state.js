// Knowledge vs state: lessons and decisions are immutable and accumulate;
// workstream STATE is mutable and lives in exactly one note per project
// (state/<project>.md), rewritten as sessions land. Session notes are the
// immutable per-session record — once folded into state they're retyped
// `archive` (content untouched, still searchable) so search and briefings
// stop presenting week-old snapshots as current truth.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getDb } from './db.js';
import { runClaude } from './claude-cli.js';
import { indexVault } from './vault/indexer.js';

const STATE_MODEL = process.env.STATE_MODEL || 'claude-sonnet-5';
const MAX_SESSIONS_PER_MERGE = 15;
const MAX_BODY_CHARS = 2000;

const STATE_PROMPT = `You maintain the CURRENT-STATE note for one engineering workstream. You get the existing state note (may be empty) and new session records, oldest first. Rewrite the state note.

Rules:
- Describe where the workstream stands NOW: active work, status, blockers, decisions in force, next steps, key context (PRs, tickets, owners).
- Newer sessions override older ones and the old state. Drop anything superseded.
- Keep it tight — a teammate should be current after one read. Prefer bullets.
- Note real uncertainty ("last known state, as of <date>") rather than guessing.
- Output ONLY the markdown body of the note. No frontmatter, no preamble.`;

function stateSlug(project) {
  return (project || 'general').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function freshSessionsByProject() {
  const rows = getDb().prepare(`
    SELECT vault_path, title, project, created_at
    FROM vault_files WHERE note_type = 'session'
    ORDER BY created_at ASC
  `).all();
  const byProject = {};
  for (const r of rows) {
    const p = r.project || 'general';
    (byProject[p] = byProject[p] || []).push(r);
  }
  return byProject;
}

function readBody(vaultPath, relPath) {
  const raw = readFileSync(join(vaultPath, relPath), 'utf-8');
  return raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

// Retype an absorbed session note to archive in place — content is preserved,
// only the frontmatter type changes (frontmatter type wins over folder).
function archiveSessionFile(vaultPath, relPath, statePath) {
  const fp = join(vaultPath, relPath);
  const raw = readFileSync(fp, 'utf-8');
  if (!/^---\n[\s\S]*?\ntype:\s*session\b/m.test(raw.slice(0, 500))) return false;
  const updated = raw.replace(/^(---\n[\s\S]*?)type:\s*session\b/, `$1type: archive\nsuperseded_by: ${statePath}`);
  if (updated === raw) return false;
  writeFileSync(fp, updated);
  return true;
}

export async function consolidateProject(vaultPath, project, sessions, { dryRun = false } = {}) {
  const recent = sessions.slice(-MAX_SESSIONS_PER_MERGE);
  const statePath = `state/${stateSlug(project)}.md`;

  let existingState = '';
  try { existingState = readBody(vaultPath, statePath); } catch { /* first consolidation */ }

  const sessionBlocks = recent.map(s => {
    let body = '';
    try { body = readBody(vaultPath, s.vault_path).slice(0, MAX_BODY_CHARS); } catch { /* skip unreadable */ }
    return `### ${s.created_at?.slice(0, 10) || '?'} — ${s.title}\n${body}`;
  }).join('\n\n');

  const prompt = `${STATE_PROMPT}\n\n# Existing state note\n${existingState || '(none yet)'}\n\n# New session records (oldest first)\n${sessionBlocks}\n\n# End of input\nReturn ONLY the updated state note markdown now.`;

  const stdout = await runClaude(prompt, { model: STATE_MODEL, timeout: 240000 });
  const body = (JSON.parse(stdout).result || '').trim();
  if (!body) throw new Error('state merge returned empty');

  if (dryRun) return { statePath, sessions: recent.length, archived: 0, preview: body.slice(0, 300) };

  const date = new Date().toISOString().split('T')[0];
  const fm = [
    '---',
    `title: ${JSON.stringify(`Workstream state: ${project}`)}`,
    'type: state',
    `project: ${(project || 'general').toLowerCase()}`,
    `updated: "${date}"`,
    'tags: [state, workstream]',
    'status: active',
    '---',
  ].join('\n');
  mkdirSync(join(vaultPath, 'state'), { recursive: true });
  writeFileSync(join(vaultPath, statePath), `${fm}\n\n${body}\n`);

  let archived = 0;
  for (const s of sessions) {
    try { if (archiveSessionFile(vaultPath, s.vault_path, statePath)) archived++; } catch { /* leave as-is */ }
  }

  return { statePath, sessions: recent.length, archived };
}

export async function runConsolidateState({ vaultPath, project = null, dryRun = false } = {}) {
  const byProject = freshSessionsByProject();
  const targets = project ? { [project]: byProject[project] || [] } : byProject;

  const results = [];
  for (const [proj, sessions] of Object.entries(targets)) {
    if (!sessions.length) continue;
    try {
      const r = await consolidateProject(vaultPath, proj, sessions, { dryRun });
      results.push({ project: proj, ...r });
      console.log(`${proj}: ${r.sessions} sessions -> ${r.statePath}${dryRun ? ' (dry run)' : `, ${r.archived} archived`}`);
    } catch (err) {
      console.error(`${proj}: ${err.message}`);
    }
  }

  if (results.length && !dryRun) {
    const res = await indexVault(vaultPath, { embeddings: true });
    console.log(`Reindexed: ${res.indexed} changed`);
  }
  return results;
}

export async function runConsolidateStateCli(args) {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH || join(process.env.HOME, '.claude', 'kb-index');
  const projFlag = args.find(a => a.startsWith('--project='));
  await runConsolidateState({
    vaultPath,
    project: projFlag ? projFlag.split('=')[1] : null,
    dryRun: args.includes('--dry-run'),
  });
}
