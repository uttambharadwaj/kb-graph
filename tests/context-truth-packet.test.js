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
});
