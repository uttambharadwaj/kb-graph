import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod/v4';
import { getDb } from '../src/db.js';
import { addFact } from '../src/facts.js';
import { getToolDefinitions } from '../src/tools.js';

const tool = getToolDefinitions().find(t => t.name === 'kb_fact_invalidate');
const stored = res => JSON.parse(res.content[0].text);

describe('kb_fact_invalidate fact-id addressing', () => {
  it('advertises the fact id returned by writers as an alternative to a triple', () => {
    const schema = z.object(tool.schema);
    assert.strictEqual(schema.safeParse({ id: 'f_ticket_status_open_abc' }).success, true);
    assert.strictEqual(schema.safeParse({
      subject: 'ticket', predicate: 'status', object: 'open',
    }).success, true, 'the legacy triple form must stay compatible');
  });

  it('invalidates the exact current row by the id returned from addFact', async () => {
    const fact = addFact('pf-3375', 'status', 'in_progress', {
      validFrom: '2026-08-20', source: 'test',
    });

    const result = stored(await tool.handler({ id: fact.id, ended: '2026-08-26' }));

    assert.deepStrictEqual(result, { id: fact.id, invalidated: 1, ended: '2026-08-26' });
    const row = getDb().prepare('SELECT valid_to FROM facts WHERE id = ?').get(fact.id);
    assert.strictEqual(row.valid_to, '2026-08-26');
  });

  it('refuses an id retirement whose end precedes its valid_from', async () => {
    const fact = addFact('pf-3375-guard', 'status', 'in_progress', {
      validFrom: '2026-08-26', source: 'test',
    });

    const result = stored(await tool.handler({ id: fact.id, ended: '2026-08-20' }));

    assert.deepStrictEqual(result, {
      id: fact.id,
      invalidated: 0,
      ended: '2026-08-20',
      refused: 'ended_before_valid_from',
      valid_from: '2026-08-26',
    });
    const row = getDb().prepare('SELECT valid_to FROM facts WHERE id = ?').get(fact.id);
    assert.strictEqual(row.valid_to, null);
  });

  it('reports an unknown id instead of returning an empty success', async () => {
    const response = await tool.handler({ id: 'f_missing' });

    assert.strictEqual(response.isError, true);
    assert.match(response.content[0].text, /fact id not found: f_missing/);
  });

  it('rejects incomplete or ambiguous addressing instead of guessing', async () => {
    const incomplete = await tool.handler({ subject: 'pf-3375', predicate: 'status' });
    assert.strictEqual(incomplete.isError, true);
    assert.match(incomplete.content[0].text, /provide either id or the complete subject, predicate, object triple/);

    const both = await tool.handler({
      id: 'f_any', subject: 'pf-3375', predicate: 'status', object: 'open',
    });
    assert.strictEqual(both.isError, true);
    assert.match(both.content[0].text, /provide either id or the complete subject, predicate, object triple/);
  });
});
