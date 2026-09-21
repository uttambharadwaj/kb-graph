# Feature manifest

This manifest records measured behavior whose claim and converse need separate
proof. It starts with prompt hints because an always-firing hint can appear to
have perfect recall while providing no useful signal.

| Feature | Proof | Status |
| --- | --- | --- |
| Prompt hints decline answerless prompts | `tests/hint-recall.test.js` covers off-topic and conversational filler; `tests/hint-real-prompt-eval.test.js` covers quoted, test-instruction, opaque-ticket, broad-ideation, generic-progress, and approval-policy controls | OK — 0/9 labeled answerless prompts interrupted |
| Prompt hints recall natural phrasing | `tests/hint-recall.test.js` probes 16 subjects without requiring title quotations and prints the measured rate in CI | OK — target 50% (8/16), up from 38% (6/16) on public `main` at `f82c199` |
| Prompt hint precision on scrubbed real-agent shapes | `tests/hint-real-prompt-eval.test.js` grades every returned note and includes audited contamination strata | OK — 100% precision and 4/4 useful prompts recalled |
| Query expansion remains bounded | `tests/hint-relevance.test.js` proves primary-candidate preservation, supplemental deduplication, a ten-candidate cap, transitive family folding, and morphology cases outside the recall corpus | OK |
| Historical prompt replay does not widen fires or change existing rankings | `kb hint-probe --json` compared by prompt hash and ordered hit IDs at the pinned base and candidate | OK — 1,848 prompts, 778 fires before and after, 0 added, 0 removed, and 0 reordered |

See [Prompt hint retrieval](hint-retrieval.md) for the scorer invariants and
replay procedure.
