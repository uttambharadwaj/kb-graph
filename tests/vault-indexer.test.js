import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getDb } from '../src/db.js';
import { scanVault, indexVaultFile } from '../src/vault/indexer.js';

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
