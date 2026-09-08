import './helpers/tmp-kb.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getDb, getDocument } from '../src/db.js';
import { factReviewState } from '../src/fact-reviews.js';
import { addFact } from '../src/facts.js';
import { runReconcileCli } from '../src/cli/reconcile.js';
import { RECONCILIATION_LOG_DIR, runReconciliation } from '../src/reconciliation.js';

const db = getDb();
let seq = 0;
let transcriptDir;

function resetDb() {
  db.exec(`
    DELETE FROM facts;
    DELETE FROM entity_aliases;
    DELETE FROM entities;
    DELETE FROM vault_files;
    DELETE FROM documents;
    DELETE FROM harvest_log;
  `);
  rmSync(RECONCILIATION_LOG_DIR, { recursive: true, force: true });
  transcriptDir = mkdtempSync(join(tmpdir(), 'kb-reconcile-transcripts-'));
  seq += 1;
}

beforeEach(resetDb);

function source(name, text) {
  const session = `reconcile-${seq}-${name}`;
  const path = join(transcriptDir, `${session}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n');
  db.prepare('INSERT INTO harvest_log (transcript_path, mtime, facts_added, notes_added) VALUES (?, ?, ?, ?)')
    .run(path, Date.now(), 1, 0);
  return `harvest:${session}`;
}

function insertDoc({ title, content, tags = '', createdAt }) {
  return db.prepare('INSERT INTO documents (title, content, doc_type, tags, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(title, content, 'note', tags, createdAt).lastInsertRowid;
}

function lineCount(path) {
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).length;
}

describe('autonomous reconciliation', () => {
  it('applies a supported note supersession from independently resolved old and change evidence', async () => {
    const oldSource = source('old', 'Widget service status was beta during the first rollout.');
    const changeSource = source('change', 'Widget service status changed from beta to GA after the launch gate passed.');
    const old = addFact('Widget service', 'status', 'beta', { validFrom: '2026-08-01 00:00:00', source: oldSource });
    db.prepare('UPDATE facts SET valid_to = ? WHERE id = ?').run('2026-08-20 00:00:00', old.id);
    addFact('Widget service', 'status', 'GA', { validFrom: '2026-08-20 00:00:00', source: changeSource });
    const stale = insertDoc({
      title: 'Widget service rollout',
      content: 'Widget service is still beta for the rollout.',
      tags: 'Widget service',
      createdAt: '2026-08-02 00:00:00',
    });
    const replacement = insertDoc({
      title: 'Widget service GA',
      content: 'Widget service is GA after launch.',
      tags: 'Widget service',
      createdAt: '2026-08-21 00:00:00',
    });

    const result = await runReconciliation({
      db,
      limit: 1,
      logPath: join(transcriptDir, 'reconcile.jsonl'),
      decideSupersession: () => ({ action: 'supersede', reason: 'Harvest evidence says Widget service changed from beta to GA.' }),
    });

    assert.strictEqual(result.applied, 1);
    const doc = getDocument(stale);
    assert.strictEqual(doc.superseded_by, replacement);
    assert.match(doc.superseded_reason, /changed from beta to GA/);
    assert.strictEqual(lineCount(join(transcriptDir, 'reconcile.jsonl')), 1);
  });

  it('abstains when the replacement claim repeats in a note but its source cannot prove the change', async () => {
    const oldSource = source('old', 'Gizmo API status was draft in the original spike.');
    const repeatOnlySource = source('repeat', 'Gizmo API status is live.');
    const old = addFact('Gizmo API', 'status', 'draft', { validFrom: '2026-08-01 00:00:00', source: oldSource });
    db.prepare('UPDATE facts SET valid_to = ? WHERE id = ?').run('2026-08-20 00:00:00', old.id);
    addFact('Gizmo API', 'status', 'live', { validFrom: '2026-08-20 00:00:00', source: repeatOnlySource });
    const stale = insertDoc({
      title: 'Gizmo API status',
      content: 'Gizmo API is draft.',
      tags: 'Gizmo API',
      createdAt: '2026-08-02 00:00:00',
    });
    insertDoc({
      title: 'Gizmo API live note',
      content: 'Gizmo API is live.',
      tags: 'Gizmo API',
      createdAt: '2026-08-21 00:00:00',
    });

    const result = await runReconciliation({
      db,
      limit: 1,
      logPath: join(transcriptDir, 'unsupported.jsonl'),
      decideSupersession: () => ({ action: 'supersede', reason: 'should not be called' }),
    });

    assert.strictEqual(result.apstained ?? result.abstained, 1);
    assert.strictEqual(getDocument(stale).superseded_at, null);
    assert.match(result.decisions[0].reason, /change clause/);
  });



  it('abstains when old/new terms are split across unrelated sentences', async () => {
    const oldSource = source('bag-old', 'Gizmo API status was beta during the first rollout.');
    const misleadingSource = source('bag-new', 'Gizmo API status is live. The unrelated beta environment moved to production.');
    const old = addFact('Gizmo API', 'status', 'beta', { validFrom: '2026-08-01 00:00:00', source: oldSource });
    db.prepare('UPDATE facts SET valid_to = ? WHERE id = ?').run('2026-08-20 00:00:00', old.id);
    addFact('Gizmo API', 'status', 'live', { validFrom: '2026-08-20 00:00:00', source: misleadingSource });
    const stale = insertDoc({ title: 'Gizmo API beta', content: 'Gizmo API is beta.', tags: 'Gizmo API', createdAt: '2026-08-02 00:00:00' });
    insertDoc({ title: 'Gizmo API live', content: 'Gizmo API is live.', tags: 'Gizmo API', createdAt: '2026-08-21 00:00:00' });

    const result = await runReconciliation({
      db,
      limit: 1,
      logPath: join(transcriptDir, 'bag-terms.jsonl'),
      decideSupersession: () => ({ action: 'supersede', reason: 'should not apply' }),
    });

    assert.strictEqual(result.abstained, 1);
    assert.match(result.decisions[0].reason, /change clause/);
    assert.strictEqual(getDocument(stale).superseded_at, null);
  });

  it('abstains when the explicit old-to-new claim is for a different predicate', async () => {
    const oldSource = source('predicate-old', 'Mismatch API status was beta during the pilot.');
    const mismatchSource = source('predicate-new', 'Mismatch API deployment changed from beta to live after rollout.');
    const old = addFact('Mismatch API', 'status', 'beta', { validFrom: '2026-08-01 00:00:00', source: oldSource });
    db.prepare('UPDATE facts SET valid_to = ? WHERE id = ?').run('2026-08-20 00:00:00', old.id);
    addFact('Mismatch API', 'status', 'live', { validFrom: '2026-08-20 00:00:00', source: mismatchSource });
    const stale = insertDoc({ title: 'Mismatch API beta', content: 'Mismatch API is beta.', tags: 'Mismatch API', createdAt: '2026-08-02 00:00:00' });
    insertDoc({ title: 'Mismatch API live', content: 'Mismatch API is live.', tags: 'Mismatch API', createdAt: '2026-08-21 00:00:00' });

    const result = await runReconciliation({
      db,
      limit: 1,
      logPath: join(transcriptDir, 'predicate-mismatch.jsonl'),
      decideSupersession: () => ({ action: 'supersede', reason: 'should not apply' }),
    });

    assert.strictEqual(result.abstained, 1);
    assert.match(result.decisions[0].reason, /change clause/);
    assert.strictEqual(getDocument(stale).superseded_at, null);
  });

  it('abstains on quoted or negated non-change assertions', async () => {
    const oldSource = source('negated-old', 'Negated API status was beta during the trial.');
    const negatedSource = source('negated-new', 'The report rejected the claim that Negated API status changed from beta to live.');
    const old = addFact('Negated API', 'status', 'beta', { validFrom: '2026-08-01 00:00:00', source: oldSource });
    db.prepare('UPDATE facts SET valid_to = ? WHERE id = ?').run('2026-08-20 00:00:00', old.id);
    addFact('Negated API', 'status', 'live', { validFrom: '2026-08-20 00:00:00', source: negatedSource });
    const stale = insertDoc({ title: 'Negated API beta', content: 'Negated API is beta.', tags: 'Negated API', createdAt: '2026-08-02 00:00:00' });
    insertDoc({ title: 'Negated API live', content: 'Negated API is live.', tags: 'Negated API', createdAt: '2026-08-21 00:00:00' });

    const result = await runReconciliation({
      db,
      limit: 1,
      logPath: join(transcriptDir, 'negated-change.jsonl'),
      decideSupersession: () => ({ action: 'supersede', reason: 'should not apply' }),
    });

    assert.strictEqual(result.abstained, 1);
    assert.match(result.decisions[0].reason, /change clause/);
    assert.strictEqual(getDocument(stale).superseded_at, null);
  });


  it('abstains when the source explicitly says the status did not change', async () => {
    const oldSource = source('did-not-old', 'Still API status was beta during the trial.');
    const negatedSource = source('did-not-new', 'Still API status did not change from beta to live during this review.');
    const old = addFact('Still API', 'status', 'beta', { validFrom: '2026-08-01 00:00:00', source: oldSource });
    db.prepare('UPDATE facts SET valid_to = ? WHERE id = ?').run('2026-08-20 00:00:00', old.id);
    addFact('Still API', 'status', 'live', { validFrom: '2026-08-20 00:00:00', source: negatedSource });
    const stale = insertDoc({ title: 'Still API beta', content: 'Still API is beta.', tags: 'Still API', createdAt: '2026-08-02 00:00:00' });
    insertDoc({ title: 'Still API live', content: 'Still API is live.', tags: 'Still API', createdAt: '2026-08-21 00:00:00' });

    const result = await runReconciliation({
      db,
      limit: 1,
      logPath: join(transcriptDir, 'did-not-change.jsonl'),
      decideSupersession: () => ({ action: 'supersede', reason: 'should not apply' }),
    });

    assert.strictEqual(result.abstained, 1);
    assert.match(result.decisions[0].reason, /change clause/);
    assert.strictEqual(getDocument(stale).superseded_at, null);
  });

  it('abstains when old and replacement facts resolve to the same harvest source', async () => {
    const shared = source('shared', 'Samebot status was queued, then Samebot status changed from queued to active.');
    const old = addFact('Samebot', 'status', 'queued', { validFrom: '2026-08-01 00:00:00', source: shared });
    db.prepare('UPDATE facts SET valid_to = ? WHERE id = ?').run('2026-08-20 00:00:00', old.id);
    addFact('Samebot', 'status', 'active', { validFrom: '2026-08-20 00:00:00', source: shared });
    const stale = insertDoc({ title: 'Samebot queued', content: 'Samebot is queued.', tags: 'Samebot', createdAt: '2026-08-02 00:00:00' });
    insertDoc({ title: 'Samebot active', content: 'Samebot is active.', tags: 'Samebot', createdAt: '2026-08-21 00:00:00' });

    const result = await runReconciliation({
      db,
      limit: 1,
      logPath: join(transcriptDir, 'same-source.jsonl'),
      decideSupersession: () => ({ action: 'supersede', reason: 'should not apply' }),
    });

    assert.strictEqual(result.abstained, 1);
    assert.match(result.decisions[0].reason, /distinct harvest sources/);
    assert.strictEqual(getDocument(stale).superseded_at, null);
  });

  it('applies a supported fact review without deleting or tier-promoting raw assertions', async () => {
    const a = addFact('Autopipe', 'status', 'GA', {
      source: source('ga', 'Autopipe status is GA for current users.'),
    });
    const b = addFact('Autopipe', 'status', 'beta', {
      source: source('beta', 'Autopipe status was beta before the release.'),
    });

    const result = await runReconciliation({
      db,
      limit: 1,
      logPath: join(transcriptDir, 'facts.jsonl'),
      decideFactGroup: ({ assertions }) => ({
        items: assertions.map(fact => fact.id === a.id
          ? { fact_id: fact.id, disposition: 'current' }
          : { fact_id: fact.id, disposition: 'superseded', target_fact_id: a.id, reason: 'Older beta status was superseded by GA.' }),
      }),
    });

    assert.strictEqual(result.applied, 1);
    assert.strictEqual(db.prepare('SELECT COUNT(*) count FROM facts WHERE valid_to IS NULL').get().count, 2);
    const state = factReviewState(db, { subject: 'Autopipe', predicate: 'status' });
    assert.deepStrictEqual(state.current.map(fact => fact.id), [a.id]);
    assert.strictEqual(getDocument(db.prepare("INSERT INTO documents (title, content, doc_type) VALUES ('tier guard', 'x', 'note')").run().lastInsertRowid).tier, 'inferred');
  });

  it('abstains instead of applying when fact group membership changes after decision', async () => {
    const a = addFact('Racepipe', 'status', 'GA', {
      source: source('race-ga', 'Racepipe status is GA now.'),
    });
    const b = addFact('Racepipe', 'status', 'beta', {
      source: source('race-beta', 'Racepipe status was beta before release.'),
    });

    const result = await runReconciliation({
      db,
      limit: 1,
      logPath: join(transcriptDir, 'stale-fact.jsonl'),
      decideFactGroup: ({ assertions }) => {
        addFact('Racepipe', 'status', 'pilot', { source: source('race-pilot', 'Racepipe status is pilot in a separate trial.') });
        return { items: assertions.map(fact => fact.id === a.id
          ? { fact_id: fact.id, disposition: 'current' }
          : { fact_id: fact.id, disposition: 'superseded', target_fact_id: a.id, reason: 'Older status.' }) };
      },
    });

    assert.strictEqual(result.stale, 1);
    assert.strictEqual(factReviewState(db, { subject: 'Racepipe', predicate: 'status' }).review_id, null);
    assert.strictEqual(db.prepare('SELECT COUNT(*) count FROM facts WHERE subject = ?').get('racepipe').count, 3);
    assert.ok(b.id);
  });

  it('abstains instead of applying when document snapshots change after decision', async () => {
    const oldSource = source('doc-old', 'Flux service status was alpha before the cutover.');
    const changeSource = source('doc-change', 'Flux service status changed from alpha to stable after the cutover.');
    const old = addFact('Flux service', 'status', 'alpha', { validFrom: '2026-08-01 00:00:00', source: oldSource });
    db.prepare('UPDATE facts SET valid_to = ? WHERE id = ?').run('2026-08-20 00:00:00', old.id);
    addFact('Flux service', 'status', 'stable', { validFrom: '2026-08-20 00:00:00', source: changeSource });
    const stale = insertDoc({ title: 'Flux service old', content: 'Flux service is alpha.', tags: 'Flux service', createdAt: '2026-08-02 00:00:00' });
    insertDoc({ title: 'Flux service new', content: 'Flux service is stable.', tags: 'Flux service', createdAt: '2026-08-21 00:00:00' });

    const result = await runReconciliation({
      db,
      limit: 1,
      logPath: join(transcriptDir, 'stale-doc.jsonl'),
      decideSupersession: () => {
        db.prepare('UPDATE documents SET content = ? WHERE id = ?').run('Flux service was manually corrected.', stale);
        return { action: 'supersede', reason: 'stale should stop apply' };
      },
    });

    assert.strictEqual(result.stale, 1);
    assert.strictEqual(getDocument(stale).superseded_at, null);
  });

  it('is idempotent when the database write succeeds but JSONL logging crashes', async () => {
    const oldSource = source('crash-old', 'Crashbot status was queued before rollout.');
    const changeSource = source('crash-change', 'Crashbot status changed from queued to active after rollout.');
    const old = addFact('Crashbot', 'status', 'queued', { validFrom: '2026-08-01 00:00:00', source: oldSource });
    db.prepare('UPDATE facts SET valid_to = ? WHERE id = ?').run('2026-08-20 00:00:00', old.id);
    addFact('Crashbot', 'status', 'active', { validFrom: '2026-08-20 00:00:00', source: changeSource });
    const stale = insertDoc({ title: 'Crashbot queued', content: 'Crashbot is queued.', tags: 'Crashbot', createdAt: '2026-08-02 00:00:00' });
    const replacement = insertDoc({ title: 'Crashbot active', content: 'Crashbot is active.', tags: 'Crashbot', createdAt: '2026-08-21 00:00:00' });
    const parentFile = join(transcriptDir, 'not-a-dir');
    writeFileSync(parentFile, 'x');

    await assert.rejects(
      () => runReconciliation({
        db,
        limit: 1,
        logPath: join(parentFile, 'decisions.jsonl'),
        decideSupersession: () => ({ action: 'supersede', reason: 'Crashbot status changed from queued to active.' }),
      }),
      /ENOTDIR|EEXIST/,
    );
    assert.strictEqual(getDocument(stale).superseded_by, replacement);

    const retry = await runReconciliation({
      db,
      limit: 1,
      logPath: join(transcriptDir, 'retry.jsonl'),
      decideSupersession: () => ({ action: 'supersede', reason: 'duplicate should not matter' }),
    });
    assert.strictEqual(retry.already_applied, 1);
    assert.strictEqual(getDocument(stale).superseded_by, replacement);
  });

  it('exposes a bounded queue CLI without invoking the model', async () => {
    addFact('Queuebot', 'status', 'GA', { source: source('queue-ga', 'Queuebot status is GA now.') });
    addFact('Queuebot', 'status', 'beta', { source: source('queue-beta', 'Queuebot status was beta before launch.') });

    const snapshot = await runReconcileCli(['--queue', '--json', '--limit', '1']);

    assert.strictEqual(snapshot.note_supersession.length, 0);
    assert.strictEqual(snapshot.fact_review.length, 1);
    assert.strictEqual(snapshot.fact_review[0].subject_name, 'Queuebot');
  });
});
