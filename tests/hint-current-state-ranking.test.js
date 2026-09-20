import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/db.js';
import { relevantNotes } from '../src/hint-relevance.js';

describe('current-context hint ranking', () => {
  it('prefers current state across a relevance-bucket rounding boundary', () => {
    const db = getDb();
    const insert = db.prepare(
      'INSERT INTO documents (title, content, doc_type, tags) VALUES (?, ?, ?, ?)'
    );
    const lessonId = insert.run(
      'Azuron belvon retrospective',
      'Accumulated guidance.',
      'lesson',
      '',
    ).lastInsertRowid;
    const stateId = insert.run(
      'Cyrion draxen',
      'Current operating state.',
      'state',
      '',
    ).lastInsertRowid;
    const strongerLessonId = insert.run(
      'Eldrin falkor',
      'Materially stronger accumulated guidance.',
      'lesson',
      '',
    ).lastInsertRowid;
    const equalLessonId = insert.run('Galdor helion', '', 'lesson', '').lastInsertRowid;
    const decisionId = insert.run('Galdor helion', '', 'decision', '').lastInsertRowid;
    const neutralLessonId = insert.run('Ivaron jexel', '', 'lesson', '').lastInsertRowid;
    const correctedStateId = insert.run('Ivaron jexel', '', 'state', '').lastInsertRowid;

    // With exactly 200 notes, these document frequencies put the lesson and
    // state 0.031 mass apart but on opposite 0.25 rounding buckets:
    // lesson df=(2,16), state df=(3,11).
    insert.run('Azuron reference', '', 'note', '');
    for (let i = 0; i < 15; i++) insert.run(`Belvon reference ${i}`, '', 'note', '');
    for (let i = 0; i < 2; i++) insert.run(`Cyrion reference ${i}`, '', 'note', '');
    for (let i = 0; i < 10; i++) insert.run(`Draxen reference ${i}`, '', 'note', '');
    insert.run('Eldrin reference', '', 'note', '');
    insert.run('Falkor reference', '', 'note', '');
    for (let i = 0; i < 163; i++) insert.run(`Unrelated archive ${i}`, '', 'note', '');

    db.prepare(
      "INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type) VALUES (?, ?, ?, ?, 'state')"
    ).run('corrected-state.md', 'corrected-state-version', correctedStateId, 'Ivaron jexel');
    const retrievalId = db.prepare(`
      INSERT INTO retrievals (doc_id, doc_version, surface, session, is_test)
      VALUES (?, ?, 'kb_read', 'ranking-outcome', 0)
    `).run(correctedStateId, 'corrected-state-version').lastInsertRowid;
    db.prepare(`
      INSERT INTO retrieval_outcomes
        (retrieval_id, doc_id, doc_version, session, outcome, evidence_kind, evidence_ref, source)
      VALUES (?, ?, ?, 'ranking-outcome', 'corrected', 'test', 'ranking-outcome', 'test')
    `).run(retrievalId, correctedStateId, 'corrected-state-version');

    const hits = relevantNotes(
      'Compare azuron belvon with cyrion draxen',
      { limit: 5, explain: true },
    );
    const lesson = hits.find(hit => hit.id === lessonId);
    const state = hits.find(hit => hit.id === stateId);

    assert.ok(lesson && state, JSON.stringify(hits));
    assert.ok(lesson.mass > state.mass, JSON.stringify(hits));
    assert.ok(lesson.mass - state.mass <= 0.05, JSON.stringify(hits));
    assert.ok(
      hits.findIndex(hit => hit.id === stateId) < hits.findIndex(hit => hit.id === lessonId),
      JSON.stringify(hits),
    );

    const materialGap = relevantNotes(
      'Compare eldrin falkor with cyrion draxen',
      { limit: 5, explain: true },
    );
    assert.ok(
      materialGap.findIndex(hit => hit.id === strongerLessonId)
        < materialGap.findIndex(hit => hit.id === stateId),
      JSON.stringify(materialGap),
    );

    const equalMass = relevantNotes('Compare galdor helion records', { limit: 5 });
    assert.ok(
      equalMass.findIndex(hit => hit.id === decisionId)
        < equalMass.findIndex(hit => hit.id === equalLessonId),
      JSON.stringify(equalMass),
    );

    const unequalOutcome = relevantNotes('Compare ivaron jexel records', { limit: 5 });
    assert.ok(
      unequalOutcome.findIndex(hit => hit.id === neutralLessonId)
        < unequalOutcome.findIndex(hit => hit.id === correctedStateId),
      JSON.stringify(unequalOutcome),
    );
  });
});
