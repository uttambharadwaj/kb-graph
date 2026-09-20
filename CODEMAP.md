# Codebase Map
> Auto-generated. Do NOT edit manually. Regenerate with: `node bin/generate-codemap.js`
> Generated: 2026-09-20

## Quick Stats
- **Files:** 248
- **Total lines:** 49,627

## Architecture Overview
```
src/
  mcp.js          ← MCP server (26 tools: search, write, capture, classify, safety)
  db.js            ← SQLite + FTS5 (documents, vault_files, embeddings tables)
  tiers.js         ← Epistemic tiers: the vocabulary, the verified-needs-a-reference rule, surface formatting
  server.js        ← Express dashboard server
  vault/           ← Obsidian vault indexer + parser
  capture/         ← YouTube, web, X bookmarks, terminal session capture
  classify/        ← AI auto-classification + summarization (uses claude CLI)
  embeddings/      ← Local embeddings (HuggingFace) + hybrid search
  promotion/       ← Knowledge promotion pipeline (prompts + promoter)
  synthesis/       ← Weekly review / cross-source synthesis
  safety/          ← Destructive action review (KB-aware)
  sync/            ← KB ↔ vault bidirectional sync
bin/
  kb.js            ← CLI entry point (start, search, classify, summarize, etc.)
  cron-capture.sh  ← Daily automated capture + classify
  post-sync.sh     ← Post-sync reindex trigger
```

## Root/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| kb-server-install.sh | 72 | - | !/bin/bash |

## bin/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| cron-capture.sh | 30 | - | !/bin/bash |
| generate-codemap.js | 170 | - | Generates a token-efficient codebase map for AI agents |
| init-vault.sh | 36 | - | !/bin/bash |
| kb-trigger-hook.js | 40 | - | bin/kb-trigger-hook.js — the installed PreToolUse (Bash) hook entry point. |
| kb.js | 326 | - | bin/kb.js — CLI entry point. |
| post-sync.sh | 31 | - | !/bin/bash |
| weekly-synthesis.js | 57 | - | Weekly synthesis job — run via launchd or manually. |
| weekly-synthesis.sh | 9 | - | !/bin/bash |

## scripts/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| test-preflight.mjs | 61 | - | - |

