# The Self-Learning AI Workflow

This document explains the self-learning system that makes your AI agents compound
intelligence over time. This is not fine-tuning. Not RLHF. It's self-modifying
instructions through operational history.

## The Core Insight

AI models are stateless — every session starts from zero. The knowledge base
server solves this by creating a persistent memory layer that agents read from
and write to. But memory alone isn't enough. The system needs to LEARN from
that memory — turning raw experience into refined intelligence.

## The Three-Tier Memory System

### Hot Tier — Active Context
- Current project decisions, recent session findings
- Active bug fixes, in-progress architecture changes
- Retrieved FIRST in every query
- Decays quickly — moves to warm after 7-14 days of inactivity

### Warm Tier — Accumulated Knowledge
- Proven patterns, validated lessons, stable workflows
- Research summaries, synthesized insights
- Retrieved when relevant to the query
- The backbone of institutional memory

### Cold Tier — Raw Archives
- Original captures, raw terminal logs, unprocessed clippings
- Historical session data, old source material
- Retrieved only when deep-diving or debugging
- Never deleted — raw data has long-tail value

### Why Three Tiers?
Without tiering, agents drown in noise. A search for "authentication" should
return your latest auth architecture decision (hot), not a raw article you
clipped six months ago (cold). The tiers ensure signal over noise.

## The Intelligence Pipeline

```
External Sources + Internal Activity
(YouTube, X, web, email, terminal, docs, code, manual notes)
                     |
                     v
              [1. CAPTURE]
         kb_ingest, kb_capture_*
         Obsidian Web Clipper
         Terminal session logs
                     |
                     v
              [2. CLASSIFY]
            kb_classify tool
         AI auto-tags content
         Routes to project/type
         Assigns confidence
                     |
                     v
             [3. SYNTHESIZE]
           kb_synthesize tool
        Connects dots across sources
        Finds themes, patterns
        Generates cross-cutting insights
                     |
                     v
              [4. PROMOTE]
           kb_promote tool
        Raw captures -> insights
        Patterns -> lessons
        Recurring themes -> decisions
        Workflows -> runbooks
                     |
                     v
              [5. RETRIEVE]
         kb_context (summaries)
         kb_search (full-text)
         kb_search_smart (semantic)
        Token-optimized ranking
        Tier-aware prioritization
                     |
                     v
              [6. APPLY]
          Agent uses knowledge
          Better decisions
          Fewer mistakes
          Faster implementation
                     |
                     v
              [7. CAPTURE AGAIN]
          Session findings -> KB
          Bug fixes -> KB
          New patterns -> KB
                     |
                     v
            [LOOP CONTINUES]
         Compounding improvement
```

## The Self-Learning Loop in Practice

### Sessions 1-10: Building the Foundation
Your AI makes mistakes. You correct it. Every correction gets captured as a
lesson or fix. The KB starts accumulating institutional memory.

### Sessions 10-50: Pattern Recognition
The AI starts finding relevant context in the KB. Previous fixes prevent
re-occurrence. Architecture decisions are consistent because past decisions
are retrieved automatically.

### Sessions 50-100: Deep Context
The AI knows your codebase patterns, your preferences, your architecture
style. Suggestions are more relevant. Less back-and-forth.

### Sessions 100+: One-Shot Quality
Accumulated context covers most scenarios. The AI produces clean, correct
code on first attempt because it has your entire operational history as context.

## How to Use This Workflow

### 1. Set Up the Templates

Copy the template files to your project root:

```bash
cp docs/workflow/CLAUDE.md.template ./CLAUDE.md
cp docs/workflow/AGENTS.md.template ./AGENTS.md
```

Edit them to match your project specifics.

### 2. Capture Everything Significant

After debugging sessions:
```
Use kb_capture_session with:
- goal: what you were trying to do
- commands_worked: what worked
- commands_failed: what failed and why
- root_causes: the actual problem
- fixes: what fixed it
- lessons: what to do differently next time
```

After bug fixes:
```
Use kb_capture_fix with:
- title: short fix title
- symptom: what was broken
- cause: root cause
- resolution: how it was fixed
```

### 3. Synthesize Periodically

Run `kb_synthesize` weekly (or daily during active development):
- Connects dots across recent captures
- Identifies recurring patterns
- Surfaces opportunities and improvements
- Generates actionable insights from raw experience

### 4. Promote Valuable Knowledge

As patterns emerge, promote them:
- Recurring fixes -> documented runbooks
- Architecture decisions -> decision records
- Workflow improvements -> updated processes
- Research insights -> project guidance

### 5. Let the Loop Run

The more you capture, the smarter the system gets. The smarter the system
gets, the less you need to capture (because fewer mistakes happen). This
is the compounding curve that makes the workflow valuable.

## Multi-Agent Self-Learning

The workflow amplifies when multiple agents share the same KB:

- **Agent A** (Claude) debugs an issue, captures the fix
- **Agent B** (Codex) encounters the same class of issue, finds the fix instantly
- **Agent C** (Gemini) reviews code, checks KB for known patterns to avoid

Each agent's experience benefits all other agents. The KB becomes a shared
brain that's smarter than any individual agent.

## Integration with Obsidian

Obsidian serves as the human layer:
- You curate, link, and organize knowledge visually
- The KB server indexes Obsidian for AI retrieval
- Changes in your vault auto-sync to the KB
- Agents write findings back to the vault (via capture tools)

This creates a bidirectional flow:
```
Human (Obsidian) <---> KB Server <---> AI Agents
   curate/link          index/rank       search/capture
```

## Measuring Progress

Track these metrics to see the self-learning loop working:

- **Time to resolution**: Should decrease as KB accumulates fixes
- **Repeated questions**: Should approach zero as lessons are captured
- **First-attempt success rate**: Should increase with accumulated context
- **KB doc count**: Growing = system is learning
- **Synthesis insights**: Quality should improve as more data connects

## The Philosophy

"You gotta 100-shot 10 apps before you can 1-shot 10 apps."

There are no shortcuts to accumulated experience. But there IS a shortcut to
making that experience persistent and retrievable. That's what this system does.

The knowledge that matters most is the knowledge that's NOT on the internet —
it's in your head, in your terminal history, in your debugging sessions, in
the decisions you made at 2am. This system captures it all and makes it
available to every agent, every session, forever.
