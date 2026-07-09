---
name: debrief
description: "Use at the end of a session (or midway through a long one) to deliberately capture what was learned — lessons, decisions, workflows, state changes, and facts — into the knowledge base. The nightly harvest is the safety net; /debrief is the higher-quality deliberate pass."
---

# Debrief

Extract experiential knowledge from the current conversation and save it to the knowledge base via the `kb_*` MCP tools.

**Note:** the nightly harvest job auto-extracts facts and lessons from session transcripts, so nothing is lost if this skill never runs. Running /debrief is for *deliberate* capture: richer context, better titles, and immediate availability instead of waiting for the nightly sweep. Your in-context judgment beats the transcript-level pass — don't skip candidates just because "harvest will get it."

**Division of labor:** user preferences and standing corrections belong in your agent's own memory system. Project state, technical knowledge, decisions, gotchas, and facts belong in the KB. During debrief, write only to the KB.

## Step 1: Scan the conversation

Review the full conversation and extract candidates.

**Strong signals (almost always extract):**
- Problem → root cause → fix chains → `lesson`
- "It turns out..." / "The actual reason was..." moments → `lesson`
- Explicit decisions with reasoning ("we chose X because...") → `decision`
- Commands/workflows that were non-obvious → `workflow`
- User saying "remember this" / "save this" → pick the type that fits
- Debugging that revealed how a system works → `idea` (mental model)

**Skip:**
- Exploratory reads that didn't yield insight
- Failed attempts that didn't teach anything reusable
- Things already documented elsewhere (reference them instead)
- Session-specific decisions that won't matter next time

**Context updates** (`type: session` — the nightly job folds these into the per-workstream state note, so write them freely):
- Project status materially changed (PR merged, blocker hit, phase completed)
- New workstream started; workstream completed or paused

**Temporal facts** (via `kb_extract` / `kb_fact_add`): subject-predicate-object triples with dates — `PR #123 shipped_via commit abc123`, `TICKET-42 blocked_by TICKET-43`, `service-x deployed_to prod`.

## Step 2: Check for existing entries

Before creating an entry, call `kb_check_duplicate` (threshold 0.7) or `kb_search` with the candidate title. If a similar entry exists and is right, skip; if it's outdated, write the update and reference the old note.

## Step 3: Filter ruthlessly

Keep only if YES to at least one:
- Will a future session hit this exact problem and waste time without it?
- Is it a non-obvious gotcha that contradicts reasonable assumptions?
- Is it reusable across projects, not just this one?
- Would the user re-discover it the hard way next time?

Drop if the code is self-documenting, it's a one-time fix, or it's general engineering common sense. Context entries are exempt — but only write one if something *material* changed.

## Step 4: Present candidates to the user

```
I found N items to save from this session:

**Knowledge:**
+ [lesson] npm ci enforces peer conflicts local install masked
+ [workflow] Fresh-history public snapshot via git archive

**Context:**
+ [session] my-app: PR #48 merged, deploy verified

**Facts:**
+ PR #48 shipped_via commit abc123 (2026-07-09)
```

Wait for approval. The user may edit, skip entries, or approve all.

## Step 5: Write approved entries

**Knowledge:** `kb_write` once per entry — `title` (concise, searchable), `type` (`lesson` / `workflow` / `decision` / `idea` / `research`), `tags` (comma-separated domain + topical tags), `content` (body only; end with a `**Source:**` line), `project` when scoped to one workstream.

Size guide: gotcha lessons 3–8 lines; patterns 8–15; workflows 5–15 (commands + when + why); decisions 4–10 (choice + reasoning + alternatives rejected).

**Context:** `kb_write` with `type: session`, title `{workstream}: {one-line change}`, a few lines covering what changed, where it stands, next action.

**Facts:** call `kb_extract` once with the session's relevant text (decisions, state changes, ownership, incidents) plus `source` and `observation_date` — it extracts and consolidates triples, retiring contradicted facts automatically. Use `dry_run: true` to preview. Fill gaps with manual `kb_fact_add`; retire superseded facts with `kb_fact_invalidate`.

## Step 6: Verify

Confirm counts match your writes, then `kb_search` one of the titles to confirm indexing. If any call failed, fix it before considering the debrief complete.

## Notes

- **Mid-session debrief:** for long sessions, run /debrief partway through so early insights survive context compression. Duplicate checks keep repeat runs safe.
- **Pointer, not duplicate:** when knowledge has a canonical home (runbook, design doc), summarize and link rather than copy.
- **Confidence upgrades:** if an older entry was tentative and this session confirmed it, write the updated understanding — the KB links related notes automatically.
