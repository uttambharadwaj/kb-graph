import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Point the KB at a throwaway dir BEFORE importing anything that opens the DB.
process.env.KB_DIR = mkdtempSync(join(tmpdir(), 'kb-qualifier-'));

const { addFact, queryFact, isQualifiedForm, nearbyEntities } = await import('../src/facts.js');

describe('isQualifiedForm', () => {
  const cases = [
    // id, entity, qualified?, why
    ['auth-service', 'auth-service', true, 'the entity itself'],
    ['auth_service_sandbox', 'auth_service', true, 'a named variant'],
    ['auth_service_prod_image', 'auth_service', true, 'a multi-word named variant'],
    ['prod_100_percent', 'prod', true, 'digits inside a phrase are not an id'],
    ['pr_3583', 'pr', false, 'a pull request is not a variant of "pr"'],
    ['pf_1605', 'pf', false, 'a ticket is not a variant of its prefix'],
    ['pr_#11', 'pr', false, 'issue numbers arrive with the hash intact'],
    ['prod_2026_07_21', 'prod', false, 'a date is a run of numbers, not a qualifier'],
    ['press', 'pr', false, 'no separator, so not an extension at all'],
    ['pricing', 'pr', false, 'a longer word that merely starts the same'],
  ];

  for (const [id, entity, expected, why] of cases) {
    it(`${id} vs ${entity}: ${expected ? 'qualified' : 'separate'} — ${why}`, () => {
      assert.strictEqual(isQualifiedForm(id, entity), expected);
    });
  }
});

describe('queryFact does not absorb numbered ids', () => {
  before(() => {
    addFact('auth-service', 'owned_by', 'platform team', { validFrom: '2026-01-01' });
    addFact('auth-service sandbox', 'deployed_to', 'staging', { validFrom: '2026-01-02' });
    addFact('PR 3583', 'shipped_via', 'commit abc1234', { validFrom: '2026-01-03' });
    addFact('PR #4001', 'reviewed_by', 'a reviewer', { validFrom: '2026-01-04' });
    addFact('PR triage', 'owned_by', 'platform team', { validFrom: '2026-01-05' });
  });

  it('reaches named variants of the entity', () => {
    const objects = queryFact('auth-service', { direction: 'outgoing' }).map(f => f.object).sort();
    assert.deepStrictEqual(objects, ['platform team', 'staging']);
  });

  it('does not return numbered ids that share the prefix', () => {
    const subjects = queryFact('pr', { direction: 'outgoing' }).map(f => f.subject);
    assert.deepStrictEqual(subjects, ['PR triage'], 'PR 3583 and PR #4001 are their own entities');
  });

  it('the numbered ids are still reachable under their own names', () => {
    assert.strictEqual(queryFact('PR 3583').length, 1);
    assert.strictEqual(queryFact('PR #4001').length, 1);
  });

  it('applies to incoming edges too, not only outgoing', () => {
    addFact('design doc', 'supersedes', 'PR 3583', { validFrom: '2026-01-06' });
    const incoming = queryFact('pr', { direction: 'incoming' });
    assert.deepStrictEqual(incoming, [], 'a numbered id on the object side is the same non-match');
  });

  it('exact mode is unaffected', () => {
    assert.deepStrictEqual(
      queryFact('auth-service', { direction: 'outgoing', exact: true }).map(f => f.object),
      ['platform team'],
    );
  });

  it('nearbyEntities still hides forms the prefix match does cover', () => {
    // "auth_service_sandbox" is a genuine qualified form, so it is queryFact's
    // to return and not something to disclose as unreachable.
    const nearby = nearbyEntities('auth-service').map(e => e.id);
    assert.ok(!nearby.includes('auth_service_sandbox'));
  });
});
