import { z } from 'zod';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { searchDocuments, listDocuments, getDocument, getStats, getDb, getHealth } from './db.js';
import { indexVaultFile } from './vault/indexer.js';
import { captureYouTube } from './capture/youtube.js';
import { captureWeb } from './capture/web.js';
import { captureSession, captureFix } from './capture/terminal.js';
import { hybridSearch, checkDuplicate } from './embeddings/search.js';
import { writeNote, relatedForDoc } from './write-note.js';
import { addFact, queryFact, invalidateFact, factTimeline, factStats } from './facts.js';
import { kbExtract } from './extract.js';
import { getRecentNotes, generateSynthesisPrompt } from './synthesis/weekly-review.js';
import { processNewClippings } from './classify/processor.js';
import { reviewDestructiveAction } from './safety/review.js';
import { getBusToolDefinitions } from './bus/tools.js';
import { tunnel, tagNeighbors } from './tunnels.js';
import { canonicalTag, getTagAliasMap } from './tags.js';

function getVaultPath() {
  return process.env.OBSIDIAN_VAULT_PATH || join(homedir(), '.claude', 'kb-index');
}

function formatVaultIndexResult(result) {
  const warning = result.errors?.length ? `; index warnings: ${result.errors.join('; ')}` : '';
  return `; indexed ${result.indexed} changed, ${result.skipped} unchanged${warning}`;
}

async function indexVaultForResponse(vaultPath, vaultFilePath) {
  try {
    const result = await indexVaultFile(vaultPath, vaultFilePath);
    return { ok: true, ...result, status: formatVaultIndexResult(result) };
  } catch (error) {
    return { ok: false, error: error.message, status: `; index failed: ${error.message}` };
  }
}

function embeddingCount() {
  try {
    return getDb().prepare('SELECT COUNT(*) as c FROM embeddings').get().c;
  } catch {
    return 0;
  }
}

// Dedup depends on embeddings. If it can't run, say so in the response instead
// of silently skipping — a silent skip reads as "no duplicates found".
async function dedupOrExplain(content) {
  try {
    const dup = await checkDuplicate(content, { threshold: 0.85 });
    if (dup.is_duplicate) return { duplicate: dup };
    return { note: '' };
  } catch (err) {
    return { note: ` [dedup skipped: ${err.message} — run 'kb vault reindex' to build embeddings]` };
  }
}

const ADMIN_ONLY_TOOLS = new Set([
  'kb_classify',
  'kb_extract',
  'kb_promote',
  'kb_synthesize',
  'kb_safety_check',
  'kb_capture_youtube',
  'bus_send',
  'bus_read',
]);

