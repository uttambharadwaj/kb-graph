---
name: debrief
description: "Use at the end of a session (or midway through a long one) to deliberately capture what was learned — lessons, decisions, workflows, state changes, and facts — into the knowledge base. The nightly harvest is a safety net for lessons; unless the host opted into KB_HARVEST_FACTS, /debrief is the only thing that records facts."
---

# Debrief

Extract experiential knowledge from the current conversation and save it to the knowledge base via the `kb_*` MCP tools.

**Note:** the nightly harvest job auto-extracts *lessons* from session transcripts, so a session that never runs this skill still leaves something behind. It extracts **facts** only if the host set `KB_HARVEST_FACTS=1`, which is off by default — assume it is off, and that a fact you skip here is simply not recorded. Running /debrief is also the higher-quality pass for lessons: richer context, better titles, immediate availability. Your in-context judgment beats the transcript-level pass — don't skip candidates just because "harvest will get it."

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

Before creating an entry, call `kb_check_duplicate` with **the exact body you are about to write** and no `threshold` — that is what makes its answer the answer `kb_write` will give. A summary of the note, or a lower threshold, produces a verdict about a different question: the write embeds the body and rejects at the default, so a check run any other way green-lights writes that are about to be refused, and vice versa. `kb_search` on the candidate title is the complementary check, since titles are not part of the comparison at all.

If a similar entry exists and is right, skip. If it's outdated, supersede it **first** and then write — `kb_write` refuses a near-duplicate of a live note, and a correction is by construction a near-duplicate of what it corrects.

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

**Facts:** call `kb_extract` once with the session's relevant text (decisions, state changes, ownership, incidents) plus `source` and `observation_date` — it extracts and consolidates triples. It retires a contradicted fact only when **both** hold: the predicate is single-valued (`status`, `state`, `review_state`, `ci_state`, `assigned_to`, `version` — see `src/predicates.json`), and the subject names one state-bearing thing, meaning a ticket or issue id like `tkt-4821` or `svc-api#59`. A repo, project or person accumulates instead: `knowledge-base-server status X` never retires an earlier `status Y`. Cumulative predicates (`owns`, `chose`, `shipped_via`, `deployed_to`) always keep both. Anything the extractor leaves standing that really is dead needs a manual `kb_fact_invalidate`. Use `dry_run: true` to preview. Read `skipped` for assertions it chose not to record, then fill gaps with manual `kb_fact_add`. Read `conflicts` too: where one call asserted two values of a single-valued pair — three "statuses" for one PR, say — nothing was retired, because the call gives no order for them. Those are usually several variables flattened onto one predicate name, so re-record them as `review_state` / `ci_state` / `status` rather than picking a winner. A long session exceeds the 12,000-character window: `skipped` will hold an `input_truncated` entry saying how much was never examined, and the end of a session is where its state changes live — call again with the remainder rather than treating the first response as the whole picture.

## Step 6: Verify

Confirm counts match your writes, then `kb_search` one of the titles to confirm indexing. If any call failed, fix it before considering the debrief complete.

## Notes

- **Mid-session debrief:** for long sessions, run /debrief partway through so early insights survive context compression. Duplicate checks keep repeat runs safe.
- **Pointer, not duplicate:** when knowledge has a canonical home (runbook, design doc), summarize and link rather than copy.
- **Confidence upgrades:** if an older entry was tentative and this session confirmed it, write the updated understanding — the KB links related notes automatically.
