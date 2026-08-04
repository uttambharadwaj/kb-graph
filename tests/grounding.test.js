// Points KB_DIR and the vault at throwaway dirs — must come before anything
// that opens the DB.
import './helpers/tmp-kb.js';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, chmodSync } from 'fs';
import { join } from 'path';

import {
  groundTriples, dateStatedIn, normalizeForGrounding,
  UNGROUNDED_REASON_PREFIX, DATE_OVERRIDE_REASON_PREFIX,
} from '../src/grounding.js';

// A fake claude that answers off the marker in the prompt, so the wiring tests
// below exercise the real extraction path without a model call.
const envelope = payload => JSON.stringify({ result: JSON.stringify(payload) });
const fakeClaude = join(process.env.KB_DIR, 'fake-claude.sh');
writeFileSync(fakeClaude, `#!/bin/sh
prompt=$(cat)
case "$prompt" in
  # One stated fact and one workflow edge the text never mentions.
  *GROUND_ME*) echo '${envelope({
    facts: [
      { subject: 'svc-a', predicate: 'depends_on', object: 'svc-b' },
      { subject: 'svc-a', predicate: 'blocked_by', object: 'tkt-909' },
    ],
    skipped: [],
  })}' ;;
  # Same shape as GROUND_ME, on entities no other test has written, so a
  # preview/commit comparison is not answered by an earlier test's row.
  *PREVIEW_ME*) echo '${envelope({
    facts: [
      { subject: 'svc-d', predicate: 'depends_on', object: 'svc-e' },
      { subject: 'svc-d', predicate: 'blocked_by', object: 'tkt-808' },
    ],
    skipped: [],
  })}' ;;
  # Every triple invented, and the model reports a skip of its own alongside —
  # the all-fail corner where an ancillary channel is easiest to lose.
  *ALL_INVENTED*) echo '${envelope({
    facts: [
      { subject: 'svc-f', predicate: 'blocked_by', object: 'tkt-707' },
      { subject: 'tkt-707', predicate: 'assigned_to', object: 'robin' },
    ],
    skipped: [{ assertion: 'the team is happy with the rollout', reason: 'not durable' }],
  })}' ;;
  # The text dates the event itself; the extractor got it right.
  *DATED_MERGE*) echo '${envelope({
    facts: [{ subject: 'pr #4242', predicate: 'merged_via', object: 'commit ab12345', valid_from: '2026-07-28' }],
    skipped: [],
  })}' ;;
  # ...and here it did not: nothing in the text says the 28th.
  *INVENTED_DATE*) echo '${envelope({
    facts: [{ subject: 'svc-c', predicate: 'status', object: 'live', valid_from: '2026-07-28' }],
    skipped: [],
  })}' ;;
  *) echo '${envelope({ facts: [], skipped: [] })}' ;;
esac
`);
chmodSync(fakeClaude, 0o755);
process.env.CLAUDE_PATH = fakeClaude;

const { kbExtract } = await import('../src/extract.js');
const { queryFact } = await import('../src/facts.js');

const triple = (subject, predicate, object, extra = {}) => ({ subject, predicate, object, ...extra });
const reasons = res => res.skipped.map(s => s.reason);
const currentRow = (subject, predicate) =>
  queryFact(subject, { direction: 'outgoing', exact: true }).find(r => r.current && r.predicate === predicate);

