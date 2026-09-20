import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

import { getDb } from '../src/db.js';
import { WRITE_SKIP_REASON } from '../src/write-note.js';

const run = promisify(execFile);

describe('authored-write process lock', () => {
  it('serializes duplicate decisions across processes', async () => {
    getDb().exec('DELETE FROM embeddings; DELETE FROM documents;');
    const arrivalBarrierPath = join(process.env.KB_DIR, 'write-lock-process-arrivals');
    const decisionBarrierPath = join(process.env.KB_DIR, 'write-lock-process-decisions');
    const writeNoteUrl = new URL('../src/write-note.js', import.meta.url).href;
    const dbUrl = new URL('../src/db.js', import.meta.url).href;
    const script = `
      import { appendFileSync, readFileSync } from 'node:fs';
      import { writeNote } from ${JSON.stringify(writeNoteUrl)};
      import { getDb } from ${JSON.stringify(dbUrl)};
      const arrivalBarrier = ${JSON.stringify(arrivalBarrierPath)};
      const decisionBarrier = ${JSON.stringify(decisionBarrierPath)};
      const content = 'A cross-process duplicate verdict must be serialized with its write.';
      const waitForPeer = async path => {
        const deadline = Date.now() + 5_000;
        while (readFileSync(path, 'utf8').trim().split('\\n').length < 2) {
          if (Date.now() >= deadline) throw new Error('timed out waiting for peer process');
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      };
      const findSimilar = async () => {
        const serialized = Boolean(getDb().prepare(
          "SELECT 1 FROM meta WHERE key = 'runtime:authored-write-lock'"
        ).get());
        appendFileSync(arrivalBarrier, process.pid + '\\n');
        if (!serialized) await waitForPeer(arrivalBarrier);
        const existing = getDb().prepare(
          'SELECT id, title FROM documents WHERE content = ? AND superseded_at IS NULL LIMIT 1'
        ).get(content);
        appendFileSync(decisionBarrier, process.pid + '\\n');
        if (!serialized) await waitForPeer(decisionBarrier);
        return existing ? [{ document_id: existing.id, title: existing.title, score: 1 }] : [];
      };
      const result = await writeNote(
        process.env.OBSIDIAN_VAULT_PATH,
        { title: 'Cross-process duplicate gate', content },
        { findSimilar },
      );
      console.log(JSON.stringify(result));
    `;
    const env = {
      ...process.env,
      NODE_OPTIONS: '',
      KB_DIR: process.env.KB_DIR,
      OBSIDIAN_VAULT_PATH: process.env.OBSIDIAN_VAULT_PATH,
    };

    const outputs = await Promise.all([
      run(process.execPath, ['--input-type=module', '--eval', script], { env }),
      run(process.execPath, ['--input-type=module', '--eval', script], { env }),
    ]);
    const results = outputs.map(({ stdout }) => JSON.parse(stdout.trim().split('\n').at(-1)));

    assert.equal(results.filter(result => !result.skipped).length, 1);
    assert.equal(results.filter(result => result.reason === WRITE_SKIP_REASON.DUPLICATE).length, 1);
    assert.equal(readFileSync(arrivalBarrierPath, 'utf8').trim().split('\n').length, 2);
    assert.equal(readFileSync(decisionBarrierPath, 'utf8').trim().split('\n').length, 2);
  });
});
