# Onboarding

Requirements: macOS or Linux, Node.js 22/24/26, and an authenticated `claude`
CLI for AI curation. The embedding model downloads on first semantic use.

```bash
git clone https://github.com/uttambharadwaj/kb-graph.git
cd kb-graph
npm ci
node bin/kb.js setup
node bin/kb.js status
```

The project is currently installed from source, not npm. Keep the checkout at a
stable path: setup writes its absolute path into agent registrations and
scheduled jobs.

## Verify the install

Run the checks that match the agents you selected:

```bash
# Store and HTTP server status
node bin/kb.js status

# MCP registration files (run the checks for selected agents)
grep -q 'knowledge-base' ~/.claude.json && echo 'Claude MCP configured'
grep -q 'knowledge-base' ~/.cursor/mcp.json && echo 'Cursor MCP configured'
grep -q 'knowledge-base' ~/.gemini/mcp.json && echo 'Gemini MCP configured'
grep -q '\[mcp_servers.knowledge-base\]' ~/.codex/config.toml \
  && echo 'Codex MCP configured'

# Claude Code hooks: briefing, hints, capture, and trigger checks
grep -c 'wakeup-hook\|prompt-hint\|session-capture-hook\|kb-trigger-hook' \
  ~/.claude/settings.json

# Codex hooks, if selected
grep -c 'wakeup-hook\|prompt-hint\|session-capture-hook\|kb-trigger-hook' \
  ~/.codex/hooks.json

# Cursor session-start briefing, if selected
grep -c 'wakeup-hook' ~/.cursor/hooks.json

# Four scheduled jobs
launchctl list | grep 'com.kb.'                         # macOS
systemctl --user list-timers | grep 'kb-'               # Linux
```

Expect jobs named `harvest`, `reindex`, `synthesis`, and `reconcile`. Codex MCP
registration is hand-managed: paste the block printed by
`node bin/kb.js register --agents=codex` into `~/.codex/config.toml`.

Lifecycle hooks enqueue capture requests; processing that queue requires the
optional resident daemon described in
[daemon-setup.md](daemon-setup.md). The nightly transcript sweep still runs
without it.

Open a new configured agent session. Claude Code, Codex, and Cursor should show
a **KB BRIEFING**. Then ask the agent to save a synthetic onboarding note and
verify it:

```bash
node bin/kb.js search onboarding
```

## What runs automatically

- Session start: briefing for Claude Code, Codex, and Cursor.
- Every prompt: sparse hints for Claude Code and Codex only.
- Before relevant shell commands: advisory or explicitly pinned trigger checks
  for Claude Code and Codex only.
- 03:30 daily: best-effort transcript harvest from Claude Code, Codex, and
  Cursor.
- Every 5 minutes: vault reindex and local embeddings.
- Sunday 04:00: weekly synthesis.
- 04:15 daily: reconciliation against source evidence.

Harvest skips short, active, subagent, and print-mode sessions by default and
caps work per run. Use `/debrief` after substantial sessions when you want
immediate, deliberate capture. Set `KB_HARVEST_SDK_SESSIONS=1` to include
print-mode sessions. If you change it or `KB_HARVEST_FACTS`, rerun setup so the
scheduled job receives the new value.

## Logs and troubleshooting

Scheduled-job logs live in `~/.knowledge-base/logs/` on macOS. On Linux:

```bash
journalctl --user -u kb-harvest.service
journalctl --user -u kb-reindex.service
journalctl --user -u kb-synthesis.service
journalctl --user -u kb-reconcile.service
```

`setup` reports individual failures and can finish with a partial installation.
Read its summary rather than assuming every step succeeded. Re-running setup
preserves generated secrets but rewrites `.env` from its template; back up
custom variables first.

Storage and retrieval are local. Harvesting and other AI curation invoke the
authenticated Claude CLI and may send selected transcript or note content to
its configured provider.
