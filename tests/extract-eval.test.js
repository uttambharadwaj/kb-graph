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

  // Observed once in production 2026-07-29: wrote "production_metronome
  // misconfigured_to sandbox_metronome" from a sentence calling the pointing
  // deliberate. Subject and object right; the predicate supplied a judgment the
  // text contradicts, which reads downstream as a finding, not a description.
  //
  // This case has never been reproduced: 0/6 on the pre-fix prompt from the
  // sentence alone, 0/6 embedded in a full debrief, and 0/6 with the qualifier
  // stripped (the shape a split chunk produces — see PF-3058). It is a guard
  // for a rule we believe in, not a regression test for a measured failure.
  it('does not editorialize a deliberate configuration into a defect', async () => {
    const { facts } = await extractFacts(
      'Production Metronome and Stripe configuration points at sandbox Metronome and Stripe test mode, ' +
      'which is temporary and tracked by PF-3043 for revert.',
    );
    const judged = facts.filter(f =>
      /misconfigur|broken|violat|wrong|incorrect|bad_/.test(f.predicate.toLowerCase()));
    assert.deepStrictEqual(judged, [], 'asserted a defect the source called deliberate');
    assert.ok(
      mentions(facts, 'metronome') || mentions(facts, 'stripe'),
      'dropped the configuration fact entirely rather than describing it neutrally',
    );
  });

  // Observed 2026-07-29: wrote "wallet_identity migrated_to users_row" from a
  // sentence saying the eight PRs doing it are all open. Past-tense predicate
  // for unmerged work — the completion is asserted before it happens.
  // Reproduces: 3/6 runs on the pre-fix prompt (migrated_to, moved_to), 0/6 with
  // the tense rule. This one is a real regression test.
  it('does not report in-flight work as completed', async () => {
    const { facts } = await extractFacts(
      'Kris owns an 8-PR stack moving wallet identity off the wallets table and onto the users row. ' +
      'All eight PRs are still open.',
    );
    const completed = facts.filter(f =>
      /^(migrated_to|moved_to|renamed_to|replaced_by)$/.test(f.predicate.toLowerCase()));
    assert.deepStrictEqual(completed, [], 'asserted a migration the source says is unmerged');
    // Without this the test passes on an empty extraction, which is not the
    // behaviour being bought — the work still has to be recorded, as a proposal.
    assert.ok(mentions(facts, 'wallet'), 'dropped the in-flight migration instead of recording it');
  });
});
