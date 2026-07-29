import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Prompt regressions for kb_extract, replayed against the real model — slow,
// non-deterministic, and needs the claude CLI, so it is opt-in:
//   KB_EVAL=1 node --test tests/extract-eval.test.js
const tmp = mkdtempSync(join(tmpdir(), 'kb-extract-eval-'));
process.env.KB_DIR = tmp;

const { extractFacts } = await import('../src/extract.js');

const mentions = (facts, token) =>
  facts.some(f => `${f.subject} ${f.predicate} ${f.object}`.toLowerCase().includes(token));

describe('kb_extract prompt behaviour', { skip: !process.env.KB_EVAL, timeout: 300000 }, () => {
  after(() => rmSync(tmp, { recursive: true, force: true }));

  // Observed 2026-07-28: extracted "decimalToScaledInteger incorrectly_handles
  // negative_decimals" — the problem, out of a sentence stating the fix.
  it('extracts the post-change state from a "was fixed" sentence', async () => {
    const { facts } = await extractFacts(
      'decimalToScaledInteger in ux-labs was fixed for negative decimals, in PR #3798.',
    );
    const broken = facts.filter(f =>
      f.subject.toLowerCase().includes('decimal') &&
      /incorrect|broken|fails|mishandl|bug|wrong/.test(`${f.predicate} ${f.object}`.toLowerCase()));
    assert.deepStrictEqual(broken, [], 'stamped the pre-fix state as currently true');
  });

  // Observed 2026-07-29: every stated fact dropped in favour of two inferences,
  // with skipped: [] claiming nothing was passed over.
  it('records stated PR/commit/reviewer facts, or admits skipping them', async () => {
    const { facts, skipped } = await extractFacts(`
On 2026-07-29, PR #539 in tinyfish-io/internal-tools-backend was squash-merged to main as
commit fde94d6 by uttambharadwaj. It was approved by paveldudka. The merge triggered workflow
container_CD_frontend.yml run 30422764087, which deployed the internal-tools frontend to
production successfully. CodeRabbit reviewed PR #539 and raised one Major finding about regex
head-injection, which was fixed in commit b1d6832.`);

    const accounted = skipped.map(s => JSON.stringify(s).toLowerCase()).join(' ');
    for (const token of ['fde94d6', 'paveldudka', 'production', 'coderabbit', 'b1d6832']) {
      assert.ok(
        mentions(facts, token) || accounted.includes(token),
        `"${token}" is stated in the input but appears in neither facts nor skipped`,
      );
    }
    assert.ok(mentions(facts, '539'), 'PR #539 was not treated as an entity');
  });
});
