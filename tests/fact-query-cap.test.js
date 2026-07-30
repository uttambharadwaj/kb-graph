import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'kb-factcap-'));
process.env.KB_DIR = tmp;

const { addFact, queryFact, invalidateFact } = await import('../src/facts.js');
// Above the 200 ceiling on purpose: with a smaller fixture, an assertion that
// the page is <= 200 holds even with the clamp removed.
const HOT_FACTS = 250;
const RETIRED_FACTS = 3;
const { getToolDefinitions } = await import('../src/tools.js');

const factQuery = getToolDefinitions().find(t => t.name === 'kb_fact_query');
const call = async (args) => JSON.parse((await factQuery.handler(args)).content[0].text);

describe('kb_fact_query result cap', () => {
  before(() => {
    for (let i = 0; i < HOT_FACTS; i++) {
      addFact('hot-repo', 'chose', `option-${String(i).padStart(3, '0')}`, {
        validFrom: `2026-${String(1 + (i % 12)).padStart(2, '0')}-01`,
        source: 'test',
      });
    }
    // Ordering gets its own small subject: on hot-repo the 250 current rows fill
    // the page before any retired row could appear, so nothing would be proven.
    // The retired rows here carry the newest dates, so sorting by date alone
    // floats them to the top and only the current-first rule pushes them down.
    for (let i = 0; i < RETIRED_FACTS; i++) {
      addFact('mixed-repo', 'chose', `sunset-${i}`, { validFrom: '2026-12-31', source: 'test' });
      invalidateFact('mixed-repo', 'chose', `sunset-${i}`, { ended: '2026-12-31' });
      addFact('mixed-repo', 'chose', `live-${i}`, { validFrom: '2026-01-01', source: 'test' });
    }
    // Deliberately wide objects: enough rows under the 200 ceiling to still
    // blow a byte budget, which is the case a row cap alone does not catch.
    for (let i = 0; i < 150; i++) {
      addFact('wide-repo', 'chose', `option-${i}-${'x'.repeat(300)}`, { validFrom: '2026-06-01', source: 'test' });
    }
    addFact('quiet-repo', 'chose', 'only-option', { validFrom: '2026-01-01', source: 'test' });
  });

  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('caps at the default page and says what it dropped', async () => {
    const res = await call({ entity: 'hot-repo', direction: 'outgoing' });
    assert.strictEqual(res.facts.length, 25);
    assert.ok(res.total > 25, 'total must report the full count, not the page');
    assert.match(res.truncated, /showing 25 of \d+/);
  });

  // A page that does not announce itself as a page reads as the whole story,
  // which is how a caller concludes a fact does not exist.
  it('omits the truncation notice when nothing was dropped', async () => {
    const res = await call({ entity: 'quiet-repo', direction: 'outgoing' });
    assert.strictEqual(res.truncated, undefined);
    assert.strictEqual(res.count, res.total);
  });

  it('honours an explicit limit', async () => {
    const res = await call({ entity: 'hot-repo', direction: 'outgoing', limit: 5 });
    assert.strictEqual(res.facts.length, 5);
    assert.match(res.truncated, /showing 5 of/);
  });

  // An absurd limit must not become an absurd response. Asserted against the
  // byte budget rather than the row ceiling, because on real-width facts bytes
  // always bind first — the row ceiling only bounds how much we serialize.
  it('does not honour an unbounded limit', async () => {
    const res = await call({ entity: 'hot-repo', direction: 'outgoing', limit: 100000 });
    assert.ok(res.total > res.facts.length, 'returned everything despite the caps');
    assert.ok(JSON.stringify(res, null, 2).length <= 30000, 'response exceeded the budget');
  });

  // The whole point of ordering: a truncated page must carry what is true now.
  // The retired rows carry the newest dates, so this fails on date-only sorting.
  it('puts current facts before retired ones', async () => {
    const res = await call({ entity: 'mixed-repo', direction: 'outgoing', limit: 200 });
    const flags = res.facts.map(f => f.current);
    assert.ok(flags.includes(false), 'fixture produced no retired facts to order against');
    assert.ok(flags.indexOf(false) > flags.lastIndexOf(true), 'a retired fact sorted ahead of a current one');
  });

  // The row cap is a proxy; what actually failed was the serialized response
  // exceeding the caller's budget, which returns them nothing at all. 200 wide
  // rows measured 65k — larger than the 56k response that prompted the ticket.
  it('shrinks the page to fit a response-size budget', async () => {
    const res = await call({ entity: 'wide-repo', direction: 'outgoing', limit: 200 });
    const size = JSON.stringify(res, null, 2).length;
    assert.ok(size <= 30000, `response was ${size} chars, over the budget`);
    assert.ok(res.facts.length < res.total, 'must report that it dropped rows');
    assert.match(res.truncated, /showing \d+ of/);
  });

  // Consolidation calls queryFact directly and must see every row; a cap there
  // would make it miss a held fact and write a duplicate instead of matching.
  it('does not cap queryFact itself', () => {
    assert.strictEqual(
      queryFact('hot-repo', { direction: 'outgoing' }).length,
      HOT_FACTS,
    );
  });
});
