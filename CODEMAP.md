# Codebase Map
> Auto-generated. Do NOT edit manually. Regenerate with: `node bin/generate-codemap.js`
> Generated: 2026-07-05

## Quick Stats
- **Files:** 95
- **Total lines:** 11,781

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
| kb.js | 133 | - | bin/kb.js — CLI entry point |
| post-sync.sh | 31 | - | !/bin/bash |
| weekly-synthesis.js | 41 | - | Weekly synthesis job — run via launchd or manually. |
| weekly-synthesis.sh | 9 | - | !/bin/bash |

## src/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| auth-oauth.js | 25 | auth | src/auth-oauth.js — Better Auth OAuth provider for MCP clients |
| auth.js | 149 | hasPassword, setPassword, checkPassword, promptPassword, createSession... | - |
| claude-cli.js | 54 | runClaude, runClaudeJSON | Shared "run the local claude CLI in print mode, get JSON back" helper. |
| db.js | 464 | insertDocument, updateDocument, deleteDocument, searchDocuments, listDocuments... | Common English stop words to filter from search queries |
| extract.js | 88 | EXTRACT_PROMPT, buildExtractPrompt, extractFacts, consolidate, kbExtract | Auto-capture: turn a raw work conversation / session transcript into durable |
| facts.js | 226 | initFactSchema, mergeEntity, addFact, queryFact, invalidateFact... | Resolve an entity id through the alias table (single hop — merges rewrite |
| harvest.js | 243 | LESSONS_PROMPT, findTranscripts, extractTranscriptText, chunkText, runHarvest... | Nightly auto-debrief: sweep agent session transcripts (Claude Code, and |
| ingest.js | 168 | getMarkdownIngestMetadata, normalizeIngestOptions, ingestFile, ingestDirectory, ingestText | - |
| mcp-http.js | 137 | mcpHttpHandler, mcpGetHandler | - |
| mcp.js | 30 | start | Allow direct execution |
| paths.js | 13 | KB_DIR, FILES_DIR, DB_PATH, CONFIG_PATH, PID_PATH | - |
| server.js | 219 | start | - |
| state.js | 136 | freshSessionsByProject, consolidateProject, runConsolidateState, runConsolidateStateCli | Knowledge vs state: lessons and decisions are immutable and accumulate; |
| tools.js | 593 | getToolDefinitions, getHttpToolDefinitions | Dedup depends on embeddings. If it can't run, say so in the response instead |
| write-note.js | 129 | DUP_THRESHOLD, RELATED_MIN, RELATED_K, renderRelatedSection, insertDocLinks... | Shared note-writing path: dedup, frontmatter, related-links, index. |

## src/bus/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| agentd.js | 417 | registerBusAgent, getBusAgent, listBusAgents, getBusRun, listBusRuns... | - |
| autobind.js | 89 | findTicketInPath, findTicketInGitBranch, autobind | - |
| cli.js | 677 | runBusSendCli, runBusStatusCli, runBusSessionCli, runBusGatewayCli, runBusAgentCli... | - |
| config.js | 33 | getBusHome, getBusDbPath, getBusRetentionMessages, getBusPollMs, getBusResourceLimit... | - |
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
| summarizer.js | 118 | summarizeNote, summarizeUnsummarized | - |

## src/cli/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| ingest-cli.js | 36 | ingest | - |
| link-backfill.js | 70 | linkBackfill | One-time (re-runnable) backfill: connect every embedded doc to its |
| mcp-register.js | 63 | SUPPORTED_AGENTS, KB_MCP_SERVER_NAME, KB_ENTRYPOINT_PATH, KB_MCP_SERVER_CONFIG, getAgentConfigPath... | - |
| prompt-hint.js | 37 | promptHint | UserPromptSubmit hook: FTS-match the user's prompt against the KB and, when |
| register.js | 17 | register | - |
| runtime-node.js | 74 | findPreferredKnowledgeBaseNode, shouldReexecWithPreferredNode, lockPreferredNodeRuntime | - |
| search-cli.js | 26 | search | - |
| setup.js | 536 | setup | fileURLToPath handles Windows drive letters correctly (avoids C:\C:\ duplication |
| status.js | 38 | status | - |
| stop.js | 25 | stop | - |
| vault-cli.js | 20 | vaultReindex | - |
| wakeup-hook.js | 44 | wakeupHook | SessionStart hook: print a compact KB briefing to stdout so the harness |

## src/embeddings/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| embed.js | 57 | generateEmbedding, embeddingToBuffer, bufferToEmbedding, cosineSimilarity | Convert Float32Array to Buffer for SQLite BLOB storage (3x smaller than JSON) |
| search.js | 127 | semanticSearch, similarDocs, checkDuplicate, hybridSearch | Brute-force cosine similarity — works for <2000 notes. |

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
| api.js | 175 | default | All API routes require auth |
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
| weekly-review.js | 105 | getRecentNotes, generateSynthesisPrompt, getNearDupPairs, generateAnalysisRequest, writeSynthesisNote | Near-duplicate pairs recorded by link-backfill / dedup — synthesis reviews |

## src/vault/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| indexer.js | 261 | scanVault, indexVault, indexVaultFile | - |
| parser.js | 85 | parseVaultNote | Map folder prefixes to note types |

## tests/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| api-key.test.js | 57 | - | tests/api-key.test.js |
| autobind.test.js | 151 | - | - |
| bus.test.js | 1102 | - | - |
| db.test.js | 45 | - | - |
| extract.test.js | 96 | - | Point the KB at a throwaway dir BEFORE importing anything that opens the DB. |
| harvest.test.js | 60 | - | - |
| ingest.test.js | 32 | - | Body |
| register.test.js | 60 | - | - |
| runtime-node.test.js | 64 | - | - |
| tools.test.js | 54 | - | - |
| v1.test.js | 189 | - | tests/v1.test.js |
| vault-indexer.test.js | 87 | - | Test Research |
| vault-parser.test.js | 55 | - | Test Note |

## tests/helpers/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
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
