# Feature manifest

This manifest records measured behavior whose claim and converse need separate
proof. It starts with prompt hints because an always-firing hint can appear to
have perfect recall while providing no useful signal.

| Feature | Proof | Status |
| --- | --- | --- |
| Prompt hints decline answerless prompts | `tests/hint-recall.test.js` covers off-topic and conversational filler; `tests/hint-real-prompt-eval.test.js` covers quoted, test-instruction, opaque-ticket, broad-ideation, generic-progress, and approval-policy controls | OK — 0/9 labeled answerless prompts interrupted |
| Prompt hints recall natural phrasing | `tests/hint-recall.test.js` probes 16 subjects without requiring title quotations and prints the measured rate in CI | OK — 7/16 (44%) against a 40% gate, up from 6/16 (38%) on public `main` at `f82c199` |
| Prompt hint precision on scrubbed real-agent shapes | `tests/hint-real-prompt-eval.test.js` grades every returned note and includes audited contamination strata | OK — 100% precision and 4/4 useful prompts recalled |
| Query expansion remains bounded | `tests/hint-relevance.test.js` proves primary-candidate preservation, supplemental deduplication, a ten-candidate cap, supported `-se`/`-sal` recovery, and sibling sense-mismatch declines | OK |
| Primary-path family scoring matches public/main | `tests/hint-relevance.test.js` includes the public/main differential `{reviewer, reviews, review}` and asserts its exact admitted families | OK — fallback-only transitive grouping does not change the primary partition |

See [Prompt hint retrieval](hint-retrieval.md) for the scorer invariants and
replay procedure.
