import { readFileSync } from 'fs';
import matter from 'gray-matter';
import { scanVault } from '../vault/indexer.js';
import { runClaudeJSON } from '../claude-cli.js';
import { replaceNoteIfUnchanged } from '../atomic-note-write.js';

const SUMMARIZE_PROMPT = `You are a knowledge base summarizer. Given a note, return ONLY valid JSON (no fencing):
{
  "summary": "1-2 sentence summary optimized for AI agent retrieval — what is this about and why would an agent need it (max 200 chars)",
  "key_topics": ["2-4 main topics/concepts"]
}

Be specific and actionable. The summary should help an AI agent decide if it needs to read the full document without actually reading it. Focus on WHAT information is available, not just the topic.`;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isValidSummary(value) {
  const validTopic = topic => typeof topic === 'string' && topic.length > 0 && topic.length <= 100;
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.summary === 'string'
    && value.summary.length > 0
    && value.summary.length <= 200
    && Array.isArray(value.key_topics)
    && value.key_topics.length >= 2
    && value.key_topics.length <= 4
    && value.key_topics.every(validTopic);
}

export function validateSummary(value) {
  if (!isValidSummary(value)) throw new Error('summarizer returned a malformed result');
  return value;
}

export async function summarizeNote(title, content, { runModel = runClaudeJSON, signal } = {}) {
  const prompt = `${SUMMARIZE_PROMPT}

Title: ${title}

${content.slice(0, 3000)}`;

  try {
    return {
      success: true,
      ...validateSummary(await runModel(prompt, {
        caller: 'summarizer',
        signal,
        validateResult: validateSummary,
      })),
    };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return { success: false, error: err.message, summary: title, key_topics: [] };
  }
}

export async function summarizeUnsummarized(vaultPath, {
  dryRun = false,
  limit = 0,
  summarize = summarizeNote,
  pause = wait,
  signal,
} = {}) {
  const allFiles = scanVault(vaultPath);
  const needsSummary = [];

  for (const filePath of allFiles) {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      if (!raw.trim()) continue;
      const { data: fm, content: body } = matter(raw);
      if (fm.summary) continue; // already has summary
      if (body.trim().length < 100) continue; // too short to summarize
      needsSummary.push({ filePath, raw, fm, body, rel: filePath.replace(vaultPath + '/', '') });
    } catch { continue; }
  }

  if (limit > 0) needsSummary.splice(limit);

  console.log(`Found ${needsSummary.length} notes without summaries`);
  const results = [];

  for (const note of needsSummary) {
    signal?.throwIfAborted();
    const title = note.fm.title || note.rel.split('/').pop().replace(/\.md$/, '');
    console.log(`Summarizing: ${note.rel}`);

    const result = await summarize(title, note.body, { signal });
    if (!result.success) {
      console.log(`  Failed: ${result.error}`);
      results.push({ path: note.rel, status: 'error' });
      await pause(2000);
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
      signal?.throwIfAborted();
      replaceNoteIfUnchanged(note.filePath, note.raw, updated);
    }

    results.push({ path: note.rel, status: dryRun ? 'dry-run' : 'summarized', summary: result.summary });
    await pause(2000);
  }

  return {
    summarized: results.filter(r => r.status === 'summarized').length,
    errors: results.filter(r => r.status === 'error').length,
    total: needsSummary.length,
    results,
  };
}
