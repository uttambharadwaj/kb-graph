# kb-graph

**A memory that tends itself, for AI agents that forget.**

kb-graph gives every AI agent you run — Claude Code, Codex, Gemini, anything speaking MCP — one shared brain that compounds. The difference from other memory systems is the loop: your agents' session transcripts are **harvested automatically every night** into facts, lessons, and decisions; per-workstream **state notes** are folded so "where is X?" always has one current answer; a **weekly synthesis** surfaces themes and contradictions; and hooks **push the relevant slice back into every new session** before you type a word. You don't have to remember to save anything, and your agents don't have to remember to search.

> kb-graph began as a fork of [knowledge-base-server](https://github.com/willynikes2/knowledge-base-server)
> by Shawn Daniel — the engine behind [Memstalker](https://memstalker.com) — and has
> since been substantially rebuilt around transcript harvesting, per-workstream state
> notes, and synthesis loops.

## Quickstart

```bash
git clone https://github.com/uttambharadwaj/kb-graph.git
cd kb-graph
npm install
node bin/kb.js setup
```

Setup registers the MCP server with your agents, installs Claude Code hooks
(a KB briefing at session start, knowledge hints on every prompt), schedules
the nightly harvest / reindex / weekly synthesis jobs, installs the bundled
`/debrief` and `kb-workflow` skills, and creates a markdown vault at
`~/kb-vault` if you don't have one. Obsidian is an optional viewer — the
vault is plain markdown.

Open a new Claude Code session: you should see your first **KB BRIEFING**.

Onboarding a teammate? Send them [docs/ONBOARDING.md](docs/ONBOARDING.md).

---

## Why

AI agents are stateless. Every session starts from zero: re-explaining the architecture, re-discovering the gotcha that cost you three hours last month, watching a second agent repeat the first one's mistake.

Most memory systems fix this with discipline — *remember to save notes, remember to search them*. Discipline doesn't survive a deadline. kb-graph is built on the opposite bet: **the loop must run even when nobody remembers to run it**. Capture is a scheduled job reading transcripts you already produced. Retrieval is a hook that fires before your prompt is even answered. The human's only job is to occasionally read what the system wrote.

## The loop

### 1. Push, not pull

Two Claude Code hooks (installed by `kb setup`) mean your agent never starts cold:

- **Session start — the briefing.** Every new session opens with a KB BRIEFING: active workstreams (with pointers to their state notes), recently captured knowledge, and a health heartbeat so you know the loops behind the scenes are actually running.

- **Every prompt — hints.** A `UserPromptSubmit` hook matches your prompt against the KB and injects hint lines:

  ```
  KB HINT: the knowledge base has entries relevant to this prompt:
  #412 "Pydantic Settings rejects extra env vars from .env" (lesson);
  #367 "Why we moved auth to per-request tokens" (decision).
  Check them with kb_read(id) before exploring from scratch.
  ```

  The agent reads two short notes instead of re-deriving context from the codebase.

Pull still works — `kb_search` (BM25), `kb_search_smart` (hybrid keyword + semantic), `kb_context` (token-efficient briefing) — and when ranking misses, the vault is plain markdown on disk: grep it directly.

### 2. Capture that doesn't rely on discipline

- **Nightly harvest (03:30).** A scheduled job reads your agents' session transcripts and extracts the durable parts — facts, lessons, decisions, fixes — as structured notes, deduplicated against what the KB already knows (`kb_check_duplicate` runs before every write). You debugged something gnarly at 2am and told no one? The harvest caught it.

- **Deliberate capture — `/debrief`.** At the end of a substantial session, run the bundled `/debrief` skill (installed to `~/.claude/skills/` by setup): it scans the conversation for lessons, decisions, workflows, and state changes, checks each against what the KB already knows, and writes the survivors with you approving the list. Deliberate capture is higher quality — better titles, richer context, immediately available; the nightly harvest is the safety net for everything you didn't capture deliberately. The companion `kb-workflow` skill teaches agents the retrieval-then-capture pattern for use mid-session, and `kb_capture_session` / `kb_capture_fix` / `kb_write` are the direct tools underneath both.

- **Entity facts.** Alongside prose notes, a lightweight fact store tracks `(subject, predicate, object)` triples with validity windows: `kb_fact_add`, `kb_fact_query`, `kb_fact_timeline` ("how did our auth approach evolve?"), `kb_fact_invalidate` (supersede without deleting history).

### 3. State notes, not stale sessions

Session notes pile up; the truth about a workstream drifts across twenty of them. Every night, the consolidation pass **folds recent session notes into one mutable state note per workstream** and retypes the absorbed sessions to `archive` (still searchable, no longer masquerading as current). Asking "where is the auth work?" reads one note that is current as of last night — not an archaeology dig.

### 4. Weekly synthesis (Sunday 04:00)

A synthesis job reads the week's knowledge and writes what a good tech lead would notice: recurring themes, **contradictions** (two notes claiming different things about the same system), and merge candidates (near-duplicate clusters worth folding together). The KB doesn't just accumulate — it argues with itself and flags where it disagrees. It also lists the week's strongest **cross-domain tunnels** (see [Tunnels](#tunnels)).

## A day with kb-graph

- **9:00** — You open Claude Code. The briefing lists your active workstreams and notes last night's harvest ran clean.
- **9:05** — You ask about a login bug. A KB HINT points at a three-week-old lesson: this exact failure was a stale credential cache. Twenty minutes saved.
- **11:30** — Your agent fixes something subtle and captures it with `kb_capture_fix` on its way out.
- **03:30** — The harvest reads today's transcripts, extracts two lessons and a decision you never explicitly saved, and folds today's sessions into the workstream's state note.
- **Sunday 04:00** — The synthesis flags that Tuesday's note contradicts what March-you decided about retry behavior. You resolve it in one line.

Every agent you run shares all of it. What Claude learns at 2am, Codex knows at 9am.

## Tunnels

Everything above files knowledge by domain. Tunnels walk *between* domains. Ask `kb_tunnels` about one tag and it ranks the neighboring domains that most often co-occur with it — scored by **lift** (co-occurrence weighted against how common each tag is on its own), so a catch-all tag never floats to the top just by being everywhere. Ask about two tags and it returns the bridge itself: the notes tagged with **both**, plus the fact-store entities **mentioned in both** domains' notes, ranked by how specific each name is to the bridge (corpus-common names that show up everywhere are downweighted, the same way lift discounts catch-all tags) — the shared services, people, and systems that quietly connect two areas of work you thought were separate. Tags are canonicalized first — lowercased and deduped on every write, with `kb tags alias <alias> <canonical>` to fold synonyms like `auth` and `authentication` into one domain — so the graph isn't fragmented by spelling. The weekly synthesis lists the strongest tunnels each week; `kb tags` reports the raw tag landscape and suggests aliases worth adding.

## Design principles

- **Files first.** Every note is plain markdown with frontmatter in a directory you own. Obsidian renders it beautifully but is optional. When search ranking fails, `grep` is the fallback — an agent can always inspect the raw store.
- **No LLM in the read path.** Retrieval is SQLite FTS5 (BM25) + local embeddings (all-MiniLM-L6-v2, runs on your machine) fused at query time. LLM calls are spent at write time — classification, extraction, synthesis — where latency doesn't hurt.
- **Self-tending, and honest about it.** Embeddings, harvest, consolidation, and synthesis run on schedules. The briefing carries a health heartbeat; if a loop stops running, you see ⚠ at your next session start instead of discovering silent rot months later.
- **No external services.** SQLite, local embeddings, your filesystem. Nothing leaves your machine unless you expose the REST API yourself.

## Architecture

```
                    +----------------------------+
                    |         AI Agents          |
                    |  Claude Code | Codex       |
                    |  Gemini      | any MCP/HTTP|
                    +-------------+--------------+
        hooks: briefing + hints   |   MCP (stdio/HTTP) · REST /api/v1/
                    +-------------+--------------+
                    |         KB Server          |
                    |       Express :3838        |
                    +-------------+--------------+
                                  |
          +-----------------------+----------------------+
          |                       |                      |
 +--------+--------+   +---------+---------+   +--------+--------+
 | SQLite + FTS5   |   | Local embeddings  |   | Markdown vault  |
 | documents/facts |   | all-MiniLM-L6-v2  |   | (Obsidian-      |
 | doc_links       |   | hybrid ranking    |   |  compatible)    |
 +-----------------+   +-------------------+   +-----------------+

 Scheduled jobs (installed by kb setup):
   harvest    nightly 03:30  — transcript extraction + state-note folding
   reindex    every 5 min    — vault → index + embeddings
   synthesis  Sunday 04:00   — themes, contradictions, merge candidates
```

Data directory: `~/.knowledge-base/` (`kb.db`, ingested file copies, config).

---

## Detailed setup

### Prerequisites

- Node.js >= 18.0.0
- That's it. No external databases, no Docker, no cloud dependencies.

### Install

```bash
git clone https://github.com/uttambharadwaj/kb-graph.git
cd kb-graph
npm install
npm link        # optional: makes `kb` available on PATH
```

### First run (interactive wizard)

```bash
kb setup
```

The wizard detects your environment, asks which AI agents you use, writes `.env`, registers MCP, installs the hooks and scheduled jobs, and creates your vault. About 60 seconds.

Agent-driven installation (no prompts):

```bash
kb setup --auto --password=yourpass --vault=~/kb-vault --agents=claude,codex
```

Re-running setup is safe: existing secrets (password, auth secret, API keys) are preserved, and hooks are never duplicated. Note that `.env` is rewritten from its template — if you hand-added custom variables, back them up first.

### Manual pieces

```bash
KB_PASSWORD=yourpassword kb start    # dashboard + REST API on :3838
kb register                          # MCP registration only
kb ingest ~/kb-vault                 # ingest a directory
kb search "docker networking"        # search from the terminal
kb status                            # stats and server status
```

---

## MCP tools

All 24 core tools are available over stdio and HTTP:

| Tool | Description |
|------|-------------|
| `kb_search` | Full-text search, BM25 ranking, highlighted snippets |
| `kb_search_smart` | Hybrid keyword + semantic search for conceptual queries |
| `kb_context` | Token-efficient briefing — summaries only; use before `kb_read` |
| `kb_read` | Read a document by ID (returns a `related:` neighborhood) |
| `kb_list` | List documents by type or tag |
| `kb_tunnels` | Cross-domain bridges: neighboring domains for one tag, or the shared notes + entities between two |
| `kb_write` | Write a note to the vault |
| `kb_ingest` | Ingest raw text |
| `kb_check_duplicate` | Similarity check before writing — prevents near-duplicate notes |
| `kb_classify` | Auto-classify unprocessed notes (type, tags, summary) |
| `kb_extract` | Extract structured facts/lessons from raw text or transcripts |
| `kb_promote` | Promote raw source into structured knowledge |
| `kb_synthesize` | Cross-source synthesis of recent knowledge |
| `kb_fact_add` | Add an entity fact (subject/predicate/object + validity) |
| `kb_fact_query` | Query facts about an entity |
| `kb_fact_timeline` | How an entity's facts evolved over time |
| `kb_fact_invalidate` | Supersede a fact, preserving history |
| `kb_capture_session` | Record a coding/debugging session |
| `kb_capture_fix` | Record a bug fix: symptom, cause, resolution |
| `kb_capture_web` | Capture a web article |
| `kb_capture_youtube` | Capture a YouTube transcript |
| `kb_wakeup` | The session briefing (what the SessionStart hook calls) |
| `kb_vault_status` | Vault indexing stats |
| `kb_safety_check` | Review a destructive action against KB history |

An experimental local message bus for cross-agent coordination (`bus_send`, `bus_read`, `bus_status`, and friends) ships alongside — see [docs/message-bus.md](docs/message-bus.md).

## CLI commands

```
kb setup               Setup wizard (--auto for agent mode)
kb start / stop        Dashboard + REST API server (default :3838)
kb mcp                 MCP stdio server (what your agents connect to)
kb register            Register MCP with Claude Code / Codex / Gemini
kb harvest             Run the transcript harvest now (normally nightly)
kb consolidate-state   Fold session notes into workstream state notes
kb vault reindex       Reindex the vault (embeddings included)
kb ingest <path>       Ingest a file or directory
kb search <query>      Search from the terminal
kb classify            Auto-classify unprocessed vault notes
kb summarize           Generate summaries for unsummarized notes
kb entity-merge        Merge two entity aliases in the fact store
kb tags                Tag report; 'tags alias <a> <b>' / 'tags aliases' to manage aliases
kb status              Stats and server status
```

---

## Multi-agent setup

### Claude Code, Codex, Gemini (MCP)

```bash
kb register    # writes to ~/.claude.json, ~/.codex/mcp.json, ~/.gemini/mcp.json
```

Any other MCP client — point it at the stdio transport:

```json
{
  "mcpServers": {
    "knowledge-base": {
      "command": "node",
      "args": ["/path/to/kb-graph/bin/kb.js", "mcp"]
    }
  }
}
```

### ChatGPT and remote agents (REST)

1. Import the OpenAPI spec from your server's `/openapi.json`
2. Authenticate with an `X-API-Key` header (keys live in `.env`)

Endpoints under `/api/v1/`: `search`, `search/smart`, `context`, `documents`, `ingest`, `capture/session`, `capture/fix`, `capture/web`.

All agents share one brain: what one learns in a session, the others have in their next.

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KB_PASSWORD` | Yes (first run) | — | Dashboard login password |
| `KB_PORT` | No | 3838 | HTTP server port |
| `OBSIDIAN_VAULT_PATH` | No | — | Vault path (any markdown directory) |
| `CLAUDE_PATH` | No | `claude` on PATH | Claude CLI binary, used by harvest/classification |
| `CLASSIFY_MODEL` | No | claude-haiku-4-5-20251001 | Model for write-time AI work |
| `KB_API_KEY_CLAUDE` / `_OPENAI` / `_GEMINI` | No | — | API keys for remote REST access |
| `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` | No | — | OAuth for remote access |
| `KB_TICKET_REGEX` | No | `pf-(\d+)` | Workstream autobind: regex that recognizes ticket ids in directory/branch names. Full match (lowercased) becomes the bus channel name |

## Running as a service

`kb setup` installs the scheduled jobs automatically (launchd on macOS, systemd user timers on Linux). To run the dashboard/API server itself as a Linux service, use `kb-server.service.example` or pick "systemd" in the wizard. Logs: `journalctl -u kb-server -f` (server) and `journalctl --user -u kb-harvest.service` or `/tmp/kb-*.log` on macOS (jobs).

## Workflow templates

`docs/workflow/` contains the operating contracts this system was built with — `CLAUDE.md.template`, `AGENTS.md.template`, and `SELF-LEARNING.md` (the full methodology). Copy them into your projects and customize: they tell your agents when to search the KB, when to capture, and how the compounding loop works.

---

## Lineage & credits

The storage engine, dashboard, REST/MCP surface, and setup wizard come from [knowledge-base-server](https://github.com/willynikes2/knowledge-base-server) by [Shawn Daniel](https://github.com/willynikes2), who runs the hosted [Memstalker](https://memstalker.com) on the same foundation — if you want this as a managed service, that's where to look. This fork rebuilds the intelligence layer around automatic transcript harvesting, per-workstream state consolidation, entity-fact timelines, weekly synthesis, and push-retrieval hooks, and was itself built by the agents it serves.

*"You gotta 100-shot 10 apps before you can 1-shot 10 apps."* — Shawn Daniel

## Roadmap

- [ ] Entity-boosted retrieval ranking (fact-store entities as a fusion signal)
- [ ] Bi-temporal facts: track "when it stopped being true" separately from "when we learned that"
- [ ] Novelty-gated writes: embedding pre-filter before LLM classification

## License

MIT — see [LICENSE](LICENSE). Copyright Shawn Daniel and Uttam Bharadwaj.
