# Onboarding

Requirements: macOS or Linux, Node.js 22/24/26, and an authenticated `claude`
CLI for AI curation. Storage and retrieval remain local; curation commands can
send selected content to the Claude provider. Registry publication is deferred,
so install from source:

```bash
git clone https://github.com/uttambharadwaj/kb-graph.git
cd kb-graph
npm ci
node bin/kb.js setup
node bin/kb.js status
```

Do not use `npm install -g kb-graph`, npx, or a project-local dependency until
a published package is linked from the README. `better-sqlite3` uses a native
binary; when npm has no prebuilt binary for the platform, `npm ci` needs
Python, `make`, and a C/C++ compiler.

Keep a source checkout at a stable path. The generated Docker Compose option
requires an operator-provided Dockerfile. Setup stores mutable state outside
the checkout under
`${KB_DIR:-~/.knowledge-base}`: `.env`, the database, logs, and the
`models/` embedding cache. The model downloads on first semantic use and is not
part of the source tree, so its disk use is additional. Source updates do not
replace that state.

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
`kb register --agents=codex` into `~/.codex/config.toml`. Source users can
replace `kb` with `node bin/kb.js` in these verification commands.

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
- Cursor Desktop: default-off lifecycle queueing from native `stop` and
  `preCompact`; opt in with `KB_DIR/cursor-capture-enabled`. The disable marker
  wins. The Desktop queue-to-indexed-note round trip is proven; `sessionEnd`
  has no usable transcript path, and Cursor CLI/headless lifecycle support is
  not yet proven.
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
preserves generated secrets but rewrites `KB_DIR/.env` from its template; back
up custom variables first.

Storage and retrieval are local. Harvesting and other AI curation invoke the
authenticated Claude CLI and may send selected transcript or note content to
its configured provider.

After a source update, run `node bin/kb.js migrate --check`, apply pending
migrations, and restart configured services and agent sessions. Re-run
`node bin/kb.js setup` and `node bin/kb.js register --force` after moving a
source checkout; prior registrations still point at the old absolute path.
Restart Cursor after re-registration.