## src/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| auth-oauth.js | 25 | auth | src/auth-oauth.js — Better Auth OAuth provider for MCP clients |
| auth.js | 151 | hasPassword, setPassword, checkPassword, promptPassword, createSession... | - |
| child-exit.js | 40 | onChildDone | When a spawned child is finished, for callers that need its output. |
| claude-cli.js | 129 | modelEnv, isBatchCall, CLAUDE_CALL_TIMEOUT_MS, runClaude, runClaudeJSON | Shared "run the local claude CLI in print mode, get JSON back" helper. |
| context-packet.js | 465 | buildContextPacket | These are useful words in a question but not a useful entity match on their |
| daemon-client.js | 82 | connectDaemonClient | Client side of the daemon socket. The SDK's stdio client transport spawns |
| daemon-hook-ops.js | 37 | HOOK_OPS | Maps control-socket op names to the same compute cores the CLI hooks fall |
| daemon-paths.js | 26 | DAEMON_SOCKET_PATH, CONTROL_SOCKET_PATH, HOOK_OP | Socket path constants, split out of daemon.js so they can be imported by |
| daemon.js | 396 | probeSocketDetailed, probeSocket, startDaemon | The resident KB service: one process, one unix socket, one MCP connection |
| db.js | 1568 | DEFAULT_BUSY_TIMEOUT_MS, MIGRATIONS, insertDocument, updateDocument, deleteDocument... | better-sqlite3's own default when no `timeout` option is passed — made |
| doc-version.js | 24 | snapshotDocumentVersion | Stable per-retrieval content identity. Prefer the vault index hash because it |
| extract-meter.js | 93 | hashInput, logExtraction, EXTRACTION_SUMMARY_WINDOW_MS, summarizeExtractions, formatExtractionSummary | Write-path telemetry for kb_extract: the read path has retrieval.js as its |
| extract.js | 884 | EXTRACT_PROMPT, MAX_EXTRACT_CHARS, buildExtractPrompt, chunkForExtract, EXTRACT_CALL_BUDGET_MS... | Auto-capture: turn a raw work conversation / session transcript into durable |
| fact-reviews.js | 457 | FACT_REVIEW_POLICY, FACT_REVIEW_DISPOSITIONS, FactReviewError, reviewSubjectId, normalizeReviewItems... | Tool reads start with display-shaped facts, not database rows with ids. Load |
| facts.js | 338 | sqlTimestamp, canonicalEntityId, entityKey, nearbyEntities, dedupeLiveFacts... | created_at defaults to SQLite's CURRENT_TIMESTAMP, which is UTC |
| fallback-tool-meter.js | 67 | FALLBACK_TOOL_LOG, FALLBACK_TOOL_WINDOW_MS, recordFallbackTool, summarizeFallbackTools, formatFallbackToolSummary | The direct CLI exists only as a recovery path when an agent's MCP transport |
| grounding.js | 334 | normalizeForGrounding, UNGROUNDED_REASON_PREFIX, CLAIM_UNGROUNDED_REASON_PREFIX, DATE_OVERRIDE_REASON_PREFIX, isIsoDate... | Grounding: the extractor asserts things its source text never states — |
| harvest.js | 688 | MAX_SESSIONS_PER_RUN, factsRequested, LESSONS_PROMPT, buildLessonsPrompt, isPrintModeTranscript... | Nightly auto-debrief: sweep agent session transcripts (Claude Code, Cursor, |
| hint-relevance.js | 290 | tokenize, filterAliases, relevantNotes | Which notes, if any, is a whole user prompt actually about? |
| ingest.js | 195 | getMarkdownIngestMetadata, normalizeIngestOptions, ingestFile, ingestDirectory, ingestText | Ingested documents have no vault file, so the reindex job — which walks the |
| jobs.js | 31 | JOBS, staleAfterHours, STALE_AFTER | The scheduled loops, and how long each may go quiet before that is news. |
| mcp-factory.js | 53 | createKbServer, createHttpKbServer | The one place an MCP server instance is built. Every surface — stdio |
| mcp-http.js | 121 | mcpHttpHandler, mcpGetHandler | - |
| mcp-supervisor.js | 352 | superviseMcpServer | How often a held swap asks again. Short because asking is free unless |
| mcp.js | 51 | start | Allow direct execution |
| meters.js | 187 | METER_TABLES, EMPTY_REPLY_CHARS, PRUNE_EXCLUDED, PRUNABLE_TABLES, meterGrowth... | Retention for the five meter tables (retrievals, extractions, tool_calls, |
| migrate-legacy.js | 902 | SOURCE_KEYS, MIGRATION_ID, MIGRATION_ACTION, MIGRATION_AUDIT_STATUS, MIGRATION_SOURCE... | Chunks that never parsed, so the writer can report them rather than let a |
| migration-gate.js | 106 | runMigrationCheck, createMigrationGate | Does the code on disk need a migration the databases have not had? |
| migration-targets.js | 31 | MIGRATION_TARGETS, migrationsFor | Which databases have migrations, and where the lists that define them live. |
| model-meter.js | 25 | logModelCall | One row per model subprocess call. Logged from the single site every caller |
| outcome-ranking.js | 56 | OUTCOME, HELPED_OUTCOME_ADJUSTMENT, CORRECTED_OUTCOME_ADJUSTMENT, FTS_OUTCOME_TIE_BUCKET, HINT_OUTCOME_TIE_BUCKET... | Outcome evidence is deliberately a tie-break, not a rank delta. SQLite FTS |
| paths.js | 40 | KB_DIR, FILES_DIR, LOGS_DIR, HOOK_ERROR_LOG, DB_PATH... | tests/helpers/tmp-kb.js checks this to prove it ran before we did. |
| predicates.js | 362 | VOCABULARY_FILE, canonicalPredicate, SINGLE_VALUED, PREDICATE_INVERSES, inverseTargetOf... | The predicate registry and the one canonicaliser every write path folds |
| private-file.js | 41 | PRIVATE_FILE_MODE, writePrivateFile | - |
| process-ancestry.js | 149 | AGENT, AGENTS, AGENT_FLAG, harnessAgent, findHarnessAncestor... | Identifies "the agent harness process" (Claude Code or Codex CLI) by |
| reconciliation.js | 612 | RECONCILIATION_LOG_DIR, RECONCILIATION_LOG, RECONCILE_REVIEWER, DEFAULT_RECONCILE_LIMIT, supersessionEvidenceCandidates... | Only bounded source excerpts and review metadata leave this module. Full |
| resident-census.js | 87 | summarizeResidentProcesses, inspectResidentProcesses, formatResidentProcessSummary | Live topology census for the resident-service rollout. Startup-event meters |
| restart-on-change.js | 81 | SOURCE_FILE, restartOnSourceChange | predicates.json is read once at import like any module, so it is source for |
| retrieval-outcomes.js | 421 | OUTCOME_SEMANTICS, retrievalOutcomesReady, parseTranscriptEvents, recordRetrievalOutcomesForSession, outcomeAdjustment | - |
| retrieval.js | 233 | SURFACE, SURFACES, PUSH_SURFACES, READ_SURFACES, isKbNudge... | Read-path telemetry: the write path has always been logged (documents, |
| schema.js | 98 | MIGRATE_COMMAND, PENDING_EXIT, SchemaOutOfDateError, hasTable, hasIndex... | Every command opens the default database, from whatever checkout it happens to |
| secret-prompt.js | 34 | askHidden | - |
| server.js | 216 | start | - |
| session-capture.js | 348 | SESSION_CAPTURE_QUEUE_DIR, SESSION_CAPTURE_RECEIPT_DIR, SESSION_CAPTURE_LOG, ensureSessionCaptureDirectories, writeJsonExclusive... | Durable, model-free handoff from lifecycle hooks to the resident daemon. |
| session-map.js | 97 | SESSION_MAP_DIR, recordSessionMap, resolveMapEntry | harness_pid -> session_id map: the MCP server process is long-lived and one |
| shim-hello.js | 63 | HELLO_KEY, HELLO_VERSION, MAX_HELLO_LINE_BYTES, encodeHello, parseHelloLine | The one line `kb mcp-shim` writes before any JSON-RPC: which harness owns |
| shim-path-meter.js | 116 | SHIM_PATH_LOG, SHIM_PATH_WINDOW_MS, recordShimPath, recordShimRecovery, summarizeShimPaths... | One row per mcp-shim startup decision. The fallback deliberately keeps KB |
| state.js | 136 | freshSessionsByProject, consolidateProject, runConsolidateState, runConsolidateStateCli | Knowledge vs state: lessons and decisions are immutable and accumulate; |
| tags.js | 40 | splitTags, normalizeTagString, getTagAliasMap, canonicalTag, tagSpellings | Tag helpers. Deliberately does not import db.js (db.js imports this module). |
| tiers.js | 344 | TIER, TIERS, DEFAULT_TIER, TIER_MEANING, tierRank... | Epistemic tier: how much standing a note has earned. Without it a conclusion |
| tool-meter.js | 61 | readToolResult, metered | One row per MCP tool call. `retrievals` covers what was read and |
| tools.js | 966 | FACT_RESULT_MAX_CHARS, getToolDefinitions, getHttpToolDefinitions | A refusal is a dead end unless it names the way forward, and the caller who |
| trigger-match.js | 239 | CORPUS_PATH, TRIGGER_INDEX_PATH, stripHeredocs, commandSegments, patternMatchesSegment... | The command-matching core of the trigger system, split out of |
| trigger-proposal-rules.js | 8 | TRIGGER_PROPOSAL_RULES | The rules a model must follow when proposing command triggers — shared |
| trigger-relevance.js | 294 | parseTriggerProposals, loadCommandCorpus, filterTriggers, rebuildTriggerIndex | Command triggers: patterns that let a note warn BEFORE a Bash tool call |
| tunnels.js | 141 | tagNeighbors, tunnel, aliasCandidatePair, strongestTunnels | Cross-domain tunnels: tag co-occurrence + entity co-mentions. |
| write-meter.js | 22 | logWriteDecision | One row per write decision: what the closest existing note was, how close, |
| write-note.js | 207 | RELATED_MIN, RELATED_K, renderRelatedSection, nearNeighborFields, renderNearNeighbors... | Shared note-writing path: dedup, frontmatter, related-links, index. |

## src/capture/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| terminal.js | 91 | redactSecrets, captureSession, captureFix | - |
| web.js | 37 | captureWeb | - |
| x-bookmarks.js | 65 | parseXBookmarks, captureXBookmarks | - |
| youtube.js | 39 | captureYouTube | - |

## src/classify/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| classifier.js | 69 | classifyNote, classifyBatch | - |
| processor.js | 111 | processNewClippings | - |
| summarizer.js | 84 | summarizeNote, summarizeUnsummarized | - |

## src/cli/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| aliases-backfill.js | 155 | neverAsked, revetAliases, runAliasesBackfillCli | `kb aliases-backfill` — propose retrieval aliases for notes that have never |
| canonicalize-entities.js | 234 | canonicalizeEntities, auditCanonicalEntities, runCanonicalizeEntitiesCli | One-time (re-runnable) migration for entities stored under a spelling |
| fact-adjudicate.js | 67 | FACT_ADJUDICATE_USAGE, runFactAdjudicateCli | - |
| fact-conflicts.js | 377 | factConflicts, formatFactConflicts, runFactConflictsCli | Multiple current objects are candidates for adjudication, not proof that the |
| flags.js | 121 | UsageError, wantsHelp, assertKnownFlags, showHelp, acceptFlags... | `--help` must print help and do nothing else, and a mistyped flag must not be |
| fold-inverses.js | 129 | foldInverses, runFoldInversesCli | One-time (re-runnable) migration for rows stored under a spelling |
| follow-through.js | 522 | followThroughReport, followedFireEvents, runFollowThroughCli | `kb follow-through` — does anyone act on what gets pushed at them? |
| hint-probe.js | 71 | hintProbe, runHintProbeCli | Replay every prompt the hint has actually been asked about, against the |
| hook-io.js | 230 | readAgentFlag, hookJsonEnvelope, hookOutput, recordHookFailure, deliver... | Shared plumbing for agent hooks (Claude Code, Codex, Cursor): never let a hook |
| ingest-cli.js | 39 | ingest | - |
| link-backfill.js | 70 | linkBackfill | One-time (re-runnable) backfill: connect every embedded doc to its |
| mcp-register.js | 153 | SUPPORTED_AGENTS, KB_MCP_SERVER_NAME, KB_ENTRYPOINT_PATH, mcpServerConfig, KB_MCP_SERVER_CONFIG... | Absent and unreadable are different answers. Treating both as "empty config" |
| mcp-shim.js | 461 | PROBE_TIMEOUT_MS, RECONNECT_DELAY_MS, RECONNECT_MAX_DELAY_MS, runMcpShimCli | Per-session stdio shim: connects this process's stdio to the resident |
| meters-cli.js | 54 | runMetersPruneCli | `kb meters prune` — the only place these five tables lose a row. No |
| migrate-legacy.js | 75 | parseMigrateLegacyArgs, migrationSummaryLines, runMigrateLegacyCli | - |
| migrate.js | 91 | runMigrateCli | The only path in the codebase that executes DDL. Everything else verifies. |
| precompact-hook.js | 270 | COMPACT_HOOK_LOG, snapshotPathFor, buildContinuitySnapshot, writeContinuitySnapshot, findContinuitySnapshot... | PreCompact cannot inject context into Claude Code's summarizer. Its stdout |
| promotions.js | 269 | PROMOTIONS_LOG_DIR, WOULD_PROMOTE_LOG, computePromotionDecisions, applyDecision, runPromotionsCli | `kb promotions` — applies the promotion the follow-through join can now |
| prompt-hint.js | 167 | computePromptHint, commitPromptHintPlan, promptHint | UserPromptSubmit hook: when the user's prompt is actually about something the |
| reconcile.js | 49 | runReconcileCli | - |
| rediscoveries.js | 64 | rediscoveries, countByAgent, runRediscoveriesCli | `kb rediscoveries` — a listing over the rediscovery rows duplicate |
| register.js | 44 | register | - |
| retrieval-report.js | 162 | retrievalReport, runRetrievalReportCli | Surface lists are constants, not input, but binding them keeps the SQL |
| runtime-node.js | 102 | findPreferredKnowledgeBaseNode, shouldReexecWithPreferredNode, lockPreferredNodeRuntime, isVersionPinned, stableNodePath | Homebrew keeps a versioned Cellar directory plus an `opt` symlink that |
| search-cli.js | 27 | search | - |
| serve.js | 92 | runServeCli | - |
| session-capture-hook.js | 45 | sessionCaptureHook | Lifecycle hook entry: enqueue only. No extraction, summarization, indexing, |
| setup-hooks.js | 362 | HOOK_FILES, PUSH_AGENTS, mergeAgentHooks, installAgentHooks, unresolvableHookCommands... | src/cli/setup-hooks.js — install KB briefing/hint hooks into an agent's hook con |
| setup-jobs.js | 153 | renderPlist, renderSystemdUnits, installJobs | src/cli/setup-jobs.js — install harvest/reindex/synthesis as launchd or systemd  |
| setup.js | 656 | parseEnvFile, askSecret, writeSetupEnv, formatSetupSummary, setup | fileURLToPath handles Windows drive letters correctly (avoids C:\C:\ duplication |
| stale-servers.js | 150 | sourceMtime, staleServers, staleRemedy, runStaleServersCli | Two shapes are running at once: a supervisor (`kb.js mcp`) with the real |
| status.js | 42 | status | - |
| stop.js | 25 | stop | - |
| surface-report.js | 247 | surfaceReport, runSurfaceReportCli | What the newest meters have to say: which tools anyone actually calls, |
| tags-cli.js | 75 | tagsReport, runTagsCli | - |
| tier-cli.js | 29 | runTierCli | `kb tier` — the standing of what is stored, and the backfill that derives it |
| tool-cli.js | 99 | FALLBACK_TOOL_NAMES, runToolCli | - |
| trigger-corpus.js | 109 | buildCommandCorpus, runTriggerCorpusCli | `kb trigger-corpus` — extract the historical Bash command corpus that |
| trigger-hook.js | 341 | MAX_SESSION_WARNINGS, TRIGGERS_LOG_DIR, TRIGGER_HOOK_ENABLED_FLAG, FALLBACK_SESSION, resolveSession... | PreToolUse hook (matcher: Bash): before a Bash call runs, check it against |
| triggers-backfill.js | 160 | neverAsked, revetTriggers, runTriggersBackfillCli | `kb triggers-backfill` — propose command triggers for notes that have |
| vault-cli.js | 26 | vaultReindex | - |
| wakeup-hook.js | 239 | computeWakeupHook, commitWakeupHookPlan, wakeupHook | SessionStart hook: print a compact KB briefing to stdout so the harness |

## src/embeddings/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| embed.js | 105 | EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, authoredBody, embeddableBody, storeEmbedding... | Convert Float32Array to Buffer for SQLite BLOB storage (3x smaller than JSON) |
| search.js | 232 | hybridMergeOrder, DUP_THRESHOLD, duplicatesIn, NEAR_FLOOR, NEAR_K... | Merge groups, in order. A row is ranked on the scale it actually carries, so |

## src/middleware/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| api-key.js | 41 | getApiKeyService, createApiKeyMiddleware | src/middleware/api-key.js |

## src/promotion/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| promoter.js | 92 | promoteNote | Promotion destinations by classification |
| prompts.js | 30 | CLASSIFY_PROMPT, PROMOTE_PROMPT | - |

## src/public/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| app.js | 341 | - | State |

## src/routes/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| api.js | 245 | default | All API routes require auth |
| auth-routes.js | 23 | default | - |
| openapi.js | 11 | default | - |
| v1.js | 281 | default | src/routes/v1.js |

## src/safety/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| review.js | 97 | reviewDestructiveAction, multiModelReview | Safety gate for destructive actions — blocks when the reviewer cannot answer. |

## src/sync/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| kb-to-vault.js | 287 | - | KB-to-Vault Sync  Exports all KB documents that don't have corresponding vault f |

## src/synthesis/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| weekly-review.js | 113 | getRecentNotes, generateSynthesisPrompt, getNearDupPairs, generateAnalysisRequest, writeSynthesisNote | Near-duplicate pairs recorded by link-backfill / dedup — synthesis reviews |

## src/vault/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| indexer.js | 346 | VAULT_INDEX_RACE_LOG, scanVault, indexVault, indexVaultFile, pruneMissingVaultFiles | `deferTriggerIndex`: skip the per-file rebuildTriggerIndex() call even when |
| parser.js | 89 | parseVaultNote | Map folder prefixes to note types |

## tests/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| aliases.test.js | 195 | - | Retrieval aliases: the gate that lets a note be found by a subject word its |
| api-key.test.js | 97 | - | tests/api-key.test.js |
| bus-removal.test.js | 91 | - | - |
| child-exit.test.js | 32 | - | - |
| claude-cli.test.js | 161 | - | Fake claude binaries so these tests need no network and run in ms. |
| cli-inert.test.js | 234 | - | Every entry point a user or a hook can invoke. `--help` on any of them must |
| context-truth-packet.test.js | 293 | - | - |
| daemon-shim-identity.test.js | 350 | - | Drives the daemon's MCP socket with hand-written bytes rather than the SDK |
| daemon.test.js | 389 | - | A listening server holds the event loop open, so a daemon a test failed to |
| db-connect-guard.test.js | 40 | - | Runs in its own process so KB_DIR can point somewhere disposable before |
| db.test.js | 46 | - | - |
| dedup-agreement.test.js | 109 | - | - |
| entity-canonicalization.test.js | 283 | - | Point the KB at a throwaway dir BEFORE importing anything that opens the DB. |
| extract-context.test.js | 197 | - | A qualifier that lands in a different chunk from its claim is not merely |
| extract-corpus.test.js | 77 | - | - |
| extract-eval.test.js | 263 | - | Prompt regressions for kb_extract, replayed against the real model — slow, |
| extract-meter.test.js | 227 | - | Point the KB at a throwaway dir BEFORE importing anything that opens the DB. |
| extract.test.js | 1054 | - | Point the KB at a throwaway dir BEFORE importing anything that opens the DB. |
| extraction-grounding-migration.test.js | 138 | - | - |
| extraction-summary.test.js | 51 | - | - |
| fact-add-retirement.test.js | 203 | - | - |
| fact-adjudicate.test.js | 342 | - | - |
| fact-conflicts.test.js | 251 | - | - |
| fact-invalidate-id.test.js | 70 | - | - |
| fact-query-adjudication.test.js | 174 | - | - |
| fact-query-cap.test.js | 139 | - | Above the 200 ceiling on purpose: with a smaller fixture, an assertion that |
| fold-inverses.test.js | 304 | - | Point the KB at a throwaway dir BEFORE importing anything that opens the DB. |
| follow-through.test.js | 462 | - | Slice 1's whole point: the report can answer "does Codex act on what it is |
| from-preview-migration.test.js | 60 | - | Point the KB at a throwaway dir BEFORE anything opens the real DB. |
| grounding.test.js | 654 | - | Points KB_DIR and the vault at throwaway dirs — must come before anything |
| harvest-eval.test.js | 32 | - | Slow behavioral coverage against the real model: |
| harvest.test.js | 1060 | - | A claude that answers instantly, so the harvest runs end to end without the |
| health-backlog.test.js | 211 | - | The briefing carried "202 notes missing summaries" unchanged for weeks. A |
| hint-live-regressions.test.js | 91 | - | - |
| hint-probe.test.js | 56 | - | - |
| hint-recall.test.js | 336 | - | The opposing force to hint-relevance.test.js. |
| hint-relevance.test.js | 246 | - | The prompt-hint surface used to fire on 100% of prompts — 94 of 94 logged |
| hook-fastpath.test.js | 515 | - | Hooks-via-daemon fast path: the control socket daemon.js serves |
| hook-io.test.js | 15 | - | - |
| hook-timing.test.js | 63 | - | Point the KB at a throwaway dir BEFORE anything opens the real DB. |
| hooks-retrieval.test.js | 649 | - | Exercises wakeup-hook.js and prompt-hint.js as real subprocesses (they |
| hybrid-search.test.js | 71 | - | - |
| ingest.test.js | 87 | - | Ingested documents had no vault file, and the reindex job — which only walks |
| inverse-fold.test.js | 203 | - | Point the KB at a throwaway dir BEFORE importing anything that opens the DB. |
| mcp-annotations.test.js | 57 | - | Codex under approval_policy=never auto-approves only tools advertising |
| mcp-shim.test.js | 402 | - | Drives `kb mcp-shim` as a real child process against a real in-process |
| mcp-supervisor.test.js | 400 | MARKER, MARKER, MARKER | Same shape as tests/restart-on-change.test.js: a fixed sleep long enough for |
| mcp-wire-identity.test.js | 194 | - | Captured by hand-rolled JSON-RPC against public/main (v1 SDK, pre-migration) |
| meter-retention.test.js | 217 | - | pruneMeters(table: 'tool_calls') deletes from the whole table, so a test |
| migrate-legacy.test.js | 949 | - | - |
| migration-check.test.js | 155 | - | - |
| migration-gate.test.js | 158 | MIGRATIONS | - |
| near-neighbors.test.js | 235 | - | The audience for this response is a model, so what it has to parse is what is |
| precompact-hook.test.js | 137 | - | - |
| predicate-closed-vocabulary.test.js | 275 | - | Point the KB at a throwaway dir BEFORE anything opens the real DB. |
| predicate-fold-migration.test.js | 182 | - | Point the KB at a throwaway dir BEFORE anything opens the real DB. |
| predicate-vocabulary.test.js | 294 | - | Point the KB at a throwaway dir BEFORE importing anything that opens the DB. |
| private-files.test.js | 220 | - | - |
| process-ancestry.test.js | 179 | - | This runs on a hook's critical path (every UserPromptSubmit) — a hung `ps` |
| promotions.test.js | 594 | - | Push at t0, read (follows it) at t0 + 5min — well inside the 30min window. |
| qualifier-prefix.test.js | 78 | - | Point the KB at a throwaway dir BEFORE importing anything that opens the DB. |
| reconciliation-review-regressions.test.js | 200 | - | - |
| reconciliation.test.js | 432 | - | - |
| rediscoveries.test.js | 254 | - | Rediscovery telemetry: duplicate detection catching an agent re-deriving a |
| register.test.js | 255 | - | Codex CLI (0.148) reads [mcp_servers. ] from config.toml and never loads |
| resident-census.test.js | 71 | - | - |
| restart-on-change.test.js | 134 | half, seed, half, half, seed... | Waiting a fixed 200ms for FSEvents delivery plus a `node --check` fork is a |
| retrieval-outcomes.test.js | 456 | - | - |
| retrieval-report.test.js | 290 | - | The classifier's whole job is to separate "go and look in the KB" from |
| retrieval-surfaces.test.js | 233 | - | Every read surface, counted rather than inspected. The meter's failure mode |
| retrieval.test.js | 397 | - | The ancestry walk itself (ps-backed) is process-ancestry.test.js's job; |
| runtime-node.test.js | 96 | - | Homebrew's Cellar path names one patch release. Persisting it into a job, |
| safety-review.test.js | 109 | - | One fake claude whose behaviour is picked by an env var the child inherits, |
| schema-migrations.test.js | 298 | - | The meter logged the system's own subprocesses alongside real sessions, and |
| serve-shutdown.test.js | 89 | - | - |
| session-capture.test.js | 628 | - | - |
| session-map.test.js | 174 | - | Backdates a file's mtime by `days` so the sweeper's age check treats it as |
| setup-env-preserve.test.js | 10 | - | - |
| setup-hooks.test.js | 633 | - | tests/setup-hooks.test.js |
| setup-jobs.test.js | 110 | - | tests/setup-jobs.test.js |
| shim-hello.test.js | 125 | - | The compatibility direction step 2 cannot cover: a NEW shim dialing an OLD |
| shim-path-meter.test.js | 67 | - | - |
| source-hygiene.test.js | 26 | - | - |
| stale-servers.test.js | 153 | - | - |
| supersession.test.js | 281 | - | - |
| surface-meters.test.js | 109 | - | - |
| synthesis-prompt.test.js | 29 | - | - |
| tags-cli.test.js | 51 | - | tmp-kb.js first: runTagsCli's alias path writes through the module-level |
| tags.test.js | 142 | - | Must be first: insertDocument writes through the module-level getDb() handle, |
| terminal.test.js | 40 | - | - |
| test-runtime.test.js | 35 | - | - |
| test-session-backfill-migration.test.js | 122 | - | Point the KB at a throwaway dir BEFORE anything opens the real DB. |
| tier-annotation.test.js | 80 | - | A tier printed on every row is a tier that tells the reader nothing. Every |
| tiers.test.js | 720 | - | Epistemic tiers: what a note claims, what it had to show for the claim, and |
| tmp-kb-guard.test.js | 44 | - | Regression: a fixture that imported src before setting KB_DIR once seeded |
| tool-cli.test.js | 111 | - | - |
| tools.test.js | 240 | - | A tool nothing points at is one no agent has a reason to call, which is |
| trigger-hook.test.js | 549 | - | PreToolUse (Bash) hook: pure decision logic in decideAndRecord/ |
| triggers.test.js | 710 | - | Command triggers: the deterministic vet (filterTriggers), the shared |
| tunnels.test.js | 133 | - | - |
| upload-path-traversal.test.js | 348 | - | tests/upload-path-traversal.test.js |
| v1.test.js | 189 | - | tests/v1.test.js |
| vault-indexer.test.js | 393 | - | Must come first: this file indexes notes through getDb(), so without it the |
| vault-parser.test.js | 55 | - | Test Note |
| write-correction.test.js | 91 | - | - |
| write-note.test.js | 73 | - | Exercise filename allocation even when semantic dedup is unavailable. |

## tests/bench/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| extract-call-cost.mjs | 75 | - | Where an extraction call spends its wall time, measured from the CLI's own |

## tests/fixtures/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| bad-import-order.fixture.js | 6 | - | Reproduces a real incident: a src-reaching import listed before |

## tests/helpers/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| extract-corpus.js | 35 | corpusTripleKey, scoreExtractCorpus | - |
| marker-server.mjs | 48 | - | A stand-in for src/mcp.js used by tests/mcp-supervisor.test.js: a real |
| migrations.js | 36 | shortOf, seedDb | Building a database that is deliberately behind the code, for the tests that |
| run-hook.mjs | 18 | - | wakeupHook/promptHint/triggerHook call process.exit() themselves — correct |
| slow-daemon.js | 45 | startSlowDaemon | - |
| supervisor-fixture.mjs | 13 | - | Entry point for the end-to-end supervisor tests. The real SDK client spawns |
| tmp-kb.js | 22 | - | Point the KB at a throwaway dir BEFORE any module opens the real DB. |
| wedged-daemon.js | 23 | startWedgedDaemon | - |

## Key Data Flows

1. **Intake:** Obsidian clip → sync → vault → `scanVault()` → `parseVaultNote()` → `upsertVaultFile()` → SQLite
2. **Classify:** `processNewClippings()` → `classifyNote()` (claude CLI) → update frontmatter → reindex
3. **Search:** `kb_context` (summaries) → `kb_search` (FTS5) → `kb_search_smart` (FTS5 + embeddings)
4. **Safety:** caller opts in (`kb_safety_check` tool or `kb safety-check`) → KB search → `reviewDestructiveAction()` → verdict; a reviewer that cannot answer blocks
5. **Capture:** `captureSession()` / `captureFix()` → write to vault → `indexVault()` → searchable

## Selected MCP Tools
| Tool | Purpose |
|------|---------|
| kb_search | FTS5 keyword search |
| kb_context | Token-efficient summary briefing (98% savings) |
| kb_search_smart | Hybrid keyword + semantic search |
| kb_read | Read full document by ID |
| kb_list | List docs by type/tag |
| kb_write | Write new note to vault |
| kb_ingest | Ingest text into KB |
| kb_classify | Auto-classify new clippings |
| kb_capture_youtube | Capture YouTube transcript |
| kb_capture_web | Capture web article |
| kb_capture_session | Record debugging session |
| kb_capture_fix | Record bug fix |
| kb_vault_status | Vault indexing stats |
| kb_promote | Raise a note's epistemic tier once a session confirms it |
| kb_synthesize | Generate cross-source synthesis |
| kb_safety_check | Review destructive action before executing |
