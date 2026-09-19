import './helpers/tmp-kb.js';
import { beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../src/db.js';
import { addFact } from '../src/facts.js';
import { runReconciliation } from '../src/reconciliation.js';

const db = getDb();
let dir;
beforeEach(() => {
  db.exec('DELETE FROM facts; DELETE FROM entity_aliases; DELETE FROM entities; DELETE FROM vault_files; DELETE FROM documents; DELETE FROM harvest_log; DELETE FROM meta;');
  dir = mkdtempSync(join(tmpdir(), 'kb-reconcile-review-'));
});
function source(name, text) {
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n');
  db.prepare('INSERT INTO harvest_log (transcript_path, mtime) VALUES (?, ?)').run(path, Date.now());
  return `harvest:${name}`;
}
function group(name, supported = true) {
  return ['beta', 'stable'].map(value => addFact(name, 'status', value, {
    source: source(`${name}-${value}`, supported ? `${name} status is ${value}.` : 'No evidence yet.'),
  }));
}
function note(name) {
  const old = addFact(name, 'status', 'beta', { source: source(`${name}-old`, `${name} status was beta.`), validFrom: '2026-08-01' });
  db.prepare('UPDATE facts SET valid_to = ? WHERE id = ?').run('2026-08-20', old.id);
  addFact(name, 'status', 'stable', { source: source(`${name}-new`, `${name} status changed from beta to stable.`), validFrom: '2026-08-20' });
  const put = (value, date) => Number(db.prepare('INSERT INTO documents (title, content, doc_type, created_at) VALUES (?, ?, ?, ?)')
    .run(`${name} ${value}`, `${name} is ${value}.`, 'note', date).lastInsertRowid);
  return { old: put('beta', '2026-08-02'), replacement: put('stable', '2026-08-21') };
}
const decideFacts = ({ assertions }) => ({ items: assertions.map(fact => ({ fact_id: fact.id, disposition: 'current' })) });
function run(options = {}) {
  return runReconciliation({ db, logPath: join(dir, 'decisions.jsonl'), decideFactGroup: decideFacts, decideSupersession: () => ({ action: 'abstain' }), ...options });
}

it('visits all fact groups across bounded runs despite repeated unsupported evidence', async () => {
  for (let i = 0; i < 6; i++) group(`Group${i}`, false);
  const visited = new Set();
  for (let i = 0; i < 3; i++) {
    const result = await run({ limit: 5 });
    assert.equal(result.candidates, 5);
    for (const decision of result.decisions) visited.add(decision.subject);
  }
  assert.equal(visited.size, 6);
});

it('rotates across both candidate kinds and retries changed evidence on the next cycle', async () => {
  note('FirstNote');
  group('LaterGroup', false);
  const first = await run({ limit: 1 });
  const second = await run({ limit: 1 });
  assert.notEqual(first.decisions[0].kind, second.decisions[0].kind);
  for (const value of ['beta', 'stable']) {
    writeFileSync(join(dir, `LaterGroup-${value}.jsonl`), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `LaterGroup status is ${value}.` }] } }) + '\n');
  }
  const retry = [...(await run({ limit: 1 })).decisions, ...(await run({ limit: 1 })).decisions];
  assert.equal(retry.find(item => item.kind === 'fact_review').outcome, 'applied');
});

it('dry runs do not consume the persisted cursor', async () => {
  group('First', false); group('Second', false);
  const first = await run({ limit: 1, dryRun: true });
  assert.equal((await run({ limit: 1 })).decisions[0].subject, first.decisions[0].subject);
  assert.notEqual((await run({ limit: 1 })).decisions[0].subject, first.decisions[0].subject);
});

it('uses the next greater key after a candidate disappears and retries restored sources', async () => {
  group('AFirst'); group('BSecond'); group('CThird');
  const missingPath = join(dir, 'BSecond-beta.jsonl');
  const text = readFileSync(missingPath, 'utf8');
  unlinkSync(missingPath);
  assert.equal((await run({ limit: 1 })).decisions[0].subject, 'AFirst');
  db.prepare('UPDATE facts SET valid_to = ? WHERE subject = ?').run('2026-08-30', 'afirst');
  const missing = await run({ limit: 1 });
  assert.equal(missing.decisions[0].subject, 'BSecond');
  assert.equal(missing.abstained, 1);
  writeFileSync(missingPath, text);
  assert.equal((await run({ limit: 1 })).decisions[0].subject, 'CThird');
  const restored = await run({ limit: 1 });
  assert.equal(restored.decisions[0].subject, 'BSecond');
  assert.equal(restored.applied, 1);
});

it('acknowledges completed note pairs only after durable logging and then removes them from scheduling', async () => {
  const ids = note('CrashNote');
  const blocked = join(dir, 'blocked');
  writeFileSync(blocked, 'not a directory');
  await assert.rejects(run({ limit: 1, logPath: join(blocked, 'decisions.jsonl'), decideSupersession: () => ({ action: 'supersede' }) }), /ENOTDIR|EEXIST/);
  assert.equal(db.prepare('SELECT superseded_by FROM documents WHERE id = ?').get(ids.old).superseded_by, ids.replacement);
  group('LaterGroup');
  assert.equal((await run({ limit: 1 })).already_applied, 1);
  for (let i = 0; i < 3; i++) {
    assert.equal((await run({ limit: 1 })).decisions[0].kind, 'fact_review');
  }
});

