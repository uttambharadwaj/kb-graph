# Upgrading to 2.0

Version 2.0 removes the local cross-agent message bus. The knowledge graph,
retrieval tools, lifecycle capture, and resident daemon remain.

## Before upgrading

Stop long-lived `bus-notifier` and `bus-agentd` processes and remove any service
that restarts them before taking a backup. SQLite's `-wal` file may contain
committed messages while a writer is active.

If historical bus messages matter, archive the configured home and database.
The defaults below also honor `KB_BUS_HOME` and `KB_BUS_DB_PATH`:

```bash
bus_home="${KB_BUS_HOME:-$HOME/.claude/bus}"
bus_db="${KB_BUS_DB_PATH:-$bus_home/bus.db}"
archive_dir="$(mktemp -d)"

if [ -d "$bus_home" ]; then
  cp -a "$bus_home" "$archive_dir/bus-home"
fi
if [ "$bus_db" != "$bus_home/bus.db" ]; then
  for file in "$bus_db" "$bus_db-wal" "$bus_db-shm"; do
    [ ! -e "$file" ] || cp -a "$file" "$archive_dir/"
  done
fi

tar -czf "kb-bus-$(date +%Y%m%dT%H%M%S).tar.gz" -C "$archive_dir" .
rm -rf "$archive_dir"
```

The archive is for manual retention only. Version 2.0 does not read or migrate
the old bus database.

## Removed interfaces

- MCP tools beginning with `bus_`, including `bus_send`, `bus_read`, and
  `bus_status`
- CLI commands and package binaries beginning with `bus-`
- bus MCP resources, hooks, notifier processes, and migration checks

Remove any hand-written `bus-*` commands from `~/.claude/settings.json`,
`~/.codex/hooks.json`, shell startup files, and local service definitions. Stop
any remaining bus processes before deleting the old store.

## Refresh the KB integration

From the 2.0 checkout:

```bash
npm ci
node bin/kb.js setup
node bin/kb.js register
```

Paste the Codex registration block printed by `node bin/kb.js register` into
`~/.codex/config.toml`, then restart each agent host so it reloads hooks and MCP
configuration.

Generated hook and MCP commands now clear inherited `NODE_OPTIONS`. Session
capture also enforces owner-only permissions on its queue and receipt directories
when possible.

## Verify

```bash
node bin/kb.js status
node bin/kb.js serve --status
```

Start a fresh agent session and confirm that the KB briefing appears and
`kb_search` is available. If an old bus command still runs, remove the stale
hook or service that launches it; 2.0 intentionally provides no compatibility
shim.

## Rollback

Check out the exact 1.x commit you used before upgrading and restore the
archived bus data if the bus is still required. The public repository does not
currently publish a 1.x release tag. This release does not add a knowledge-base
schema migration, so the graph itself does not need to be downgraded.
