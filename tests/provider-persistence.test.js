import './helpers/tmp-kb.js';
import { after, describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import matter from 'gray-matter';
import { classifyNote } from '../src/classify/classifier.js';
import { processNewClippings } from '../src/classify/processor.js';
import { summarizeNote, summarizeUnsummarized } from '../src/classify/summarizer.js';
import { noteWriteLockPath, replaceNoteIfUnchanged } from '../src/atomic-note-write.js';

const tmp = mkdtempSync(join(tmpdir(), 'kb-provider-persistence-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const noPause = async () => {};

const validClassification = {
  success: true,
  type: 'research',
  tags: ['provider', 'safety', 'testing'],
  project: null,
  summary: 'A bounded provider contract.',
  confidence: 'high',
  key_topics: ['provider', 'safety'],
  aliases: [],
  triggers: [],
};

describe('provider results fail closed before durable writes', () => {
  it('rejects malformed classifier and summarizer results', async () => {
    const classification = await classifyNote('Title', 'body', 'inbox/note.md', {
      runModel: async () => ({}),
    });
    const summary = await summarizeNote('Title', 'body', {
      runModel: async () => ({ summary: 'missing topics' }),
    });
    const oversized = await classifyNote('Title', 'body', 'inbox/note.md', {
      runModel: async () => ({
        ...validClassification,
        tags: Array.from({ length: 9 }, (_, index) => `tag-${index}`),
      }),
    });

    assert.strictEqual(classification.success, false);
    assert.match(classification.error, /malformed/);
    assert.strictEqual(summary.success, false);
    assert.match(summary.error, /malformed/);
    assert.strictEqual(oversized.success, false);
    assert.match(oversized.error, /malformed/);
  });

  it('leaves a clipping byte-identical after provider failure and retries only until success', async () => {
    const vault = join(tmp, 'classify');
    const inbox = join(vault, 'inbox');
    mkdirSync(inbox, { recursive: true });
    const path = join(inbox, 'note.md');
    const original = `---\ntitle: Provider note\n---\n\n${'durable content '.repeat(12)}\n`;
    writeFileSync(path, original);

    let calls = 0;
    let reindexes = 0;
    const failed = await processNewClippings(vault, {
      classify: async () => {
        calls++;
        return { success: false, error: 'provider unavailable' };
      },
      reindex: async () => { reindexes++; },
      pause: noPause,
    });
    assert.strictEqual(failed.processed, 0);
    assert.strictEqual(readFileSync(path, 'utf8'), original);
    assert.strictEqual(reindexes, 0);

    await processNewClippings(vault, {
      classify: async () => {
        calls++;
        return validClassification;
      },
      reindex: async () => { reindexes++; },
      pause: noPause,
    });
    await processNewClippings(vault, {
      classify: async () => {
        calls++;
        return validClassification;
      },
      reindex: async () => { reindexes++; },
      pause: noPause,
    });

    assert.strictEqual(calls, 2, 'a classified note must not be billed again');
    assert.strictEqual(reindexes, 1);
    assert.strictEqual(matter(readFileSync(path, 'utf8')).data.classified, true);
  });

  it('leaves a note byte-identical after summary failure and retries only until success', async () => {
    const vault = join(tmp, 'summarize');
    mkdirSync(vault, { recursive: true });
    const path = join(vault, 'note.md');
    const original = `---\ntitle: Summary note\n---\n\n${'substantial note content '.repeat(12)}\n`;
    writeFileSync(path, original);

    let calls = 0;
    const failed = await summarizeUnsummarized(vault, {
      summarize: async () => {
        calls++;
        return { success: false, error: 'malformed provider result' };
      },
      pause: noPause,
    });
    assert.strictEqual(failed.summarized, 0);
    assert.strictEqual(readFileSync(path, 'utf8'), original);

    await summarizeUnsummarized(vault, {
      summarize: async () => {
        calls++;
        return { success: true, summary: 'A valid bounded summary.', key_topics: ['provider'] };
      },
      pause: noPause,
    });
    await summarizeUnsummarized(vault, {
      summarize: async () => {
        calls++;
        return { success: true, summary: 'A valid bounded summary.', key_topics: ['provider'] };
      },
      pause: noPause,
    });

    assert.strictEqual(calls, 2, 'a summarized note must not be billed again');
    assert.strictEqual(matter(readFileSync(path, 'utf8')).data.summary, 'A valid bounded summary.');
  });

  it('refuses to overwrite a clipping changed during classification', async () => {
    const vault = join(tmp, 'classify-race');
    const inbox = join(vault, 'inbox');
    mkdirSync(inbox, { recursive: true });
    const path = join(inbox, 'note.md');
    writeFileSync(path, `---\ntitle: Race note\n---\n\n${'original content '.repeat(12)}\n`);
    const concurrent = `---\ntitle: Race note\n---\n\n${'concurrent edit '.repeat(12)}\n`;

    await assert.rejects(processNewClippings(vault, {
      classify: async () => {
        writeFileSync(path, concurrent);
        return validClassification;
      },
      reindex: async () => assert.fail('must not reindex a refused write'),
      pause: noPause,
    }), /changed while provider call was in flight/);
    assert.strictEqual(readFileSync(path, 'utf8'), concurrent);
  });

  it('refuses to overwrite a note changed during summarization', async () => {
    const vault = join(tmp, 'summarize-race');
    mkdirSync(vault, { recursive: true });
    const path = join(vault, 'note.md');
    writeFileSync(path, `---\ntitle: Race note\n---\n\n${'original content '.repeat(12)}\n`);
    const concurrent = `---\ntitle: Race note\n---\n\n${'concurrent edit '.repeat(12)}\n`;

    await assert.rejects(summarizeUnsummarized(vault, {
      summarize: async () => {
        writeFileSync(path, concurrent);
        return { success: true, summary: 'A valid bounded summary.', key_topics: ['provider', 'race'] };
      },
      pause: noPause,
    }), /changed while provider call was in flight/);
    assert.strictEqual(readFileSync(path, 'utf8'), concurrent);
  });

  it('reindexes completed classification writes before propagating cancellation', async () => {
    const vault = join(tmp, 'classify-cancel');
    const inbox = join(vault, 'inbox');
    mkdirSync(inbox, { recursive: true });
    for (const name of ['a.md']) {
      writeFileSync(join(inbox, name), `---\ntitle: ${name}\n---\n\n${'provider content '.repeat(12)}\n`);
    }
    const controller = new AbortController();
    let reindexes = 0;
    await assert.rejects(processNewClippings(vault, {
      classify: async () => validClassification,
      reindex: async () => { reindexes++; },
      pause: async () => controller.abort(),
      signal: controller.signal,
    }), { name: 'AbortError' });

    assert.strictEqual(reindexes, 1);
    const classified = ['a.md'].filter(name =>
      matter(readFileSync(join(inbox, name), 'utf8')).data.classified
    );
    assert.strictEqual(classified.length, 1);
  });

  it('preserves cancellation identity when the required reindex also fails', async () => {
    const vault = join(tmp, 'classify-cancel-reindex-failure');
    const inbox = join(vault, 'inbox');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(
      join(inbox, 'note.md'),
      `---\ntitle: note\n---\n\n${'provider content '.repeat(12)}\n`,
    );
    const controller = new AbortController();
    await assert.rejects(processNewClippings(vault, {
      classify: async () => validClassification,
      reindex: async () => { throw new Error('index unavailable'); },
      pause: async () => controller.abort(),
      signal: controller.signal,
    }), err => err.name === 'AbortError' && err.cause?.message === 'index unavailable');
  });

  it('propagates cancellation that arrives during reindex', async () => {
    const vault = join(tmp, 'classify-cancel-during-reindex');
    const inbox = join(vault, 'inbox');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(
      join(inbox, 'note.md'),
      `---\ntitle: note\n---\n\n${'provider content '.repeat(12)}\n`,
    );
    const controller = new AbortController();
    await assert.rejects(processNewClippings(vault, {
      classify: async () => validClassification,
      reindex: async () => controller.abort(),
      pause: noPause,
      signal: controller.signal,
    }), { name: 'AbortError' });
  });

  it('serializes provider note replacement and recovers an abandoned lock', () => {
    const vault = join(tmp, 'write-lock');
    mkdirSync(vault, { recursive: true });
    const path = join(vault, 'note.md');
    const lockRoot = join(vault, 'locks');
    const lockPath = noteWriteLockPath(path, lockRoot);
    const abandonedTemp = `${path}.999.00000000-0000-4000-8000-000000000000.tmp`;
    writeFileSync(path, 'before');
    mkdirSync(lockRoot);
    mkdirSync(lockPath);

    assert.throws(
      () => replaceNoteIfUnchanged(path, 'before', 'blocked', { lockRoot }),
      /another provider write is in progress/,
    );
    assert.strictEqual(readFileSync(path, 'utf8'), 'before');

    const stale = new Date(Date.now() - 60_000);
    const reaperPath = join(lockPath, '.reaper');
    writeFileSync(reaperPath, 'another-reaper');
    utimesSync(lockPath, stale, stale);
    assert.throws(
      () => replaceNoteIfUnchanged(path, 'before', 'blocked', { lockRoot }),
      /another provider write is in progress/,
    );

    utimesSync(reaperPath, stale, stale);
    utimesSync(lockPath, stale, stale);
    writeFileSync(abandonedTemp, 'sensitive abandoned provider output');
    utimesSync(abandonedTemp, stale, stale);
    replaceNoteIfUnchanged(path, 'before', 'after', { lockRoot });
    assert.strictEqual(readFileSync(path, 'utf8'), 'after');
    assert.strictEqual(existsSync(lockPath), false);
    assert.strictEqual(existsSync(abandonedTemp), false);
  });
});
