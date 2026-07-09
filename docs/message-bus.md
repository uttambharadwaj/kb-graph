# Local message bus

The knowledge-base MCP server now includes a **local-only message bus** for agent-to-agent coordination across Claude Code, Codex, Gemini, and shell scripts.

## What ships

- MCP tools: `bus_send`, `bus_read`, `bus_status`
- MCP resource template: `bus://{channel}`
- CLI shims: `bus-send`, `bus-read`, `bus-status`, `bus-session`, `bus-gateway`, `bus-agent`, `bus-agentd`, `bus-hook`, `bus-bind` / `bus-unbind`, `bus-hook-current`, `bus-autobind`
- Shared append-only SQLite storage at `~/.claude/bus/bus.db`
- Typed envelope columns on `bus_messages`: `thread`, `reply_to`, `recipient`, `deadline`, `expects_reply` (all first-class `bus_send` params)
- Presence folded into `bus_readers` (`last_hook_at`, `capabilities_json`) — refreshed on every hook fire

Because this is an extension of `kb mcp`, you do **not** need a second MCP server if KB is already registered. Any client already pointed at `kb mcp` gets the bus tools automatically on next restart.

Run `kb register` to update local Claude/Codex/Gemini MCP configs in one shot, then restart the sessions that should gain `bus_send`.

## Channel naming

Use free-form channel IDs with stable prefixes.

For parent-agent collaboration on a single workstream, prefer:

- `ws:ticket-42`
- `ws:auth-m2`
- `ws:browser-profile-setup`

Other useful patterns:

- `ticket:TICKET-42`
- `session:3d74f5b1`
- `swarm:frontend-refactor`
- `deploy:my-app-sandbox`

Recommended sender identities for cross-model parent agents:

- `claude:<role>`
- `codex:<role>`
- `gemini:<role>`

Examples:

- `claude:architect`
- `codex:implementer`
- `gemini:reviewer`

For readability, keep spawned subagents private to their parent and have only the parent agent summarize important updates onto the shared workstream channel.

## Message kinds

Use the `kind` field to make intent scannable at a glance. Conventions for parent-agent workstream coordination:

- `sync` — role announcement or mid-stream state check-in
- `heartbeat` — liveness marker during active work; include `status`, `step`, and `files_touched` metadata when useful
- `status` — lightweight progress update, still accepted as a heartbeat-compatible kind for status displays
- `question` — request for clarification; set `expects_reply` and a deadline when it gates work
- `decision` — a call made, with rationale (architectural, scope, trade-off)
- `handoff` — work is transitioning to another agent
- `artifact` — produced output (plan, diff, doc); include `diff_since_last_ack` so reviewers can see additions/removals since the last acknowledged checkpoint
- `ack` — explicit checkpoint response to an artifact/question/control message; include `ack_decision` (`accepted`, `needs_changes`, or `blocked`) and `ack_message_id`
- `control` — priority operator command (`pause`, `stop`, `redirect`, or `resume`) for the other parent to honor on its next bus check
- `blocked` — waiting on a dependency or decision; needs attention
- `done` — a milestone or the workstream itself is complete

`message` and `result` remain the generic fallbacks for less-structured traffic.

Protocol metadata is normalized onto the returned `protocol` object when present: `status`, `step`, `files_touched`, `diff_since_last_ack`, `ack_decision`, `ack_message_id`, `control_command`, `tests`, and `risk`. These stay in `metadata_json` instead of schema columns because they are protocol hints, not routing/index fields.

## Envelope fields

These are first-class columns on `bus_messages` and accepted directly as `bus_send` parameters. Prefer them over stuffing routing hints into `metadata_json`:

- `recipient` — intended recipient reader id, or `"*"` for broadcast
- `thread` — topic or subthread identifier (free-form, e.g. `"startup"`, `"review-round-2"`)
- `reply_to` — the `id` of the message you're responding to
- `deadline` — ISO-8601 timestamp the sender expects a reply by
- `expects_reply` — `true` when the sender is waiting; receivers should prioritize these

`metadata_json` is still supported for arbitrary unstructured hints (model version, branch name, etc.), but the five fields above must not live there — they drive hook-digest filtering and presence semantics.

### `to_reader` — deprecated, read-fallback only

`to_reader` was the V1/V2 name for what is now `recipient`. It remains accepted on both `bus_send` and hook-digest filtering as a **read-fallback compatibility path** — when `recipient IS NULL`, the reader falls back to `to_reader`. New code must use `recipient`. The `to_reader` column on `bus_messages` will be dropped in a future migration once no in-flight readers depend on it.

## Recommended flow

### From an external script / Codex shell

```bash
bus-send ticket:TICKET-42 "Implementation finished. Tests passed." \
  --sender codex \
  --kind result \
  --metadata '{"model":"gpt-5.4","branch":"alice/ticket-42-message-bus"}'
```

