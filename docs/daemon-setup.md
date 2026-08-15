# Running the resident daemon (`kb serve`)

Optional, and worth it once you run more than a couple of concurrent agent
sessions. Without it, every session runs its own full KB server process
(embedding model included) and every hook pays cold-start; with it, one
resident daemon owns the database and the warm state, sessions attach through
`kb mcp-shim` (a thin byte pipe), and hooks answer over a control socket in
milliseconds.

Nothing else changes: `kb register` already points agents at `mcp-shim`, which
probes the daemon socket for ~2s and runs a full server in-process when
nothing answers. Setting the daemon up later — or tearing it down — requires
no re-registration.

## Sockets and logs

| Path | What |
|------|------|
| `~/.knowledge-base/daemon.sock` | MCP sessions (via `kb mcp-shim`) |
| `~/.knowledge-base/daemon-ctl.sock` | Hooks (prompt-hint / trigger-hook / wakeup-hook) |
| `~/.knowledge-base/logs/hook-timings.log` | Abnormal hook tail: kills and ≥2s completions |

Probe a running daemon with `kb serve --status`.

## Environment: PATH and CLAUDE_PATH (read this even if nothing else)

Service managers start the daemon with a minimal environment — **not** your
shell's PATH. `kb_extract` shells out to the `claude` CLI; under a bare PATH
every chunk fails with `spawn claude ENOENT` and the extraction comes back
empty while looking well-formed. Set both variables in the service definition:

- `PATH` — must include your node install and the directory holding `claude`
- `CLAUDE_PATH` — absolute path to the `claude` binary (takes precedence)

The templates below include both. Fill in the placeholder paths (`which node`,
`which claude`).

## macOS — launchd

`~/Library/LaunchAgents/com.kb.serve.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.kb.serve</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/node</string>
        <string>/path/to/kb-graph/bin/kb.js</string>
        <string>serve</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/kb-graph</string>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>/Users/YOU/.knowledge-base/logs/kb-serve.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOU/.knowledge-base/logs/kb-serve.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/path/to/node-bin-dir:/path/to/claude-bin-dir:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>CLAUDE_PATH</key>
        <string>/path/to/claude</string>
    </dict>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kb.serve.plist
kb serve --status   # up — ~/.knowledge-base/daemon.sock
```

## Linux — systemd (user unit)

`~/.config/systemd/user/kb-serve.service`:

```ini
[Unit]
Description=kb-graph resident MCP daemon

[Service]
ExecStart=/path/to/node /path/to/kb-graph/bin/kb.js serve
WorkingDirectory=/path/to/kb-graph
Restart=always
RestartSec=10
Environment=PATH=/path/to/node-bin-dir:/path/to/claude-bin-dir:/usr/bin:/bin
Environment=CLAUDE_PATH=/path/to/claude
StandardOutput=append:%h/.knowledge-base/logs/kb-serve.log
StandardError=append:%h/.knowledge-base/logs/kb-serve.err

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now kb-serve
kb serve --status
```

## Restarting after code updates

The daemon deliberately does **not** watch `src/` — a resident service
restarts, it does not hot-swap itself. After pulling or editing code:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.kb.serve
# Linux
systemctl --user restart kb-serve
```

Cold start can take several seconds (embedding model load) — `kb serve
--status` may briefly report down right after a restart. Sessions attached
through the shim lose their pipe on restart; reconnect the MCP server in the
session (or start a new one). Hooks need nothing: they fall back in-process
until the daemon is back.

Pending migrations gate startup the same way they gate `kb mcp` — run
`kb migrate` after updates that change schema (`kb migrate --check` tells you).
