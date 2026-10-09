# Outcome eval

kb-graph's claim is that when one coding session learns something, a later
session can start knowing it. The other evals in this repository measure parts
of that claim: whether capture triggers fire and whether prompt hints recall
notes. This eval measures the whole thing. Does a later session actually get
the work right more often, and at what cost?

## Design

Each task is a small fixture repository with a piece of knowledge that the
repository does not reveal: a stale config value, a helper that must not be
used for writes, a frozen module, a superseded API. Session B gets an ordinary
request in that repository. A deterministic `check.mjs` scores B's result, and
it passes only when B acted on the knowledge.

Every task is calibrated before any agent runs it. `tests/outcome-eval.test.js`
checks three things in CI:

- the check fails on the untouched fixture;
- it fails on `naive/`, the solution that follows the repository's own
  patterns; and
- it passes on `reference/`, the solution the lesson leads to.

So a pass means B did something the repository alone would not have led it to.

B runs once per **arm**. Every arm uses the same fixture, prompt, model, and
tool allowlist:

| Arm | What session B starts with |
| --- | --- |
| `cold` | Nothing. The baseline. |
| `rules` | Every current lesson in the repository's `CLAUDE.md`. This is the hand-curated rules file the README compares against: the best case for the simpler approach, since someone has already written exactly the right notes. |
| `kb-seeded` | Every lesson written through `kb_write`, superseded ones included, with the MCP server, hooks, and skills that `kb setup` installs. This tests retrieval and application. |
| `kb-e2e` | Like `kb-seeded`, except the task's own lessons are not written. Session A first does a different task in which a teammate's message carries the lesson. Only what A's session leaves behind can reach B: its own `kb_write` calls and a harvest of its transcript. This tests the full loop. |

Each knowledge arm also holds the shared pool of distractor notes in
[`lessons.json`](lessons.json), so retrieval has to pick the relevant note out
of plausible neighbours. The `slugify-control` task has no relevant lesson. It
measures what kb-graph costs (turns, dollars, and any distraction) when it has
nothing to offer. `ledger-balance-supersession` stores an outdated note
alongside the note that replaces it. A pass there requires the current truth to
win.

A and B work in separate checkouts. Whatever A changes in code is invisible to
B, so the knowledge base is the only path between them.

## Running it

Prerequisites:

- an authenticated `claude` CLI on `PATH` (or `CLAUDE_BIN`);
- for the `kb-*` arms, network access to `huggingface.co` the first time, so
  the embedding model can download. `kb_write` refuses to write without it.
  The model is cached under `.cache/test-embedding` and shared across runs; and
- permission to start headless sessions. Each session runs with
  `--permission-mode acceptEdits` and the narrow allowlist in
  `scripts/outcome-eval.mjs`: file tools, `node`, `npm`, `git`, and the KB.

```bash
# Prepare every run directory without starting a session
node scripts/outcome-eval.mjs --dry-run --arms cold,rules,kb-seeded,kb-e2e

# Pilot: every task, every arm, one repetition, capped spend
node scripts/outcome-eval.mjs --arms cold,rules,kb-seeded,kb-e2e --reps 1 --budget-usd 15 --out eval-out/pilot

# Full run once the pilot looks sane
node scripts/outcome-eval.mjs --arms cold,rules,kb-seeded,kb-e2e --reps 10 --concurrency 4 --budget-usd 300 --out eval-out/v1

# Re-render a summary from results.jsonl
node scripts/outcome-eval.mjs --summarize eval-out/v1
```

Each run gets its own `HOME`, `KB_DIR`, and vault under
`<out>/runs/<task>--<arm>--<rep>/`. No run reads your Claude settings, global
`CLAUDE.md`, or knowledge base. The run directory keeps B's full stream-json
transcript (`session-b.jsonl`, plus `session-a.jsonl` for `kb-e2e`) and the
repository B left behind. `results.jsonl` gets one row per run, with the
verdict, cost, turns, and KB tool calls. `summary.md` gives pass rates with 95%
Wilson intervals by arm and by task.

`--budget-usd` stops new runs from starting once recorded spend reaches the
limit. Runs already in progress finish. A `kb-e2e` run costs two sessions plus
a harvest, so it costs roughly twice as much as the other arms. Run the pilot
first and use its mean cost per arm to size the full run.

## Reading the results

- `kb-seeded` beats `cold` by a clear margin: retrieval works.
- `kb-e2e` close to `kb-seeded`: the loop actually captures what a session
  learns.
- `kb-seeded` close to `rules`: kb-graph delivers what a perfect hand-written
  rules file would, without the hand-writing.
- `slugify-control`: no worse than `cold` on pass rate, with modest overhead in
  turns and cost.
- `ledger-balance-supersession`: a `kb-seeded` failure that called `/v1/` means
  superseded knowledge leaked.

A task where `cold` already passes most of the time has no headroom. Replace it
rather than averaging it in. With a handful of tasks and ten repetitions, only
large differences are meaningful. Treat the per-task table as the result and
the per-arm rate as a summary of it.

## Results so far (2026-10-09)

The default model was Claude Sonnet 5.5, with 5 repetitions for each task and
arm. The three redesigned tasks were rerun after the change described below.

| Task | cold | rules | kb-seeded |
| --- | --- | --- | --- |
| due-date-helper | 0/5 | 5/5 | 5/5 |
| ledger-balance-supersession | 0/5 | 5/5 | 5/5 |
| rate-limit-retry-after | 0/5 | 5/5 | 5/5 |
| refund-idempotency-key | 0/5 | 5/5 | 5/5 |
| staging-db-host | 0/5 | 5/5 | 5/5 |
| slugify-control | 5/5 | 5/5 | 5/5 |

- When a lesson is in the knowledge base, a session finds and applies it as
  reliably as it applies a hand-curated `CLAUDE.md`, at about $0.01–0.03 and
  2–3 turns more per session. Superseded guidance never won.
- The suite does not separate `kb-seeded` from `rules` yet. With 18 notes, any
  retrieval works. A pool of hundreds of notes would test retrieval precision.
- In the end-to-end pilot (one repetition), nothing session A learned reached
  B. A never called `kb_write`, even when its prompt stated a team rule. Harvest
  also skipped every A session as too short: about 1,000–1,400 characters of
  conversation text against a 4,000-character minimum. The lifecycle-capture
  daemon calls the same harvest, so it would not have helped either.
- The first versions of three tasks leaked their lesson through the fixture,
  and cold sessions solved them from the code: a `sendOnce` helper, a visible
  docs table, and a `vendor/legacy` path. They were rewritten so the knowledge
  has no trace in the repository.

Total spend for these runs was about $19.

## Limits

The tasks are synthetic and small. Each one isolates a single piece of
knowledge, while real sessions mix many. In `kb-e2e`, the lesson reaches A as
an explicit message. That is the easy case for capture: knowledge A has to
discover on its own is harder to notice and to write down. A strong result
here is necessary for the product's claim, not sufficient. More tasks, longer
sessions, and Codex as session B are the natural next steps.

## Adding a task

Create `tasks/<id>/` with:

- `task.json`: `id`, `kind` (`lesson`, `supersession`, or `control`),
  `lessons` (ids in `lessons.json`), `promptA`, and `promptB`;
- `repo/`: the fixture;
- `naive/` and `reference/`: overlays onto `repo/`; and
- `check.mjs`: takes the repository path as its argument and exits 0 only on
  success, printing `PASS` or `FAIL <reason>`.

Then run `node --test tests/outcome-eval.test.js`. The new task must fail on
`repo/` and `naive/` and pass on `reference/`.
