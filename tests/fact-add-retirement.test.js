import './helpers/tmp-kb.js'; // MUST be first — redirects the DB to a temp dir
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getDb } from '../src/db.js';
import { addFact, entityKey, queryFact } from '../src/facts.js';
import { getToolDefinitions } from '../src/tools.js';

const tool = name => getToolDefinitions().find(t => t.name === name);
const stored = res => JSON.parse(res.content[0].text);
const current = (subject, predicate) =>
  queryFact(subject, { direction: 'outgoing', exact: true })
    .filter(r => r.current && r.predicate === predicate)
    .map(r => r.object);

describe('kb_fact_add retires a contradicted single-valued fact', () => {
  it('the verbatim PF-3469 repro: shipped -> in_review retires shipped', async () => {
    await tool('kb_fact_add').handler({
      subject: 'pf-3453', predicate: 'status', object: 'shipped', valid_from: '2026-08-11',
    });
    assert.deepStrictEqual(current('pf-3453', 'status'), ['shipped']);

    const res = stored(await tool('kb_fact_add').handler({
      subject: 'pf-3453', predicate: 'status', object: 'in_review', valid_from: '2026-08-11',
    }));

    // Both current was the bug: only in_review may be current now.
    assert.deepStrictEqual(current('pf-3453', 'status'), ['in_review']);
    assert.strictEqual(res.retired.length, 1, 'the response must state the retirement');
    assert.strictEqual(res.retired[0].object, 'shipped');
    assert.strictEqual(res.retired[0].valid_to, '2026-08-11');
    assert.match(res.note, /retired prior status=shipped \(valid_to 2026-08-11\)/);

    // The retired row itself is no longer current.
    const all = queryFact('pf-3453', { direction: 'outgoing', exact: true });
    const shippedRow = all.find(r => r.object === 'shipped');
    assert.strictEqual(shippedRow.current, false);
    assert.strictEqual(shippedRow.valid_to, '2026-08-11');
  });

  it('same-day retirement is accepted, not refused as ending before it began', async () => {
    // ended === valid_from is exactly the repro's shape — invalidateFact's
    // guard only refuses ended < valid_from, so this must not be silently
    // dropped as "ended_before_valid_from".
    await tool('kb_fact_add').handler({
      subject: 'pf-5001', predicate: 'status', object: 'open', valid_from: '2026-08-11',
    });
    const res = stored(await tool('kb_fact_add').handler({
      subject: 'pf-5001', predicate: 'status', object: 'closed', valid_from: '2026-08-11',
    }));

    assert.strictEqual(res.retired.length, 1);
    assert.strictEqual(res.retired[0].valid_to, '2026-08-11');
    assert.deepStrictEqual(current('pf-5001', 'status'), ['closed']);
  });

  it('a repo subject accumulates instead of retiring (cumulative case unchanged)', async () => {
    await tool('kb_fact_add').handler({
      subject: 'knowledge-base-server', predicate: 'status', object: 'v1.1-complete', valid_from: '2026-07-14',
    });
    const res = stored(await tool('kb_fact_add').handler({
      subject: 'knowledge-base-server', predicate: 'status', object: 'deploy branch in sync', valid_from: '2026-07-29',
    }));

    assert.strictEqual(res.retired, undefined, 'a repo subject must not retire — response carries no retired field');
    assert.deepStrictEqual(
      current('knowledge-base-server', 'status').sort(),
      ['deploy branch in sync', 'v1.1-complete'],
    );
  });

  it('a many-valued predicate on a ticket subject also keeps both (accumulate, not retire)', async () => {
    await tool('kb_fact_add').handler({
      subject: 'pf-5002', predicate: 'chose', object: 'embeddings at write time',
    });
    const res = stored(await tool('kb_fact_add').handler({
      subject: 'pf-5002', predicate: 'chose', object: 'restart on source change',
    }));

    assert.strictEqual(res.retired, undefined);
    assert.strictEqual(current('pf-5002', 'chose').length, 2);
  });

  it('retirement targets the row\'s own stored predicate spelling, not the canonical one', () => {
    // Simulates a row written before a predicate alias existed (migration 12's
    // starting condition) — inserted directly, bypassing addFact's own
    // canonicalPredicate fold, the same way extract.test.js's inverted-interval
    // fixture does. facts.js:222-231 documents why invalidateFact must be
    // handed this exact spelling: passing the canonical `status` here instead
    // would look up a predicate the row does not have and retire nothing.
    const db = getDb();
    const subId = entityKey('pf-5003');
    const objId = entityKey('legacy-open');
    db.prepare('INSERT OR IGNORE INTO entities (id, name) VALUES (?, ?)').run(subId, 'pf-5003');
    db.prepare('INSERT OR IGNORE INTO entities (id, name) VALUES (?, ?)').run(objId, 'legacy-open');
    db.prepare(
      'INSERT INTO facts (id, subject, predicate, object, valid_from, source) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('f_pf-5003_is_status_legacy-open_pre12', subId, 'is_status', objId, '2026-07-01', 'seed');

    return (async () => {
      const res = stored(await tool('kb_fact_add').handler({
        subject: 'pf-5003', predicate: 'status', object: 'closed', valid_from: '2026-08-11',
      }));

      assert.strictEqual(res.retired.length, 1, 'canonicalPredicate("is_status") === "status", so this must be seen as held');
      assert.strictEqual(res.retired[0].object, 'legacy-open');
      assert.deepStrictEqual(current('pf-5003', 'status'), ['closed']);

      const row = db.prepare('SELECT valid_to FROM facts WHERE id = ?').get('f_pf-5003_is_status_legacy-open_pre12');
      assert.strictEqual(row.valid_to, '2026-08-11', 'the pre-fold row itself must carry the retirement');
    })();
  });

  it('a fact that does not contradict anything writes with no retired field (no behavior change)', async () => {
    const res = stored(await tool('kb_fact_add').handler({
      subject: 'pf-5004', predicate: 'status', object: 'open', valid_from: '2026-08-11',
    }));
    assert.strictEqual(res.retired, undefined);
    assert.strictEqual(res.note, undefined);
  });

  it('addFact itself gains no retirement of its own — the rule lives one layer up, at the tool', () => {
    // Locks the layering the ticket asked for: addFact stays the dumb writer
    // consolidate has always used; retireContradicted is what kb_fact_add calls
    // before it, not something addFact does implicitly.
    addFact('pf-5005', 'status', 'open', { validFrom: '2026-08-11' });
    addFact('pf-5005', 'status', 'closed', { validFrom: '2026-08-11' });
    assert.deepStrictEqual(current('pf-5005', 'status').sort(), ['closed', 'open']);
  });
});
