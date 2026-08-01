# Bus hooks

V2 adds a hook-friendly bridge so Claude/Codex sessions can be **nudged at turn boundaries** without long-polling inside the model.

## Design

Each `(reader, channel)` now has **two durable cursors** in `bus_readers`:

- `last_seen_id` — advanced by explicit `bus_read`
- `notify_cursor` — advanced by `bus-hook` after a non-dry-run digest is shown

Hooks are hints, not consumption. A later `bus_read` still returns full message bodies until `last_seen_id` advances. Explicit `bus_read` also bumps `notify_cursor` forward so already-read messages do not keep reappearing in digests.

**Self-sender filter.** Hook digests still only include messages where `sender != reader`.

**Directed routing.** Hook digests honor `recipient`: a message is visible when `recipient IS NULL`, `recipient = reader`, or `recipient = '*'`. When `recipient IS NULL`, the deprecated `to_reader` column is consulted as a read-fallback for legacy writers — new code must set `recipient` directly.

**Presence.** Every non-dry-run hook fire refreshes `bus_readers.last_hook_at` and `capabilities_json` for the `(reader, channel)` pair. Digest previews may include `presence — stale: <reader>` lines when a subscribed peer has not hooked in recently, letting senders see who is actually listening without a separate presence table.

## CLI

```bash
kb bus-hook ws:ticket-42 --reader claude:architect
```

Default output is hook JSON with `additional_context` plus `hookSpecificOutput.additionalContext`.

Useful flags:

- `--format hook|json|text` (default `hook`)
- `--limit 5`
- `--preview-chars 80`
- `--hook-event UserPromptSubmit`
- `--dry-run` (show the digest without recording a handoff or advancing the cursor)
- `--agent`, `--cwd` (session identity for the recorded handoff)

## Recorded delivery

A non-dry-run hook fire is a **handoff**, and it is recorded. In one write transaction the hook reads
the digest, writes a `bus_deliveries` row for every message that digest covered, and advances
`notify_cursor` past them. Session identity is `(channel, reader, agent, cwd)`, hashed — the cwd
being the binding's own directory, so a hook fired from a subdirectory lands on the same session.

Hook-wired sessions register themselves on their first fire, which is why `bus_sessions` is a live
picture of who is listening rather than a registry someone has to maintain. `bus-session register` is
for a workspace whose hooks are not wired yet; `bus-session deliveries` shows what actually landed.

Concurrency is settled in the database, not by luck: the transaction is `IMMEDIATE`, so parallel
hooks for one session serialize and exactly one of them gets a non-empty digest. Two sessions on the
same channel each get their own delivery row for the same message.

`bus_read` is deliberately outside this ledger. It is the agent consuming its own inbox, not a
handoff to a session, and it advances `last_seen_id` rather than recording a delivery.

For asleep/offline agents, use `bus-agent register ... --adapter exec` plus `bus-agentd --serve`. That path starts a fresh Codex/Claude worker for a directed bus task instead of trying to push text into an arbitrary live terminal.

## Generic workspace binding

Fixed-channel hook commands were only a proof of concept. The generalized flow is:

1. bind the current workspace/session:

```bash
kb bus-bind ws:ticket-42 --reader claude:architect --agent claude
kb bus-bind ws:ticket-44 --reader claude:architect --agent claude
```

2. wire generic hooks once:

- `kb bus-hook-current --agent claude --hook-event SessionStart`
- `kb bus-hook-current --agent claude --hook-event UserPromptSubmit`

`bus-hook-current` resolves the active subscriptions from the current workspace binding and emits a valid hook payload even when no binding exists yet.

Binding files now use a list-capable schema:

```json
{
  "agent": "claude",
  "cwd": "/path/to/repo",
  "subscriptions": [
    { "channel": "ws:ticket-42", "reader": "claude:architect" },
    { "channel": "ws:ticket-44", "reader": "claude:architect" }
  ],
  "updated_at": "2026-04-23T20:28:00.000Z"
}
```

Repeated `bus-bind` calls append or update subscriptions for the current cwd. `bus-unbind --channel <channel>` removes one subscription; plain `bus-unbind --agent ...` clears them all. `bus-bind --list --agent ...` shows the current resolved binding.

The digest is intentionally sanitized:

- first line only
- whitespace collapsed
- `<`, `>`, backticks, and control chars stripped
- fixed truncation (80 chars default, ellipsis on overflow)
- max 5 messages shown per digest; rest collapsed to `+N more`

Peer message bodies are untrusted model output, so hooks inject a **sanitized digest**, not raw message bodies. The structural wrapper (`[bus] <channel> — <N> new message(s):` + bulleted preview lines) keeps output unambiguously in the "there is mail" category, not "here is content to obey."

### Advance semantics

- `bus-hook` without `--dry-run` → records the handoff and advances `notify_cursor` to the latest scanned message ID on the channel, then prints the digest it took. Its session is `(channel, reader, agent, cwd)`, where `--agent` defaults to the reader's host prefix (`codex:implementer` → `codex`) and `--cwd` to the current directory.
- `bus-hook --dry-run` → prints the digest but does not advance `notify_cursor`. Useful in `SessionStart` when you want the user to see pending messages without consuming them yet.
- `bus-hook-current` loops over every subscription in the resolved workspace binding, concatenates non-empty digests, and records and advances each subscription independently.
- Every hook fire refreshes `last_hook_at` / `capabilities_json` in `bus_readers`, which is also the presence source for digest summaries.

## Claude Code wiring

Example `~/.claude/settings.json` snippet:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "kb bus-hook-current --agent claude --hook-event SessionStart"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "kb bus-hook-current --agent claude --hook-event UserPromptSubmit"
          }
        ]
      }
    ]
  }
}
```

At session start, bind the workspace:

```bash
bus-bind ws:ticket-42 --reader claude:architect --agent claude
```

If `kb` is not on PATH, replace it with the absolute node + script path you already use for local KB registration.

## Codex / oh-my-codex wiring

Codex/OMX also supports `SessionStart`, `UserPromptSubmit`, and `Stop` hooks. Start with the same pattern:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "kb bus-hook-current --agent codex --hook-event SessionStart"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "kb bus-hook-current --agent codex --hook-event UserPromptSubmit"
          }
        ]
      }
    ]
  }
}
```

Bind the workspace before expecting hook wakeups:

```bash
bus-bind ws:ticket-42 --reader codex:implementer --agent codex
```

## Scope

This is **not** a true asynchronous interrupt. Hook delivery happens at turn boundaries:

- session start / resume
- before the next user prompt

That is usually the correct trade-off: no model polling, no PTY injection, no mid-tool-call interruption.

Use `bus-status <channel> --reader <name>` when a peer appears asleep. It is a non-consuming diagnostic view of unread backlog, hook presence, latest heartbeat/status, and latest control message. Pair it with `heartbeat`, `artifact` + `diff_since_last_ack`, `ack`, and `control` messages to make silence and review checkpoints explicit rather than relying on model memory.
