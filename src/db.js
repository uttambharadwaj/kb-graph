import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { statSync } from 'fs';
import { DB_PATH } from './paths.js';
import { normalizeTagString, splitTags, canonicalTag, tagSpellings, getTagAliasMap } from './tags.js';
import { STALE_AFTER } from './jobs.js';
import {
  TIERS, DEFAULT_TIER, REF_MAX_CHARS,
  assertTier, byScoreThenTier, normalizeRef, RANK_BUCKET, resolveTier, sourceFamily, tierForSource, tierRank,
} from './tiers.js';
import { logRetrievalResults } from './retrieval.js';
import { canonicalPredicate } from './predicates.js';
import { addColumn, applyMigrations, ensureSchemaReady, hasColumn, hasIndex, hasTable } from './schema.js';

let db = null;

// better-sqlite3's own default when no `timeout` option is passed — made
// explicit so retrieval.js's fast-write path has a real value to restore,
// not a number it has to keep in sync with an implicit default by hand.
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

function getDb() {
  if (!db) {
    const opened = new Database(DB_PATH);
    opened.pragma('journal_mode = WAL');
    opened.pragma(`busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
    opened.pragma('wal_autocheckpoint = 100');  // Checkpoint every 100 pages (~400KB) to prevent WAL bloat
    try {
      // Verify only. A connection that failed verification must not become the
      // module's `db`, or a caller that swallows this error hands the next one a
      // database this code cannot read.
      ensureSchemaReady(opened, { migrations: MIGRATIONS, label: 'knowledge base', path: DB_PATH });
    } catch (err) {
      opened.close();
      throw err;
    }
    db = opened;

    // Periodic WAL checkpoint every 5 minutes to keep WAL file small
    setInterval(() => {
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch (e) {
        console.error('[KB] WAL checkpoint failed:', e.message);
      }
    }, 5 * 60 * 1000).unref();
  }
  return db;
}

// Our own model subprocesses, by the opening words of what we send them.
// Prefixes, not full text: the prompts have been edited since, and a row only
// has to be recognisable, not reproducible.
const OWN_PROMPT_PREFIXES = [
  'You are a Memory Extractor%',
  'You are the auto-debrief%',
  'You maintain the CURRENT-STATE%',
  'You are a knowledge base summarizer%',
];

// Surface names are literals rather than retrieval.js's constants: that module
// and this one are already a cycle, and this SQL is built at module load, so
// importing them throws "cannot access before initialization" whenever
// retrieval.js is the entry point.
const OWN_SUBPROCESS_SESSIONS = `
  SELECT DISTINCT session FROM retrievals
  WHERE surface = 'hint' AND session IS NOT NULL
    AND (${OWN_PROMPT_PREFIXES.map(prefix => `query LIKE '${prefix}'`).join(' OR ')})
    AND session NOT IN (
      SELECT session FROM retrievals
      WHERE surface NOT IN ('hint', 'briefing') AND session IS NOT NULL
    )
`;

export const MIGRATIONS = [{
  version: 1,
  name: 'documents, full-text index, and vault file tracking',
  applied: db => hasTable(db, 'documents') && hasTable(db, 'vault_files'),
  up: db => db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT,
      doc_type TEXT NOT NULL,
      tags TEXT DEFAULT '',
      file_path TEXT,
      file_size INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      title, content, tags,
      content='documents',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, title, content, tags)
      VALUES (new.id, new.title, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, content, tags)
      VALUES('delete', old.id, old.title, old.content, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, content, tags)
      VALUES('delete', old.id, old.title, old.content, old.tags);
      INSERT INTO documents_fts(rowid, title, content, tags)
      VALUES (new.id, new.title, new.content, new.tags);
    END;

    CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_documents_type_created_at ON documents(doc_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source);

    -- Vault file tracking for incremental indexing
    CREATE TABLE IF NOT EXISTS vault_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vault_path TEXT NOT NULL UNIQUE,
      content_hash TEXT NOT NULL,
      document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
      title TEXT,
      note_type TEXT,
      tags TEXT DEFAULT '',
      project TEXT,
      status TEXT DEFAULT 'active',
      source TEXT,
      confidence TEXT,
      summary TEXT,
      key_topics TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_vault_files_hash ON vault_files(content_hash);
    CREATE INDEX IF NOT EXISTS idx_vault_files_type ON vault_files(note_type);
    CREATE INDEX IF NOT EXISTS idx_vault_files_project ON vault_files(project);
  `),
}, {
  version: 2,
  name: 'vault file summaries',
  applied: db => hasColumn(db, 'vault_files', 'summary') && hasColumn(db, 'vault_files', 'key_topics'),
  up: db => {
    addColumn(db, 'vault_files', 'summary', 'TEXT');
    addColumn(db, 'vault_files', 'key_topics', 'TEXT');
  },
}, {
  version: 3,
  // superseded_at NULL = live and drives the recall filter; the pointer +
  // reason feed the kb_read banner. Superseded is retired, not deleted.
  name: 'document supersession lifecycle',
  applied: db => ['superseded_at', 'superseded_by', 'superseded_reason']
    .every(column => hasColumn(db, 'documents', column)),
  up: db => {
    addColumn(db, 'documents', 'superseded_at', 'DATETIME');
    addColumn(db, 'documents', 'superseded_by', 'INTEGER');
    addColumn(db, 'documents', 'superseded_reason', 'TEXT');
  },
}, {
  version: 4,
  // Epistemic tier (see src/tiers.js). NOT NULL with the floor as its default,
  // so existing rows land on the conservative reading and an untiered note —
  // the unlabelled state the tier exists to remove — cannot occur. The CHECK is
  // built from the tier tuple, not a second copy of it.
  name: 'epistemic tier on documents',
  applied: db => ['tier', 'tier_ref', 'tier_at'].every(column => hasColumn(db, 'documents', column)),
  up: db => {
    const allowed = TIERS.map(t => `'${t}'`).join(', ');
    addColumn(db, 'documents', 'tier', `TEXT NOT NULL DEFAULT '${DEFAULT_TIER}' CHECK (tier IN (${allowed}))`);
    addColumn(db, 'documents', 'tier_ref', 'TEXT');
    addColumn(db, 'documents', 'tier_at', 'DATETIME');
  },
}, {
  version: 5,
  name: 'embeddings, document links, and the temporal fact graph',
  applied: db => hasTable(db, 'embeddings') && hasTable(db, 'tag_aliases'),
  up: db => db.exec(`

    -- Embeddings for semantic search (stored as Float32Array binary blobs)
    CREATE TABLE IF NOT EXISTS embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      vault_path TEXT,
      chunk_index INTEGER DEFAULT 0,
      chunk_text TEXT,
      embedding BLOB NOT NULL,
      dimensions INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_embeddings_doc ON embeddings(document_id);
    CREATE INDEX IF NOT EXISTS idx_embeddings_vault ON embeddings(vault_path);

    -- Doc-to-doc relatedness edges (embedding neighbors at write/backfill time)
    CREATE TABLE IF NOT EXISTS doc_links (
      from_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      to_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      score REAL NOT NULL,
      kind TEXT DEFAULT 'related',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(from_id, to_id, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_doc_links_from ON doc_links(from_id);
    CREATE INDEX IF NOT EXISTS idx_doc_links_to ON doc_links(to_id);

    -- Temporal fact graph (entities + relationship triples with validity windows)
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'unknown',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      valid_from TEXT,
      valid_to TEXT,
      source TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (subject) REFERENCES entities(id),
      FOREIGN KEY (object) REFERENCES entities(id)
    );

    CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject);
    CREATE INDEX IF NOT EXISTS idx_facts_object ON facts(object);
    CREATE INDEX IF NOT EXISTS idx_facts_predicate ON facts(predicate);
    CREATE INDEX IF NOT EXISTS idx_facts_valid ON facts(valid_from, valid_to);

    -- Alias -> canonical entity id, for what spelling alone cannot fold:
    -- renames (old-name -> new-name) and synonyms. Separator and case variants
    -- need no row here — canonicalEntityId collapses those on the way in.
    CREATE TABLE IF NOT EXISTS entity_aliases (
      alias TEXT PRIMARY KEY,
      canonical TEXT NOT NULL
    );

    -- Alias -> canonical tag (see tags.js)
    CREATE TABLE IF NOT EXISTS tag_aliases (
      alias TEXT PRIMARY KEY,
      canonical TEXT NOT NULL
    );
  `),
}, {
  version: 6,
  name: 'system state, harvest watermarks, and read-path telemetry',
  applied: db => hasTable(db, 'meta') && hasTable(db, 'harvest_log') && hasTable(db, 'retrievals'),
  up: db => db.exec(`
    -- Pipeline heartbeats and other scalar system state (key/value)
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Nightly transcript-harvest watermarks (core schema so health checks
    -- can read it before the first harvest ever runs)
    CREATE TABLE IF NOT EXISTS harvest_log (
      transcript_path TEXT PRIMARY KEY,
      mtime INTEGER NOT NULL,
      harvested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      facts_added INTEGER,             -- NULL: extraction did not run. 0: it ran and found none.
      notes_added INTEGER DEFAULT 0
    );

    -- Read-path telemetry (see src/retrieval.js). doc_id NULL means a miss —
    -- a search/context query that matched nothing, which is signal, not noise.
    CREATE TABLE IF NOT EXISTS retrievals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
      surface TEXT NOT NULL,
      query TEXT,
      session TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_retrievals_doc_id ON retrievals(doc_id);
    CREATE INDEX IF NOT EXISTS idx_retrievals_surface_created ON retrievals(surface, created_at);
    CREATE INDEX IF NOT EXISTS idx_retrievals_session ON retrievals(session, surface, created_at);
  `),
}, {
  version: 7,
  name: 'write-path telemetry for kb_extract',
  applied: db => hasTable(db, 'extractions'),
  up: db => db.exec(`
    -- Write-path telemetry for kb_extract (see src/extract-meter.js) --
    -- the retrievals table's twin for the write path. One row per call --
    -- success, dry run, or failure alike -- carrying shape metrics instead
    -- of the input itself, so a reported recall bug can be correlated
    -- against its call weeks later without the original session. chunk_chars
    -- is a JSON array of per-chunk character counts; chunk_failures counts
    -- chunks that were retried and still lost their facts, which can be > 0
    -- on a call whose overall result otherwise looks like success. from_preview
    -- marks a commit that replayed a prior dry run instead of extracting fresh
    -- -- it never re-sent any chunks, so its near-zero duration_ms is expected,
    -- not an anomaly.
    CREATE TABLE IF NOT EXISTS extractions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      input_hash TEXT NOT NULL,
      input_chars INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      chunk_chars TEXT NOT NULL,
      emitted_count INTEGER NOT NULL,
      skipped_count INTEGER NOT NULL,
      chunk_failures INTEGER NOT NULL DEFAULT 0,
      dry_run INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      from_preview INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL,
      source TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_extractions_created_at ON extractions(created_at);
    CREATE INDEX IF NOT EXISTS idx_extractions_hash ON extractions(input_hash);
  `),
}, {
  version: 8,
  // Embeddings originally had no unique key, so INSERT OR REPLACE never
  // conflicted and every re-embed added a duplicate row. Dedupe (keep newest)
  // and enforce uniqueness so REPLACE works as intended.
  name: 'unique embedding per document chunk',
  applied: db => hasIndex(db, 'uq_embeddings_doc_chunk'),
  up: db => db.exec(`
    DELETE FROM embeddings WHERE id NOT IN (
      SELECT MAX(id) FROM embeddings GROUP BY document_id, chunk_index
    );
    CREATE UNIQUE INDEX uq_embeddings_doc_chunk ON embeddings(document_id, chunk_index);
  `),
}, {
  version: 9,
  // Per-term document frequency, read straight off the FTS index. A view over
  // data that already exists: no rows are stored and nothing has to be kept in
  // sync. Relevance scoring needs to know which words are distinctive.
  name: 'per-term document frequency over the full-text index',
  applied: db => hasTable(db, 'documents_fts_vocab'),
  up: db => db.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts_vocab USING fts5vocab(documents_fts, 'row');"
  ),
}, {
  version: 10,
  // The session hooks used to fire for our own model subprocesses, so the meter
  // recorded the system pushing notes at itself — 913 of 1421 rows where this
  // was measured. isBatchCall stopped the collection but could not clean up
  // behind itself, and nothing on a row says which kind it is, so every
  // aggregate mixed the two populations with no way to notice from the data.
  //
  // A session is ours iff it emitted a hint for one of our own prompts AND
  // never pulled a note. The second half is what stops a human who pastes one
  // of those prompts from losing their session: they have tools.
  //
  // Matches nothing on a fresh install. Going pending again would mean the
  // batch guard has regressed, which is worth the `kb migrate` it will demand.
  name: 'drop meter rows logged for the system talking to itself',
  applied: db => !hasTable(db, 'retrievals')
    || !db.prepare(`SELECT 1 FROM (${OWN_SUBPROCESS_SESSIONS}) LIMIT 1`).get(),
  up: db => db.exec(`DELETE FROM retrievals WHERE session IN (${OWN_SUBPROCESS_SESSIONS})`),
}, {
  version: 11,
  // Two meters for the surfaces that had none. `retrievals` answers what was
  // read and `extractions` what one tool did with its input; between them sat
  // 26 tools nobody could count calls to, and the write decision — accept or
  // refuse this note — which recorded nothing at all unless it refused.
  //
  // Neither table stores arguments. The read meter already keeps query text
  // where a query is the whole point; doing it here would make a second
  // uncontrolled copy of every note anyone has written.
  name: 'meters for the tool surface and the write decision',
  applied: db => hasTable(db, 'tool_calls') && hasTable(db, 'write_decisions'),
  up: db => db.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool TEXT NOT NULL,
      ok INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      -- Length of the reply, not the reply. The only cheap stand-in for
      -- "did this answer anything" on a tool whose result shape we don't know.
      result_chars INTEGER,
      error TEXT,
      session TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_created ON tool_calls(tool, created_at);

    CREATE TABLE IF NOT EXISTS write_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- The nearest existing note and how close it was, recorded whether or
      -- not it crossed the threshold. The refusals were always visible; it is
      -- the near misses that decide whether the threshold is in the right
      -- place, and those were the rows that did not exist.
      nearest_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
      nearest_score REAL,
      threshold REAL NOT NULL,
      refused INTEGER NOT NULL,
      -- Whether the note was later retired is the outcome label this table is
      -- collecting, and documents.superseded_at already holds it: join through
      -- doc_id rather than keeping a second copy that can disagree.
      doc_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_write_decisions_doc ON write_decisions(doc_id);
  `),
}, {
  version: 12,
  // Rows stored before the predicate vocabulary closed still carry whatever
  // spelling the extractor happened to pick that run — 13,090 distinct
  // predicates over 31k facts, 10,004 of them used exactly once. Writes fold
  // now, but a stored row does not fold itself, and until it does the next
  // mention of the same relationship lands on the canonical edge while the old
  // one sits beside it: invisible to the dedup, invisible to the retirement that
  // should have superseded it, and still reading as a true fact. That makes this
  // part of the change rather than a follow-up to it.
  //
  // Predicate spelling only. Direction is the fold-inverses migration's job
  // (`kb fold-inverses`), and doing it in both places would swap every mirrored
  // row twice.
  name: 'fold stored predicates onto the closed vocabulary',
  // The cheap half of the plan: if no distinct predicate folds, nothing folds,
  // and the merge below only ever fires on a collision a fold caused — so the
  // two agree exactly without this reading 31k rows on every connect.
  applied: db => !hasTable(db, 'facts') || predicatesNeedingFold(db).length === 0,
  preview: (db) => {
    const { rewrite, drop } = planPredicateFold(db);
    const onto = new Set(rewrite.map(r => r.predicate)).size;
    return `${rewrite.length} rows fold onto ${onto} predicates, ${drop.length} duplicate rows merge`;
  },
  up: (db) => {
    const { rewrite, drop } = planPredicateFold(db);
    const dropRow = db.prepare('DELETE FROM facts WHERE id = ?');
    const setPredicate = db.prepare('UPDATE facts SET predicate = ? WHERE id = ?');
    // Duplicates first. Nothing depends on the order — facts carries no unique
    // index on the triple — but leaving the row that is about to disappear
    // un-rewritten keeps the two lists disjoint, which is what makes the preview
    // counts add up to what runs.
    for (const id of drop) dropRow.run(id);
    for (const { id, predicate } of rewrite) setPredicate.run(predicate, id);
  },
}, {
  version: 13,
  // The tool meter (v11) covers the 26 MCP tools; nothing metered the model
  // subprocess calls underneath them -- classification, summarization, safety
  // review, harvest, state, extraction -- until one of them hung for 1800s with
  // nothing to show for it. Logged from the single site every caller funnels
  // through (runClaude in claude-cli.js), so a caller added later cannot ship
  // dark by forgetting a log line. extractions (v7) still owns the
  // extract-specific shape (chunk counts, input hash); this is the surface-wide
  // twin every caller gets for free, extract included -- see the comment at its
  // runClaudeJSON call site in extract.js for where the two rows meet.
  name: 'model call metering',
  applied: db => hasTable(db, 'model_calls'),
  up: db => db.exec(`
    CREATE TABLE IF NOT EXISTS model_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caller TEXT NOT NULL,
      model TEXT NOT NULL,
      ok INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      error TEXT,
      prompt_chars INTEGER NOT NULL,
      response_chars INTEGER,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_model_calls_caller_created ON model_calls(caller, created_at);
  `),
}, {
  version: 14,
  // Five meter tables, none ever pruned, on a shared SQLite file -- tool_calls
  // grows per call to any of 26 tools and model_calls per model subprocess
  // call, both faster than the older per-result tables. `kb meters prune`
  // (see src/meters.js) deletes rows older than an operator-chosen window, but
  // some reports (surface-report's tool demand and write-decision bands) read
  // those tables over all time, so a naive delete would silently change the
  // numbers they print. This table is where the rows about to be deleted get
  // folded first, in the same transaction as the delete, so those reports read
  // identical before and after a prune. One row per (table_name, day, dim)
  // bucket; `dim` means something different per table_name (see foldToolCalls
  // / foldWriteDecisions in src/meters.js). Two of the five tables
  // (retrievals, model_calls) have no rollup shape that preserves what reads
  // them, so prune refuses to touch them -- see PRUNE_EXCLUDED.
  name: 'meter rollups for prune coverage preservation',
  applied: db => hasTable(db, 'meter_rollups'),
  up: db => db.exec(`
    CREATE TABLE IF NOT EXISTS meter_rollups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      day TEXT NOT NULL,
      dim TEXT NOT NULL DEFAULT '',
      n INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      empty INTEGER NOT NULL DEFAULT 0,
      duration_sum INTEGER NOT NULL DEFAULT 0,
      duration_max INTEGER NOT NULL DEFAULT 0,
      refused INTEGER NOT NULL DEFAULT 0,
      no_neighbour INTEGER NOT NULL DEFAULT 0,
      later_superseded INTEGER NOT NULL DEFAULT 0
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_meter_rollups_bucket ON meter_rollups(table_name, day, dim);
  `),
}, {
  version: 15,
  // Retrieval aliases: extra tokens the hint scorer counts as a note's
  // identity alongside title and tags. Only ever written through
  // filterAliases (src/hint-relevance.js) — raw model output never lands here.
  name: 'document retrieval aliases',
  applied: db => hasColumn(db, 'documents', 'aliases'),
  up: db => addColumn(db, 'documents', 'aliases', 'TEXT'),
}, {
  version: 16,
  // Command triggers: patterns that let a note fire before a Bash tool call
  // runs. Only ever written through filterTriggers (src/trigger-relevance.js)
  // — raw model output never lands here.
  name: 'document command triggers',
  applied: db => hasColumn(db, 'documents', 'triggers'),
  up: db => addColumn(db, 'documents', 'triggers', 'TEXT'),
}, {
  version: 17,
  // event_id groups the rows one decision produced -- a hint prompt's up to
  // MAX_HINTS doc rows, a SessionStart briefing's state rows -- into the unit
  // follow-through actually measures, so a report reads it off the row
  // instead of reconstructing it from timestamp proximity in SQL. is_test is
  // computed at write time from the session id (isTestSession in
  // retrieval.js) so smoke/manual-verification sessions can be excluded by a
  // column instead of a session-string filter copied into every report query.
  // Additive only: historical rows stay event_id NULL / is_test 0, which a
  // report has to reconstruct for anyway since those rows predate the unit
  // existing at all.
  name: 'event identity and test-session flag on retrievals',
  applied: db => ['event_id', 'is_test'].every(column => hasColumn(db, 'retrievals', column)),
  up: db => {
    addColumn(db, 'retrievals', 'event_id', 'TEXT');
    addColumn(db, 'retrievals', 'is_test', 'INTEGER NOT NULL DEFAULT 0');
  },
}, {
  version: 18,
  // Migration 17 added is_test but only flags it going forward -- every row
  // logged before that landed stays is_test 0 even though it's exactly the
  // smoke/manual-verification traffic the column exists to exclude. This
  // flags those rows in place; it does not delete them, since a flagged row
  // is still a true record of a run against the KB, just not one that
  // should count toward a "did a human follow a hint" measurement.
  //
  // Envelope rows -- query LIKE '<agent-message%' / '<task-notification%',
  // 15 historical rows from before the harness-envelope guard in
  // prompt-hint.js existed -- are deliberately left untouched by this
  // migration. Those are real sessions with the wrong provenance (a subagent
  // report logged as if a human sent it), not test traffic, and is_test
  // means "exclude from measurement", not "wrong shape". The exclusion for
  // them is a report-time LIKE on query, the follow-through report's
  // contract, not a column here.
  name: 'backfill is_test on historical smoke rows',
  // Same guard shape as migration 12's dependency on `facts`: pendingMigrations
  // evaluates every migration's `applied` against the database as it is right
  // now, not after the migrations ahead of it in the list have run -- so on a
  // pre-17 fixture the is_test column this depends on doesn't exist yet, and
  // querying it would throw rather than report "nothing to do here yet".
  // applyMigrations (the sequential path `kb migrate` actually uses) re-checks
  // `applied` once it reaches this entry, by which point 17 has already run.
  applied: db => !hasTable(db, 'retrievals') || !hasColumn(db, 'retrievals', 'is_test') || testSessionBackfillCount(db) === 0,
  preview: db => `${testSessionBackfillCount(db)} rows flagged is_test`,
  up: db => db.exec(`UPDATE retrievals SET is_test = 1 WHERE ${TEST_SESSION_BACKFILL_WHERE}`),
}, {
  version: 19,
  // from_preview was added to migration 7's CREATE TABLE after that migration
  // had already run on live databases. Its `applied` checks hasTable, so those
  // databases report up to date while every extraction-log INSERT fails on the
  // missing column. Missing table = migration 7 hasn't run yet and will create
  // the column itself.
  name: 'from_preview on extractions',
  applied: db => !hasTable(db, 'extractions') || hasColumn(db, 'extractions', 'from_preview'),
  up: db => addColumn(db, 'extractions', 'from_preview', 'INTEGER NOT NULL DEFAULT 0'),
}];

// SQL's restatement of isTestSession() (src/retrieval.js) -- SQLite has no
// REGEXP by default, so the prefix match becomes LIKE. The two must change
// together: a new smoke-id convention added to one and not the other
// silently un-syncs write-time flagging from what this backfill considers
// already covered. `_` is a LIKE wildcard (matches any one character), not a
// literal underscore, so every `_`-separator clause below escapes it --
// without that, `smoke_%` also matches e.g. "smokeXfoo", which the regex
// (literal `[-_]`) does not.
const TEST_SESSION_BACKFILL_WHERE = `
  is_test = 0 AND (
    session IN ('smoke-test', 'smoke-2', 'smoke-compact-test', 'live-verify')
    OR session LIKE 'smoke-%'
    OR session LIKE 'smoke\\_%' ESCAPE '\\'
    OR session LIKE 'test-%'
    OR session LIKE 'test\\_%' ESCAPE '\\'
    OR session LIKE 'fake-%'
    OR session LIKE 'fake\\_%' ESCAPE '\\'
  )
`;

// Recomputed rather than a stored marker, same as migration 12: a row that
// still needs flagging is one the fixture-shaped test can plant, so idempotence
// falls out of the query going to zero rather than out of trusting a flag.
function testSessionBackfillCount(db) {
  return db.prepare(`SELECT COUNT(*) c FROM retrievals WHERE ${TEST_SESSION_BACKFILL_WHERE}`).get().c;
}

// The stored spellings that are not their own canonical form. One column, no
// row bodies: this runs on every connect, through pendingMigrations.
function predicatesNeedingFold(db) {
  return db.prepare('SELECT DISTINCT predicate FROM facts').pluck().all()
    .filter(p => canonicalPredicate(p) !== p);
}

/**
 * What migration 12 will do, as two disjoint lists of row ids.
 *
 * Rows that land on the same (subject, predicate, object) once folded are the
 * same fact written twice, and addFact would have refused the second — so the
 * earliest survives whole and the rest are dropped, which keeps the survivor's
 * source attached to its own date.
 *
 * Two restrictions, both in the do-no-harm direction. Only LIVE rows merge: a
 * retired row and a live one under the same triple are a state that ended and
 * came back, and collapsing them would delete history rather than a duplicate.
 * And a collision merges only where the fold caused it — two rows already
 * identical before this ran are a pre-existing duplicate that dedupeLiveFacts
 * owns, and claiming them here would put rows in `drop` that `applied` cannot
 * see, so the migration would report itself pending forever.
 */
function planPredicateFold(db) {
  // ORDER BY is load-bearing: the first row to claim a triple is the one kept,
  // so it has to be the earliest. NULL sorts first here, matching queryFact's
  // as-of test and dedupeLiveFacts. id breaks ties, because a plan that depends
  // on the order SQLite happened to return is not one you can dry-run.
  const rows = db.prepare(
    'SELECT id, subject, predicate, object, valid_to FROM facts ORDER BY valid_from, id'
  ).all();

  const rewrite = new Map();
  const liveByTriple = new Map();
  for (const row of rows) {
    const folded = canonicalPredicate(row.predicate);
    if (folded !== row.predicate) rewrite.set(row.id, folded);
    if (row.valid_to !== null) continue;
    const key = `${row.subject}\0${folded}\0${row.object}`;
    if (!liveByTriple.has(key)) liveByTriple.set(key, []);
    liveByTriple.get(key).push(row.id);
  }

  const drop = [];
  for (const ids of liveByTriple.values()) {
    if (ids.length < 2 || !ids.some(id => rewrite.has(id))) continue;
    for (const id of ids.slice(1)) {
      drop.push(id);
      rewrite.delete(id);
    }
  }

  return { rewrite: [...rewrite].map(([id, predicate]) => ({ id, predicate })), drop };
}

// Bring a database up to the schema this code needs. `kb migrate` and tests are
// the only callers — connecting verifies instead, so that no ordinary command
// can migrate a database as a side effect of reading it.
function initSchema(db) {
  return applyMigrations(db, MIGRATIONS);
}

export { initSchema, getDb };

// Every insert into documents lands here, which is what makes it the place an
// unsupported tier claim gets clamped rather than trusted.
export function insertDocument({ title, content, source, doc_type, tags, file_path, file_size, tier, tier_ref }) {
  const normTags = normalizeTagString(tags);
  const graded = resolveTier({ tier, ref: tier_ref });
  const stmt = getDb().prepare(`
    INSERT INTO documents (title, content, source, doc_type, tags, file_path, file_size, tier, tier_ref, tier_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);
  const result = stmt.run(title, content, source || null, doc_type, normTags, file_path || null, file_size || 0, graded.tier, graded.ref);
  return {
    id: result.lastInsertRowid,
    title,
    content,
    source: source || null,
    doc_type,
    tags: normTags,
    file_path: file_path || null,
    file_size: file_size || 0,
    tier: graded.tier,
    tier_ref: graded.ref,
  };
}

