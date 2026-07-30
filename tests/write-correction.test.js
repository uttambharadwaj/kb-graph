import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { getToolDefinitions } from '../src/tools.js';
import { getDocument, getDb } from '../src/db.js';

const call = async (name, args) => {
  const tool = getToolDefinitions().find(t => t.name === name);
  const res = await tool.handler(args);
  return { text: res.content[0].text, isError: res.isError === true };
};

const write = (args) => call('kb_write', { type: 'lesson', ...args });

describe('correcting a note through kb_write', () => {
  // The defect: a same-title write lands on the target's own vault path, so it
  // reindexes into the target's id — and the handler then tried to supersede
  // that note with itself, threw, and reported an error for a write that had
  // already been committed to disk and to the index. The caller, believing
  // nothing had happened, wrote the correction a second time.
  it('reports success when the correction replaced the note in place', async () => {
    const title = 'A claim that turns out to be wrong';
    const first = await write({ title, content: 'The original claim, stated confidently.' });
    assert.strictEqual(first.isError, false, first.text);
    const id = getDb().prepare('SELECT id FROM documents WHERE title = ?').get(title).id;

    const corrected = await write({ title, content: 'Measured today: the original claim is false.', supersedes: id });
    assert.strictEqual(corrected.isError, false, `a committed write must not be reported as an error: ${corrected.text}`);
    assert.match(corrected.text, new RegExp(`updated #${id} in place`));

    const doc = getDocument(id);
    assert.match(doc.content, /Measured today/, 'the correction must be what the note now says');
    assert.strictEqual(doc.superseded_at, null, 'the current note must not be marked as retired');
  });

  // Replacing under a different title is the other half: there the old note is
  // a genuinely separate row that has to be retired and pointed at the new one.
  it('retires the old note when the correction lands on a different file', async () => {
    const old = await write({ title: 'Original phrasing of a finding', content: 'As first understood.' });
    assert.strictEqual(old.isError, false, old.text);
    const oldId = getDb().prepare('SELECT id FROM documents WHERE title = ?').get('Original phrasing of a finding').id;

    const next = await write({ title: 'Sharper phrasing of the same finding', content: 'As now understood.', supersedes: oldId });
    assert.strictEqual(next.isError, false, next.text);
    assert.match(next.text, new RegExp(`superseded #${oldId}`));

    const retired = getDocument(oldId);
    assert.ok(retired.superseded_at, 'the replaced note must be retired');
    assert.notStrictEqual(retired.superseded_by, oldId, 'and must never point at itself');
  });

  // Asserted against the source, because the only remaining way to throw here
  // is the database itself failing mid-statement — which a test can fake but
  // not honestly reproduce. What matters is structural: once the file is on
  // disk, no path out of this handler may report a failure, or the caller's
  // recovery is a second copy of the note.
  it('cannot report an error once the note has been written', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'tools.js'), 'utf8');
    // Anchored on the tool, not on the writeNote call — there is more than one.
    const handler = src.slice(src.indexOf("name: 'kb_write'"));
    const postWrite = handler.slice(
      handler.indexOf('const result = await writeNote('),
      handler.indexOf('return { content: [{ type: \'text\', text: `Note saved to'),
    );
    assert.ok(postWrite.length > 0, 'failed to locate the kb_write handler body');
    assert.match(postWrite, /catch \(err\) \{\s*supersedeNote = `; WARNING: the note was written/,
      'the supersede step must degrade to a warning, never fall through to the handler catch');
    assert.doesNotMatch(postWrite, /isError/, 'nothing after the write may return an error');
  });

  it('refuses an unknown supersedes target before writing anything', async () => {
    const res = await write({ title: 'Points at nothing', content: 'Body.', supersedes: 999999 });
    assert.strictEqual(res.isError, true);
    assert.match(res.text, /not found/);
    assert.strictEqual(getDb().prepare('SELECT COUNT(*) c FROM documents WHERE title = ?').get('Points at nothing').c, 0);
  });
});
