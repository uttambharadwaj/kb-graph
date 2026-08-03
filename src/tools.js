import { z } from 'zod';
import { join } from 'path';
import { homedir } from 'os';
import { searchDocuments, listDocuments, getDocument, getStats, getDb, getHealth, liveTierCounts, supersedeDocument, supersedeCandidates, promoteDocumentTier } from './db.js';
import { indexVaultFile } from './vault/indexer.js';
import { captureYouTube } from './capture/youtube.js';
import { captureWeb } from './capture/web.js';
import { captureSession, captureFix } from './capture/terminal.js';
import { hybridSearch, checkDuplicate, DUP_THRESHOLD } from './embeddings/search.js';
import { writeNote, setNoteTier, relatedForDoc } from './write-note.js';
import { TIER, TIERS, TIER_MEANING, DEFAULT_TIER, tierBanner, tiersDiscriminate } from './tiers.js';
import { addFact, queryFact, invalidateFact, factTimeline, factStats, nearbyEntities } from './facts.js';
import { kbExtract, canonicalTriple } from './extract.js';
import { getRecentNotes, generateSynthesisPrompt, generateAnalysisRequest, getNearDupPairs } from './synthesis/weekly-review.js';
import { processNewClippings } from './classify/processor.js';
import { reviewDestructiveAction } from './safety/review.js';
import { getBusToolDefinitions } from './bus/tools.js';
import { tunnel, tagNeighbors, strongestTunnels } from './tunnels.js';
import { canonicalTag, getTagAliasMap } from './tags.js';
import { SURFACE, logRetrievalResults } from './retrieval.js';

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

// A refusal is a dead end unless it names the way forward, and the caller who
// hits one is usually trying to correct the very note that matched — which
// dedup will refuse every time, because a correction resembles what it corrects.
function duplicateRefusal(matches) {
  const id = matches?.[0]?.document_id;
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        skipped: true,
        reason: 'duplicate_detected',
        matches,
        ...(id && { remedy: `To replace #${id} rather than add a note beside it, call kb_write with supersedes: ${id}.` }),
      }, null, 2),
    }],
  };
}

// Dedup depends on embeddings. If it can't run, say so in the response instead
// of silently skipping — a silent skip reads as "no duplicates found".
async function dedupOrExplain(content) {
  try {
    const dup = await checkDuplicate(content);
    if (dup.is_duplicate) return { duplicate: dup };
    return { note: '' };
  } catch (err) {
    return { note: ` [dedup skipped: ${err.message} — run 'kb vault reindex' to build embeddings]` };
  }
}

// A hot entity (a repo, an active workstream) is where the history lives, so it
// is exactly the query that used to exceed the tool-result budget and return
// nothing at all. 25 is a readable page well inside the size cap below.
const FACT_PAGE_DEFAULT = 25;
// The binding cap: a row count is only a proxy for what actually fails, which is
// the serialized response exceeding the caller's tool-result budget and handing
// them nothing at all. Facts measure ~315 chars each on the real graph, so this
// is what decides the page size in practice.
export const FACT_RESULT_MAX_CHARS = 30000;
// Not an output bound — bytes always bind first. This only stops a caller who
// asks for 100000 from making us serialize the whole graph before shrinking it.
const FACT_PAGE_MAX = 200;
// entities.name is TEXT with no length bound and kb_extract fills it from model
// output, so one row can be arbitrarily wide. Dropping rows cannot fix that —
// the last row is undroppable — so bound the fields and the row is bounded too.
// Longest name in the live graph is 260, so this clips nothing today.
const FACT_FIELD_MAX_CHARS = 500;
// Enough near-identical ids to show the caller the shape of what is missing
// without the disclosure itself eating the page it is warning about.
const FACT_NEAR_MAX = 5;

// A truncated page has to be the useful half: what is true now, most recent
// first. Retired rows sort last so they are what a small limit drops.
function compareFactsForDisplay(a, b) {
  if (a.current !== b.current) return a.current ? -1 : 1;
  return String(b.valid_from ?? '').localeCompare(String(a.valid_from ?? ''));
}

