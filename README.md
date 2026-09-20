# kb-graph

**Shared memory for coding agents, stored in Markdown and SQLite.**

[![CI](https://github.com/uttambharadwaj/kb-graph/actions/workflows/test.yml/badge.svg)](https://github.com/uttambharadwaj/kb-graph/actions/workflows/test.yml)
[![GitHub release](https://img.shields.io/github/v/release/uttambharadwaj/kb-graph)](https://github.com/uttambharadwaj/kb-graph/releases/latest)
[![Node 22, 24, 26](https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2026-339933?logo=node.js&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

kb-graph gives Claude Code, Codex, Cursor, Gemini, and other MCP clients one
searchable knowledge base. Notes remain files you own. SQLite adds full-text
search, local embeddings add semantic retrieval, and agent hooks can put current
context into a session before work starts.

Storage and retrieval are local. AI curation is not: harvesting,
classification, extraction, reconciliation, safety review, and synthesis invoke
your authenticated Claude CLI and may send selected transcript or note content
to its configured provider. The embedding model is downloaded on first use,
then runs locally.

## Install from source

kb-graph is not currently published on npm. Clone it into a stable location:
generated registrations and scheduled jobs contain the checkout's absolute
path.

```bash
git clone https://github.com/uttambharadwaj/kb-graph.git
cd kb-graph
npm ci
node bin/kb.js setup
node bin/kb.js status
```

Requirements:

- macOS or Linux
- Node.js 22, 24, or 26
- an installed, authenticated `claude` CLI for AI curation
- network access on first embedding use to download the model

After `.env` is written, setup treats later integrations as best-effort and
reports each result. Review its summary, then open a new configured agent
session. Claude Code, Codex, and Cursor should receive a **KB BRIEFING** at
session start.

For a teammate checklist, see [Onboarding](docs/ONBOARDING.md). Existing 1.x
users should read [Upgrading to 2.0](docs/UPGRADING-2.0.md).

## What setup changes

Depending on your answers, `node bin/kb.js setup`:

- creates or updates this checkout's owner-only `.env`;
- creates a Markdown vault (Obsidian is optional);
- registers MCP for Claude Code, Gemini, and Cursor;
- tells Codex users to run `node bin/kb.js register --agents=codex`, which
  prints the hand-managed `config.toml` block;
- installs supported hooks for Claude Code, Codex, and Cursor;
- installs four launchd or systemd-user jobs;
- copies bundled skills into `~/.claude/skills` without overwriting existing
  customizations; and
- optionally configures the HTTP server as a service.

Moving the clone later breaks paths embedded in those integrations. Re-run
`setup` for hooks/jobs and `node bin/kb.js register --force` for MCP from the
new checkout.

## What each agent gets

- **Claude Code:** MCP, session briefing, prompt hints, trigger checks,
  pre-compaction continuity, optional post-tool capture checkpoints,
  daemon-backed lifecycle capture, and nightly transcript discovery.
- **Codex:** MCP after you paste the printed registration, session briefing,
  prompt hints, trigger checks, optional post-tool capture checkpoints,
  daemon-backed activity/pre-compaction capture, and nightly transcript
  discovery.
- **Cursor:** MCP, session-start briefing, and nightly transcript discovery.
  Cursor's current prompt/tool hooks have no context-output channel, so kb-graph
  does not install prompt hints, trigger warnings, or lifecycle capture there.
- **Gemini:** MCP registration. Gemini transcripts are not automatically
  harvested and kb-graph does not install Gemini hooks.
- **Other clients:** point any MCP client at
  `node /absolute/path/to/kb-graph/bin/kb.js mcp-shim`.

Bundled `/debrief` and `kb-workflow` skills are installed only for Claude's
skill directory. Other agents can call the underlying MCP tools directly.
Lifecycle hooks enqueue capture requests; the optional `kb serve` daemon is
what drains that queue. Without it, the nightly transcript sweep remains the
automatic capture path.

## The loop

### Retrieve

Pull context with `kb_search`, `kb_search_smart`, or `kb_context`. Claude Code
and Codex also receive sparse, precision-first hints when a prompt clearly
matches a note. Cursor receives the session briefing but not per-prompt hints.

### Capture

Use `/debrief`, `kb_write`, `kb_capture_session`, or `kb_capture_fix` for
deliberate capture. This is the high-quality path: the agent can name the lesson
and preserve its evidence while the session is still fresh. Routine note
creation is one `kb_write` call: it owns semantic duplicate detection and
refuses without writing when that check is unavailable. Search and read first
when correcting an existing note, then pass `supersedes`.

Nightly harvest is a safety net, not guaranteed capture. By default it scans
Claude Code, Codex, and Cursor transcripts, but skips short, still-active,
subagent, and print-mode sessions. Work is capped per run and long transcripts
are processed in bounded chunks. Set `KB_HARVEST_SDK_SESSIONS=1` if print-mode
sessions are genuine work you want harvested. Fact extraction remains opt-in
with `KB_HARVEST_FACTS=1`. Scheduled jobs snapshot both settings, so rerun setup
after changing either one. Harvest uses the same fail-closed note writer; a
chunk whose duplicate check is unavailable remains incomplete and retries.

Claude Code and Codex also install a default-off PostToolUse checkpoint. It
classifies successful commit/merge, full verification, and release/deploy
boundaries, then records only the agent, native session key, checkpoint class,
permission mode, and outcome under `~/.knowledge-base/logs/checkpoints/`.
Command text and tool output are never logged. Create
`KB_DIR/checkpoint-hook-enabled` to emit at most two distinct reminders per
session; `KB_DIR/checkpoint-hook-disabled` is the kill switch. Failures, KB
tool calls, detectable subagents, missing identities, and write-denied sessions
never emit. Cursor remains disabled until its write-approval contract is
verified.

Measure the default-off rollout with
`kb capture-follow-through --since <ISO-8601> --through <ISO-8601> --json`.
The aggregate report separates emitted and log-only cohorts, waits for each
30-minute immediate-capture window to mature, and reports delayed harvest
salvage separately. Claude and Codex use exact agent/session correlation;
Cursor candidates are counted by agent only and excluded from all correlation
denominators. Test sessions and other unattributable candidates are excluded
too. Session IDs, commands, prompts, output, and note bodies are never printed.
The same report evaluates the shipped synthetic checkpoint replay corpus for
precision, recall, and unsafe captures.

### Consolidate and review

Harvest folds recent sessions into current workstream state notes. Entity facts
retain provenance and history; reviewed projections represent current state
without rewriting raw evidence. Weekly synthesis reports themes,
contradictions, and cross-domain links.

## Architecture

```text
Claude Code / Codex / Cursor / Gemini / MCP clients
                    |
             kb mcp-shim
         (one per client session)
              /           \
  optional kb serve      in-process fallback
  Unix-socket daemon      when daemon is absent
              \           /
               SQLite + FTS5
               local embeddings
               Markdown vault

Browser / remote clients
          |
       kb start
 dashboard + REST + HTTP MCP
          |
  same SQLite and vault
```

`kb serve` is the optional resident MCP and hook daemon. It does not host the
dashboard. `kb start` is the separate HTTP process. The HTTP server binds to
`127.0.0.1` by default; intentional remote access requires an explicit
`KB_HOST`, authentication, and a TLS-terminating reverse proxy.

See [Resident daemon setup](docs/daemon-setup.md) for restart behavior and
service definitions.

## Scheduled maintenance

Setup installs these four jobs:

- **03:30 daily — harvest:** extract durable lessons and fold state notes;
- **every 5 minutes — reindex:** sync vault Markdown into FTS and embeddings;
- **04:00 Sunday — synthesis:** surface themes, contradictions, and merge
  candidates; and
- **04:15 daily — reconcile:** revisit supported fact/retrieval decisions
  against their source evidence.

On macOS, job logs live under `~/.knowledge-base/logs/`; Linux jobs use the
systemd journal. These jobs may mutate indexed state or vault notes. The
session briefing reports loop health; inspect the logs for per-run details.

## Everyday commands

```bash
node bin/kb.js search "credential cache" # terminal search
node bin/kb.js status                    # store and HTTP server status
node bin/kb.js harvest --dry-run         # preview transcript work
node bin/kb.js capture-follow-through --json # checkpoint outcome report
node bin/kb.js serve --status            # probe the optional daemon
node bin/kb.js start                     # local dashboard/API
node bin/kb.js migrate --check           # read-only schema gate
```

`node bin/kb.js --help` lists maintenance and migration commands. `npm link`
is optional if you prefer the shorter `kb ...` form.

All 26 stdio tools are documented here so clients and maintainers can audit the
surface:

- retrieval: `kb_search`, `kb_search_smart`, `kb_context`, `kb_read`,
  `kb_list`, `kb_tunnels`;
- notes: `kb_write`, `kb_ingest`, `kb_check_duplicate`, `kb_supersede`,
  `kb_supersede_candidates`, `kb_classify`, `kb_extract`, `kb_promote`,
  `kb_synthesize`;
- facts: `kb_fact_add`, `kb_fact_query`, `kb_fact_timeline`,
  `kb_fact_invalidate`;
- capture: `kb_capture_session`, `kb_capture_fix`, `kb_capture_web`,
  `kb_capture_youtube`; and
- operations: `kb_wakeup`, `kb_vault_status`, `kb_safety_check`.

Nineteen non-admin tools, including mutating write and capture tools, are also
available over HTTP; seven administrative tools remain local-only. See
[Skills vs MCP](docs/SKILL-VS-MCP.md) for the complete surface and
[llms.txt](llms.txt) for agent-oriented reference.

`kb_write`, `kb_ingest`, REST ingest, and harvest own their fail-closed
similarity check. `kb_check_duplicate` is an exploratory check, not a mandatory
preflight. The bulk CLI command `node bin/kb.js ingest <path>` instead skips
only filenames it has already imported; it does not silently drop a requested
file because its content resembles an existing note.

## Data, privacy, and backups

- Primary application data lives in `~/.knowledge-base/`.
- The vault path is configured by `OBSIDIAN_VAULT_PATH`; it is plain Markdown.
- Retrieval uses SQLite FTS5 and `all-MiniLM-L6-v2` locally.
- Claude-backed write-time operations can send selected content to your Claude
  provider and can consume provider quota.
- The local HTTP boundary is loopback by default. Remote binding is an operator
  decision, not a setup default.
- Back up both the SQLite data directory and the vault. One is not a complete
  replacement for the other.

## More documentation

- [Onboarding and verification](docs/ONBOARDING.md)
- [Upgrading from 1.x](docs/UPGRADING-2.0.md)
- [Resident daemon](docs/daemon-setup.md)
- [Obsidian and vault layout](docs/OBSIDIAN-SETUP.md)
- [Skills vs MCP](docs/SKILL-VS-MCP.md)
- [Extending tools, schema, and HTTP](EXTENDING.md)
- [Contributing](CONTRIBUTING.md)

CI validates Node 22, 24, and 26. Green CI is not deployment proof: releases,
deploy-line reconciliation, database migration, and daemon rollout are manual
operator steps.

For an update: pull, run `node bin/kb.js migrate --check`, apply pending changes
with `node bin/kb.js migrate`, then restart `kb start` and `kb serve`. Existing
databases fail loudly rather than auto-migrating when opened by newer code.

## Lineage and license

kb-graph began as a fork of
[knowledge-base-server](https://github.com/willynikes2/knowledge-base-server)
by Shawn Daniel, the engine behind [Memstalker](https://memstalker.com). This
fork adds transcript harvesting, state consolidation, fact timelines,
synthesis, push retrieval, and a resident multi-client daemon.

MIT — see [LICENSE](LICENSE). Copyright Shawn Daniel and Uttam Bharadwaj.
