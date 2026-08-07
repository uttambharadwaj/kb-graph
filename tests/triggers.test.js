// Command triggers: the deterministic vet (filterTriggers), the match engine
// (matchCommand), and the index/corpus plumbing around them. Mirrors the
// posture of aliases.test.js — a synthetic corpus with exact, named hit
// counts, so "≤1% kept, >1% dropped" is asserted at the boundary rather than
// approximately.
import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../src/db.js';
import { KB_DIR } from '../src/paths.js';
import {
  filterTriggers, parseTriggerProposals, matchCommand,
  rebuildTriggerIndex, loadTriggerIndex,
} from '../src/trigger-relevance.js';
import { buildCommandCorpus } from '../src/cli/trigger-corpus.js';

function buildCorpus() {
  const inject = [
    ['ground-present', 3],
    ['ceil-ten', 10],
    ['ceil-eleven', 11],
    ['cap-alpha', 1],
    ['cap-bravo', 2],
    ['cap-charlie', 3],
    ['cap-delta', 4],
  ];
  const lines = [];
  for (const [token, count] of inject) {
    for (let i = 0; i < count; i++) lines.push(`some command using ${token} here`);
  }
  while (lines.length < 1000) {
    const n = lines.length;
    lines.push(n % 2 === 0 ? `git status --short run${n}` : `ls -la /tmp/dir${n}`);
  }
  return lines;
}

const CORPUS = buildCorpus(); // 1000 lines -> 1% ceiling is exactly 10 hits
const NOTE = {
  title: 'Dangerous invocation warnings',
  content: 'ground-present should warn. ceil-ten and ceil-eleven both appear here. '
    + 'cap-alpha cap-bravo cap-charlie cap-delta are the capped set. '
    + 'never-seen-in-corpus is our zero-hit case. gh is too short to ever qualify.',
};

describe('filterTriggers — grounding', () => {
  it('drops a part absent from the note\'s own title+content', () => {
    assert.strictEqual(filterTriggers(['totally-unrelated-token'], NOTE, { corpus: CORPUS }), '');
  });

  it('keeps a part the note actually uses', () => {
    const kept = JSON.parse(filterTriggers(['ground-present'], NOTE, { corpus: CORPUS }));
    assert.deepStrictEqual(kept, [{ parts: ['ground-present'], hits: 3 }]);
  });
});

describe('filterTriggers — noise ceiling', () => {
  it('drops a pattern above 1% of corpus lines, keeps one at the boundary', () => {
    const kept = JSON.parse(filterTriggers(['ceil-ten', 'ceil-eleven'], NOTE, { corpus: CORPUS }));
    assert.deepStrictEqual(kept, [{ parts: ['ceil-ten'], hits: 10 }]);
  });
});

describe('filterTriggers — MIN_PART_LEN', () => {
  it('drops a part shorter than the floor', () => {
    assert.strictEqual(filterTriggers(['gh'], NOTE, { corpus: CORPUS }), '');
  });
});

describe('filterTriggers — zero-hit patterns', () => {
  it('keeps a pattern that never matched history', () => {
    const kept = JSON.parse(filterTriggers(['never-seen-in-corpus'], NOTE, { corpus: CORPUS }));
    assert.deepStrictEqual(kept, [{ parts: ['never-seen-in-corpus'], hits: 0 }]);
  });
});

describe('filterTriggers — cap, order, dedup', () => {
  it('sorts rarest-first, caps at 3, and drops an exact duplicate', () => {
    const proposed = ['cap-alpha', 'cap-alpha', 'cap-bravo', 'cap-charlie', 'cap-delta'];
    const kept = JSON.parse(filterTriggers(proposed, NOTE, { corpus: CORPUS }));
    assert.deepStrictEqual(kept, [
      { parts: ['cap-alpha'], hits: 1 },
      { parts: ['cap-bravo'], hits: 2 },
      { parts: ['cap-charlie'], hits: 3 },
    ]);
  });
});

describe('filterTriggers — corpus floor', () => {
  it('refuses to grade against fewer than 500 lines, even for a perfect pattern', () => {
    const tiny = CORPUS.slice(0, 50);
    assert.strictEqual(filterTriggers(['ground-present'], NOTE, { corpus: tiny }), '');
  });
});

describe('parseTriggerProposals', () => {
  it('splits a string pattern on " && "', () => {
    assert.deepStrictEqual(
      parseTriggerProposals(['gh pr merge && --delete-branch']),
      [['gh pr merge', '--delete-branch']],
    );
  });

  it('takes an array pattern\'s elements as parts directly', () => {
    assert.deepStrictEqual(
      parseTriggerProposals([['gh pr merge', '--delete-branch']]),
      [['gh pr merge', '--delete-branch']],
    );
  });
});