export function getToolDefinitions() {
  return [
    ...getBusToolDefinitions(),
    {
      name: 'kb_search',
      description: 'Search the knowledge base using full-text search. Returns ranked results with highlighted snippets.',
      schema: {
        query: z.string().describe('Full-text search query'),
        tags: z.string().optional().describe('Filter results by tag (e.g. "backend", "infra", "auth"). Matches entries whose tags contain this value.'),
        limit: z.number().optional().default(20).describe('Maximum number of results to return'),
      },
      handler: async ({ query, tags, limit }) => {
        try {
          const results = searchDocuments(query, limit, { tags });
          return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_tunnels',
      description: 'Explore cross-domain connections in the knowledge graph. With one tag: ranked neighboring domains by co-occurrence strength (lift-scored, so big generic tags do not dominate). With two tags: the bridge between them — notes tagged with both, plus entities mentioned in both domains\' notes.',
      schema: {
        from: z.string().describe('Domain tag to start from (e.g. "backend")'),
        to: z.string().optional().describe('Second domain tag; when set, returns the bridge between the two domains'),
        limit: z.number().optional().default(10).describe('Max bridge docs/entities or neighbors to return'),
      },
      handler: async ({ from, to, limit }) => {
        try {
          const db = getDb();
          // Degenerate two-tag case: if `to` collapses to `from` (case/alias),
          // tunnel(from, from) is nonsense — fall back to single-tag neighbors.
          if (to) {
            const aliasMap = getTagAliasMap(db);
            if (canonicalTag(from, aliasMap) === canonicalTag(to, aliasMap)) to = undefined;
          }
          const result = to
            ? tunnel(db, from, to, { limit })
            : { from, neighbors: tagNeighbors(db, from, { limit }) };
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_list',
      description: 'List documents in the knowledge base, optionally filtered by type or tag.',
      schema: {
        type: z.string().optional().describe('Filter by document type (e.g. text, markdown, code, pdf)'),
        tag: z.string().optional().describe('Filter by tag'),
        limit: z.number().optional().default(50).describe('Maximum number of results to return'),
      },
      handler: async ({ type, tag, limit }) => {
        try {
          const results = listDocuments({ type, tag, limit });
          return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_read',
      description: 'Read the full content of a specific document by its ID.',
      schema: {
        id: z.number().describe('Document ID'),
      },
      handler: async ({ id }) => {
        try {
          const doc = getDocument(id);
          if (!doc) {
            return { content: [{ type: 'text', text: `Error: Document with ID ${id} not found.` }], isError: true };
          }
          const related = relatedForDoc(id);
          if (related.length) doc.related = related;
          return { content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_ingest',
      description: 'Ingest a new document into the knowledge base from text content. Writes a vault file (inbox) — files are the source of truth; the DB is a derived index.',
      schema: {
        title: z.string().describe('Document title'),
        content: z.string().describe('Document text content'),
        tags: z.string().optional().describe('Comma-separated tags'),
      },
      handler: async ({ title, content, tags }) => {
        try {
          // Files-first invariant: no DB-only writes. Every historical
          // vault/DB divergence traced back to this tool bypassing the vault.
          const result = await writeNote(getVaultPath(), { title, content, type: 'capture', tags });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_write',
      description: 'Write a new note to the Obsidian vault. Use this to capture knowledge, ideas, lessons, or research that should persist across sessions. The note will be synced to all devices via Obsidian Sync.',
      schema: {
        title: z.string().describe('Note title'),
        content: z.string().describe('Markdown content (body text, no frontmatter needed)'),
        type: z.enum(['research', 'idea', 'workflow', 'lesson', 'fix', 'decision', 'session', 'capture'])
          .optional().default('capture').describe('Note type — determines vault folder destination'),
        tags: z.string().optional().describe('Comma-separated tags'),
        project: z.string().optional().describe('Project name (e.g. my-app, backend, frontend)'),
      },
      handler: async ({ title, content, type, tags, project }) => {
        try {
          const result = await writeNote(getVaultPath(), { title, content, type, tags, project });
          if (result.skipped) {
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }
          const relatedNote = result.related.length
            ? `; related: ${result.related.map(r => `#${r.id} ${r.title}`).join(' | ')}`
            : '';
          return { content: [{ type: 'text', text: `Note saved to ${result.path}${result.status}${relatedNote}` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_vault_status',
      description: 'Show vault indexing status — how many notes are indexed, by type and project.',
      schema: {},
      handler: async () => {
        try {
          const stats = getStats();
          const db = getDb();
          const byType = db.prepare(
            'SELECT note_type, COUNT(*) as count FROM vault_files GROUP BY note_type ORDER BY count DESC'
          ).all();
          const byProject = db.prepare(
            'SELECT project, COUNT(*) as count FROM vault_files WHERE project IS NOT NULL GROUP BY project ORDER BY count DESC'
          ).all();
          return { content: [{ type: 'text', text: JSON.stringify({ ...stats, byType, byProject }, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_capture_youtube',
      description: 'Capture a YouTube video transcript into the knowledge base. Creates a structured note with metadata.',
      schema: {
        title: z.string().describe('Video title'),
        url: z.string().describe('YouTube URL'),
        transcript: z.string().describe('Video transcript text'),
        channel: z.string().optional().describe('Channel name'),
        tags: z.string().optional().describe('Comma-separated tags'),
      },
      handler: async ({ title, url, transcript, channel, tags }) => {
        try {
          const vaultPath = getVaultPath();
          const result = captureYouTube({ title, url, transcript, channel, tags }, vaultPath);
          const index = await indexVaultForResponse(vaultPath, result.path);
          return { content: [{ type: 'text', text: JSON.stringify({ ...result, index }) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_capture_web',
      description: 'Capture a web article or URL into the knowledge base. Use this whenever you find useful information during research.',
      schema: {
        title: z.string().describe('Article/page title'),
        url: z.string().describe('Source URL'),
        content: z.string().describe('Article content or summary in markdown'),
        tags: z.string().optional().describe('Comma-separated tags'),
        project: z.string().optional().describe('Related project'),
      },
      handler: async ({ title, url, content, tags, project }) => {
        try {
          const dedup = await dedupOrExplain(content);
          if (dedup.duplicate) {
            return { content: [{ type: 'text', text: JSON.stringify({ skipped: true, reason: 'duplicate_detected', matches: dedup.duplicate.matches }, null, 2) }] };
          }
          const vaultPath = getVaultPath();
          const result = captureWeb({ title, url, content, tags, project }, vaultPath);
          const index = await indexVaultForResponse(vaultPath, result.path);
          return { content: [{ type: 'text', text: JSON.stringify({ ...result, index }) + dedup.note }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_capture_session',
      description: 'Record a terminal/coding session summary — what you tried, what worked, what failed, and lessons learned. IMPORTANT: Call this at the end of every significant debugging or implementation session.',
      schema: {
        goal: z.string().describe('What was the session trying to accomplish'),
        commands_failed: z.string().optional().describe('Commands that failed (markdown list)'),
        commands_worked: z.string().optional().describe('Commands that worked (markdown list)'),
        root_causes: z.string().optional().describe('Root cause analysis'),
        fixes: z.string().optional().describe('Fixes applied'),
        lessons: z.string().optional().describe('Key takeaways and lessons learned'),
        project: z.string().optional().describe('Project name'),
        machine: z.string().optional().describe('Machine/environment identifier'),
      },
      handler: async ({ goal, commands_failed, commands_worked, root_causes, fixes, lessons, project, machine }) => {
        try {
          const vaultPath = getVaultPath();
          const result = captureSession({ goal, commands_failed, commands_worked, root_causes, fixes, lessons, project, machine }, vaultPath);
          const index = await indexVaultForResponse(vaultPath, result.path);
          return { content: [{ type: 'text', text: JSON.stringify({ ...result, index }) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_capture_fix',
      description: 'Record a bug fix with symptom, cause, and resolution. Creates a searchable fix note for future reference.',
      schema: {
        title: z.string().describe('Short title for the fix'),
        symptom: z.string().optional().describe('What the symptom/error was'),
        cause: z.string().optional().describe('Root cause'),
        resolution: z.string().optional().describe('How it was fixed'),
        commands: z.string().optional().describe('Key commands used'),
        project: z.string().optional().describe('Project name'),
        stack: z.string().optional().describe('Tech stack (e.g. node, docker, postgres)'),
      },
      handler: async ({ title, symptom, cause, resolution, commands, project, stack }) => {
        try {
          const vaultPath = getVaultPath();
          const result = captureFix({ title, symptom, cause, resolution, commands, project, stack }, vaultPath);
          const index = await indexVaultForResponse(vaultPath, result.path);
          return { content: [{ type: 'text', text: JSON.stringify({ ...result, index }) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_search_smart',
      description: 'Smart search combining keyword matching and semantic similarity. Better than kb_search for conceptual queries like "how do we handle authentication" vs exact keyword matches.',
      schema: {
        query: z.string().describe('Search query — can be a question or topic'),
        limit: z.number().optional().default(10),
        project: z.string().optional().describe('Filter by project'),
        type: z.string().optional().describe('Filter by note type'),
      },
      handler: async ({ query, limit, project, type }) => {
        try {
          const results = await hybridSearch(query, { limit, project, type });
          const warning = embeddingCount() === 0
            ? "WARNING: semantic layer is empty — these results are keyword-only. Run 'kb vault reindex' to build embeddings.\n\n"
            : '';
          return { content: [{ type: 'text', text: warning + JSON.stringify(results, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_promote',
      description: 'Analyze a source/inbox note and promote it into structured knowledge. Read the note, classify it, then use kb_write to create promoted notes (research, ideas, workflows, lessons).',
      schema: {
        note_path: z.string().describe('Vault-relative path to the source note (e.g. sources/web/article.md)'),
      },
      handler: async ({ note_path }) => {
        try {
          return { content: [{ type: 'text', text: `To promote this note, read it and use kb_write to create the appropriate output notes (research, idea, workflow, lesson, decision) based on what you extract. Source note: ${note_path}` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_synthesize',
      description: 'Generate a synthesis of recent knowledge. Connects dots across sources to find themes, opportunities, and improvements.',
      schema: {
        days: z.number().optional().default(7).describe('How many days back to look'),
      },
      handler: async ({ days }) => {
        try {
          const vaultPath = getVaultPath();
          const notes = getRecentNotes(vaultPath, days);
          if (notes.length === 0) return { content: [{ type: 'text', text: 'No recent notes to synthesize.' }] };
          const prompt = generateSynthesisPrompt(notes);
          return { content: [{ type: 'text', text: prompt }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_classify',
      description: 'Auto-classify new clippings and inbox notes using AI. Reads unprocessed notes, classifies them (type, tags, project, summary), and updates their frontmatter. Run this after syncing new content.',
      schema: {
        dry_run: z.boolean().optional().default(false).describe('Preview classifications without writing changes'),
      },
      handler: async ({ dry_run }) => {
        try {
          const vaultPath = getVaultPath();
          const result = await processNewClippings(vaultPath, { dryRun: dry_run });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_context',
      description: 'Get a token-efficient briefing on a topic. Returns summaries and metadata for matching docs WITHOUT full content. Use this BEFORE kb_read to decide which docs are worth reading in full. Saves 90%+ tokens vs reading everything.',
      schema: {
        query: z.string().describe('Topic or question to get context on'),
        limit: z.number().optional().default(15).describe('Max docs to include'),
        project: z.string().optional().describe('Filter by project'),
        type: z.string().optional().describe('Filter by note type'),
      },
      handler: async ({ query, limit, project, type }) => {
        try {
          const db = getDb();
          const ftsResults = searchDocuments(query, limit);

          const briefings = ftsResults.map(r => {
            const vf = db.prepare('SELECT vault_path, note_type, tags, project, summary, key_topics FROM vault_files WHERE document_id = ?').get(r.id);
            return {
              id: r.id,
              title: r.title,
              type: vf?.note_type || r.doc_type,
              tags: vf?.tags || r.tags,
              project: vf?.project || null,
              summary: vf?.summary || r.snippet?.replace(/<\/?mark>/g, '').slice(0, 200),
              key_topics: vf?.key_topics || null,
            };
          });

          if (project || type) {
            let sql = 'SELECT vf.document_id as id, vf.title, vf.note_type, vf.tags, vf.project, vf.summary, vf.key_topics FROM vault_files vf WHERE 1=1';
            const params = [];
            if (project) { sql += ' AND vf.project = ?'; params.push(project); }
            if (type) { sql += ' AND vf.note_type = ?'; params.push(type); }
            sql += ' LIMIT ?';
            params.push(limit);
            const filtered = db.prepare(sql).all(...params);
            const seenIds = new Set(briefings.map(b => b.id));
            for (const f of filtered) {
              if (!seenIds.has(f.id)) {
                briefings.push({ id: f.id, title: f.title, type: f.note_type, tags: f.tags, project: f.project, summary: f.summary, key_topics: f.key_topics });
              }
            }
          }

          const header = `Found ${briefings.length} relevant docs. Use kb_read(id) for full content on any that look useful.`;
          return { content: [{ type: 'text', text: header + '\n\n' + JSON.stringify(briefings, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_check_duplicate',
      description: 'Check if content already exists in the knowledge base before writing. Returns similar matches above the threshold. Call this before kb_write or kb_ingest to avoid duplicates.',
      schema: {
        content: z.string().describe('Content to check for duplicates'),
        threshold: z.number().optional().default(0.85).describe('Similarity threshold 0-1 (default 0.85)'),
      },
      handler: async ({ content, threshold }) => {
        try {
          if (embeddingCount() === 0) {
            return { content: [{ type: 'text', text: "Error: cannot check duplicates — embeddings table is empty. Run 'kb vault reindex' to build it. Falling back is NOT safe: treat this as \"dedup unavailable\", not \"no duplicates\"." }], isError: true };
          }
          const result = await checkDuplicate(content, { threshold });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_wakeup',
      description: 'Get a token-efficient briefing on what the knowledge base contains. Returns entry counts by type and domain, plus the most recent entries. Use this at the start of a session instead of reading the full index.',
      schema: {},
      handler: async () => {
        try {
          const db = getDb();
          const stats = getStats();

          const byType = db.prepare(
            'SELECT note_type, COUNT(*) as count FROM vault_files WHERE note_type IS NOT NULL GROUP BY note_type ORDER BY count DESC'
          ).all();

          const byDomain = db.prepare(`
            SELECT tags, COUNT(*) as count FROM documents
            WHERE tags != '' GROUP BY tags ORDER BY count DESC LIMIT 15
          `).all();

          const recent = db.prepare(
            'SELECT title, note_type, tags, project FROM vault_files ORDER BY indexed_at DESC LIMIT 10'
          ).all();

          const factCount = db.prepare('SELECT COUNT(*) as count FROM facts WHERE valid_to IS NULL').get()?.count || 0;

          const summary = {
            total_documents: stats.count,
            current_facts: factCount,
            health: getHealth(),
            by_type: byType,
            top_domains: byDomain.slice(0, 10),
            recent_entries: recent,
            hint: 'Use kb_search(query, tags) for keyword search, kb_search_smart(query) for conceptual queries, kb_context(query) for token-efficient browsing, kb_fact_query(entity) for temporal facts.',
          };
          return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_fact_add',
      description: 'Add a temporal fact to the knowledge graph. Facts are subject-predicate-object triples with optional time validity. Use for decisions, relationships, and states that change over time. E.g. ("my-app", "uses", "postgres", valid_from="2026-03-12").',
      schema: {
        subject: z.string().describe('The entity doing/being something'),
        predicate: z.string().describe('The relationship (e.g. "uses", "depends_on", "decided", "owns")'),
        object: z.string().describe('The target entity or value'),
        valid_from: z.string().optional().describe('When this became true (YYYY-MM-DD)'),
        source: z.string().optional().describe('Where this fact came from (ticket ID, session, PR)'),
      },
      handler: async ({ subject, predicate, object, valid_from, source }) => {
        try {
          const result = addFact(subject, predicate, object, { validFrom: valid_from, source });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_extract',
      description: 'Auto-extract durable facts from a raw conversation or session transcript into the knowledge graph. The LLM pulls subject-predicate-object triples; consolidation dedupes identical facts and retires any prior fact the transcript contradicts (e.g. "beta" -> "GA"). Use at session end (e.g. from /debrief) instead of hand-writing kb_fact_add calls. Set dry_run to preview candidates without writing.',
      schema: {
        text: z.string().describe('The conversation or session transcript to extract facts from'),
        source: z.string().optional().describe('Provenance for the facts (e.g. "debrief:2026-06-24", "session:<id>")'),
        observation_date: z.string().optional().describe('When this happened (YYYY-MM-DD) — stamps valid_from / retirement dates. Defaults to today.'),
        dry_run: z.boolean().optional().default(false).describe('Return candidate facts WITHOUT writing them — review before committing.'),
      },
      handler: async ({ text, source, observation_date, dry_run }) => {
        try {
          const result = await kbExtract(text, { source, observationDate: observation_date, dryRun: dry_run });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_fact_query',
      description: 'Query the knowledge graph for an entity\'s relationships. Returns typed facts with temporal validity. Optionally filter by date to see what was true at a point in time.',
      schema: {
        entity: z.string().describe('Entity to query (e.g. "my-app", "auth-service", "browser profiles")'),
        as_of: z.string().optional().describe('Date filter — only facts valid at this date (YYYY-MM-DD)'),
        direction: z.enum(['outgoing', 'incoming', 'both']).optional().default('both').describe('outgoing (entity->?), incoming (?->entity), or both'),
      },
      handler: async ({ entity, as_of, direction }) => {
        try {
          const results = queryFact(entity, { asOf: as_of, direction });
          return { content: [{ type: 'text', text: JSON.stringify({ entity, as_of, facts: results, count: results.length }, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_fact_invalidate',
      description: 'Mark a fact as no longer true (set end date). Use when decisions are reversed, architectures change, or states expire. E.g. invalidate("my-app", "uses", "legacy-auth") after removing it.',
      schema: {
        subject: z.string().describe('Entity'),
        predicate: z.string().describe('Relationship'),
        object: z.string().describe('Target entity'),
        ended: z.string().optional().describe('When it stopped being true (YYYY-MM-DD, default: today)'),
      },
      handler: async ({ subject, predicate, object, ended }) => {
        try {
          const result = invalidateFact(subject, predicate, object, { ended });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_fact_timeline',
      description: 'Get chronological timeline of facts, optionally for one entity. Shows the story of an entity or the full knowledge graph in order.',
      schema: {
        entity: z.string().optional().describe('Entity to get timeline for (omit for full timeline)'),
      },
      handler: async ({ entity }) => {
        try {
          const results = factTimeline(entity);
          const stats = factStats();
          return { content: [{ type: 'text', text: JSON.stringify({ entity: entity || 'all', timeline: results, stats }, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_safety_check',
      description: 'Review a potentially destructive action before executing it. Searches KB for past incidents, evaluates risk, and returns a safety verdict. Use this before ANY destroy, delete, drop, or force-push operation.',
      schema: {
        action: z.string().describe('The destructive action about to be taken (e.g. "destroy vast.ai instance 12345")'),
        context: z.string().optional().describe('Additional context about why this is being done'),
      },
      handler: async ({ action, context }) => {
        try {
          const result = await reviewDestructiveAction(action, context);
          const prefix = result.safe ? 'SAFE' : 'BLOCKED';
          return { content: [{ type: 'text', text: `[${prefix}] Risk: ${result.risk_level}\n\n${JSON.stringify(result, null, 2)}` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },
  ];
}

export function getHttpToolDefinitions() {
  return getToolDefinitions().filter(tool => !ADMIN_ONLY_TOOLS.has(tool.name));
}