it('keeps moving after stale and already-applied fact decisions', async () => {
  group('AStale'); group('BApplied'); group('CLater');
  const first = await run({ limit: 1, decideFactGroup: candidate => {
    addFact('AStale', 'status', 'pilot', { source: source('AStale-pilot', 'AStale status is pilot.') });
    return decideFacts(candidate);
  } });
  assert.equal(first.stale, 1);
  assert.equal((await run({ limit: 1 })).decisions[0].subject, 'BApplied');
  assert.equal((await run({ limit: 1 })).decisions[0].subject, 'CLater');
  await run({ limit: 1 });
  const already = await run({ limit: 1 });
  assert.equal(already.decisions[0].subject, 'BApplied');
  assert.equal(already.already_applied, 1);
  assert.equal((await run({ limit: 1 })).decisions[0].subject, 'CLater');
});

for (const [label, invalid] of Object.entries({ null: null, primitive: 1, array: [], nullItem: { items: [null] }, numericId: { items: [{ fact_id: 42, disposition: 'current' }] } })) {
  it(`isolates invalid ${label} model decisions and rejects them during dry-run`, async () => {
    group('AInvalid'); group('BValid');
    for (const dryRun of [true, false]) {
      const result = await run({ limit: 2, dryRun, decideFactGroup: candidate => candidate.subject === 'AInvalid' ? invalid : decideFacts(candidate) });
      assert.equal(result.abstained, 1);
      assert.equal(result[dryRun ? 'would_apply' : 'applied'], 1);
    }
  });
}

it('isolates rejected model calls without leaking their error secret', async () => {
  group('AInvalid'); group('BValid');
  await assert.rejects(run({ limit: 2, decideFactGroup: candidate => {
    if (candidate.subject === 'AInvalid') throw new Error('token=secret-canary-123456789');
    return decideFacts(candidate);
  } }), /model call failed/);
  const logged = readFileSync(join(dir, 'decisions.jsonl'), 'utf8');
  const decisions = logged.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(decisions[0].outcome, 'abstained');
  assert.equal(decisions[1].outcome, 'applied');
  assert.ok(!logged.includes('secret-canary'));
  assert.match(db.prepare("SELECT value FROM meta WHERE key = 'last_reconcile_error'").get().value, /REDACTED/);

});

it('keeps document bodies private but still rejects content races without vault hashes', async () => {
  const ids = note('PrivateNote');
  const privateBody = 'PRIVATE_BODY_CANARY';
  const secret = 'sk-123456789012345678901234567890';
  db.prepare('UPDATE documents SET content = content || ? WHERE id = ?').run(` ${privateBody} ${secret}`, ids.old);
  let modelInput;
  const result = await run({ limit: 1, decideSupersession: candidate => {
    modelInput = JSON.stringify(candidate);
    assert.match(candidate.snapshot.stale.hash, /^[a-f0-9]{64}$/);
    db.prepare('UPDATE documents SET content = content || ? WHERE id = ?').run(' Manual edit.', ids.old);
    return { action: 'supersede', reason: `Corrected ${secret}` };
  } });
  assert.equal(result.stale, 1);
  const outward = modelInput + JSON.stringify(result) + readFileSync(join(dir, 'decisions.jsonl'), 'utf8');
  assert.ok(!outward.includes(privateBody));
  assert.ok(!outward.includes(secret));
  assert.ok(!outward.includes('transcript_path'));
});

it('rejects malformed supersession actions and continues with the later fact candidate', async () => {
  note('MalformedNote'); group('LaterGroup');
  const result = await run({ limit: 2, dryRun: true, decideSupersession: () => null });
  assert.equal(result.abstained, 1);
  assert.equal(result.would_apply, 1);
});

it('propagates database failures instead of classifying them as invalid model output', async () => {
  group('BrokenWrite');
  db.exec("CREATE TEMP TRIGGER fail_review BEFORE INSERT ON fact_reviews BEGIN SELECT RAISE(ABORT, 'test database write failure'); END;");
  try {
    await assert.rejects(run({ limit: 1 }), /test database write failure/);
  } finally {
    db.exec('DROP TRIGGER fail_review');
  }
});

it('validates malformed IDs before comparing with an existing review', async () => {
  group('ReviewedGroup');
  assert.equal((await run({ limit: 1 })).applied, 1);
  const result = await run({ limit: 1, decideFactGroup: () => ({ items: [{ fact_id: 42, disposition: 'current' }] }) });
  assert.equal(result.abstained, 1);
  assert.equal(result.already_applied, 0);
});

for (const invalid of ['bad-disposition', 'foreign-target']) {
  it(`rejects ${invalid} in otherwise well-shaped dry-run decisions`, async () => {
    group('ValidatedGroup');
    const result = await run({ limit: 1, dryRun: true, decideFactGroup: ({ assertions }) => ({
      items: assertions.map((fact, index) => index === 0
        ? { fact_id: fact.id, disposition: invalid === 'bad-disposition' ? 'made-up' : 'superseded', ...(invalid === 'foreign-target' ? { target_fact_id: 'not-a-member' } : {}) }
        : { fact_id: fact.id, disposition: 'current' }),
    }) });
    assert.equal(result.abstained, 1);
    assert.equal(result.would_apply, 0);
  });
}
