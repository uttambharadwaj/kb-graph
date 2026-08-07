// The rules a model must follow when proposing command triggers — shared
// verbatim between the classifier (new notes, src/classify/classifier.js)
// and triggers-backfill (the corpus that predates it,
// src/cli/triggers-backfill.js), so a rule change can't silently diverge the
// two proposal paths the way independently-worded copies already had:
// code-span-only grounding, the " && " join format, and the 0-3 cap.
export const TRIGGER_PROPOSAL_RULES = 'Propose a pattern only when its exact command text appears inside this note\'s own code spans (backticks or a fenced code block) — never for a command the note only describes in prose. Each pattern is a string: the required parts of the command, joined " && " (e.g. "gh pr merge && --delete-branch"). Propose 0 to 3 patterns; most notes warn about nothing you\'d type at a shell, so an empty array is the normal answer.';
