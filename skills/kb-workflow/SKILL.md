---
name: kb-workflow
description: "Use before starting any non-trivial task to search the knowledge base for context, and after completing work to capture findings. Teaches the token-efficient retrieval pattern and self-learning loop."
---

# Knowledge Base Workflow

## What This Skill Does

This skill teaches you how to use the knowledge-base-server MCP tools efficiently. It does NOT replace the MCP server — it complements it by giving you the retrieval strategy that saves 90%+ tokens.

Think of it this way:
- **MCP server** = the engine (search, read, write, capture)
- **This skill** = the driving instructions (when to search, what to read, how to capture)

## Before Starting Any Task

Search the KB for relevant context BEFORE writing code or making decisions:

```
1. kb_context("topic") — get summaries only (~100 tokens per doc, 90% savings)
2. Review titles and summaries — decide which docs matter
3. kb_read(id) — read full content ONLY for docs you actually need
```

Never skip this. The KB has accumulated lessons, fixes, decisions, and architecture docs. Searching first prevents:
- Repeating solved problems
- Contradicting past decisions
- Missing known pitfalls
- Wasting tokens on re-discovery

## The Three-Tier Retrieval Pattern

The KB has three tiers of information. Query the right tier for your need:

| Need | Tool | Tokens | When |
|------|------|--------|------|
| Quick context | `kb_context` | ~100/doc | Always start here |
| Specific search | `kb_search` | ~200/result | Looking for something specific |
| Conceptual match | `kb_search_smart` | ~200/result | Fuzzy/semantic queries |
| Full document | `kb_read` | ~500-5000/doc | Only after context confirms relevance |

**Rule: Never kb_read without kb_context first.** You wouldn't read an entire book to check if it's relevant — you'd read the summary.

- **Fallback:** if `kb_search` comes up empty, grep the vault directly — it is plain
  markdown on disk. Find the vault path in the kb-graph install's `.env`
  (`OBSIDIAN_VAULT_PATH=`), default `~/kb-vault`, then `grep -ri "<term>" <vault-path>`.
  Retrieval ranking can miss sparse signals; direct inspection of raw files is the
  reliable backstop.

## After Completing Work

Capture what you learned so the next session starts smarter:

### After debugging sessions:
```
kb_capture_session:
  goal: "What you were trying to do"
  commands_worked: "What worked"
  commands_failed: "What failed and why"
  root_causes: "The actual problem"
  fixes: "What fixed it"
  lessons: "What to do differently next time"
```

### After bug fixes:
```
kb_capture_fix:
  title: "Short fix title"
  symptom: "What was broken"
  cause: "Root cause"
  resolution: "How it was fixed"
```

### After research or decisions:
```
kb_write:
  title: "Decision or finding title"
  type: "decision" or "research" or "lesson"
  content: "What was decided and why"
```

## The Self-Learning Loop

This is how the system compounds intelligence:

```
Session N:
  1. Search KB for context (maybe find nothing)
  2. Do the work (hit problems, make decisions)
  3. Capture findings to KB

Session N+1:
  1. Search KB for context (find Session N's captures!)
  2. Skip the problems Session N already solved
  3. Capture NEW findings

Session N+100:
  1. Search KB for context (find 100 sessions of accumulated knowledge)
  2. One-shot clean implementation because context covers everything
  3. Capture only genuinely new learnings
```

This is NOT fine-tuning. The model doesn't change. The context it receives improves. And context is everything.

## When to Use Each Tool

| Situation | Tool | Why |
|-----------|------|-----|
| Starting a new task | `kb_context` | Get the lay of the land |
| "How did we do X?" | `kb_search` | Find specific past work |
| "What do we know about X?" | `kb_search_smart` | Conceptual/fuzzy match |
| Need full implementation details | `kb_read` | After context identified the doc |
| Finished debugging | `kb_capture_session` | Record what happened — and redact secrets from the output you paste |
| Fixed a bug | `kb_capture_fix` | Symptom and cause as separate fields, so searching the symptom finds the cause |
| Made a decision | `kb_write` type=decision | Record the decision and why |
| Found useful research | `kb_write` type=research | Save for future reference |
| Fetched a page you will cite later | `kb_capture_web` | Keeps the URL as provenance; `kb_write` does not |
| Handed a transcript you do not want to re-fetch | `kb_capture_youtube` | Files it as a source keyed to the video |
| A later session confirmed an earlier note | `kb_promote` | Raise its tier and record what confirmed it |
| A briefing contradicts what you just saw | `kb_supersede_candidates` | Lists what the fact graph thinks went stale; changes nothing |
| "What have we learned lately?" across projects | `kb_synthesize` | A review brief to answer — not a lookup, and not a finished synthesis |
| Search turns up notes with no type or tags | `kb_classify` | Unclassified notes have no summary, so they rank badly and `kb_context` shows nothing |
| Coordinating with an agent in a *different* tool | `bus_send` / `bus_read` | Your harness cannot see a Codex or Gemini session; the bus can |

## Reaching for the less obvious tools

Most of these go unused not because they are unwanted but because nothing ever
triggers them. A tool you have never called is not thereby a tool you do not
need — check this table before concluding the KB cannot do something.

## What NOT to Do

- Don't `kb_read` every document that matches a search — read summaries first
- Don't skip searching because "I probably know this" — the KB knows more than you remember
- Don't forget to capture after significant work — a lesson not captured is a lesson repeated
- Don't index raw code into the KB — use CODEMAP.md structural maps instead
- Don't treat the KB as a dump — classified, typed, tagged notes are 10x more useful than raw text