### From an MCP client

**Recommended agent read path — `bus_read`:**

- `bus_read(channel, reader, wait?, timeout_ms?, limit?, peek?)` — fetch new messages for `reader` since its stored cursor and advance that cursor in one call.
  - Non-blocking by default; pass `wait=true` to long-poll (defaults: `timeout_ms=30000`, max `300000`).
  - Pass `peek=true` to inspect without advancing the stored cursor.
  - Cursor is stored in SQLite keyed by `(reader, channel)`, so `reader` must be a stable label (e.g. `"claude:architect"`).

**Core primitives:**

- `bus_send(channel, sender, message, kind?, thread?, reply_to?, recipient?, deadline?, expects_reply?, to_reader?, metadata_json?)` — write. `to_reader` is deprecated; pass `recipient` instead.
- `bus_read(channel, reader, wait?, timeout_ms?, limit?, peek?)` — stateful read for a named reader
- `bus_status(channel, readers?)` — inspect readers, unread backlog, latest heartbeat/status per participant, and latest control message

Advance semantics (V1): `bus_read` commits the cursor as soon as messages are returned (read-commit). If at-least-once processing becomes necessary, a future `bus_ack` can decouple read from commit.

### Hook bridge (V2)

`kb bus-hook <channel> --reader <name>` emits a sanitized digest for hook systems using a separate notify cursor from `bus_read`.

- `last_seen_id` tracks explicit `bus_read` consumption
- `notify_cursor` tracks which messages have already been surfaced as hook hints
- explicit `bus_read` advances both cursors so stale hook reminders do not repeat
- `--dry-run` lets a hook preview pending messages without advancing `notify_cursor`

See [`docs/bus-hooks.md`](./bus-hooks.md) for wiring examples.

### Notifier daemon + pending-digest (V3+)

A background `bus-notifier --daemonize` process (one per `(agent, cwd)`) polls the workspace binding's subscriptions at `KB_BUS_NOTIFIER_INTERVAL_MS` (default 1000 ms) and maintains a **pending-digest file** that hooks can read instantly:

- **Pending file:** `~/.claude/bus/pending/<agent>-<cwd-hash>.json` — fresh digest + total_new + channels list
- **PID file:** `~/.claude/bus/notifiers/<agent>-<cwd-hash>.pid` — used to detect liveness and avoid spawning duplicate daemons

`bus-hook-current --pending-only` reads the pending file instead of querying SQLite. This is the fast path used by `SessionStart` / `UserPromptSubmit` / `Stop` hooks: digest is already computed, hook fires return in milliseconds.

When the daemon sees no mail for a workspace, it clears the pending file. `--pending-only` then returns empty, and hooks emit `{}` cleanly without false positives.

Lifecycle:

- **Startup:** `bus-notifier --daemonize` is wired into `SessionStart` and `UserPromptSubmit` hooks. Idempotent — if a live PID already exists, returns without forking.
- **Liveness:** consumers (e.g. Stop hook) should check `readBusNotifierPid` and re-launch if the PID is stale. Future work (`kb bus-host-hook`) consolidates this check.
- **Shutdown:** the daemon is detached and `unref`'d; it survives parent session exit. Restart the host or kill the PID to stop it.

Architectural roles (post-notifier):

- **Bus** = shared state / append-only log
- **Notifier** = event detector / pending cache
- **Host hooks** = turn-boundary bridge
- **Wake-from-true-idle** = host limit; not solvable in bus-core

### Generic workspace binding

The generalized local workflow is:

1. bind the current workspace to one or more workstreams:
   - `bus-bind ws:ticket-43 --reader codex:implementer --agent codex`
   - `bus-bind ws:ticket-44 --reader codex:implementer --agent codex`
   - `bus-bind ws:ticket-43 --reader claude:architect --agent claude`
2. wire host hooks once to `bus-hook-current`
3. let `bus-hook-current` resolve all channel + reader subscriptions from the current workspace binding file

This is the replacement for proof-of-concept fixed-channel hook commands.

Bindings are cwd-scoped with nearest-ancestor lookup, so a bind at repo root still applies when the session later runs from `src/` or another subdirectory.

### Heartbeats, checkpoints, and control

Use this pattern for long cross-model workstreams:

```bash
bus-send ws:ticket-42 "Still on step 2/5; no blocker." \
  --sender codex:implementer \
  --kind heartbeat \
  --status working \
  --step 2/5 \
  --files src/bus/service.js,tests/bus.test.js

bus-send ws:ticket-42 "Artifact ready for architect review." \
  --sender codex:implementer \
  --kind artifact \
  --diff-since-last-ack "Added bus_status; no deletions." \
  --tests "node --test tests/bus.test.js" \
  --risk low

bus-send ws:ticket-42 "Accepted; commit it." \
  --sender claude:architect \
  --kind ack \
  --ack-decision accepted \
  --ack-message-id 42

bus-send ws:ticket-42 "Pause before commit; reviewing hidden regression risk." \
  --sender claude:architect \
  --kind control \
  --control-command pause \
  --recipient codex:implementer
```

