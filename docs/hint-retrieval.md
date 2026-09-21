# Prompt hint retrieval

Prompt hints are precision-first. An empty result is a valid and common answer:
the hook should interrupt only when a prompt supplies enough independent
evidence that it is about a live note.

`tests/hint-recall.test.js` keeps the recall side visible in CI. Against its
16-subject natural-phrasing corpus:

- public `main` at `f82c199` recalled 6/16 subjects (38%);
- the current scorer recalls 7/16 subjects (44%) against a 40% CI gate;
- answerless, quoted, test-instruction, and conversational-filler prompts must
  still decline.

The 40% gate separates the measured result from the 37.5% base without pinning
CI to the exact achieved fraction. It does not imply one-probe headroom:
acoustics is the one corrected corpus subject, while baking remains an explicit
miss after rejecting a fixture-specific `loaf`/`loaves` lookup.

The scorer continues to treat title, tags, and vetted aliases as note identity.
Scoring arbitrary body prose as identity was previously rejected because it
made the live hint surface nearly never decline. Natural-language expansion is
therefore limited to a closed vocabulary of reviewed, semantically equivalent
`-se`/`-sal` pairs. Positive coverage includes `rehearse`/`rehearsal`,
`propose`/`proposal`, `dispose`/`disposal`, `appraise`/`appraisal`,
`arouse`/`arousal`, and `recuse`/`recusal`. Unsupported and sense-mismatched
controls include `remove`/`removal`, `reverse`/`reversal`, `refuse`/`refusal`,
`reprise`/`reprisal`, and `callose`/`callosal`; irregular `-ves` forms are also
unsupported. Expansion runs only after the unchanged primary path declines and
is bounded to ten supplemental candidates.

Before changing these rules, run:

```bash
node --test tests/hint-relevance.test.js \
  tests/hint-recall.test.js \
  tests/hint-real-prompt-eval.test.js \
  tests/hint-live-regressions.test.js
```

The primary-family regression in `tests/hint-relevance.test.js` is the public,
repository-contained equivalence proof for the adversarial
`{reviewer, reviews, review}` differential. A local historical corpus can also
be inspected with:

```bash
node bin/kb.js hint-probe --json
```

That probe is supplemental observational evidence only: its SQLite retrieval
corpus is local and is not reproducible from this repository. Do not use it as
the sole safety or primary-parity proof.
