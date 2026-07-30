# Codebase Map
> Auto-generated. Do NOT edit manually. Regenerate with: `node bin/generate-codemap.js`
> Generated: 2026-07-30

## Quick Stats
- **Files:** 124
- **Total lines:** 16,384

## Architecture Overview
```
src/
  mcp.js          ← MCP server (16 tools: search, write, capture, classify, safety)
  db.js            ← SQLite + FTS5 (documents, vault_files, embeddings tables)
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
| bus-agent.js | 9 | - | !/usr/bin/env node |
| bus-agentd.js | 9 | - | !/usr/bin/env node |
| bus-autobind.js | 59 | - | !/usr/bin/env node |
| bus-bind.js | 13 | - | !/usr/bin/env node |
| bus-gateway.js | 9 | - | !/usr/bin/env node |
| bus-hook-current.js | 13 | - | !/usr/bin/env node |
| bus-hook.js | 13 | - | !/usr/bin/env node |
| bus-notifier.js | 13 | - | !/usr/bin/env node |
| bus-read.js | 13 | - | !/usr/bin/env node |
| bus-send.js | 13 | - | !/usr/bin/env node |
| bus-session.js | 9 | - | !/usr/bin/env node |
| bus-status.js | 9 | - | !/usr/bin/env node |
| bus-unbind.js | 13 | - | !/usr/bin/env node |
| cron-capture.sh | 30 | - | !/bin/bash |
| generate-codemap.js | 155 | - | Generates a token-efficient codebase map for AI agents |
| init-vault.sh | 36 | - | !/bin/bash |
| kb.js | 139 | - | bin/kb.js — CLI entry point |
| post-sync.sh | 31 | - | !/bin/bash |
| weekly-synthesis.js | 45 | - | Weekly synthesis job — run via launchd or manually. |
| weekly-synthesis.sh | 9 | - | !/bin/bash |

## src/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| auth-oauth.js | 25 | auth | src/auth-oauth.js — Better Auth OAuth provider for MCP clients |
| auth.js | 149 | hasPassword, setPassword, checkPassword, promptPassword, createSession... | - |
| claude-cli.js | 72 | runClaude, runClaudeJSON | Shared "run the local claude CLI in print mode, get JSON back" helper. |
| db.js | 610 | insertDocument, updateDocument, deleteDocument, searchDocuments, listDocuments... | Common English stop words to filter from search queries |
| extract.js | 468 | EXTRACT_PROMPT, MAX_EXTRACT_CHARS, buildExtractPrompt, chunkForExtract, extractFacts... | Auto-capture: turn a raw work conversation / session transcript into durable |
| facts.js | 248 | initFactSchema, sqlTimestamp, mergeEntity, addFact, queryFact... | created_at defaults to SQLite's CURRENT_TIMESTAMP, which is UTC |
| harvest.js | 366 | MAX_SESSIONS_PER_RUN, factsRequested, LESSONS_PROMPT, isPrintModeTranscript, harvestsPrintModeSessions... | Nightly auto-debrief: sweep agent session transcripts (Claude Code, and |
| ingest.js | 170 | getMarkdownIngestMetadata, normalizeIngestOptions, ingestFile, ingestDirectory, ingestText | - |
| mcp-http.js | 137 | mcpHttpHandler, mcpGetHandler | - |
| mcp-supervisor.js | 283 | superviseMcpServer | Taken from the client's own default rather than restated: past its timeout a |
| mcp.js | 51 | start | Allow direct execution |
| paths.js | 13 | KB_DIR, FILES_DIR, DB_PATH, CONFIG_PATH, PID_PATH | - |
| restart-on-change.js | 81 | SOURCE_FILE, restartOnSourceChange | predicates.json is read once at import like any module, so it is source for |
| server.js | 219 | start | - |
| state.js | 136 | freshSessionsByProject, consolidateProject, runConsolidateState, runConsolidateStateCli | Knowledge vs state: lessons and decisions are immutable and accumulate; |
| tags.js | 28 | splitTags, normalizeTagString, getTagAliasMap, canonicalTag | Tag helpers. Deliberately does not import db.js (db.js imports this module). |
| tools.js | 760 | FACT_RESULT_MAX_CHARS, getToolDefinitions, getHttpToolDefinitions | Dedup depends on embeddings. If it can't run, say so in the response instead |
| tunnels.js | 141 | tagNeighbors, tunnel, aliasCandidatePair, strongestTunnels | Cross-domain tunnels: tag co-occurrence + entity co-mentions. |
| write-note.js | 134 | DUP_THRESHOLD, RELATED_MIN, RELATED_K, renderRelatedSection, insertDocLinks... | Shared note-writing path: dedup, frontmatter, related-links, index. |

## src/bus/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| agentd.js | 417 | registerBusAgent, getBusAgent, listBusAgents, getBusRun, listBusRuns... | - |
| autobind.js | 89 | findTicketInPath, findTicketInGitBranch, autobind | - |
| cli.js | 677 | runBusSendCli, runBusStatusCli, runBusSessionCli, runBusGatewayCli, runBusAgentCli... | - |
| config.js | 51 | getBusHome, getBusDbPath, getBusRetentionMessages, getBusPollMs, getBusResourceLimit... | Read at use time; invalid pattern warns once then falls back to default. |
| context.js | 151 | normalizeCwd, writeBusBinding, readBusBinding, clearBusBinding | - |
| db.js | 216 | getBusDb, closeBusDb | - |
| gateway.js | 273 | registerBusSession, getBusSession, listBusSessions, runBusGatewayOnce, runBusGatewayLoop... | - |
| pending.js | 76 | getBusPendingPath, readBusPending, writeBusPending, clearBusPending, getBusNotifierPidPath... | - |
| resources.js | 32 | registerBusResources | - |
| service.js | 647 | onBusMessage, sendBusMessage, getMessageById, readBusInbox, readBusNotifications... | - |
| tools.js | 197 | getBusToolDefinitions | - |

## src/capture/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| terminal.js | 90 | captureSession, captureFix | - |
| web.js | 37 | captureWeb | - |
| x-bookmarks.js | 65 | parseXBookmarks, captureXBookmarks | - |
| youtube.js | 39 | captureYouTube | - |

## src/classify/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| classifier.js | 64 | classifyNote, classifyBatch | - |
| processor.js | 100 | processNewClippings | - |
| summarizer.js | 84 | summarizeNote, summarizeUnsummarized | - |

## src/cli/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| fold-inverses.js | 112 | foldInverses, runFoldInversesCli | One-time (re-runnable) migration for rows written before inverse folding. |
| ingest-cli.js | 36 | ingest | - |
| link-backfill.js | 70 | linkBackfill | One-time (re-runnable) backfill: connect every embedded doc to its |
| mcp-register.js | 63 | SUPPORTED_AGENTS, KB_MCP_SERVER_NAME, KB_ENTRYPOINT_PATH, KB_MCP_SERVER_CONFIG, getAgentConfigPath... | - |
| prompt-hint.js | 37 | promptHint | UserPromptSubmit hook: FTS-match the user's prompt against the KB and, when |
| register.js | 17 | register | - |
| runtime-node.js | 74 | findPreferredKnowledgeBaseNode, shouldReexecWithPreferredNode, lockPreferredNodeRuntime | - |
| search-cli.js | 26 | search | - |
| setup-hooks.js | 48 | mergeClaudeHooks, installClaudeHooks | src/cli/setup-hooks.js — install KB briefing/hint hooks into Claude Code setting |
| setup-jobs.js | 138 | JOBS, renderPlist, renderSystemdUnits, installJobs | src/cli/setup-jobs.js — install harvest/reindex/synthesis as launchd or systemd  |
| setup.js | 634 | parseEnvFile, setup | fileURLToPath handles Windows drive letters correctly (avoids C:\C:\ duplication |
| stale-servers.js | 131 | sourceMtime, staleServers, runStaleServersCli | Two shapes are running at once: a supervisor (`kb.js mcp`) with the real |
| status.js | 38 | status | - |
| stop.js | 25 | stop | - |
| tags-cli.js | 75 | tagsReport, runTagsCli | - |
| vault-cli.js | 20 | vaultReindex | - |
| wakeup-hook.js | 47 | wakeupHook | SessionStart hook: print a compact KB briefing to stdout so the harness |

## src/embeddings/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| embed.js | 57 | generateEmbedding, embeddingToBuffer, bufferToEmbedding, cosineSimilarity | Convert Float32Array to Buffer for SQLite BLOB storage (3x smaller than JSON) |
| search.js | 132 | semanticSearch, similarDocs, checkDuplicate, hybridSearch | Brute-force cosine similarity — works for <2000 notes. |

## src/middleware/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| api-key.js | 38 | createApiKeyMiddleware | src/middleware/api-key.js |

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
| api.js | 179 | default | All API routes require auth |
| auth-routes.js | 23 | default | - |
| openapi.js | 11 | default | - |
| v1.js | 273 | default | src/routes/v1.js |

## src/safety/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| review.js | 136 | reviewDestructiveAction, multiModelReview | Multi-model review: ask all 3, take the most conservative answer |

## src/sync/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| kb-to-vault.js | 280 | - | KB-to-Vault Sync  Exports all KB documents that don't have corresponding vault f |

## src/synthesis/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| weekly-review.js | 113 | getRecentNotes, generateSynthesisPrompt, getNearDupPairs, generateAnalysisRequest, writeSynthesisNote | Near-duplicate pairs recorded by link-backfill / dedup — synthesis reviews |

## src/vault/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| indexer.js | 262 | scanVault, indexVault, indexVaultFile | - |
| parser.js | 85 | parseVaultNote | Map folder prefixes to note types |

## tests/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| api-key.test.js | 57 | - | tests/api-key.test.js |
| autobind.test.js | 185 | - | - |
| bus.test.js | 1102 | - | - |
| claude-cli.test.js | 39 | - | Fake claude binaries so these tests need no network and run in ms. |
| db.test.js | 45 | - | - |
| extract-eval.test.js | 94 | - | Prompt regressions for kb_extract, replayed against the real model — slow, |
| extract.test.js | 568 | - | Point the KB at a throwaway dir BEFORE importing anything that opens the DB. |
| fact-query-cap.test.js | 118 | - | Above the 200 ceiling on purpose: with a smaller fixture, an assertion that |
| fold-inverses.test.js | 226 | - | Point the KB at a throwaway dir BEFORE importing anything that opens the DB. |
| harvest.test.js | 329 | - | A claude that answers instantly, so the harvest runs end to end without the |
| ingest.test.js | 32 | - | Body |
| inverse-fold.test.js | 176 | - | Point the KB at a throwaway dir BEFORE importing anything that opens the DB. |
| mcp-supervisor.test.js | 173 | MARKER, MARKER | Same shape as tests/restart-on-change.test.js: a fixed sleep long enough for |
| register.test.js | 60 | - | - |
| restart-on-change.test.js | 134 | half, seed, half, half, seed... | Waiting a fixed 200ms for FSEvents delivery plus a `node --check` fork is a |
| runtime-node.test.js | 64 | - | - |
| setup-env-preserve.test.js | 9 | - | - |
| setup-hooks.test.js | 77 | - | tests/setup-hooks.test.js |
| setup-jobs.test.js | 87 | - | tests/setup-jobs.test.js |
| source-hygiene.test.js | 26 | - | - |
| stale-servers.test.js | 134 | - | - |
| supersession.test.js | 145 | - | - |
| synthesis-prompt.test.js | 28 | - | - |
| tags-cli.test.js | 51 | - | tmp-kb.js first: runTagsCli's alias path writes through the module-level |
| tags.test.js | 49 | - | Must be first: insertDocument writes through the module-level getDb() handle, |
| tools.test.js | 70 | - | - |
| tunnels.test.js | 132 | - | - |
| upload-path-traversal.test.js | 33 | - | tests/upload-path-traversal.test.js |
| v1.test.js | 189 | - | tests/v1.test.js |
| vault-indexer.test.js | 87 | - | Test Research |
| vault-parser.test.js | 55 | - | Test Note |

## tests/helpers/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| marker-server.mjs | 35 | - | A stand-in for src/mcp.js used by tests/mcp-supervisor.test.js: a real |
| supervisor-fixture.mjs | 12 | - | Entry point for the end-to-end supervisor tests. The real SDK client spawns |
| tmp-kb.js | 12 | - | Point the KB at a throwaway dir BEFORE any module opens the real DB. |

## Key Data Flows

1. **Intake:** Obsidian clip → sync → vault → `scanVault()` → `parseVaultNote()` → `upsertVaultFile()` → SQLite
2. **Classify:** `processNewClippings()` → `classifyNote()` (claude CLI) → update frontmatter → reindex
3. **Search:** `kb_context` (summaries) → `kb_search` (FTS5) → `kb_search_smart` (FTS5 + embeddings)
4. **Safety:** Hook intercepts Bash → pattern match → `reviewDestructiveAction()` → KB search → block/allow
5. **Capture:** `captureSession()` / `captureFix()` → write to vault → `indexVault()` → searchable

## MCP Tools (16 total)
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
| kb_promote | Promote source to structured knowledge |
| kb_synthesize | Generate cross-source synthesis |
| kb_safety_check | Review destructive action before executing |
