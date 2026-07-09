import { readFileSync, writeFileSync } from 'fs';
import matter from 'gray-matter';
import { scanVault } from '../vault/indexer.js';
import { runClaudeJSON } from '../claude-cli.js';

const SUMMARIZE_PROMPT = `You are a knowledge base summarizer. Given a note, return ONLY valid JSON (no fencing):
{
  "summary": "1-2 sentence summary optimized for AI agent retrieval — what is this about and why would an agent need it (max 200 chars)",
  "key_topics": ["2-4 main topics/concepts"]
}

Be specific and actionable. The summary should help an AI agent decide if it needs to read the full document without actually reading it. Focus on WHAT information is available, not just the topic.`;

export async function summarizeNote(title, content) {
  const prompt = `${SUMMARIZE_PROMPT}

Title: ${title}

${content.slice(0, 3000)}`;

  try {
    return { success: true, ...(await runClaudeJSON(prompt)) };
  } catch (err) {
    return { success: false, error: err.message, summary: title, key_topics: [] };
  }
}

export async function summarizeUnsummarized(vaultPath, { dryRun = false, limit = 0 } = {}) {
  const allFiles = scanVault(vaultPath);
  const delay = (ms) => new Promise(r => setTimeout(r, ms));
  const needsSummary = [];

  for (const filePath of allFiles) {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      if (!raw.trim()) continue;
      const { data: fm, content: body } = matter(raw);
      if (fm.summary) continue; // already has summary
      if (body.trim().length < 100) continue; // too short to summarize
      needsSummary.push({ filePath, fm, body, rel: filePath.replace(vaultPath + '/', '') });
    } catch { continue; }
  }

  if (limit > 0) needsSummary.splice(limit);

  console.log(`Found ${needsSummary.length} notes without summaries`);
  const results = [];

  for (const note of needsSummary) {
    const title = note.fm.title || note.rel.split('/').pop().replace(/\.md$/, '');
    console.log(`Summarizing: ${note.rel}`);

    const result = await summarizeNote(title, note.body);
    if (!result.success) {
      console.log(`  Failed: ${result.error}`);
      results.push({ path: note.rel, status: 'error' });
      await delay(2000);
      continue;
    }

    console.log(`  → ${result.summary?.slice(0, 80)}...`);

    if (!dryRun) {
      const updatedFm = {
        ...note.fm,
        summary: result.summary,
        key_topics: result.key_topics,
      };
      const updated = matter.stringify(note.body, updatedFm);
      writeFileSync(note.filePath, updated);
    }

    results.push({ path: note.rel, status: dryRun ? 'dry-run' : 'summarized', summary: result.summary });
    await delay(2000);
  }

  return {
    summarized: results.filter(r => r.status === 'summarized').length,
    errors: results.filter(r => r.status === 'error').length,
    total: needsSummary.length,
    results,
  };
}