describe('grounding extracted triples in the source text', () => {
  // The four corners of the filter loop. The all-fail one is the magnet: an
  // empty result with a full skipped list is the only honest report of it, and
  // returning [] with nothing in skipped is what a silent drop looks like.
  describe('the filter loop', () => {
    const text = 'svc-a depends on svc-b, and dana owns svc-b.';

    it('leaves every grounded triple untouched, in order', () => {
      const facts = [
        triple('svc-a', 'depends_on', 'svc-b'),
        triple('dana', 'owns', 'svc-b'),
      ];
      const res = groundTriples(facts, text, { observationDate: '2026-08-04' });

      assert.deepStrictEqual(res.facts, facts);
      assert.deepStrictEqual(res.skipped, []);
    });

    it('drops every triple and reports every one when none is grounded', () => {
      const facts = [
        triple('svc-z', 'depends_on', 'svc-y'),
        triple('robin', 'owns', 'svc-y'),
        triple('tkt-77', 'blocks', 'tkt-88'),
      ];
      const res = groundTriples(facts, 'a transcript about something else entirely.', {});

      assert.deepStrictEqual(res.facts, [], 'wrote a triple the text never states');
      assert.strictEqual(res.skipped.length, 3, 'dropped a triple without reporting it');
      assert.ok(res.skipped.every(s => s.reason.startsWith(UNGROUNDED_REASON_PREFIX)), reasons(res).join(' | '));
      assert.deepStrictEqual(res.skipped.map(s => s.assertion), [
        'svc-z depends_on svc-y', 'robin owns svc-y', 'tkt-77 blocks tkt-88',
      ]);
    });

    it('keeps the grounded half of a mixed batch and reports the rest', () => {
      const res = groundTriples([
        triple('svc-a', 'depends_on', 'svc-b'),
        triple('svc-a', 'blocked_by', 'tkt-404'),
        triple('dana', 'owns', 'svc-b'),
      ], text, {});

      assert.deepStrictEqual(res.facts.map(f => f.object), ['svc-b', 'svc-b']);
      assert.deepStrictEqual(reasons(res), [`${UNGROUNDED_REASON_PREFIX}object "tkt-404" not in source text`]);
    });

    it('says nothing about an empty batch', () => {
      assert.deepStrictEqual(groundTriples([], text, {}), { facts: [], skipped: [] });
      assert.deepStrictEqual(groundTriples(undefined, text, {}), { facts: [], skipped: [] });
    });

    it('names both sides when both are ungrounded', () => {
      const res = groundTriples([triple('svc-z', 'depends_on', 'svc-y')], text, {});
      assert.deepStrictEqual(reasons(res), [
        `${UNGROUNDED_REASON_PREFIX}subject "svc-z" and object "svc-y" not in source text`,
      ]);
    });

    // An incomplete triple is consolidation's to report as incomplete_triple —
    // renaming it here would hide which of the two things went wrong.
    it('passes an incomplete triple through untouched', () => {
      const partial = { subject: 'svc-a', predicate: 'depends_on' };
      const res = groundTriples([partial], text, {});

      assert.deepStrictEqual(res.facts, [partial]);
      assert.deepStrictEqual(res.skipped, []);
    });
  });

  describe('the normalizer', () => {
    for (const [raw, expected] of [
      ['Browser_Profiles', 'browser profiles'],
      ['browser-profiles', 'browser profiles'],
      ['BROWSER PROFILES', 'browser profiles'],
      ['pr #539', 'pr 539'],
      ['PR#539', 'pr 539'],
      ['  svc-a/v2.contracts  ', 'svc a v2 contracts'],
    ]) {
      it(`folds ${JSON.stringify(raw)} to ${JSON.stringify(expected)}`, () => {
        assert.strictEqual(normalizeForGrounding(raw), expected);
      });
    }

    // The same fold on both sides of the comparison, which is the only thing
    // that makes the spellings the extractor rewrites into each other match.
    for (const [entity, text] of [
      ['browser_profiles', 'Browser Profiles shipped this week.'],
      ['browser profiles', 'browser-profiles shipped this week.'],
      ['BROWSER-PROFILES', 'the browser_profiles work shipped.'],
      ['pr #539', 'PR 539 is merged.'],
      ['pr 539', 'pr #539 is merged.'],
      ['commit fde94d6', 'squash-merged to main as fde94d6.'],
      ['web-app pr #3865', 'reviewed PR #3865 this morning.'],
      ['sandbox_pointing', 'production billing points at the sandbox.'],
    ]) {
      it(`grounds ${JSON.stringify(entity)} in ${JSON.stringify(text)}`, () => {
        const res = groundTriples([triple(entity, 'status', 'live')], `${text} it is live.`, {});
        assert.deepStrictEqual(reasons(res), [], `${entity} was rejected`);
      });
    }

    it('keeps two references with different numbers apart', () => {
      const res = groundTriples([triple('pr #123', 'status', 'open')], 'pr #539 is open.', {});
      assert.deepStrictEqual(reasons(res), [`${UNGROUNDED_REASON_PREFIX}subject "pr #123" not in source text`]);
    });
  });

  // A count or a version is legitimately reworded on the way out, so those are
  // exempt. A date is not: it goes through the date rule instead, or "2026" and
  // "28" borrowed from an unrelated PR number would ground an invented one.
  describe('value-shaped objects', () => {
    it('lets a reworded quantity through', () => {
      const res = groundTriples([
        triple('retry_loop', 'attempts', '3'),
        triple('retry_loop', 'pinned_to', 'v1.2'),
      ], 'the retry loop tries three times, pinned to version one point two.', {});

      assert.deepStrictEqual(reasons(res), []);
    });

    it('still requires a date-valued object to be stated as a date', () => {
      const res = groundTriples(
        [triple('release', 'shipped_on', '2026-07-28')],
        'the release note for pr #28 landed in the 2026 planning cycle.',
        {},
      );

      assert.deepStrictEqual(reasons(res), [`${UNGROUNDED_REASON_PREFIX}object "2026-07-28" not in source text`]);
    });

    it('accepts a date-valued object the text does state', () => {
      const res = groundTriples([triple('release', 'shipped_on', '2026-07-28')], 'the release shipped on July 28.', {});
      assert.deepStrictEqual(reasons(res), []);
    });
  });

  describe('dates the text states', () => {
    for (const spelling of [
      'merged on 2026-07-28 after review',
      'merged on 2026/7/28 after review',
      'merged on July 28 after review',
      'merged on Jul 28 after review',
      'merged on Jul. 28th after review',
      'merged on 28 July after review',
      'merged on 7/28 after review',
      'merged on 07/28/2026 after review',
    ]) {
      it(`reads the date out of ${JSON.stringify(spelling)}`, () => {
        assert.strictEqual(dateStatedIn(spelling, '2026-07-28'), true);
      });
    }

    it('does not read a date the text does not state', () => {
      assert.strictEqual(dateStatedIn('merged on July 28 after review', '2026-07-29'), false);
      assert.strictEqual(dateStatedIn('merged after review', '2026-07-28'), false);
      assert.strictEqual(dateStatedIn('merged on 2026-07-28', 'last tuesday'), false);
    });

    it('keeps a valid_from the text states', () => {
      const res = groundTriples(
        [triple('pr #4242', 'merged_via', 'commit ab12345', { valid_from: '2026-07-28' })],
        'pr #4242 was merged as ab12345 on July 28.',
        { observationDate: '2026-08-04' },
      );

      assert.strictEqual(res.facts[0].valid_from, '2026-07-28');
      assert.deepStrictEqual(reasons(res), []);
    });

    // The override is the whole point: falling back silently would be a new
    // invisible behaviour, which is the disease this filter treats.
    it('falls back to the observation date and says so', () => {
      const res = groundTriples(
        [triple('svc-c', 'status', 'live', { valid_from: '2026-07-28' })],
        'svc-c is live.',
        { observationDate: '2026-08-04' },
      );

      assert.strictEqual('valid_from' in res.facts[0], false, 'kept a date the text never states');
      assert.deepStrictEqual(reasons(res), [
        `${DATE_OVERRIDE_REASON_PREFIX}model claimed 2026-07-28, text does not state it, used observation date 2026-08-04`,
      ]);
    });

    it('reports a valid_from that is not a date at all', () => {
      const res = groundTriples(
        [triple('svc-c', 'status', 'live', { valid_from: 'last tuesday' })],
        'svc-c is live.',
        { observationDate: '2026-08-04' },
      );

      assert.strictEqual('valid_from' in res.facts[0], false);
      assert.match(res.skipped[0].reason, /not a YYYY-MM-DD date, used observation date 2026-08-04/);
    });

    it('says nothing when the model agrees with the observation date', () => {
      const res = groundTriples(
        [triple('svc-c', 'status', 'live', { valid_from: '2026-08-04' })],
        'svc-c is live.',
        { observationDate: '2026-08-04' },
      );

      assert.strictEqual(res.facts[0].valid_from, '2026-08-04');
      assert.deepStrictEqual(reasons(res), []);
    });
  });

  // Through kb_extract itself, not the module: a filter tested only in
  // isolation goes on passing after someone unwires it from the call path.
  describe('wired into kb_extract', () => {
    it('writes the stated fact and refuses the invented edge', async () => {
      const res = await kbExtract('GROUND_ME: svc-a depends on svc-b.', {
        source: 'test', observationDate: '2026-08-04',
      });

      assert.deepStrictEqual(res.added.map(f => `${f.subject}|${f.predicate}|${f.object}`), ['svc-a|depends_on|svc-b']);
      assert.deepStrictEqual(res.skipped.map(s => s.reason), [
        `${UNGROUNDED_REASON_PREFIX}object "tkt-909" not in source text`,
      ]);
      // and nothing reached the graph under the invented name
      assert.deepStrictEqual(queryFact('tkt-909', { direction: 'both' }), []);
    });

    it('writes nothing and reports everything when the whole batch is invented', async () => {
      const res = await kbExtract('ALL_INVENTED: the rollout finished this morning.', {
        source: 'test', observationDate: '2026-08-04',
      });

      assert.deepStrictEqual(res.added, [], 'wrote a triple the text never states');
      assert.deepStrictEqual(res.invalidated, [], 'retired a real fact on the strength of an invented one');
      assert.strictEqual(res.skipped.filter(s => s.reason.startsWith(UNGROUNDED_REASON_PREFIX)).length, 2);
      // The extractor's own accounting has to survive a batch that lost every
      // triple — it is the only record of what it passed over.
      assert.ok(res.skipped.some(s => s.reason === 'not durable'), JSON.stringify(res.skipped));
    });

    it('dates a fact from the text, not from the day the text was read', async () => {
      const res = await kbExtract('DATED_MERGE: pr #4242 was merged as ab12345 on July 28.', {
        source: 'test', observationDate: '2026-08-04',
      });

      assert.strictEqual(res.added.length, 1);
      assert.strictEqual(currentRow('pr #4242', 'merged_via').valid_from, '2026-07-28',
        'the interval starts when the text was read, not when the merge happened');
    });

    it('overrides an invented date and leaves the override visible', async () => {
      const res = await kbExtract('INVENTED_DATE: svc-c is live.', {
        source: 'test', observationDate: '2026-08-04',
      });

      assert.strictEqual(currentRow('svc-c', 'status').valid_from, '2026-08-04');
      assert.ok(
        res.skipped.some(s => s.reason.startsWith(DATE_OVERRIDE_REASON_PREFIX)),
        `the correction was silent: ${JSON.stringify(res.skipped)}`,
      );
    });

    // A preview that showed the ungrounded triple would promise a row the
    // commit then refuses to write.
    it('previews only what it will commit', async () => {
      const text = 'PREVIEW_ME: svc-d depends on svc-e.';
      const preview = await kbExtract(text, { source: 'test', observationDate: '2026-08-04', dryRun: true });

      assert.deepStrictEqual(preview.candidates.map(f => f.object), ['svc-e']);
      assert.ok(preview.skipped.some(s => s.reason.startsWith(UNGROUNDED_REASON_PREFIX)));

      const committed = await kbExtract(text, { source: 'test', observationDate: '2026-08-04' });
      assert.strictEqual(committed.from_preview, true);
      assert.deepStrictEqual(
        committed.added.map(f => f.object),
        preview.candidates.map(f => f.object),
      );
    });
  });
});
