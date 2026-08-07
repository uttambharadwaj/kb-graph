// Must come first: this file indexes notes through getDb(), so without it the
// run opens the real ~/.knowledge-base/kb.db, migrates it, and writes rows into
// it — which is what the delete-on-the-way-out below was compensating for.
import './helpers/tmp-kb.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getDb } from '../src/db.js';
import { scanVault, indexVaultFile } from '../src/vault/indexer.js';
import { CORPUS_PATH, TRIGGER_INDEX_PATH, loadTriggerIndex, rebuildTriggerIndex } from '../src/trigger-relevance.js';

// The indexer's triggers wiring uses filterTriggers's DEFAULT corpus (no
// explicit `corpus` option), which reads CORPUS_PATH — so these tests write
// a real TSV there rather than passing a synthetic array the way
// tests/triggers.test.js does. 40 sessions x 20 filler lines (>=500 lines,
// >=20 sessions, the corpus-adequacy floor) plus two markers: one common
// enough to be rejected by the 5% session ceiling, one rare enough to clear
// it.
function writeTestCorpus() {
  const lines = [];
  for (let s = 0; s < 40; s += 1) {
    for (let j = 0; j < 20; j += 1) lines.push(`s${s}\t${j % 2 === 0 ? 'git status' : 'ls -la'}`);
  }
  for (let s = 0; s < 4; s += 1) lines.push(`s${s}\tgit push --force`); // 4/40 = 10% -> rejected
  lines.push('s10\trare-marker-cmd run'); // 1/40 = 2.5% -> accepted
  writeFileSync(CORPUS_PATH, lines.join('\n') + '\n');
}

