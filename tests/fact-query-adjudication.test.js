import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'kb-fact-query-review-'));
process.env.KB_DIR = tmp;

const { addFact, queryFact, invalidateFact } = await import('../src/facts.js');
const { getDb } = await import('../src/db.js');
const { reviewFactGroup } = await import('../src/fact-reviews.js');
const { getToolDefinitions } = await import('../src/tools.js');

const factQuery = getToolDefinitions().find(tool => tool.name === 'kb_fact_query');
const call = async args => JSON.parse((await factQuery.handler(args)).content[0].text);

function review(subject, facts, decisions) {
  return reviewFactGroup(getDb(), {
    subject,
    predicate: 'status',
    reviewer: 'projection test',
    note: 'review provenance stays separate from raw facts',
    items: facts.map(fact => ({ fact_id: fact.id, ...decisions[fact.object] })),
  });
}

describe('kb_fact_query adjudication projection', () => {
  let available;
  let abstained;
  let stale;
  let removed;

  before(() => {
    addFact('unreviewed-query', 'status', 'active', {
      validFrom: '2026-01-01',
      source: 'note:unreviewed',
    });

    available = [
      addFact('reviewed-query', 'status', 'general availability', {
        validFrom: '2026-02-01',
        source: 'linear:reviewed',
      }),
      addFact('reviewed-query', 'status', 'GA', {
        validFrom: '2026-02-02',
        source: 'harvest:reviewed',
      }),
    ];
    review('reviewed-query', available, {
      'general availability': { disposition: 'current' },
      GA: { disposition: 'synonym', target_fact_id: available[0].id },
    });

    abstained = [
      addFact('abstained-query', 'status', 'ready', { source: 'linear:ready' }),
      addFact('abstained-query', 'status', 'maybe ready', { source: 'harvest:maybe' }),
    ];
    review('abstained-query', abstained, {
      ready: { disposition: 'current' },
      'maybe ready': { disposition: 'abstain', reason: 'retained evidence is ambiguous' },
    });

    stale = [
      addFact('stale-query', 'status', 'pilot', { source: 'linear:pilot' }),
      addFact('stale-query', 'status', 'beta', { source: 'linear:beta' }),
    ];
    review('stale-query', stale, {
      pilot: { disposition: 'current' },
      beta: { disposition: 'synonym', target_fact_id: stale[0].id },
    });
    addFact('stale-query', 'status', 'launched', { source: 'linear:launched' });

    removed = addFact('removed-query', 'status', 'temporary', {
      validFrom: '2026-01-01',
      source: 'linear:temporary',
    });
    review('removed-query', [removed], {
      temporary: { disposition: 'current' },
    });
    invalidateFact('removed-query', 'status', 'temporary', { ended: '2026-02-01' });
  });

  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('leaves an unreviewed response in the original shape', async () => {
    const facts = queryFact('unreviewed-query', { direction: 'outgoing' });
    const response = await call({ entity: 'unreviewed-query', direction: 'outgoing' });
    assert.deepStrictEqual(response, {
      entity: 'unreviewed-query',
      facts,
      count: facts.length,
      total: facts.length,
    });
  });

  it('returns a versioned human-readable projection beside unchanged raw facts', async () => {
    const response = await call({ entity: 'reviewed-query', direction: 'outgoing' });
    const raw = queryFact('reviewed-query', { direction: 'outgoing' })
      .sort((a, b) => String(b.valid_from ?? '').localeCompare(String(a.valid_from ?? '')));
    assert.deepStrictEqual(response.facts, raw);
    assert.strictEqual(response.facts.some(fact => 'id' in fact), false, 'raw fact rows changed shape');
    assert.strictEqual(response.adjudications.length, 1);
    const [projection] = response.adjudications;
    assert.deepStrictEqual({
      subject: projection.subject,
      predicate: projection.predicate,
      state: projection.state,
      projection: projection.projection,
      policy: projection.policy,
      reviewer: projection.reviewer,
    }, {
      subject: 'reviewed_query',
      predicate: 'status',
      state: 'adjudicated',
      projection: 'available',
      policy: 'manual-review-v1',
      reviewer: 'projection test',
    });
    assert.ok(Number.isInteger(projection.review_id));
    assert.match(projection.reviewed_at, /^\d{4}-\d{2}-\d{2}/);
    assert.deepStrictEqual(projection.current_fact_ids, [available[0].id]);
    assert.deepStrictEqual(projection.current_facts, [{
      fact_id: available[0].id,
      object: 'general availability',
      evidence_ref: 'linear:reviewed',
    }]);
  });

  it('reports abstention without manufacturing current state', async () => {
    const response = await call({ entity: 'abstained-query', direction: 'outgoing' });
    const [projection] = response.adjudications;
    assert.strictEqual(projection.state, 'adjudicated');
    assert.strictEqual(projection.projection, 'abstained');
    assert.strictEqual(projection.current_fact_ids, null);
    assert.strictEqual(projection.current_facts, null);
  });

  it('makes a review stale when live group membership changes', async () => {
    const response = await call({ entity: 'stale-query', direction: 'outgoing' });
    const [projection] = response.adjudications;
    assert.strictEqual(projection.state, 'stale');
    assert.strictEqual(projection.projection, 'abstained');
    assert.strictEqual(projection.current_fact_ids, null);
    assert.strictEqual(projection.current_facts, null);
  });

  it('keeps a fully removed reviewed group visible as stale', async () => {
    const response = await call({ entity: 'removed-query', direction: 'outgoing' });
    assert.strictEqual(response.facts.length, 1);
    assert.strictEqual(response.facts[0].current, false);
    const [projection] = response.adjudications;
    assert.strictEqual(projection.state, 'stale');
    assert.strictEqual(projection.projection, 'abstained');
    assert.strictEqual(projection.current_fact_ids, null);
  });

  it('does not apply live reviews to historical queries', async () => {
    const response = await call({
      entity: 'reviewed-query',
      direction: 'outgoing',
      as_of: '2026-12-31',
    });
    assert.strictEqual(response.adjudications, undefined);
  });

  it('does not project a reviewed subject through an incoming query', async () => {
    const response = await call({ entity: 'general availability', direction: 'incoming' });
    assert.strictEqual(response.facts.length, 1);
    assert.strictEqual(response.facts[0].subject, 'reviewed-query');
    assert.strictEqual(response.adjudications, undefined);
  });
});