const ADMIN_ONLY_TOOLS = new Set([
  'kb_classify',
  'kb_extract',
  'kb_promote',
  'kb_synthesize',
  'kb_safety_check',
  'kb_capture_youtube',
  'kb_supersede_candidates',
  'bus_send',
  'bus_read',
]);

export function getToolDefinitions() {
  return [
    ...getBusToolDefinitions(),
    {
      name: 'kb_search',
      description: 'Search the knowledge base using full-text search. Returns ranked results with highlighted snippets. Superseded (retired) notes are excluded unless include_superseded is set.',
      schema: {
        query: z.string().describe('Full-text search query'),
        tags: z.string().optional().describe('Filter results by tag (e.g. "backend", "infra", "auth"). Matches entries whose tags contain this value.'),
        limit: z.number().optional().default(20).describe('Maximum number of results to return'),
        include_superseded: z.boolean().optional().default(false).describe('Include notes marked superseded (retired). Off by default — use to trace how a current state was reached.'),
      },
      handler: async ({ query, tags, limit, include_superseded }) => {
        try {
          const results = searchDocuments(query, limit, {
            tags,
            includeSuperseded: include_superseded,
            surface: SURFACE.SEARCH,
          });
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
          // Two-tag mode hands back specific notes, so it meters like any
          // other surface that does. Single-tag mode returns tag names only —
          // there is no document to have been retrieved, and a miss row would
          // claim the caller asked for one.
          if (result.bridge_docs) {
            logRetrievalResults({ results: result.bridge_docs, surface: SURFACE.TUNNELS, query: `${from} -> ${to}` });
          }
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_list',
      description: 'List documents in the knowledge base, optionally filtered by type or tag. Superseded (retired) notes are excluded unless include_superseded is set.',
      schema: {
        type: z.string().optional().describe('Filter by document type (e.g. text, markdown, code, pdf)'),
        tag: z.string().optional().describe('Filter by tag'),
        limit: z.number().optional().default(50).describe('Maximum number of results to return'),
        include_superseded: z.boolean().optional().default(false).describe('Include notes marked superseded (retired). Off by default.'),
      },
      handler: async ({ type, tag, limit, include_superseded }) => {
        try {
          const results = listDocuments({ type, tag, limit, includeSuperseded: include_superseded });
          return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_read',
      description: 'Read a document in full, by ID — after kb_context or kb_search has told you which ID is worth the tokens. The response carries a `related` neighborhood, so this is also how you walk from one note to the ones it sits beside without running another search.',
      schema: {
        id: z.number().describe('Document ID'),
      },
      handler: async ({ id }) => {
        try {
          const doc = getDocument(id, { surface: SURFACE.READ });
          if (!doc) {
            return { content: [{ type: 'text', text: `Error: Document with ID ${id} not found.` }], isError: true };
          }
          const related = relatedForDoc(id);
          if (related.length) doc.related = related;
          // Banners lead, because this is the point at which a reader decides
          // whether to act on the note: what standing it has, then whether it
          // was retired. Superseded notes stay readable — this is also the
          // "how we got here" path.
          let text = `${tierBanner(doc)}\n\n${JSON.stringify(doc, null, 2)}`;
          if (doc.superseded_at) {
            const by = doc.superseded_by ? ` by #${doc.superseded_by}` : '';
            const reason = doc.superseded_reason ? `, ${doc.superseded_reason}` : '';
            text = `⚠ SUPERSEDED ${doc.superseded_at}${by}${reason}\n${text}`;
          }
          return { content: [{ type: 'text', text }] };
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
          if (result.skipped) return duplicateRefusal(result.matches);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_write',
      description: 'Write a new note to the Obsidian vault. Use this to capture knowledge, ideas, lessons, or research that should persist across sessions. The note will be synced to all devices via Obsidian Sync. Pass supersedes to retire an older note this one replaces.',
      schema: {
        title: z.string().describe('Note title'),
        content: z.string().describe('Markdown content (body text, no frontmatter needed)'),
        type: z.enum(['research', 'idea', 'workflow', 'lesson', 'fix', 'decision', 'session', 'capture'])
          .optional().default('capture').describe('Note type — determines vault folder destination'),
        tags: z.string().optional().describe('Comma-separated tags'),
        project: z.string().optional().describe('Project name (e.g. my-app, backend, frontend)'),
        supersedes: z.number().int().optional().describe('ID of an existing note this one replaces — that note is marked superseded and pointed at this one, or updated in place if the new note lands on its own file. This is also how you correct a note: without it, dedup refuses a near-duplicate, and a correction is always a near-duplicate of what it corrects.'),
        tier: z.enum(TIERS).optional().default(DEFAULT_TIER).describe(
          `How much standing this note has earned: ${TIERS.map(t => `${t} = ${TIER_MEANING[t]}`).join('; ')}. ` +
          `Defaults to ${DEFAULT_TIER}, which is what a conclusion you reasoned your way to is. ` +
          `${TIER.VERIFIED} is refused without tier_ref. Raise a note later with kb_promote.`
        ),
        tier_ref: z.string().optional().describe(`What backs the tier — a commit sha, a pull request (#42 or its URL), or a test file. Required for ${TIER.VERIFIED}.`),
      },
      handler: async ({ title, content, type, tags, project, supersedes, tier, tier_ref }) => {
        try {
          // Fail before writing if the supersede target does not exist — the
          // note could not fulfil its stated purpose otherwise. Deliberately
          // surface-less: an existence check on a write is not a retrieval.
          if (supersedes != null && !getDocument(supersedes)) {
            return { content: [{ type: 'text', text: `Error: supersedes target #${supersedes} not found.` }], isError: true };
          }
          const result = await writeNote(getVaultPath(), { title, content, type, tags, project, tier, tier_ref, excludeId: supersedes });
          if (result.skipped) return duplicateRefusal(result.matches);

          // The note is on disk and indexed from here on, so nothing below may
          // report a failure: a caller told the write failed writes it again,
          // and that duplicate is worse than bookkeeping that did not finish.
          let supersedeNote = '';
          if (supersedes != null) {
            try {
              if (result.docId === supersedes) {
                // A note's vault path is its type, the date and a slug of its
                // title, so re-writing all three lands on the target's own file
                // and reindexes into its id. The write *is* the replacement —
                // there is no older note left to retire, and marking this one
                // superseded would point it at itself.
                supersedeNote = `; updated #${supersedes} in place`;
              } else if (result.docId) {
                supersedeDocument(supersedes, { replacementId: result.docId, reason: `superseded by #${result.docId}` });
                supersedeNote = `; superseded #${supersedes} (replaced by #${result.docId})`;
              } else {
                supersedeDocument(supersedes, { reason: 'superseded by replacement note' });
                supersedeNote = `; superseded #${supersedes} (replacement id unavailable — reindex may have failed)`;
              }
            } catch (err) {
              supersedeNote = `; WARNING: the note was written, but superseding #${supersedes} failed: ${err.message}`;
            }
          }
          const relatedNote = result.related.length
            ? `; related: ${result.related.map(r => `#${r.id} ${r.title}`).join(' | ')}`
            : '';
          return { content: [{ type: 'text', text: `Note saved to ${result.path} as ${result.tier}${result.status}${relatedNote}${supersedeNote}` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_supersede',
      description: 'Mark a note as superseded (meaningfully replaced) so it drops out of search, briefings, and current-state recall while staying reachable via kb_read and its replacement pointer. Superseded is NOT deleted. Optionally record the replacement note and a reason; pass unset to restore the note. Reach for this when the replacement already exists, or when a note is simply wrong and nothing replaces it. If you are about to WRITE the replacement, use kb_write with supersedes instead — it retires the old note and points it at the new one in a single call, so the pointer is never a guess.',
      schema: {
        id: z.number().int().describe('ID of the note to supersede'),
        replacement_id: z.number().int().optional().describe('ID of the note that replaces it (records a pointer for the kb_read banner). Must already exist — do not predict the id of a note you are about to write, since ids are shared with concurrent sessions and a wrong guess usually still resolves. Use kb_write with supersedes for that.'),
        reason: z.string().optional().describe('Why it was superseded — shown in the kb_read banner'),
        unset: z.boolean().optional().default(false).describe('Clear supersession, restoring the note to current-state recall'),
      },
      handler: async ({ id, replacement_id, reason, unset }) => {
        try {
          const doc = supersedeDocument(id, { replacementId: replacement_id ?? null, reason: reason ?? null, unset });
          if (!doc) {
            return { content: [{ type: 'text', text: `Error: Document with ID ${id} not found.` }], isError: true };
          }
          // Name the replacement, don't just number it. An id is checked to
          // exist, which is not the same as being the right one — in a dense id
          // space a guessed id almost always resolves, to somebody else's note.
          // The title is what tells the caller the pointer landed where they meant.
          const replacement = doc.superseded_by ? getDocument(doc.superseded_by) : null;
          const by = replacement ? ` by #${replacement.id} "${replacement.title}"` : '';
          const state = doc.superseded_at
            ? `superseded ${doc.superseded_at}${by}${doc.superseded_reason ? ` (${doc.superseded_reason})` : ''}`
            : 'restored to current-state recall';
          return { content: [{ type: 'text', text: `#${id} "${doc.title}" ${state}` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_supersede_candidates',
      description: 'Propose notes that may be stale, from retired facts in the temporal graph. Reach for this when a briefing or a search result contradicts something you have just observed to be true, after a session that retired several facts, or as a periodic sweep of a knowledge base you have started to distrust. SUGGESTIONS ONLY — this never marks anything superseded, so it is safe to run at any time. Each candidate is a live note whose content asserts a value a later fact retired, alongside a newer note asserting the current value. Review, then confirm real ones with kb_supersede. Conservative by design (prefers misses over false retires), so an empty result is not proof the base is current.',
      schema: {
        since: z.string().optional().describe('Only consider facts retired on/after this ISO date (YYYY-MM-DD)'),
        limit: z.number().int().optional().default(20).describe('Max candidates to return'),
      },
      handler: async ({ since, limit }) => {
        try {
          const candidates = supersedeCandidates({ since: since ?? null, limit });
          const header = candidates.length
            ? `${candidates.length} supersession candidate(s). Review, then confirm real ones with kb_supersede. Nothing has been changed.`
            : 'No supersession candidates found. Nothing has been changed.';
          return { content: [{ type: 'text', text: header + '\n\n' + JSON.stringify(candidates, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_vault_status',
      description: 'Show vault indexing status — how many notes are indexed, broken down by type and project. Reach for this when a search comes back empty for something you are confident was captured: if the project or type you expected holds no notes at all, the problem is the index rather than the query, and the answer is a reindex rather than a reword.',
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
      description: 'File a YouTube transcript you already have in hand — a talk, an interview, a conference session — as a source note keyed to the video URL. Reach for this the moment a transcript arrives in the conversation and is long enough that you would not want to fetch it twice. It does not fetch the video: pass the transcript text.',
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
      description: 'File a page you fetched as a source note under sources/web, with its URL recorded. Reach for this as soon as a fetch returns something you will want to cite or re-read, before it scrolls out of context. Prefer it over kb_write for material you did not write: the URL is kept in frontmatter, so a later reader can check the claim against the original rather than take the note\'s word for it. kb_write is for your own conclusions.',
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
            return duplicateRefusal(dedup.duplicate.matches);
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
      description: 'Record a terminal/coding session summary — what you tried, what worked, what failed, and lessons learned. IMPORTANT: Call this at the end of every significant debugging or implementation session. Prefer it over kb_write whenever you are pasting terminal output: command text, logs and error dumps go through secret redaction here (API keys, tokens, JWTs, connection strings), and kb_write has no such pass.',
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
      description: 'Record a bug fix once you have verified it fixed — the symptom you were chasing, the cause you found, the change that resolved it. Reach for this over kb_write for anything you debugged: symptom and cause are separate fields, which is what lets a later session search the symptom and land on the cause, and pasted commands and logs go through secret redaction that kb_write does not perform.',
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
          const results = await hybridSearch(query, { limit, project, type, surface: SURFACE.SEARCH_SMART });
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
      description: `Raise a note's tier because this session confirmed it, recording what did the confirming. This is the only way a note leaves ${DEFAULT_TIER}: ${TIERS.map(t => `${t} = ${TIER_MEANING[t]}`).join('; ')}. Promotions only go up, and ${TIER.VERIFIED} is refused unless confirmed_by names a commit, a pull request or a test. The note's own file is rewritten too, so the tier survives the next reindex.`,
      schema: {
        id: z.number().int().describe('ID of the note to promote'),
        tier: z.enum(TIERS).describe('The tier the note has now earned — must be higher than its current one'),
        confirmed_by: z.string().describe(`What confirmed it: a commit sha, a pull request (#42 or its URL) or a test file for ${TIER.VERIFIED}; a short description of what you watched happen for ${TIER.OBSERVED}.`),
      },
      handler: async ({ id, tier, confirmed_by }) => {
        try {
          const doc = promoteDocumentTier(id, { tier, confirmedBy: confirmed_by });
          if (!doc) return { content: [{ type: 'text', text: `Error: Document with ID ${id} not found.` }], isError: true };

          // The note's own file has to say so too, or the next reindex reads
          // the old frontmatter back over the row. Failing here leaves the
          // promotion to be undone by that reindex — the safe direction.
          const vf = getDb().prepare('SELECT vault_path FROM vault_files WHERE document_id = ?').get(id);
          if (!vf) {
            return { content: [{ type: 'text', text: `#${id} "${doc.title}" promoted to ${tierBanner(doc)}\n(no vault file for this note — recorded in the index only)` }] };
          }
          setNoteTier(getVaultPath(), vf.vault_path, { tier: doc.tier, ref: doc.tier_ref });
          const index = await indexVaultForResponse(getVaultPath(), vf.vault_path);
          return { content: [{ type: 'text', text: `#${id} "${doc.title}" promoted to ${tierBanner(doc)}\n${vf.vault_path}${index.status}` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_synthesize',
      description: 'Assemble a review brief over the last N days of notes: grouped by project, with the strongest cross-domain tunnels, the near-duplicate pairs, and the questions to answer against them (recurring themes, contradictions, merge candidates, stale entries, gaps). Reach for this at a week boundary, before planning a next block of work, or whenever the question is "what have we learned lately" across projects rather than a lookup of one thing — kb_search is for the lookup. It returns the brief for YOU to answer, not a finished synthesis: read it, write the answer, save that with kb_write (type: research).',
      schema: {
        days: z.number().optional().default(7).describe('How many days back to look'),
      },
      handler: async ({ days }) => {
        try {
          const vaultPath = getVaultPath();
          const notes = getRecentNotes(vaultPath, days);
          if (notes.length === 0) return { content: [{ type: 'text', text: 'No recent notes to synthesize.' }] };
          // The same brief the weekly job composes. Without the analysis half a
          // caller gets a list of notes and no statement of what to do with it,
          // which is indistinguishable from a tool that did nothing useful.
          // Both enrichments degrade the same way: an empty section reads as
          // "nothing to report", so losing one must not cost the whole brief,
          // and a silent loss must still be visible in the server log.
          const optional = (what, fn) => {
            try {
              return fn();
            } catch (err) {
              console.error(`kb_synthesize: omitting ${what} (${err.message})`);
              return [];
            }
          };
          const tunnels = optional('cross-domain tunnels', () => strongestTunnels(getDb(), { limit: 10 }));
          const nearDups = optional('near-duplicate pairs', () => getNearDupPairs());
          const prompt = generateSynthesisPrompt(notes, { tunnels }) + generateAnalysisRequest(nearDups);
          return { content: [{ type: 'text', text: prompt }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_classify',
      description: 'Type, tag and summarise the notes sitting in the intake folders (inbox/ and Clippings/) without a classification yet — what a web clipper, a vault sync, or a kb_ingest/kb_write capture left there. Reach for this when a search turns up notes with no type or no tags: an unclassified note has no summary, so kb_context has nothing to show for it and it ranks poorly. It reads only those two folders, so notes filed elsewhere (sources/, builds/) are out of its reach. Safe to call speculatively — it reports "No new clippings to classify" and touches nothing when the intake folders are clean. Pass dry_run to see the classifications before they are written.',
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
              tier: r.tier,
              tags: vf?.tags || r.tags,
              project: vf?.project || null,
              summary: vf?.summary || r.snippet?.replace(/<\/?mark>/g, '').slice(0, 200),
              key_topics: vf?.key_topics || null,
            };
          });

          if (project || type) {
            let sql = 'SELECT vf.document_id as id, vf.title, vf.note_type, d.tier, vf.tags, vf.project, vf.summary, vf.key_topics FROM vault_files vf JOIN documents d ON d.id = vf.document_id WHERE 1=1';
            const params = [];
            if (project) { sql += ' AND vf.project = ?'; params.push(project); }
            if (type) { sql += ' AND vf.note_type = ?'; params.push(type); }
            sql += ' LIMIT ?';
            params.push(limit);
            const filtered = db.prepare(sql).all(...params);
            const seenIds = new Set(briefings.map(b => b.id));
            for (const f of filtered) {
              if (!seenIds.has(f.id)) {
                briefings.push({ id: f.id, title: f.title, type: f.note_type, tier: f.tier, tags: f.tags, project: f.project, summary: f.summary, key_topics: f.key_topics });
              }
            }
          }

          // Logged here rather than by threading a surface into the search:
          // the project/type pass appends docs the search never returned, and
          // the briefing set is what the caller actually gets.
          logRetrievalResults({ results: briefings, surface: SURFACE.CONTEXT, query });

          const header = `Found ${briefings.length} relevant docs. Use kb_read(id) for full content on any that look useful. tier "${DEFAULT_TIER}" means ${TIER_MEANING[DEFAULT_TIER]}.`;
          return { content: [{ type: 'text', text: header + '\n\n' + JSON.stringify(briefings, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_check_duplicate',
      description: `Check whether content already exists in the knowledge base, using the same comparison kb_write will make. Pass the exact note body you are about to write: the write path embeds that body, so a summary or a title scores against different text and predicts nothing. Leave threshold unset to get the write's own verdict — a lower threshold reports notes kb_write will accept as merely related, and a higher one hides notes it will reject as duplicates.`,
      schema: {
        content: z.string().describe('The exact note body that will be passed to kb_write'),
        threshold: z.number().optional().default(DUP_THRESHOLD).describe(`Similarity threshold 0-1. Defaults to ${DUP_THRESHOLD}, the value kb_write uses; change it only to explore, not to pre-check a write.`),
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

          // Parity with the wakeup-hook briefing: superseded notes drop out of
          // "recent". LEFT JOIN keeps vault files with no linked document.
          const recent = db.prepare(
            'SELECT vf.title, vf.note_type, vf.tags, vf.project, d.tier FROM vault_files vf LEFT JOIN documents d ON d.id = vf.document_id WHERE d.superseded_at IS NULL ORDER BY vf.indexed_at DESC LIMIT 10'
          ).all();

          const byTier = liveTierCounts();
          // Gated identically to the wakeup-hook briefing this mirrors.
          const showTier = tiersDiscriminate(byTier);

          const factCount = db.prepare('SELECT COUNT(*) as count FROM facts WHERE valid_to IS NULL').get()?.count || 0;

          const summary = {
            total_documents: stats.count,
            current_facts: factCount,
            health: getHealth({ recordBacklog: true }),
            by_type: byType,
            ...(showTier ? { by_tier: byTier, tier_meaning: TIER_MEANING } : {}),
            top_domains: byDomain.slice(0, 10),
            recent_entries: showTier ? recent : recent.map(({ tier, ...rest }) => rest),
            hint: `Use kb_search(query, tags) for keyword search, kb_search_smart(query) for conceptual queries, kb_context(query) for token-efficient browsing, kb_fact_query(entity) for temporal facts.${showTier ? ` A ${DEFAULT_TIER} note is a lead, not a finding — kb_promote one when a session confirms it.` : ''}`,
          };
          return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_fact_add',
      description: 'Add a temporal fact to the knowledge graph. Facts are subject-predicate-object triples with optional time validity. Use for decisions, relationships, and states that change over time. E.g. ("my-app", "uses", "postgres", valid_from="2026-03-12"). The triple is canonicalized before it is written, the same way kb_extract canonicalizes, so a synonym, an inflection or a mirrored direction lands on the edge the graph already uses — ("tkt-99", "fixed_in", "pr #48") is stored as ("pr #48", "fixes", "tkt-99"). The response reports the triple as stored; pass that spelling to kb_fact_invalidate, which canonicalizes the same way.',
      schema: {
        subject: z.string().describe('The entity doing/being something'),
        predicate: z.string().describe('The relationship (e.g. "uses", "depends_on", "decided", "owns")'),
        object: z.string().describe('The target entity or value'),
        valid_from: z.string().optional().describe('When this became true (YYYY-MM-DD)'),
        source: z.string().optional().describe('Where this fact came from (ticket ID, session, PR)'),
      },
      // Through canonicalTriple, as kb_extract's writes are. Both tools write the
      // same table, so a hand-written fixed_in beside an extracted fixes is two
      // live rows for one relationship that no query joins and no retirement can
      // supersede — and it re-opens that gap after every migration closes it.
      // The response reports the triple as stored, not as asked for.
      handler: async ({ subject, predicate, object, valid_from, source }) => {
        try {
          const t = canonicalTriple({ subject, predicate, object });
          const result = addFact(t.subject, t.predicate, t.object, { validFrom: valid_from, source });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_extract',
      description: 'Auto-extract durable facts from a raw conversation or session transcript into the knowledge graph. The LLM pulls subject-predicate-object triples; consolidation dedupes identical facts and retires a contradicted one only where the predicate is single-valued AND the subject names one state-bearing thing — a ticket or issue id (tkt-4821 status "in_review" -> "done"). A repo, project or person accumulates instead, so "knowledge-base-server status X" never retires "status Y"; retire those by hand with kb_fact_invalidate. Cumulative predicates (owns, chose, shipped_via) always keep both. Where one call asserts two objects for the same single-valued pair, nothing is retired — the call gives no order for them — and the pair comes back in "conflicts" for you to resolve. Assertions the extractor chose not to record come back in "skipped" with a reason. Input past 12,000 characters is not examined and comes back there too, as "input_truncated" with the count — call again with the remainder if it matters. Use at session end (e.g. from /debrief) instead of hand-writing kb_fact_add calls. Set dry_run to preview candidates without writing.',
      schema: {
        text: z.string().describe('The conversation or session transcript to extract facts from'),
        source: z.string().optional().describe('Provenance for the facts (e.g. "debrief:2026-06-24", "session:<id>")'),
        observation_date: z.string().optional().describe('When this happened (YYYY-MM-DD) — stamps valid_from / retirement dates. Defaults to today. An observation older than a fact already held will not overwrite it; it comes back in "skipped" as stale_observation.'),
        observed_at: z.string().optional().describe('The instant this happened, UTC, as "YYYY-MM-DD HH:MM:SS" (an ISO 8601 string is accepted and converted). For replaying text from earlier the same day — observation_date alone cannot order two observations within one day. Defaults to now.'),
        dry_run: z.boolean().optional().default(false).describe('Return candidate facts WITHOUT writing them — review before committing.'),
      },
      handler: async ({ text, source, observation_date, observed_at, dry_run }) => {
        try {
          const result = await kbExtract(text, { source, observationDate: observation_date, observedAt: observed_at, dryRun: dry_run });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_fact_query',
      description: 'Query the knowledge graph for an entity\'s relationships. Returns typed facts with temporal validity. Optionally filter by date to see what was true at a point in time. The entity name is canonicalized before lookup — case and separators (space, hyphen, underscore, dot, slash) are interchangeable, so "auth service" and "auth-service" are one node. Spellings a separator fold cannot reach come back in "other_spellings" with their fact counts: the answer is partial whenever that field is present, and those ids have to be queried separately or merged with "kb entity-merge".',
      schema: {
        entity: z.string().describe('Entity to query (e.g. "my-app", "auth-service", "browser profiles")'),
        as_of: z.string().optional().describe('Date filter — only facts valid at this date (YYYY-MM-DD)'),
        direction: z.enum(['outgoing', 'incoming', 'both']).optional().default('both').describe('outgoing (entity->?), incoming (?->entity), or both'),
        limit: z.number().int().positive().optional().default(FACT_PAGE_DEFAULT)
          .describe(`Max facts to return (default ${FACT_PAGE_DEFAULT}). Fewer may come back: the page is trimmed to fit a response-size cap, so a large limit does not guarantee that many rows. Current facts come first, then most recent.`),
      },
      handler: async ({ entity, as_of, direction, limit }) => {
        try {
          // The cap lives here, not in queryFact: consolidation in extract.js
          // calls that too, and a truncated view there would silently miss a
          // held fact and write a duplicate instead of matching it.
          const all = queryFact(entity, { asOf: as_of, direction }).sort(compareFactsForDisplay);
          // Canonicalisation folds separator and case variants, but not every
          // spelling of one concept is a separator apart. What is left is a
          // complete-looking answer holding a fraction of what is stored, which
          // the caller cannot tell from a whole one — so name the rest.
          const near = nearbyEntities(entity);
          // Default here as well as in the schema: a non-numeric limit would make
          // slice() return an empty page, and "no facts" is indistinguishable
          // from "this entity has none" to whoever asked.
          const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, FACT_PAGE_MAX) : FACT_PAGE_DEFAULT;

          let clipped = 0;
          const clip = (v) => {
            if (typeof v !== 'string' || v.length <= FACT_FIELD_MAX_CHARS) return v;
            clipped += 1;
            return `${v.slice(0, FACT_FIELD_MAX_CHARS)}… [clipped ${v.length - FACT_FIELD_MAX_CHARS} chars]`;
          };

          const render = (facts) => {
            clipped = 0;
            facts = facts.map(f => ({
              ...f, subject: clip(f.subject), object: clip(f.object), source: clip(f.source),
            }));
            const body = { entity, as_of, facts, count: facts.length, total: all.length };
            if (clipped) body.clipped = `${clipped} field(s) exceeded ${FACT_FIELD_MAX_CHARS} chars and were shortened`;
            if (near.length) {
              const shownNear = near.slice(0, FACT_NEAR_MAX).map(n => `${n.id} (${n.facts})`).join(', ');
              const rest = near.length > FACT_NEAR_MAX ? `, and ${near.length - FACT_NEAR_MAX} more` : '';
              const missing = near.reduce((sum, e) => sum + e.facts, 0);
              body.other_spellings = `${missing} fact(s) sit under ${near.length} near-identical id(s) and are NOT in this answer: ${shownNear}${rest} — query one by name, or fold it in with "kb entity-merge <from> <to>"`;
            }
            // Never let a truncated page read as the whole story.
            if (facts.length < all.length) {
              body.truncated = `showing ${facts.length} of ${all.length} — narrow with as_of/direction, or raise limit (max ${FACT_PAGE_MAX}, subject to a response-size cap)`;
            }
            return JSON.stringify(body, null, 2);
          };

          let shown = all.slice(0, n);
          let text = render(shown);
          // Shrink until the response fits. Dropping rows keeps the caller's
          // best facts (current, most recent) rather than handing back nothing.
          while (shown.length > 1 && text.length > FACT_RESULT_MAX_CHARS) {
            shown = shown.slice(0, Math.max(1, Math.floor(shown.length * 0.8)));
            text = render(shown);
          }
          return { content: [{ type: 'text', text }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_fact_invalidate',
      description: 'Mark a fact as no longer true (set end date). Use when decisions are reversed, architectures change, or states expire. E.g. invalidate("my-app", "uses", "legacy-auth") after removing it. Refuses with "refused": "ended_before_valid_from" if the end date precedes the fact\'s valid_from — an interval cannot end before it begins.',
      schema: {
        subject: z.string().describe('Entity'),
        predicate: z.string().describe('Relationship'),
        object: z.string().describe('Target entity'),
        ended: z.string().optional().describe('When it stopped being true (YYYY-MM-DD, default: today)'),
      },
      // Canonicalised with kb_fact_add, or the spelling that named a row on the
      // way in could not name it again on the way out.
      handler: async ({ subject, predicate, object, ended }) => {
        try {
          const t = canonicalTriple({ subject, predicate, object });
          const result = invalidateFact(t.subject, t.predicate, t.object, { ended });
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