export function updateDocument(id, { title, tags }) {
  const stmt = getDb().prepare(`
    UPDATE documents SET title = ?, tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `);
  return stmt.run(title, normalizeTagString(tags), id);
}

export function deleteDocument(id) {
  const doc = getDb().prepare('SELECT file_path FROM documents WHERE id = ?').get(id);
  getDb().prepare('DELETE FROM documents WHERE id = ?').run(id);
  return doc ? doc.file_path : null;
}

// Common English stop words to filter from search queries
export const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
  'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than', 'too',
  'very', 'just', 'because', 'if', 'when', 'where', 'how', 'what',
  'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'i', 'me',
  'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her',
  'it', 'its', 'they', 'them', 'their', 'about', 'up',
]);

export function preferConfirmed(results) {
  return results.sort((a, b) => byScoreThenTier(a, b, r => r.rank, RANK_BUCKET, false));
}

// Metered entry point for FTS search. The logging sits below every read
// surface — MCP, REST, CLI — so a new caller cannot ship an unmetered read
// path by forgetting to add a log line; the most it can get wrong is the
// surface label. See logRetrievalResults for when to log here vs. yourself.
export function searchDocuments(query, limit = 20, { tags, includeSuperseded = false, surface = null } = {}) {
  const results = ftsSearch(query, limit, { tags, includeSuperseded });
  // One id per call, not per row: two calls landing in the same session in
  // the same second are otherwise indistinguishable to a report that has to
  // reconstruct events from (session, surface, timestamp).
  logRetrievalResults({ results, surface, query, eventId: randomUUID() });
  return results;
}

