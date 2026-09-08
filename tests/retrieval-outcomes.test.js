import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { getDb, searchDocuments } from '../src/db.js';
import { SURFACE, logRetrieval } from '../src/retrieval.js';
import { OUTCOME, outcomeAdjustment, recordRetrievalOutcomesForSession, retrievalOutcomesReady } from '../src/retrieval-outcomes.js';

function ensureOutcomeSchema(db) {
  const columns = db.prepare('PRAGMA table_info(retrievals)').all().map(c => c.name);
  if (!columns.includes('doc_version')) db.exec('ALTER TABLE retrievals ADD COLUMN doc_version TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS retrieval_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      retrieval_id INTEGER NOT NULL,
      doc_id INTEGER NOT NULL,
      doc_version TEXT,
      session TEXT,
      event_id TEXT,
      outcome TEXT NOT NULL,
      evidence_kind TEXT NOT NULL,
      evidence_ref TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session, doc_id, doc_version, outcome, evidence_ref)
    );
  `);
}

function insertDoc(db, title, hash = 'v1') {
  const id = db.prepare('INSERT INTO documents (title, content, doc_type, tags) VALUES (?, ?, ?, ?)')
    .run(title, `${title} body`, 'note', 'outcomes').lastInsertRowid;
  db.prepare("INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type) VALUES (?, ?, ?, ?, 'note')")
    .run(`${title.replace(/\W+/g, '-').toLowerCase()}.md`, hash, id, title);
  return id;
}

function transcript(name, lines) {
  const path = join(tmpdir(), `${name}-${process.pid}-${Math.random()}.jsonl`);
  writeFileSync(path, lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n'));
  return path;
}

describe('recordRetrievalOutcomesForSession', () => {
  it('records helped only for explicit same-session doc use plus independent success', async () => {
    const db = getDb();
    ensureOutcomeSchema(db);
    const docId = insertDoc(db, 'Outcome build note', 'hash-helped');
    logRetrieval({ docId, surface: SURFACE.READ, session: 'sess-helped' });
    const path = transcript('helped', [
      { session_id: 'sess-helped', message: { content: 'I used KB #'+docId+' to run the targeted node test for the outcome parser.' } },
      { session_id: 'sess-helped', type: 'function_call', call_id: 'call_helped', name: 'shell', arguments: JSON.stringify({ cmd: 'node --test tests/retrieval-outcomes.test.js' }) },
      { session_id: 'sess-helped', type: 'function_call_output', call_id: 'call_helped', output: '3 passing' },
    ]);

    const result = await recordRetrievalOutcomesForSession({ transcriptPath: path });

    assert.strictEqual(result.recorded, 1);
    const row = db.prepare('SELECT outcome, doc_id, doc_version, evidence_kind FROM retrieval_outcomes').get();
    assert.deepStrictEqual(row, {
      outcome: OUTCOME.HELPED,
      doc_id: docId,
      doc_version: 'hash-helped',
      evidence_kind: 'attributed_success',
    });
  });

  it('correlates Claude tool_use command input with its matching successful tool_result', async () => {
    const db = getDb();
    ensureOutcomeSchema(db);
    const docId = insertDoc(db, 'Outcome Claude tool note', 'hash-claude-tool');
    logRetrieval({ docId, surface: SURFACE.READ, session: 'sess-claude-tool' });
    const path = transcript('claude-tool', [
      { session_id: 'sess-claude-tool', message: { content: `I used KB #${docId} to run the retrieval outcomes parser test.` } },
      { session_id: 'sess-claude-tool', message: { content: [
        { type: 'tool_use', id: 'toolu_123', name: 'Bash', input: { command: 'node --test tests/retrieval-outcomes.test.js' } },
      ] } },
      { session_id: 'sess-claude-tool', message: { content: [
        { type: 'tool_result', tool_use_id: 'toolu_123', content: '3 passing', is_error: false },
      ] } },
    ]);

    const result = await recordRetrievalOutcomesForSession({ transcriptPath: path });

    assert.strictEqual(result.recorded, 1);
    assert.strictEqual(db.prepare('SELECT outcome FROM retrieval_outcomes WHERE doc_id = ?').get(docId).outcome, OUTCOME.HELPED);
  });

  it('correlates Codex function_call arguments with the matching function_call_output', async () => {
    const db = getDb();
    ensureOutcomeSchema(db);
    const docId = insertDoc(db, 'Outcome Codex tool note', 'hash-codex-tool');
    logRetrieval({ docId, surface: SURFACE.READ, session: 'sess-codex-tool' });
    const path = transcript('codex-tool', [
      { session_id: 'sess-codex-tool', message: { content: `I used KB #${docId} to run the retrieval outcomes parser test.` } },
      { session_id: 'sess-codex-tool', type: 'function_call', call_id: 'call_abc', name: 'shell', arguments: JSON.stringify({ cmd: 'node --test tests/retrieval-outcomes.test.js' }) },
      { session_id: 'sess-codex-tool', type: 'function_call_output', call_id: 'call_abc', output: '3 passing' },
    ]);

    const result = await recordRetrievalOutcomesForSession({ transcriptPath: path });

    assert.strictEqual(result.recorded, 1);
    assert.strictEqual(db.prepare('SELECT outcome FROM retrieval_outcomes WHERE doc_id = ?').get(docId).outcome, OUTCOME.HELPED);
  });

  it('rejects unrelated success and successful kb writes without doc-use attribution', async () => {
    const db = getDb();
    ensureOutcomeSchema(db);
    const docId = insertDoc(db, 'Outcome unrelated note', 'hash-unrelated');
    logRetrieval({ docId, surface: SURFACE.READ, session: 'sess-unrelated' });
    const path = transcript('unrelated', [
      { session_id: 'sess-unrelated', message: { content: 'kb_write saved a different note successfully.' } },
      { session_id: 'sess-unrelated', output: 'node --test tests/some-other.test.js\n9 passing' },
    ]);

    const result = await recordRetrievalOutcomesForSession({ transcriptPath: path });

    assert.strictEqual(result.recorded, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM retrieval_outcomes WHERE doc_id = ?').get(docId).c, 0);
  });

  it('rejects a matching call id when the tool result is marked failed', async () => {
    const db = getDb();
    ensureOutcomeSchema(db);
    const docId = insertDoc(db, 'Outcome failed tool note', 'hash-failed-tool');
    logRetrieval({ docId, surface: SURFACE.READ, session: 'sess-failed-tool' });
    const path = transcript('failed-tool', [
      { session_id: 'sess-failed-tool', message: { content: `I used KB #${docId} to run the retrieval outcomes parser test.` } },
      { session_id: 'sess-failed-tool', type: 'function_call', call_id: 'call_failed', name: 'shell', arguments: JSON.stringify({ cmd: 'node --test tests/retrieval-outcomes.test.js' }) },
      { session_id: 'sess-failed-tool', type: 'function_call_output', call_id: 'call_failed', output: '3 passing', is_error: true },
    ]);

    const result = await recordRetrievalOutcomesForSession({ transcriptPath: path });

    assert.strictEqual(result.recorded, 0);
  });

  it('rejects an orphan tool result even when it contains a passing result', async () => {
    const db = getDb();
    ensureOutcomeSchema(db);
    const docId = insertDoc(db, 'Outcome orphan result note', 'hash-orphan-result');
    logRetrieval({ docId, surface: SURFACE.READ, session: 'sess-orphan-result' });
    const path = transcript('orphan-result', [
      { session_id: 'sess-orphan-result', message: { content: `I used KB #${docId} to run the retrieval outcomes parser test.` } },
      { session_id: 'sess-orphan-result', type: 'function_call_output', call_id: 'call_orphan', output: 'node --test tests/retrieval-outcomes.test.js\n3 passing' },
    ]);

    const result = await recordRetrievalOutcomesForSession({ transcriptPath: path });

    assert.strictEqual(result.recorded, 0);
  });

  it('rejects assistant text claiming the command passed', async () => {
    const db = getDb();
    ensureOutcomeSchema(db);
    const docId = insertDoc(db, 'Outcome assistant text note', 'hash-assistant-text');
    logRetrieval({ docId, surface: SURFACE.READ, session: 'sess-assistant-text' });
    const path = transcript('assistant-text', [
      { session_id: 'sess-assistant-text', message: { content: `I used KB #${docId} to run the retrieval outcomes parser test.` } },
      { session_id: 'sess-assistant-text', message: { content: 'node --test tests/retrieval-outcomes.test.js finished with 3 passing' } },
    ]);

    const result = await recordRetrievalOutcomesForSession({ transcriptPath: path });

    assert.strictEqual(result.recorded, 0);
  });

  it('rejects a successful result whose call id does not match the action call', async () => {
    const db = getDb();
    ensureOutcomeSchema(db);
    const docId = insertDoc(db, 'Outcome mismatched call note', 'hash-mismatched-call');
    logRetrieval({ docId, surface: SURFACE.READ, session: 'sess-mismatched-call' });
    const path = transcript('mismatched-call', [
      { session_id: 'sess-mismatched-call', message: { content: `I used KB #${docId} to run the retrieval outcomes parser test.` } },
      { session_id: 'sess-mismatched-call', type: 'function_call', call_id: 'call_expected', name: 'shell', arguments: JSON.stringify({ cmd: 'node --test tests/retrieval-outcomes.test.js' }) },
      { session_id: 'sess-mismatched-call', type: 'function_call_output', call_id: 'call_other', output: '3 passing' },
    ]);

    const result = await recordRetrievalOutcomesForSession({ transcriptPath: path });

    assert.strictEqual(result.recorded, 0);
  });

  it('rejects Codex output JSON that hides a nonzero exit code beside passing text', async () => {
    const db = getDb();
    ensureOutcomeSchema(db);
    const docId = insertDoc(db, 'Outcome nested Codex failure note', 'hash-nested-codex-failure');
    logRetrieval({ docId, surface: SURFACE.READ, session: 'sess-nested-codex-failure' });
    const path = transcript('nested-codex-failure', [
      { session_id: 'sess-nested-codex-failure', message: { content: `I used KB #${docId} to run the retrieval outcomes parser test.` } },
      { session_id: 'sess-nested-codex-failure', type: 'function_call', call_id: 'call_nested_codex_failure', name: 'shell', arguments: JSON.stringify({ cmd: 'node --test tests/retrieval-outcomes.test.js' }) },
      { session_id: 'sess-nested-codex-failure', type: 'function_call_output', call_id: 'call_nested_codex_failure', output: JSON.stringify({ exit_code: 1, output: '3 passing' }) },
    ]);

    const result = await recordRetrievalOutcomesForSession({ transcriptPath: path });

    assert.strictEqual(result.recorded, 0);
  });

  it('rejects Claude tool_result content JSON that hides an error beside passing text', async () => {
    const db = getDb();
    ensureOutcomeSchema(db);
    const docId = insertDoc(db, 'Outcome nested Claude failure note', 'hash-nested-claude-failure');
    logRetrieval({ docId, surface: SURFACE.READ, session: 'sess-nested-claude-failure' });
    const path = transcript('nested-claude-failure', [
      { session_id: 'sess-nested-claude-failure', message: { content: `I used KB #${docId} to run the retrieval outcomes parser test.` } },
      { session_id: 'sess-nested-claude-failure', message: { content: [
        { type: 'tool_use', id: 'toolu_nested_failure', name: 'Bash', input: { command: 'node --test tests/retrieval-outcomes.test.js' } },
      ] } },
      { session_id: 'sess-nested-claude-failure', message: { content: [
        { type: 'tool_result', tool_use_id: 'toolu_nested_failure', content: JSON.stringify({ is_error: true, output: '3 passing' }) },
      ] } },
    ]);

    const result = await recordRetrievalOutcomesForSession({ transcriptPath: path });

    assert.strictEqual(result.recorded, 0);
  });

  it('rejects a matching tool result with a nonzero exit code', async () => {
    const db = getDb();
    ensureOutcomeSchema(db);
    const docId = insertDoc(db, 'Outcome nonzero exit note', 'hash-nonzero-exit');
    logRetrieval({ docId, surface: SURFACE.READ, session: 'sess-nonzero-exit' });
    const path = transcript('nonzero-exit', [
      { session_id: 'sess-nonzero-exit', message: { content: `I used KB #${docId} to run the retrieval outcomes parser test.` } },
      { session_id: 'sess-nonzero-exit', type: 'function_call', call_id: 'call_nonzero', name: 'shell', arguments: JSON.stringify({ cmd: 'node --test tests/retrieval-outcomes.test.js' }) },
      { session_id: 'sess-nonzero-exit', type: 'function_call_output', call_id: 'call_nonzero', output: '3 passing', exit_code: 1 },
    ]);

    const result = await recordRetrievalOutcomesForSession({ transcriptPath: path });

    assert.strictEqual(result.recorded, 0);
  });

  it('rejects explicit doc use when the later success is for an unrelated action', async () => {
    const db = getDb();
    ensureOutcomeSchema(db);
    const docId = insertDoc(db, 'Outcome rollback note', 'hash-rollback');
    logRetrieval({ docId, surface: SURFACE.READ, session: 'sess-unrelated-success-after-use' });
    const path = transcript('unrelated-success-after-use', [
      { session_id: 'sess-unrelated-success-after-use', message: { content: `I used KB #${docId} to inspect rollback note.` } },
      { session_id: 'sess-unrelated-success-after-use', output: 'node --test tests/unrelated.test.js\n9 passing' },
    ]);

    const result = await recordRetrievalOutcomesForSession({ transcriptPath: path });

    assert.strictEqual(result.recorded, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM retrieval_outcomes WHERE doc_id = ?').get(docId).c, 0);
  });

  it('rejects helped when the retrieved version is missing', async () => {
    const db = getDb();
    ensureOutcomeSchema(db);
    const docId = insertDoc(db, 'Outcome missing version note', 'hash-missing');
    logRetrieval({ docId, surface: SURFACE.READ, session: 'sess-missing-version' });
    db.prepare('UPDATE retrievals SET doc_version = NULL WHERE session = ?').run('sess-missing-version');
    const path = transcript('missing-version', [
      { session_id: 'sess-missing-version', message: { content: `I used KB #${docId} to run the missing-version test.` } },
      { session_id: 'sess-missing-version', type: 'function_call', call_id: 'call_missing_version', name: 'shell', arguments: JSON.stringify({ cmd: 'node --test tests/missing-version.test.js' }) },
      { session_id: 'sess-missing-version', type: 'function_call_output', call_id: 'call_missing_version', output: '1 passing' },
    ]);

    const result = await recordRetrievalOutcomesForSession({ transcriptPath: path });

    assert.strictEqual(result.recorded, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM retrieval_outcomes WHERE doc_id = ?').get(docId).c, 0);
  });

  it('keeps a helped outcome tied to the retrieved version after content drift', async () => {
    const db = getDb();
    ensureOutcomeSchema(db);
    const docId = insertDoc(db, 'Outcome drift note', 'hash-before');
    logRetrieval({ docId, surface: SURFACE.READ, session: 'sess-drift' });
    db.prepare('UPDATE vault_files SET content_hash = ? WHERE document_id = ?').run('hash-after', docId);
    const path = transcript('drift', [
      { session_id: 'sess-drift', message: { content: `I used KB #${docId} to run the drift-sensitive test.` } },
      { session_id: 'sess-drift', type: 'function_call', call_id: 'call_drift', name: 'shell', arguments: JSON.stringify({ cmd: 'node --test tests/drift-sensitive.test.js' }) },
      { session_id: 'sess-drift', type: 'function_call_output', call_id: 'call_drift', output: '1 passing' },
    ]);

    await recordRetrievalOutcomesForSession({ transcriptPath: path });

    const row = db.prepare('SELECT doc_version FROM retrieval_outcomes WHERE doc_id = ?').get(docId);
    assert.strictEqual(row.doc_version, 'hash-before');
    assert.strictEqual(outcomeAdjustment({ id: docId }, db), 0, 'current hash changed, so current retrieval ranking gets no helped boost');
  });

  it('requires a direct read surface before recording helped', async () => {
    const db = getDb();
    ensureOutcomeSchema(db);
    const docId = insertDoc(db, 'Outcome search-only note', 'hash-search-only');
    logRetrieval({ docId, surface: SURFACE.SEARCH, session: 'sess-search-only' });
    const path = transcript('search-only', [
      { session_id: 'sess-search-only', message: { content: `I used KB #${docId} to run the search-only test.` } },
      { session_id: 'sess-search-only', type: 'function_call', call_id: 'call_search_only', name: 'shell', arguments: JSON.stringify({ cmd: 'node --test tests/search-only.test.js' }) },
      { session_id: 'sess-search-only', type: 'function_call_output', call_id: 'call_search_only', output: '1 passing' },
    ]);

    const result = await recordRetrievalOutcomesForSession({ transcriptPath: path });

    assert.strictEqual(result.recorded, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM retrieval_outcomes WHERE doc_id = ?').get(docId).c, 0);
  });

  it('records corrected from confirmed supersession without changing document tiers', async () => {
    const db = getDb();
    ensureOutcomeSchema(db);
    const docId = insertDoc(db, 'Outcome corrected note', 'hash-corrected');
    const tierBefore = db.prepare('SELECT tier FROM documents WHERE id = ?').get(docId).tier;
    logRetrieval({ docId, surface: SURFACE.READ, session: 'sess-corrected' });
    db.prepare("UPDATE documents SET superseded_at = datetime('now', '+1 minute'), superseded_reason = 'wrong', superseded_by = NULL WHERE id = ?").run(docId);
    const path = transcript('corrected', [
      { session_id: 'sess-corrected', message: { content: 'No positive use claim here.' } },
    ]);

    const result = await recordRetrievalOutcomesForSession({ transcriptPath: path });

    assert.strictEqual(result.recorded, 1);
    assert.strictEqual(db.prepare('SELECT outcome FROM retrieval_outcomes WHERE doc_id = ?').get(docId).outcome, OUTCOME.CORRECTED);
    assert.strictEqual(db.prepare('SELECT tier FROM documents WHERE id = ?').get(docId).tier, tierBefore);
    assert.strictEqual(outcomeAdjustment({ id: docId }, db), -4);
  });

  it('feeds search ranking without promoting document tiers', () => {
    const db = getDb();
    ensureOutcomeSchema(db);
    const first = insertDoc(db, 'Azimuth quokka outcome ranking alpha', 'search-rank-a');
    const second = insertDoc(db, 'Azimuth quokka outcome ranking beta', 'search-rank-b');
    const tierBefore = db.prepare('SELECT tier FROM documents WHERE id = ?').get(second).tier;
    const retrievalId = db.prepare(`
      INSERT INTO retrievals (doc_id, doc_version, surface, session, is_test)
      VALUES (?, ?, 'kb_read', 'sess-search-rank', 0)
    `).run(second, 'search-rank-b').lastInsertRowid;
    db.prepare(`
      INSERT INTO retrieval_outcomes
        (retrieval_id, doc_id, doc_version, session, outcome, evidence_kind, evidence_ref, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(retrievalId, second, 'search-rank-b', 'sess-search-rank', OUTCOME.HELPED, 'test', 'search-rank-helped', 'test');

    const hits = searchDocuments('azimuth quokka outcome ranking', 10);

    assert.ok(hits.findIndex(hit => hit.id === second) < hits.findIndex(hit => hit.id === first), JSON.stringify(hits));
    assert.strictEqual(db.prepare('SELECT tier FROM documents WHERE id = ?').get(second).tier, tierBefore);
  });

  it('does not let helped history outrank a much stronger lexical match', () => {
    const db = getDb();
    ensureOutcomeSchema(db);
    const strong = insertDoc(db, 'Azimuth quokka outcome ranking exact target phrase', 'search-strong');
    const weak = db.prepare('INSERT INTO documents (title, content, doc_type, tags) VALUES (?, ?, ?, ?)')
      .run('Weak helped fixture', 'azimuth quokka outcome ranking appears only in the body', 'note', 'outcomes').lastInsertRowid;
    db.prepare("INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type) VALUES (?, ?, ?, ?, 'note')")
      .run('weak-helped-fixture.md', 'search-weak', weak, 'Weak helped fixture');
    const retrievalId = db.prepare(`
      INSERT INTO retrievals (doc_id, doc_version, surface, session, is_test)
      VALUES (?, ?, 'kb_read', 'sess-search-weak', 0)
    `).run(weak, 'search-weak').lastInsertRowid;
    db.prepare(`
      INSERT INTO retrieval_outcomes
        (retrieval_id, doc_id, doc_version, session, outcome, evidence_kind, evidence_ref, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(retrievalId, weak, 'search-weak', 'sess-search-weak', OUTCOME.HELPED, 'test', 'search-weak-helped', 'test');

    const hits = searchDocuments('azimuth quokka outcome ranking', 10);

    assert.ok(hits.findIndex(hit => hit.id === strong) < hits.findIndex(hit => hit.id === weak), JSON.stringify(hits));
  });

  it('is inert until the outcome table exists', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE documents (id INTEGER PRIMARY KEY)');
    assert.strictEqual(retrievalOutcomesReady(db), false);
    assert.strictEqual(outcomeAdjustment({ id: 1 }, db), 0);
  });
});
