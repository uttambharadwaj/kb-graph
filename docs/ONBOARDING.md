# Onboarding (10 minutes)

Prereqs: Node ≥18, Claude Code installed (`claude` on PATH), macOS or Linux.

1. `git clone https://github.com/uttambharadwaj/kb-graph.git && cd kb-graph`
2. `npm install`
3. `node bin/kb.js setup` — answer the prompts (defaults are fine).
4. Open a new Claude Code session. You should see a **KB BRIEFING** block.

## Verify your install

| Check | Command | Expect |
|-------|---------|--------|
| MCP registered | `claude mcp list` | `knowledge-base` listed |
| Hooks installed | `grep -c "wakeup-hook\|prompt-hint" ~/.claude/settings.json` | ≥2 |
| Jobs scheduled (macOS) | `launchctl list \| grep com.kb` | harvest, reindex, synthesis |
| Jobs scheduled (Linux) | `systemctl --user list-timers \| grep kb-` | 3 timers |
| First capture works | ask Claude: "save a note that onboarding worked" then `node bin/kb.js search onboarding` | your note |

> Caution: re-running `node bin/kb.js setup` preserves your password, auth secret, and
> API keys, but rewrites `.env` from its template — custom variables you added by hand
> get dropped. Back up `.env` first if you've customized it.

## Build the habit

One habit makes this system compound: **end substantial sessions with `/debrief`**. It scans the conversation for lessons, decisions, and state changes, shows you the list, and saves what you approve. The nightly harvest catches what you skip — but deliberate capture is what makes next month's briefings good.

## What runs when

- **Session start:** briefing of active workstreams + KB health.
- **Every prompt:** hint lines pointing at relevant KB entries.
- **Nightly 03:30:** harvest — extracts facts/lessons from your agent transcripts.
- **Every 5 min:** vault reindex (embeddings + search index).
- **Sunday 04:00:** weekly synthesis — themes, contradictions, merge candidates.

If something doesn't appear, check the job logs:
- **macOS (launchd):** `/tmp/kb-*.log` and `/tmp/kb-*.err`.
- **Linux (systemd):** `journalctl --user -u kb-<job>.service` (jobs: `kb-harvest`, `kb-reindex`, `kb-synthesis`).
