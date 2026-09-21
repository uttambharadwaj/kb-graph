import { runClaudeJSON } from '../claude-cli.js';
import { TRIGGER_PROPOSAL_RULES } from '../trigger-proposal-rules.js';

const CLASSIFY_PROMPT = `You are a knowledge classifier. Given a note's content and metadata, classify it for an AI knowledge base.

Return ONLY valid JSON (no markdown fencing, no explanation) with these fields:
{
  "type": one of: "research", "idea", "workflow", "lesson", "fix", "decision", "source", "person", "company", "project",
  "tags": array of 3-8 specific, lowercase tags (e.g. ["ai-agents", "obsidian", "automation", "knowledge-management"]),
  "project": project name if relevant (e.g. "my-app", "backend", "frontend") or null,
  "summary": 1-2 sentence summary optimized for AI retrieval (max 200 chars),
  "confidence": "high", "medium", or "low",
  "key_topics": array of 2-4 main topics/concepts covered,
  "aliases": array of 0-6 retrieval aliases — the words a person's QUESTION would use when this note is the answer. Imagine the questions the note answers; each alias is the subject of one, phrased as the question would say it, usually a one-to-three-word phrase ("harvest job", "vault indexer"). Every alias must be a word or phrase the note's own text uses (never invent a synonym the note does not contain). Prefer the plain name a person would say over a code identifier. Duplication against the title is fine; a filter removes what the title already covers.
  "triggers": array of command patterns this note warns about running. ${TRIGGER_PROPOSAL_RULES}
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

const NOTE_TYPES = new Set(['research', 'idea', 'workflow', 'lesson', 'fix', 'decision', 'source', 'person', 'company', 'project']);
const CONFIDENCE_LEVELS = new Set(['high', 'medium', 'low']);

function isValidClassification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  const validString = (item, max) => typeof item === 'string' && item.length > 0 && item.length <= max;
  const validStrings = (items, min, max, itemMax = 100) =>
    Array.isArray(items)
    && items.length >= min
    && items.length <= max
    && items.every(item => validString(item, itemMax));
  const validProject = value.project === null
    || value.project === undefined
    || validString(value.project, 100);
  const validAliases = value.aliases === undefined || validStrings(value.aliases, 0, 6);
  const validTriggers = value.triggers === undefined || validStrings(value.triggers, 0, 3, 200);

  return NOTE_TYPES.has(value.type)
    && validStrings(value.tags, 3, 8)
    && validString(value.summary, 200)
    && CONFIDENCE_LEVELS.has(value.confidence)
    && validStrings(value.key_topics, 2, 4)
    && validProject
    && validAliases
    && validTriggers;
}

export function validateClassification(value) {
  if (!isValidClassification(value)) throw new Error('classifier returned a malformed result');
  return value;
}

export async function classifyNote(title, content, sourcePath, { runModel = runClaudeJSON, signal } = {}) {
  const prompt = `${CLASSIFY_PROMPT}

---
Title: ${title}
Source path: ${sourcePath}
---

${content.slice(0, 4000)}`;

  try {
    const classification = validateClassification(await runModel(prompt, {
      caller: 'classifier',
      signal,
      validateResult: validateClassification,
    }));
    return {
      success: true,
      ...classification,
    };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return {
      success: false,
      error: err.message,
      type: 'source',
      tags: ['unclassified'],
      summary: title,
      confidence: 'low',
      key_topics: [],
      aliases: [],
      triggers: [],
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