// A tag is a whole element of the comma-separated list, never a substring of
// it: `auth` must not match a note tagged `oauth`. SQLite has no split, so
// bracket both the stored list and the wanted tag with the separator and
// compare. The inner replace makes an unspaced `a,b` match the same as `a, b`.
const taggedWith = (column) =>
  `(',' || replace(lower(${column}), ', ', ',') || ',') LIKE ?`;

// One clause per requested tag, so callers AND them; the spellings of a single
// tag are ORed inside its clause.
function tagFilterFor(tags, column) {
  const wanted = splitTags(tags);
  // Before touching the alias table: unfiltered search is the common call.
  if (!wanted.length) return { clauses: [], params: [] };
  const aliasMap = getTagAliasMap(getDb());
  const clauses = [], params = [];
  for (const tag of wanted) {
    const spellings = tagSpellings(tag, aliasMap);
    clauses.push(`(${spellings.map(() => taggedWith(column)).join(' OR ')})`);
    params.push(...spellings.map(s => `%,${s},%`));
  }
  return { clauses, params };
}

// How much of a note's own identity the query terms cover, as a rank bonus.
// Tags match whole or not at all, the same rule the filter uses: sub-token
// overlap ("auth" inside "oauth") is already carried by the tags column's
// bm25 weight, and awarding it here counts a coincidence twice.
export function identityBoost(doc, terms) {
  const title = (doc.title || '').toLowerCase();
  const tags = new Set(splitTags(doc.tags));
  let boost = 0;
  for (const term of terms) {
    if (title.includes(term)) boost += 20;  // title match is very strong
    if (tags.has(term)) boost += 10;        // tag match is strong
  }
  return boost;
}

