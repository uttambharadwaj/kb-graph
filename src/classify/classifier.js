import { runClaudeJSON } from '../claude-cli.js';

const CLASSIFY_PROMPT = `You are a knowledge classifier. Given a note's content and metadata, classify it for an AI knowledge base.

Return ONLY valid JSON (no markdown fencing, no explanation) with these fields:
{
  "type": one of: "research", "idea", "workflow", "lesson", "fix", "decision", "source", "person", "company", "project",
  "tags": array of 3-8 specific, lowercase tags (e.g. ["ai-agents", "obsidian", "automation", "knowledge-management"]),
  "project": project name if relevant (e.g. "my-app", "backend", "frontend") or null,
  "summary": 1-2 sentence summary optimized for AI retrieval (max 200 chars),
  "confidence": "high", "medium", or "low",
  "key_topics": array of 2-4 main topics/concepts covered
}

Classification guidelines:
- "research": articles, papers, technical deep-dives, analysis of tools/systems
- "idea": business ideas, product concepts, feature proposals
- "workflow": processes, automation patterns, how-to guides
- "lesson": things learned, best practices, anti-patterns
- "fix": bug fixes, troubleshooting solutions
- "decision": architectural or business decisions with rationale
- "source": raw reference material, bookmarks, clippings that don't fit other types
- Tags should be specific and reusable (not one-off descriptions)
- Summary should help an AI agent decide whether to read the full note`;

export async function classifyNote(title, content, sourcePath) {
  const prompt = `${CLASSIFY_PROMPT}

---
Title: ${title}
Source path: ${sourcePath}
---

${content.slice(0, 4000)}`;

  try {
    const classification = await runClaudeJSON(prompt);
    return {
      success: true,
      ...classification,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      type: 'source',
      tags: ['unclassified'],
      summary: title,
      confidence: 'low',
      key_topics: [],
      project: null,
    };
  }
}

export async function classifyBatch(notes) {
  const results = [];
  for (const note of notes) {
    const result = await classifyNote(note.title, note.content, note.path);
    results.push({ ...note, classification: result });
  }
  return results;
}
