# Prompt hint retrieval

Prompt hints are precision-first. An empty result is a valid and common answer:
the hook should interrupt only when a prompt supplies enough independent
evidence that it is about a live note.

`tests/hint-recall.test.js` keeps the recall side visible in CI. Against its
16-subject natural-phrasing corpus:

- public `main` at `f82c199` recalled 6/16 subjects (38%);
- the current target is at least 8/16 subjects (50%);
- answerless, quoted, test-instruction, and conversational-filler prompts must
  still decline.

The scorer continues to treat title, tags, and vetted aliases as note identity.
Scoring arbitrary body prose as identity was previously rejected because it
made the live hint surface nearly never decline. Natural-language expansion is
therefore limited to reviewed morphology rules, kept separate from the
primary candidate query, and bounded to ten supplemental candidates.

Before changing these rules, run:

```bash
node --test tests/hint-recall.test.js \
  tests/hint-real-prompt-eval.test.js \
  tests/hint-live-regressions.test.js
node bin/kb.js hint-probe --json
```

Compare the probe against the same prompt corpus at the pinned base revision.
No synthetic recall gain justifies new unreviewed fires on that replay.