describe('scanVault', () => {
  let vaultDir;

  before(() => {
    vaultDir = mkdtempSync(join(tmpdir(), 'test-vault-'));
    mkdirSync(join(vaultDir, '05_research'), { recursive: true });
    mkdirSync(join(vaultDir, '.obsidian'), { recursive: true });
    symlinkSync(join(tmpdir(), 'missing-vault-link'), join(vaultDir, 'broken-link'));

    writeFileSync(join(vaultDir, '05_research', 'test.md'), `---
title: Test Research
type: research
tags: [ai]
project: kb-system
---

# Test Research

Some research content.`);

    writeFileSync(join(vaultDir, '.obsidian', 'config.json'), '{}');
    writeFileSync(join(vaultDir, '05_research', '.DS_Store'), 'junk');
  });

  after(() => rmSync(vaultDir, { recursive: true, force: true }));

  it('should find markdown files and skip system folders', () => {
    const files = scanVault(vaultDir);
    assert.strictEqual(files.length, 1);
    assert.ok(files[0].endsWith('test.md'));
  });

  it('should skip broken symlinks without aborting the scan', () => {
    const files = scanVault(vaultDir);
    assert.strictEqual(files.length, 1);
  });

  it('should index one vault file without scanning the whole vault', async () => {
    const relPath = '05_research/single-file-index.md';
    writeFileSync(join(vaultDir, relPath), `---
title: Single File Index Test
type: research
tags: [single-file-index]
---

Only this note should need indexing.`);

    try {
      const result = await indexVaultFile(vaultDir, relPath);
      assert.deepStrictEqual(
        { indexed: result.indexed, skipped: result.skipped, deleted: result.deleted, errors: result.errors },
        { indexed: 1, skipped: 0, deleted: 0, errors: [] }
      );

      const row = getDb().prepare('SELECT title, doc_type, tags FROM documents WHERE source = ?').get(`vault:${relPath}`);
      assert.strictEqual(row.title, 'Single File Index Test');
      assert.strictEqual(row.doc_type, 'research');
      assert.match(row.tags, /single-file-index/);
    } finally {
      const row = getDb().prepare('SELECT document_id FROM vault_files WHERE vault_path = ?').get(relPath);
      if (row?.document_id) getDb().prepare('DELETE FROM documents WHERE id = ?').run(row.document_id);
      getDb().prepare('DELETE FROM vault_files WHERE vault_path = ?').run(relPath);
    }
  });

  it('stores frontmatter aliases only after the filter has vetted them', async () => {
    const relPath = '05_research/aliased-note.md';
    // "indexer" is the body's word, "vectorizer" is nobody's — the filter
    // keeps the first and drops the second (tests/aliases.test.js owns the
    // full gate; this pins the wiring from frontmatter to column).
    writeFileSync(join(vaultDir, relPath), `---
title: Only the write path embeds a note
type: research
tags: [embedding-plumbing]
aliases: [indexer, vectorizer]
---

The vault indexer is what embeds a document after a write.`);

    try {
      const result = await indexVaultFile(vaultDir, relPath);
      assert.deepStrictEqual(result.errors, []);
      const row = getDb().prepare('SELECT aliases FROM documents WHERE source = ?').get(`vault:${relPath}`);
      assert.strictEqual(row.aliases, 'indexer');
    } finally {
      const row = getDb().prepare('SELECT document_id FROM vault_files WHERE vault_path = ?').get(relPath);
      if (row?.document_id) getDb().prepare('DELETE FROM documents WHERE id = ?').run(row.document_id);
      getDb().prepare('DELETE FROM vault_files WHERE vault_path = ?').run(relPath);
    }
  });

  it('vets frontmatter triggers into the column — one accepted, one rejected by the session ceiling', async () => {
    writeTestCorpus();
    const relPath = '05_research/trigger-note.md';
    writeFileSync(join(vaultDir, relPath), `---
title: Force-push cleanup
type: lesson
tags: [git]
triggers: ["git push && --force", "rare-marker-cmd"]
---

Never run \`git push --force\` here; also watch for \`rare-marker-cmd\`.`);

    try {
      const result = await indexVaultFile(vaultDir, relPath);
      assert.deepStrictEqual(result.errors, []);
      const row = getDb().prepare('SELECT id, triggers FROM documents WHERE source = ?').get(`vault:${relPath}`);
      const kept = JSON.parse(row.triggers);
      assert.deepStrictEqual(kept.map(k => k.parts), [['rare-marker-cmd']]);

      const index = loadTriggerIndex(TRIGGER_INDEX_PATH);
      const entry = index.find(e => e.id === row.id);
      assert.ok(entry, 'rebuildTriggerIndex must have run and picked up the new column');
      assert.deepStrictEqual(entry.patterns.map(p => p.parts), [['rare-marker-cmd']]);
    } finally {
      const row = getDb().prepare('SELECT document_id FROM vault_files WHERE vault_path = ?').get(relPath);
      if (row?.document_id) getDb().prepare('DELETE FROM documents WHERE id = ?').run(row.document_id);
      getDb().prepare('DELETE FROM vault_files WHERE vault_path = ?').run(relPath);
    }
  });

  it('honors triggers_pinned, keeping a pattern the session ceiling would otherwise reject', async () => {
    writeTestCorpus();
    const relPath = '05_research/pinned-trigger-note.md';
    writeFileSync(join(vaultDir, relPath), `---
title: Force-push cleanup (curated)
type: lesson
tags: [git]
triggers: ["git push && --force"]
triggers_pinned: true
---

Never run \`git push --force\` here.`);

    try {
      const result = await indexVaultFile(vaultDir, relPath);
      assert.deepStrictEqual(result.errors, []);
      const row = getDb().prepare('SELECT triggers FROM documents WHERE source = ?').get(`vault:${relPath}`);
      const kept = JSON.parse(row.triggers);
      assert.deepStrictEqual(kept.map(k => k.parts), [['git push', '--force']]);
      assert.strictEqual(kept[0].pinned, true);
    } finally {
      const row = getDb().prepare('SELECT document_id FROM vault_files WHERE vault_path = ?').get(relPath);
      if (row?.document_id) getDb().prepare('DELETE FROM documents WHERE id = ?').run(row.document_id);
      getDb().prepare('DELETE FROM vault_files WHERE vault_path = ?').run(relPath);
    }
  });

  it('stores NULL, never an empty string, when nothing survives the vet', async () => {
    writeTestCorpus();
    const relPath = '05_research/no-trigger-note.md';
    writeFileSync(join(vaultDir, relPath), `---
title: A note with no groundable command
type: lesson
tags: [git]
triggers: ["totally-unrelated-command"]
---

This note only describes totally-unrelated-command in prose, never inside a code span.`);

    try {
      const result = await indexVaultFile(vaultDir, relPath);
      assert.deepStrictEqual(result.errors, []);
      const row = getDb().prepare('SELECT triggers FROM documents WHERE source = ?').get(`vault:${relPath}`);
      assert.strictEqual(row.triggers, null);
    } finally {
      const row = getDb().prepare('SELECT document_id FROM vault_files WHERE vault_path = ?').get(relPath);
      if (row?.document_id) getDb().prepare('DELETE FROM documents WHERE id = ?').run(row.document_id);
      getDb().prepare('DELETE FROM vault_files WHERE vault_path = ?').run(relPath);
    }
  });

  it('a malformed triggers row elsewhere does not block rebuilding the index for a good note (B1)', async () => {
    writeTestCorpus();
    // Simulate a corrupted row from a past write (hand SQL edit, a partial
    // write) — the only way malformed JSON could land in this column, since
    // filterTriggers only ever produces valid JSON or ''.
    const bad = getDb().prepare('INSERT INTO documents (title, content, doc_type, tags, triggers) VALUES (?, ?, ?, ?, ?)')
      .run('Corrupted trigger row', 'x', 'lesson', '', '{not valid json');

    const relPath = '05_research/good-trigger-note.md';
    writeFileSync(join(vaultDir, relPath), `---
title: Good trigger note
type: lesson
tags: [git]
triggers: ["rare-marker-cmd"]
---

Watch for \`rare-marker-cmd\` in history.`);

    try {
      const result = await indexVaultFile(vaultDir, relPath);
      assert.deepStrictEqual(result.errors, []);
      const row = getDb().prepare('SELECT id FROM documents WHERE source = ?').get(`vault:${relPath}`);

      const index = loadTriggerIndex(TRIGGER_INDEX_PATH);
      assert.ok(index.some(e => e.id === row.id), 'the good note must still appear in the rebuilt index');
      assert.ok(!index.some(e => e.id === bad.lastInsertRowid), 'the bad row is skipped, not left to crash the rebuild');
    } finally {
      const row = getDb().prepare('SELECT document_id FROM vault_files WHERE vault_path = ?').get(relPath);
      if (row?.document_id) getDb().prepare('DELETE FROM documents WHERE id = ?').run(row.document_id);
      getDb().prepare('DELETE FROM vault_files WHERE vault_path = ?').run(relPath);
      getDb().prepare('DELETE FROM documents WHERE id = ?').run(bad.lastInsertRowid);
    }
  });

  it('defers the index rebuild when asked — column changes, index waits for an explicit rebuild (B2)', async () => {
    writeTestCorpus();
    const relPath = '05_research/deferred-trigger-note.md';
    writeFileSync(join(vaultDir, relPath), `---
title: Deferred trigger note
type: lesson
tags: [git]
triggers: ["rare-marker-cmd"]
---

Watch for \`rare-marker-cmd\` in history.`);

    try {
      const result = await indexVaultFile(vaultDir, relPath, { deferTriggerIndex: true });
      assert.strictEqual(result.triggersChanged, true);
      const row = getDb().prepare('SELECT id, triggers FROM documents WHERE source = ?').get(`vault:${relPath}`);
      assert.ok(row.triggers, 'the column updates regardless of deferral');

      const beforeExplicitRebuild = loadTriggerIndex(TRIGGER_INDEX_PATH);
      assert.ok(!beforeExplicitRebuild.some(e => e.id === row.id), 'a deferred call must not rebuild inline');

      rebuildTriggerIndex();
      const afterExplicitRebuild = loadTriggerIndex(TRIGGER_INDEX_PATH);
      assert.ok(afterExplicitRebuild.some(e => e.id === row.id), 'an explicit rebuild picks up the deferred change');
    } finally {
      const row = getDb().prepare('SELECT document_id FROM vault_files WHERE vault_path = ?').get(relPath);
      if (row?.document_id) getDb().prepare('DELETE FROM documents WHERE id = ?').run(row.document_id);
      getDb().prepare('DELETE FROM vault_files WHERE vault_path = ?').run(relPath);
    }
  });

  it('an indexer upsert survives a trigger-index rebuild failure, vault_files row still recorded (B1)', async () => {
    writeTestCorpus();
    // An unwritable index location: a directory sitting where the atomic
    // rename needs to land a file makes renameSync throw EISDIR. Clear
    // whatever an earlier test already left at this path first (a real
    // trigger-index.json, most likely) — mkdirSync fails on an existing file.
    rmSync(TRIGGER_INDEX_PATH, { recursive: true, force: true });
    mkdirSync(TRIGGER_INDEX_PATH);
    const relPath = '05_research/rebuild-failure-note.md';
    writeFileSync(join(vaultDir, relPath), `---
title: Rebuild failure note
type: lesson
tags: [git]
triggers: ["rare-marker-cmd"]
---

Watch for \`rare-marker-cmd\` in history.`);

    try {
      const result = await indexVaultFile(vaultDir, relPath);
      assert.strictEqual(result.indexed, 1, 'the write itself must not abort');
      assert.match(result.errors.join(' '), /trigger index rebuild failed/);

      const row = getDb().prepare('SELECT id, triggers FROM documents WHERE source = ?').get(`vault:${relPath}`);
      assert.ok(row.triggers, 'the column write itself still lands');

      const vf = getDb().prepare('SELECT document_id FROM vault_files WHERE vault_path = ?').get(relPath);
      assert.strictEqual(vf.document_id, row.id, 'the vault_files row is still recorded despite the rebuild failure');
    } finally {
      rmSync(TRIGGER_INDEX_PATH, { recursive: true, force: true });
      const row = getDb().prepare('SELECT document_id FROM vault_files WHERE vault_path = ?').get(relPath);
      if (row?.document_id) getDb().prepare('DELETE FROM documents WHERE id = ?').run(row.document_id);
      getDb().prepare('DELETE FROM vault_files WHERE vault_path = ?').run(relPath);
    }
  });

  it('should reject single-file indexing outside the vault', async () => {
    const outsideFile = join(tmpdir(), 'outside-kb-vault.md');
    writeFileSync(outsideFile, '# Outside');

    try {
      const result = await indexVaultFile(vaultDir, outsideFile);
      assert.strictEqual(result.indexed, 0);
      assert.match(result.errors[0], /outside vault/);
    } finally {
      rmSync(outsideFile, { force: true });
    }
  });
});