function ftsSearch(query, limit, { tags, includeSuperseded }) {
  const { clauses, params: tagParams } = tagFilterFor(tags ?? '', 'd.tags');
  const tagFilter = clauses.map(c => `AND ${c}`).join(' ');
  // Superseded notes drop out of current-state recall unless explicitly asked
  // for. No bound param — the clause is a literal, so param arrays are unchanged.
  const supersededFilter = includeSuperseded ? '' : 'AND d.superseded_at IS NULL';

  // Strip punctuation, split into terms, remove stop words
  const terms = query
    .replace(/['"]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map(t => t.toLowerCase())
    .filter(t => !STOP_WORDS.has(t) && t.length > 1);

  if (terms.length === 0) {
    // All terms were stop words — fall back to original terms
    const fallback = query.replace(/['"]/g, '').split(/\s+/).filter(Boolean);
    if (fallback.length === 0) return [];
    const sanitized = fallback.map(term => `"${term}"`).join(' OR ');
    const stmt = getDb().prepare(`
      SELECT d.id, d.title,
        snippet(documents_fts, 1, '<mark>', '</mark>', '...', 30) as snippet,
        d.doc_type, d.tags, d.tier, d.tier_ref, d.file_size, d.created_at,
        bm25(documents_fts, 10.0, 1.0, 5.0) as rank
      FROM documents_fts f
      JOIN documents d ON d.id = f.rowid
      WHERE documents_fts MATCH ?
      ${tagFilter}
      ${supersededFilter}
      ORDER BY rank
      LIMIT ?
    `);
    return preferConfirmed(stmt.all(sanitized, ...tagParams, limit));
  }

  // Build FTS5 query: AND-first for precision, OR fallback for recall
  // Title-boosted ranking via bm25() weights: title=10x, content=1x, tags=5x
  const andQuery = terms.map(term => `"${term}" *`).join(' AND ');
  const orQuery = terms.map(term => `"${term}" *`).join(' OR ');

  const stmt = getDb().prepare(`
    SELECT d.id, d.title,
      snippet(documents_fts, 1, '<mark>', '</mark>', '...', 30) as snippet,
      d.doc_type, d.tags, d.tier, d.tier_ref, d.file_size, d.created_at,
      bm25(documents_fts, 10.0, 1.0, 5.0) as rank
    FROM documents_fts f
    JOIN documents d ON d.id = f.rowid
    WHERE documents_fts MATCH ?
    ${tagFilter}
    ${supersededFilter}
    ORDER BY rank
    LIMIT ?
  `);

  // Try AND first for precision; fall back to OR if no results
  let results = stmt.all(andQuery, ...tagParams, limit);
  if (results.length === 0 && terms.length > 1) {
    results = stmt.all(orQuery, ...tagParams, limit);
  }

  // If OR gives too many low-quality results, re-rank: boost docs matching more terms
  if (terms.length > 1 && results.length > 0) {
    // rank is negative (lower = better in bm25), so subtract boost to improve ranking
    for (const r of results) r.rank = r.rank - identityBoost(r, terms);
  }

  return preferConfirmed(results);
}

export function listDocuments({ type, tag, limit = 50, offset = 0, includeSuperseded = false } = {}) {
  let sql = 'SELECT id, title, doc_type, tags, tier, tier_ref, file_size, source, created_at, updated_at FROM documents';
  const conditions = [];
  const params = [];

  if (type) {
    conditions.push('doc_type = ?');
    params.push(type);
  }
  if (tag) {
    const filter = tagFilterFor(tag, 'tags');
    conditions.push(...filter.clauses);
    params.push(...filter.params);
  }
  if (!includeSuperseded) {
    conditions.push('superseded_at IS NULL');
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return getDb().prepare(sql).all(...params);
}

// Metered for the same reason as searchDocuments. A miss logs a row with a
// NULL doc_id: a read of an id that is gone is a retrieval that failed, and
// dropping it would leave the per-surface miss rate without a denominator.
export function getDocument(id, { surface = null } = {}) {
  const doc = getDb().prepare('SELECT * FROM documents WHERE id = ?').get(id) || null;
  logRetrievalResults({ results: doc ? [doc] : [], surface });
  return doc;
}

// Mark a note superseded (retired, not deleted) or clear it (unset). Returns
// the updated row, or null if `id` is unknown. Guards self-supersession and
// dangling replacement pointers so a bad call fails loud instead of corrupting
// the chain.
export function supersedeDocument(id, { replacementId = null, reason = null, unset = false } = {}) {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM documents WHERE id = ?').get(id)) return null;

  if (unset) {
    db.prepare(
      'UPDATE documents SET superseded_at = NULL, superseded_by = NULL, superseded_reason = NULL WHERE id = ?'
    ).run(id);
    return getDocument(id);
  }

  if (replacementId != null) {
    if (replacementId === id) {
      throw new Error(`Cannot supersede document #${id} with itself`);
    }
    if (!db.prepare('SELECT 1 FROM documents WHERE id = ?').get(replacementId)) {
      throw new Error(`Replacement document #${replacementId} not found`);
    }
  }

  db.prepare(
    'UPDATE documents SET superseded_at = CURRENT_TIMESTAMP, superseded_by = ?, superseded_reason = ? WHERE id = ?'
  ).run(replacementId, reason, id);
  return getDocument(id);
}

// Read-only supersession *suggestions* from the temporal fact graph. NEVER
// writes superseded_at — a human/agent confirms each via kb_supersede. Facts
// have no document_id, so the note<->fact link is inferred by name/literal
// match; the bar is deliberately high (retired fact + stale note asserting the
// old value + a newer note asserting the new value) to prefer misses over
// false retires.
export function supersedeCandidates({ since = null, limit = 20 } = {}) {
  const db = getDb();
  const like = (s) => `%${s.replace(/([%_\\])/g, '\\$1')}%`;

  let sql = `
    SELECT f.subject, f.predicate, f.valid_to,
           s.name AS subject_name, o.name AS old_object
    FROM facts f
    JOIN entities s ON f.subject = s.id
    JOIN entities o ON f.object = o.id
    WHERE f.valid_to IS NOT NULL
  `;
  const params = [];
  if (since) { sql += ' AND f.valid_to >= ?'; params.push(since); }
  sql += ' ORDER BY f.valid_to DESC';
  const retired = db.prepare(sql).all(...params);

  const candidates = [];
  const seen = new Set();

  for (const rf of retired) {
    if (candidates.length >= limit) break;
    if (!rf.subject_name || !rf.old_object) continue;

    // The value that replaced old_object for this (subject, predicate).
    const current = db.prepare(`
      SELECT o.name AS new_object FROM facts f
      JOIN entities o ON f.object = o.id
      WHERE f.subject = ? AND f.predicate = ? AND f.valid_to IS NULL
      LIMIT 1
    `).get(rf.subject, rf.predicate);
    if (!current?.new_object) continue;

    const oldVal = rf.old_object, newVal = current.new_object, subj = rf.subject_name;
    if (oldVal.toLowerCase() === newVal.toLowerCase()) continue;
    const subjLike = like(subj);

    // Stale LIVE notes: subject in title/tags AND the old value in content.
    const stale = db.prepare(`
      SELECT id, title, created_at,
             (CASE WHEN title LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END) AS title_hit
      FROM documents
      WHERE superseded_at IS NULL
        AND (title LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')
        AND content LIKE ? ESCAPE '\\'
      ORDER BY created_at ASC
    `).all(subjLike, subjLike, subjLike, like(oldVal));

    for (const doc of stale) {
      if (candidates.length >= limit) break;
      if (seen.has(doc.id)) continue;

      // Evidence the note is genuinely behind: a NEWER live note asserts the
      // current value for the same subject.
      const replacement = db.prepare(`
        SELECT id, title FROM documents
        WHERE superseded_at IS NULL AND id != ? AND created_at > ?
          AND (title LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')
          AND content LIKE ? ESCAPE '\\'
        ORDER BY created_at DESC LIMIT 1
      `).get(doc.id, doc.created_at, subjLike, subjLike, like(newVal));
      if (!replacement) continue;

      seen.add(doc.id);
      candidates.push({
        note_id: doc.id,
        title: doc.title,
        reason: `Asserts ${subj} ${rf.predicate.replace(/_/g, ' ')} "${oldVal}", but that fact was retired ${rf.valid_to} in favor of "${newVal}" (newer note #${replacement.id} asserts it)`,
        suggested_replacement_id: replacement.id,
        score: doc.title_hit ? 0.8 : 0.5,
      });
    }
  }
  return candidates;
}

// Derive tiers for rows that predate the column, from provenance alone.
//
// Raises only. A note above its family's floor got there by a deliberate act —
// an explicit write or a kb_promote — and a re-run must not undo that, which is
// what makes this safe to run repeatedly.
export function backfillTiers({ apply = false } = {}) {
  const db = getDb();
  // The tier follows the note's OWN provenance, which for a vault note is its
  // frontmatter `source:` on vault_files. documents.source holds the indexer's
  // `vault:<path>` and says nothing about where the knowledge came from.
  const rows = db.prepare(`
    SELECT d.id, d.tier,
           CASE WHEN vf.document_id IS NULL THEN d.source ELSE vf.source END AS provenance
    FROM documents d LEFT JOIN vault_files vf ON vf.document_id = d.id
  `).all();

  const families = new Map();
  const updates = [];
  for (const row of rows) {
    const family = sourceFamily(row.provenance);
    const target = tierForSource(row.provenance);
    const seen = families.get(family) || { family, tier: target, count: 0, raised: 0 };
    seen.count++;
    if (tierRank(target) > tierRank(row.tier)) {
      seen.raised++;
      updates.push([target, row.id]);
    }
    families.set(family, seen);
  }

  if (apply && updates.length) {
    const stmt = db.prepare('UPDATE documents SET tier = ?, tier_at = CURRENT_TIMESTAMP WHERE id = ?');
    db.transaction(() => { for (const u of updates) stmt.run(...u); })();
  }

  return {
    total: rows.length,
    raised: updates.length,
    applied: apply,
    families: [...families.values()].sort((a, b) => b.count - a.count),
  };
}

export function getStats() {
  const count = getDb().prepare('SELECT COUNT(*) as count FROM documents').get().count;
  const totalSize = getDb().prepare('SELECT COALESCE(SUM(file_size), 0) as total FROM documents').get().total;
  let dbFileSize = 0;
  try {
    dbFileSize = statSync(DB_PATH).size;
  } catch {
    // DB file may not exist yet
  }
  return { count, totalSize, dbFileSize };
}

// Notes per tag, biggest first. Grouping on the stored string counts tag
// *sets* instead, and those are near-unique — so the biggest "domain" it
// reports is whichever combination happens to repeat, off by ~30x.
export function tagCounts(limit = 15) {
  const aliasMap = getTagAliasMap(getDb());
  const counts = new Map();
  for (const row of getDb().prepare("SELECT tags FROM documents WHERE tags != ''").all()) {
    for (const tag of new Set(splitTags(row.tags).map(t => canonicalTag(t, aliasMap)))) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag, count]) => ({ tag, count }));
}

export function getDocumentCount() {
  return getDb().prepare('SELECT COUNT(*) as count FROM documents').get().count;
}

// The reindex path: the vault file is the source of truth, so the tier it
// declares wins on every pass. tier_at only moves when the tier itself does —
// in an UPDATE the right-hand sides still see the pre-update row.
export function updateDocumentFull(id, { title, content, tags, doc_type, source, file_path, file_size, tier, tier_ref }) {
  const graded = resolveTier({ tier, ref: tier_ref });
  const stmt = getDb().prepare(`
    UPDATE documents SET title = ?, content = ?, tags = ?, doc_type = ?, source = ?, file_path = ?, file_size = ?,
      tier_at = CASE WHEN tier IS ? THEN tier_at ELSE CURRENT_TIMESTAMP END,
      tier = ?, tier_ref = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  return stmt.run(title, content, normalizeTagString(tags), doc_type, source, file_path, file_size, graded.tier, graded.tier, graded.ref, id);
}

// Raise a note's tier because a later session confirmed it, recording what did
// the confirming. Promotion only ever moves up: a caller asking for the tier a
// note already holds, or a lower one, is told no rather than silently ignored.
//
// Deliberately does NOT apply the unattended-source ceiling. That ceiling is
// about what a sweep may assert about its own output; a note it wrote is the
// most likely thing a later session confirms, and 36% of the store came in
// that way. What promotion still requires is the reference.
export function promoteDocumentTier(id, { tier, confirmedBy }) {
  const doc = getDocument(id);
  if (!doc) return null;

  const evidence = normalizeRef(confirmedBy);
  if (!evidence) {
    throw new Error(`A promotion must record what confirmed the note, in at most ${REF_MAX_CHARS} characters.`);
  }
  const graded = assertTier({ tier, ref: evidence });
  if (tierRank(graded.tier) <= tierRank(doc.tier)) {
    throw new Error(`#${id} is already ${doc.tier}; kb_promote only raises a tier.`);
  }

  getDb().prepare(
    'UPDATE documents SET tier = ?, tier_ref = ?, tier_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(graded.tier, graded.ref, id);
  return getDocument(id);
}

export function getVaultFile(vaultPath) {
  return getDb().prepare('SELECT * FROM vault_files WHERE vault_path = ?').get(vaultPath);
}

export function upsertVaultFile({ vault_path, content_hash, document_id, title, note_type, tags, project, status, source, confidence, summary, key_topics }) {
  const stmt = getDb().prepare(`
    INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type, tags, project, status, source, confidence, summary, key_topics, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(vault_path) DO UPDATE SET
      content_hash = excluded.content_hash,
      document_id = excluded.document_id,
      title = excluded.title,
      note_type = excluded.note_type,
      tags = excluded.tags,
      project = excluded.project,
      status = excluded.status,
      source = excluded.source,
      confidence = excluded.confidence,
      summary = excluded.summary,
      key_topics = excluded.key_topics,
      indexed_at = CURRENT_TIMESTAMP
  `);
  return stmt.run(vault_path, content_hash, document_id, title, note_type, tags || '', project, status, source, confidence, summary || null, key_topics ? JSON.stringify(key_topics) : null);
}

export function deleteVaultFile(vaultPath) {
  const vf = getDb().prepare('SELECT document_id FROM vault_files WHERE vault_path = ?').get(vaultPath);
  if (vf && vf.document_id) {
    getDb().prepare('DELETE FROM documents WHERE id = ?').run(vf.document_id);
  }
  getDb().prepare('DELETE FROM vault_files WHERE vault_path = ?').run(vaultPath);
}

export function getAllVaultPaths() {
  return getDb().prepare('SELECT vault_path, content_hash FROM vault_files').all();
}

export function setMeta(key, value) {
  getDb().prepare(
    'INSERT INTO meta (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP'
  ).run(key, String(value));
}

// One query behind every surface that decides whether to print a tier, so the
// push surfaces cannot disagree about what the store contains.
export function liveTierCounts() {
  return getDb().prepare(
    'SELECT tier, COUNT(*) AS count FROM documents WHERE superseded_at IS NULL GROUP BY tier'
  ).all();
}

export function getMeta(key) {
  return getDb().prepare('SELECT value, updated_at FROM meta WHERE key = ?').get(key) || null;
}

// A backlog is only news when it grows.
//
// The summaries warning stood at "202 notes missing summaries" for weeks. It
// was true every session, so it stopped being read — and an alarm nobody reads
// no longer works for the urgent case either. A count that has not moved since
// last session is a standing decision, not a fault; a count that has climbed is
// a job that has stopped doing its work. Only the second is worth a line.
//
// `record` is passed by the session-start surfaces alone. Read-only callers
// must leave the baseline where it is, or the comparison measures how often the
// snapshot was taken.
function backlogWarning({ key, count, floor, message, record }) {
  const seen = getMeta(key);
  const previous = seen ? Number(seen.value) : null;
  if (record) setMeta(key, count);
  // No baseline yet: adopt this one silently. A fresh install's backlog is its
  // starting condition, not a regression.
  if (previous === null || !Number.isFinite(previous)) return null;
  if (count <= floor || count <= previous) return null;
  return message(count, previous);
}

// One health snapshot for wakeup/status: derived-layer coverage plus job
// heartbeats, with a warning string per stale/failed component. The KB's
// worst historical failure mode is silent degradation — this is the alarm.
//
// `recordBacklog` marks this call as a session boundary, which is the clock the
// backlog warnings measure growth against.
export function getHealth({ recordBacklog = false } = {}) {
  const db = getDb();
  const docs = db.prepare('SELECT COUNT(*) c FROM documents').get().c;
  const embedded = db.prepare('SELECT COUNT(DISTINCT document_id) c FROM embeddings').get().c;
  const vaultFiles = db.prepare('SELECT COUNT(*) c FROM vault_files').get().c;
  const summarized = db.prepare(
    "SELECT COUNT(*) c FROM vault_files WHERE summary IS NOT NULL AND summary != ''"
  ).get().c;

  const ageHours = (row) => row ? (Date.now() - new Date(row.updated_at + 'Z').getTime()) / 3600000 : null;
  const reindex = getMeta('last_reindex');
  // A heartbeat has to record that the job ran, not what it happened to find:
  // harvest_log only grows when there was a transcript worth reading, so a
  // quiet weekend used to look identical to a broken launchd job. Fall back to
  // the log for installs whose last run predates the heartbeat.
  const harvest = getMeta('last_harvest');
  const harvestLogged = db.prepare("SELECT MAX(harvested_at) t FROM harvest_log").get()?.t || null;
  const lastHarvest = harvest?.updated_at || harvestLogged;
  const harvestAge = lastHarvest ? (Date.now() - new Date(lastHarvest + 'Z').getTime()) / 3600000 : null;
  const synthesis = getMeta('last_synthesis');

  const warnings = [];
  // Both remedies are long-running and neither is free, so each says what it
  // costs and what it touches: nobody should run an unbounded command against
  // the store that holds everything on the strength of a one-word imperative.
  const growth = [
    backlogWarning({
      key: 'backlog_embeddings', count: docs - embedded, floor: 25, record: recordBacklog,
      message: (now, was) => `docs missing embeddings grew ${was} → ${now} — 'kb vault reindex' re-embeds locally (no model API) and writes to this graph`,
    }),
    backlogWarning({
      key: 'backlog_summaries', count: vaultFiles - summarized, floor: 50, record: recordBacklog,
      message: (now, was) => `notes missing summaries grew ${was} → ${now} — 'kb summarize' rewrites note frontmatter in the vault, ~11s and one model call per note (try --limit=N --dry-run first); the graph picks it up on the next reindex`,
    }),
  ].filter(Boolean);
  warnings.push(...growth);
  // Every tolerance is one period plus slack (src/jobs.js), so a loop that
  // skips a single run is always reportable. Hand-picked numbers let the
  // harvest's grow to twice its period, which made one dead night invisible.
  const reindexAge = ageHours(reindex);
  if (reindexAge === null || reindexAge > STALE_AFTER.reindex) warnings.push(`reindex heartbeat ${reindexAge === null ? 'never recorded' : Math.round(reindexAge) + 'h old'} — check com.kb.reindex launchd job`);
  if (harvestAge === null || harvestAge > STALE_AFTER.harvest) warnings.push(`harvest ${harvestAge === null ? 'never ran' : Math.round(harvestAge) + 'h ago'} — check com.kb.harvest launchd job`);
  const synthAge = ageHours(synthesis);
  if (synthAge === null || synthAge > STALE_AFTER.synthesis) warnings.push(`synthesis ${synthAge === null ? 'never recorded' : Math.round(synthAge / 24) + 'd ago'} — check com.kb.synthesis launchd job`);

  return {
    embeddings: `${embedded}/${docs}`,
    summaries: `${summarized}/${vaultFiles}`,
    last_reindex: reindex?.updated_at || null,
    last_harvest: lastHarvest,
    last_synthesis: synthesis?.updated_at || null,
    ok: warnings.length === 0,
    warnings,
  };
}