describe('matchCommand', () => {
  const entryA = { id: 'a', title: 'Force-delete branch', patterns: [{ parts: ['gh pr merge', '--delete-branch'], hits: 5 }] };
  const entryB = { id: 'b', title: 'Any merge', patterns: [{ parts: ['gh pr merge'], hits: 1 }] };
  const entryC = { id: 'c', title: 'Any delete-branch', patterns: [{ parts: ['--delete-branch'], hits: 3 }] };
  const entryEmpty = { id: 'd', title: 'No patterns yet', patterns: [] };

  it('fires with parts in any position, case, and extra args', () => {
    const hits = matchCommand('GH PR MERGE 78 --squash --delete-branch', [entryA]);
    assert.deepStrictEqual(hits, [{ id: 'a', title: 'Force-delete branch', hits: 5 }]);
  });

  it('declines when only some parts are present', () => {
    assert.deepStrictEqual(matchCommand('gh pr merge 78 --squash', [entryA]), []);
  });

  it('excludes an id in alreadyFired', () => {
    assert.deepStrictEqual(
      matchCommand('gh pr merge 78 --delete-branch', [entryA], { alreadyFired: new Set(['a']) }),
      [],
    );
  });

  it('sorts multiple firing entries rarest-first', () => {
    const hits = matchCommand('gh pr merge 78 --squash --delete-branch', [entryA, entryB, entryC]);
    assert.deepStrictEqual(hits.map(h => h.id), ['b', 'c', 'a']);
  });

  it('matches a multi-line command because normalize collapses whitespace', () => {
    const hits = matchCommand('gh pr merge 78\n--delete-branch now', [entryA]);
    assert.deepStrictEqual(hits, [{ id: 'a', title: 'Force-delete branch', hits: 5 }]);
  });

  it('tolerates an entry whose patterns is empty', () => {
    assert.deepStrictEqual(matchCommand('gh pr merge --delete-branch', [entryEmpty]), []);
  });
});

describe('rebuildTriggerIndex / loadTriggerIndex', () => {
  it('indexes only live, non-archive notes that carry triggers', () => {
    const db = getDb();
    const insert = db.prepare(
      'INSERT INTO documents (title, content, doc_type, tags, triggers) VALUES (?, ?, ?, ?, ?)'
    );
    const triggered = insert.run(
      'Force-push warning', 'git push --force rewrites history', 'lesson', '',
      JSON.stringify([{ parts: ['git push', '--force'], hits: 2 }]),
    );
    insert.run('No triggers here', 'just a note', 'lesson', '', null);
    const superseded = insert.run(
      'Stale warning', 'old', 'lesson', '', JSON.stringify([{ parts: ['old'], hits: 0 }]),
    );
    db.prepare("UPDATE documents SET superseded_at = datetime('now') WHERE id = ?")
      .run(superseded.lastInsertRowid);
    insert.run('Archived warning', 'archived', 'archive', '', JSON.stringify([{ parts: ['archived'], hits: 0 }]));

    // A path under the tmp KB dir this test file already runs against, not
    // the module's default TRIGGER_INDEX_PATH, so a parallel run of this
    // suite can't collide on the same file.
    const idxPath = join(KB_DIR, 'trigger-index-test.json');
    const count = rebuildTriggerIndex(idxPath);
    assert.strictEqual(count, 1);

    const loaded = loadTriggerIndex(idxPath);
    assert.deepStrictEqual(loaded, [{
      id: triggered.lastInsertRowid,
      title: 'Force-push warning',
      patterns: [{ parts: ['git push', '--force'], hits: 2 }],
    }]);
  });

  it('a missing path loads as no entries', () => {
    assert.deepStrictEqual(loadTriggerIndex(join(KB_DIR, 'does-not-exist.json')), []);
  });
});

describe('buildCommandCorpus', () => {
  it('streams a Bash tool_use command out, skips non-Bash and malformed lines', async () => {
    const projectsDir = mkdtempSync(join(tmpdir(), 'trigger-corpus-projects-'));
    const projectDir = join(projectsDir, 'proj1');
    mkdirSync(projectDir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'echo hi\necho there' } },
      ] } }),
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Read', input: { file_path: '/x' } },
      ] } }),
      // Contains "Bash" so it passes the cheap pre-filter, but is truncated —
      // exercises the JSON.parse catch, not the pre-filter skip.
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"rm -rf /"',
    ];
    writeFileSync(join(projectDir, 'session.jsonl'), lines.join('\n') + '\n');

    const outDir = mkdtempSync(join(tmpdir(), 'trigger-corpus-out-'));
    const outPath = join(outDir, 'corpus.txt');
    const result = await buildCommandCorpus({ projectsDir, outPath });

    assert.deepStrictEqual(result, { commands: 1, files: 1 });
    assert.strictEqual(readFileSync(outPath, 'utf-8'), 'echo hi echo there\n');
  });
});
