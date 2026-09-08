import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'kb-context-truth-'));
process.env.KB_DIR = tmp;

const { addFact } = await import('../src/facts.js');
const { getDb, insertDocument, supersedeDocument } = await import('../src/db.js');
const { reviewFactGroup } = await import('../src/fact-reviews.js');
const { getToolDefinitions } = await import('../src/tools.js');

const contextTool = getToolDefinitions().find(tool => tool.name === 'kb_context');

async function context(query, limit = 15) {
  const response = await contextTool.handler({ query, limit });
  assert.ok(!response.isError, response.content[0].text);
  const text = response.content[0].text;
  const separator = text.indexOf('\n\n');
  assert.notStrictEqual(separator, -1, `kb_context did not return a briefing payload: ${text}`);
  const packet = JSON.parse(text.slice(separator + 2));
  assert.ok(!Array.isArray(packet), 'kb_context still returns a flat document list');
  return packet;
}

function review(subject, facts, decisions) {
  return reviewFactGroup(getDb(), {
    subject,
    predicate: 'status',
    reviewer: 'context truth test',
    note: 'current state stays separate from raw evidence',
    items: facts.map(fact => ({ fact_id: fact.id, ...decisions[fact.object] })),
  });
}

describe('kb_context truth packet', () => {
  before(() => {
    insertDocument({
      title: 'Falcon service status guide',
      content: 'Falcon service status and rollout notes.',
      doc_type: 'lesson',
      source: 'linear:falcon-guide',
    });
    insertDocument({
      title: 'Falcon service current state',
      content: 'Falcon service is the active workstream.',
      doc_type: 'state',
      source: 'state:falcon',
    });

    const falcon = [
      addFact('falcon-service', 'status', 'pilot', {
        validFrom: '2026-08-01',
        source: 'linear:falcon-pilot',
      }),
      addFact('falcon-service', 'status', 'general availability', {
        validFrom: '2026-08-20',
        source: 'linear:falcon-ga',
      }),
    ];
    review('falcon-service', falcon, {
      pilot: { disposition: 'superseded', target_fact_id: falcon[1].id },
      'general availability': { disposition: 'current' },
    });
    const incoming = addFact('external-service', 'depends on', 'falcon-service', {
      source: 'linear:external-dependency',
    });
    reviewFactGroup(getDb(), {
      subject: 'external-service',
      predicate: 'depends on',
      reviewer: 'context truth test',
      items: [{ fact_id: incoming.id, disposition: 'current' }],
    });

    addFact('otter-service', 'status', 'pilot', { source: 'linear:otter-pilot' });
    addFact('otter-service', 'status', 'blocked', { source: 'slack:otter-blocked' });

    const stale = [
      addFact('heron-service', 'status', 'pilot', { source: 'linear:heron-pilot' }),
      addFact('heron-service', 'status', 'beta', { source: 'linear:heron-beta' }),
    ];
    review('heron-service', stale, {
      pilot: { disposition: 'superseded', target_fact_id: stale[1].id },
      beta: { disposition: 'current' },
    });
    addFact('heron-service', 'status', 'launched', { source: 'linear:heron-launched' });

    const abstained = [
      addFact('ibis-service', 'status', 'ready', { source: 'linear:ibis-ready' }),
      addFact('ibis-service', 'status', 'maybe ready', { source: 'harvest:ibis-maybe' }),
    ];
    review('ibis-service', abstained, {
      ready: { disposition: 'current' },
      'maybe ready': { disposition: 'abstain', reason: 'evidence remains ambiguous' },
    });

    for (const predicate of [
      'status', 'state', 'review state', 'ci state', 'version',
      'uses', 'depends on', 'calls', 'runs on', 'stored in', 'contains',
    ]) {
      addFact('grouplimit-service', predicate, `value for ${predicate}`, {
        source: `linear:grouplimit-${predicate.replaceAll(' ', '-')}`,
      });
    }
    for (const predicate of [
      'status', 'state', 'review state', 'ci state', 'version',
      'uses', 'depends on', 'calls', 'runs on', 'stored in',
    ]) {
      addFact('exactgroup-service', predicate, `value for ${predicate}`, {
        source: `linear:exactgroup-${predicate.replaceAll(' ', '-')}`,
      });
    }
    for (let index = 0; index < 73; index++) {
      addFact('rowlimit-service', 'contains', `component ${index}`, {
        source: `linear:rowlimit-${index}`,
      });
    }
    for (let index = 0; index < 72; index++) {
      addFact('exactrow-service', 'contains', `component ${index}`, {
        source: `linear:exactrow-${index}`,
      });
    }

    const old = insertDocument({
      title: 'Kite migration approach',
      content: 'Kite migration uses the original queue approach.',
      doc_type: 'decision',
      source: 'linear:kite-old',
    });
    const replacement = insertDocument({
      title: 'Kite migration approach',
      content: 'Kite migration now uses the replacement stream approach.',
      doc_type: 'decision',
      source: 'linear:kite-new',
    });
    supersedeDocument(old.id, {
      replacementId: replacement.id,
      reason: 'stream design replaced the queue design',
    });
  });

  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('keeps document briefings while separating reviewed current state from raw evidence', async () => {
    const packet = await context('what is the current falcon service status');

    assert.ok(packet.documents.some(doc => doc.title === 'Falcon service status guide'));
    assert.ok(packet.current_state.notes.some(doc => doc.title === 'Falcon service current state'));

    assert.deepStrictEqual(packet.current_state.facts.map(row => ({
      subject: row.subject,
      predicate: row.predicate,
      objects: row.facts.map(fact => fact.object),
    })), [{
      subject: 'falcon_service',
      predicate: 'status',
      objects: ['general availability'],
    }]);
    assert.ok(packet.current_state.facts.every(row => row.subject !== 'external_service'));
    assert.strictEqual(packet.limits.fact_groups, 10);

    const raw = packet.evidence.facts.filter(fact => fact.subject === 'falcon-service');
    assert.deepStrictEqual(new Set(raw.map(fact => fact.object)), new Set(['pilot', 'general availability']));
    assert.ok(raw.every(fact => fact.source?.startsWith('linear:')));
    assert.deepStrictEqual(packet.unresolved.fact_groups, []);
  });

  it('does not manufacture current state for unreviewed, stale, or abstained groups', async () => {
    for (const [entity, expected] of [
      ['otter service', 'unadjudicated'],
      ['heron service', 'stale'],
      ['ibis service', 'adjudicated'],
    ]) {
      const packet = await context(`show the current ${entity} status`);
      assert.deepStrictEqual(packet.current_state.facts, [], entity);
      assert.strictEqual(packet.unresolved.fact_groups.length, 1, entity);
      assert.strictEqual(packet.unresolved.fact_groups[0].state, expected, entity);
      assert.strictEqual(packet.unresolved.fact_groups[0].projection, 'abstained', entity);
      assert.ok(packet.unresolved.fact_groups[0].candidates.every(candidate => candidate.source), entity);
      if (entity === 'ibis service') {
        assert.ok(packet.unresolved.fact_groups[0].decisions.some(decision =>
          decision.disposition === 'abstain' && decision.reason === 'evidence remains ambiguous'));
      }
    }
  });

  it('keeps superseded notes out of live documents and exposes their replacement history', async () => {
    const packet = await context('kite migration approach');

    assert.strictEqual(packet.documents.filter(doc => doc.title === 'Kite migration approach').length, 1);
    assert.strictEqual(packet.history.superseded_notes.length, 1);
    assert.match(packet.history.superseded_notes[0].superseded_reason, /replaced the queue design/);
    assert.ok(Number.isInteger(packet.history.superseded_notes[0].superseded_by));
  });

  it('does not bind incidental generic entity tokens from a broad topic query', async () => {
    addFact('agent', 'status', 'unrelated generic entity', { source: 'note:generic-agent' });
    addFact('stale', 'status', 'unrelated stale entity', { source: 'note:generic-stale' });

    const packet = await context('agent retrieval follow through stale plans correction');

    assert.deepStrictEqual(packet.matched_entities.map(entity => entity.id), []);
    assert.deepStrictEqual(packet.evidence.facts, []);
    assert.deepStrictEqual(packet.unresolved.fact_groups, []);
  });

  it('keeps meaningful single-word entities in natural queries', async () => {
    addFact('postgres', 'status', 'connection pooling owner set', { source: 'note:postgres' });

    const packet = await context('Postgres connection pooling');

    assert.deepStrictEqual(packet.matched_entities.map(entity => entity.id), ['postgres']);
    assert.deepStrictEqual(packet.evidence.facts.map(fact => fact.object), ['connection pooling owner set']);
  });

  it('keeps meaningful single-word aliases in natural queries', async () => {
    addFact('orion-service', 'status', 'deployed', { source: 'note:orion' });
    getDb().prepare(
      'INSERT OR REPLACE INTO entity_aliases (alias, canonical) VALUES (?, ?)'
    ).run('orion', 'orion_service');

    const packet = await context('Orion deployment status');

    assert.deepStrictEqual(packet.matched_entities.map(entity => entity.id), ['orion_service']);
    assert.deepStrictEqual(packet.evidence.facts.map(fact => fact.object), ['deployed']);
  });

  it('keeps exact generic entity lookups explicit', async () => {
    addFact('workstream', 'status', 'active', { source: 'note:generic-workstream' });

    const packet = await context('agent');
    assert.deepStrictEqual(packet.matched_entities.map(entity => entity.id), ['agent']);
    assert.deepStrictEqual(packet.evidence.facts.map(fact => fact.object), ['unrelated generic entity']);

    const fixedGenericPacket = await context('workstream');
    assert.deepStrictEqual(fixedGenericPacket.matched_entities.map(entity => entity.id), ['workstream']);
    assert.deepStrictEqual(fixedGenericPacket.evidence.facts.map(fact => fact.object), ['active']);
  });

  it('keeps exact generic aliases and concrete identifiers eligible', async () => {
    addFact('retrieval-worker', 'status', 'ready', { source: 'note:retrieval-worker' });
    addFact('status-probe', 'status', 'green', { source: 'note:status-probe' });
    addFact('issue-4242', 'status', 'accepted', { source: 'note:issue-4242' });
    getDb().prepare(
      'INSERT OR REPLACE INTO entity_aliases (alias, canonical) VALUES (?, ?)'
    ).run('agent', 'retrieval_worker');
    getDb().prepare(
      'INSERT OR REPLACE INTO entity_aliases (alias, canonical) VALUES (?, ?)'
    ).run('status', 'status_probe');

    const aliasPacket = await context('agent');
    assert.deepStrictEqual(aliasPacket.matched_entities.map(entity => entity.id), ['agent', 'retrieval_worker']);

    const genericAliasPacket = await context('status');
    assert.deepStrictEqual(genericAliasPacket.matched_entities.map(entity => entity.id), ['status_probe']);
    assert.deepStrictEqual(genericAliasPacket.evidence.facts.map(fact => fact.object), ['green']);

    const identifierPacket = await context('ISSUE-4242');
    assert.deepStrictEqual(identifierPacket.matched_entities.map(entity => entity.id), ['issue_4242']);
    assert.deepStrictEqual(identifierPacket.evidence.facts.map(fact => fact.object), ['accepted']);
  });


  it('marks possible fact row omissions without counting unmeasured rows', async () => {
    const packet = await context('rowlimit service');

    assert.deepStrictEqual(packet.partial.fact_rows, {
      limit: 72,
      more_may_exist: true,
      note: 'fact rows exceeded the packet cap; narrow the query to inspect omitted fact evidence and review state',
    });
    assert.ok(!('omitted' in packet.partial.fact_rows));
  });

  it('marks possible fact group omissions and stays quiet at the exact limit', async () => {
    const overflow = await context('grouplimit service');
    assert.deepStrictEqual(overflow.partial.fact_groups, {
      limit: 10,
      more_may_exist: true,
      note: 'fact groups exceeded the packet cap; narrow the query to inspect omitted reviewed or unresolved groups',
    });
    assert.ok(!('omitted' in overflow.partial.fact_groups));

    const exactGroup = await context('exactgroup service');
    assert.strictEqual(exactGroup.partial, undefined);

    const exactRows = await context('exactrow service');
    assert.strictEqual(exactRows.partial, undefined);
  });
});