When a peer goes quiet, inspect status instead of guessing:

```bash
bus-status ws:ticket-42 --reader claude:architect --reader codex:implementer
```

`bus-status` reports unread backlog, hook-derived presence (`live`, `stale`, `unknown`), the latest heartbeat/status per participant, and the latest `control` message. This makes "Claude is asleep" vs "Claude has backlog" vs "Claude is actively working" visible.

### Gateway sessions and delivery

The bus itself remains durable memory; `bus-gateway` is the local delivery owner. Register each parent session once, then run gateway passes to create hook-pending deliveries for wake-worthy traffic:

```bash
bus-session register ws:ticket-42 \
  --reader codex:implementer \
  --agent codex \
  --adapter hook \
  --cwd "$PWD"

bus-session register ws:ticket-42 \
  --reader claude:architect \
  --agent claude \
  --adapter hook \
  --cwd "$PWD"

bus-gateway ws:ticket-42 --once
# or keep it running locally:
bus-gateway --channel ws:ticket-42 --serve --interval-ms 1000
```

`bus-session register` stores a row in `bus_sessions`. For `adapter=hook`, it also writes the normal workspace binding so existing `bus-hook-current --pending-only` hooks can surface the gateway's pending digest.

`bus-gateway` records attempted delivery in `bus_deliveries` and only routes attention-worthy messages by default:

- direct `recipient` messages
- `question` / `control` / `announce` / `handoff` / `blocked`
- `expects_reply=true`
- metadata `needs_attention=true`

Heartbeats and ordinary chatter stay in the log but do not wake peers by themselves. Current production-safe adapter is `hook`; `noop` is for tests. PTY/tmux injection is intentionally not implemented here because prompt injection into a live terminal misattributes messages and can interrupt tool calls.

### Executable worker daemon

For OpenClaw-style async execution, keep the bus as durable memory and let `bus-agentd` own process launch. Register disposable workers that can be started when a directed task/question arrives:

```bash
bus-agent register ws:ticket-42 \
  --reader codex:implementer \
  --agent codex \
  --adapter exec \
  --cwd "$PWD" \
  --command codex \
  --arg "{prompt}"

bus-agent register ws:ticket-42 \
  --reader claude:architect \
  --agent claude \
  --adapter exec \
  --cwd "$PWD" \
  --command claude \
  --arg "{prompt}"

bus-agentd --channel ws:ticket-42 --serve --interval-ms 1000
```

`bus-agentd` watches wake-worthy bus messages, launches the matching executable once per triggering message, and records outcomes in `bus_runs`. Workers receive a bootstrap prompt containing the channel, reader, triggering message, and instruction to read/post via the bus. This is the preferred "push-like" path for asleep agents because it starts a fresh worker instead of injecting into an arbitrary running terminal.

### Polling pattern

- `bus_read` is the recommended default for agents because it is non-blocking by default and carries a stored per-reader cursor.
- `wait=true` is the only remaining long-poll surface. Reach for it only when you are genuinely idle and blocked on a reply.
- `bus_status` is diagnostic; it does not consume messages.

Agents using `bus_read` get this pattern for free: call with `wait=false` between steps, `wait=true` when idle. Hooks remain the preferred wakeup path when the host supports them.

## Resources

`bus://ticket:TICKET-42` returns the latest messages for that channel as JSON.

If your MCP host supports resource subscriptions, you can subscribe to that URI.

**Delivery semantics remain turn-boundary, not interrupt-driven.** Current Claude Code and Codex hosts do not resume a paused session on message arrival. The practical wakeup path is hook-based (`SessionStart` / `UserPromptSubmit`) plus `bus_read`.

## Storage / retention

- DB path: `~/.claude/bus/bus.db`
- Retention: last `KB_BUS_RETENTION_MESSAGES` per channel (default `200`)
- Poll interval for `bus_read(wait=true)`: `KB_BUS_POLL_MS` (default `250`)
- Notifier interval: `KB_BUS_NOTIFIER_INTERVAL_MS` (default `1000`)
- Pending digest file: `~/.claude/bus/pending/<agent>-<cwd-hash>.json`
- Notifier PID file: `~/.claude/bus/notifiers/<agent>-<cwd-hash>.pid`

## Scope

V1 is intentionally:

- local only
- append only
- opaque markdown message bodies
- no auth beyond local machine trust
- no cross-machine delivery
