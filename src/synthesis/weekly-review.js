import { getDb } from '../db.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parseVaultNote } from '../vault/parser.js';

export function getRecentNotes(vaultPath, days = 7) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const rows = getDb().prepare(`
    SELECT vault_path, title, note_type, project, tags
    FROM vault_files
    WHERE indexed_at > ? AND note_type NOT IN ('inbox', 'archive')
    ORDER BY indexed_at DESC
  `).all(cutoff);

  return rows.map(row => {
    try {
      const content = readFileSync(join(vaultPath, row.vault_path), 'utf-8');
      const parsed = parseVaultNote(content, row.vault_path);
      return { ...row, body: parsed.body.slice(0, 500) };
    } catch {
      return { ...row, body: '' };
    }
  });
}

export function generateSynthesisPrompt(notes, { tunnels = [] } = {}) {
  const byProject = {};
  const byType = {};

  for (const note of notes) {
    const proj = note.project || 'general';
    const type = note.note_type || 'other';
    (byProject[proj] = byProject[proj] || []).push(note);
    (byType[type] = byType[type] || []).push(note);
  }

  const sections = [];
  sections.push(`# Weekly Knowledge Synthesis\n`);
  sections.push(`**Period:** Last 7 days | **Notes processed:** ${notes.length}\n`);

  sections.push(`## Notes by Project`);
  for (const [proj, items] of Object.entries(byProject)) {
    sections.push(`### ${proj} (${items.length} notes)`);
    for (const item of items.slice(0, 5)) {
      sections.push(`- **${item.title}** (${item.note_type}): ${item.body.slice(0, 100)}...`);
    }
  }

  if (tunnels.length) {
    sections.push(`\n## Cross-domain tunnels (strongest)`);
    for (const t of tunnels) {
      sections.push(`- ${t.from} <-> ${t.to} (co-occur ${t.cooccur}, lift ${t.lift})`);
    }
    sections.push(`\nFlag any surprising pairs above as cross-domain themes worth examining.`);
  }

  return sections.join('\n');
}

// Near-duplicate pairs recorded by link-backfill / dedup — synthesis reviews
// them for merging instead of an auto-merge pass silently rewriting knowledge.
export function getNearDupPairs(limit = 15) {
  return getDb().prepare(`
    SELECT a.title as title_a, b.title as title_b, l.score
    FROM doc_links l
    JOIN documents a ON a.id = l.from_id
    JOIN documents b ON b.id = l.to_id
    WHERE l.kind = 'near-dup'
    ORDER BY l.score DESC LIMIT ?
  `).all(limit);
}

export function generateAnalysisRequest(nearDups = []) {
  const sections = [];
  if (nearDups.length) {
    sections.push(`\n## Candidate duplicate pairs (embedding similarity)`);
    for (const d of nearDups) {
      sections.push(`- "${d.title_a}" <-> "${d.title_b}" (${Math.round(d.score * 100) / 100})`);
    }
  }
  sections.push(`\n## Analysis Needed`);
  sections.push(`Based on the notes above, write a synthesis with these sections:`);
  sections.push(`1. **Recurring themes** — what kept coming up this week, across projects`);
  sections.push(`2. **Contradictions** — where new notes disagree with each other or with earlier assumptions; name the notes`);
  sections.push(`3. **Merge candidates** — from the duplicate pairs above (and any you notice), which should be consolidated and which are genuinely distinct`);
  sections.push(`4. **Stale knowledge** — entries this week's work likely supersedes`);
  sections.push(`5. **Gaps** — what this week's work implies we should capture or investigate next`);
  sections.push(`\nBe specific: reference note titles. Write markdown, no preamble.`);
  return sections.join('\n');
}

export function writeSynthesisNote(content, vaultPath) {
  const destDir = join(vaultPath, 'research', 'weekly');
  mkdirSync(destDir, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const filename = `${date}-weekly-synthesis.md`;

  const fm = [
    '---',
    `title: "Weekly Synthesis ${date}"`,
    `type: synthesis`,
    `created: "${date}"`,
    `updated: "${date}"`,
    `tags: [synthesis, weekly, meta]`,
    `status: active`,
    '---',
  ].join('\n');

  writeFileSync(join(destDir, filename), `${fm}\n\n${content}\n`);
  return { path: `research/weekly/${filename}` };
}
