// Command triggers: the deterministic vet (filterTriggers), the shared
// segment matcher (commandSegments / matchCommand), and the index/corpus
// plumbing around them. Revision 1 (docs/plans/2026-08-07-kb-action-triggers-
// design.md) — session-level noise ceiling, code-span-only grounding,
// heredoc stripping, and command-position matching, all measured against a
// real-history adversarial review. Corpus fixtures below are synthetic but
// session-tagged, so ratios are exact rather than approximated.
import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../src/db.js';
import { KB_DIR } from '../src/paths.js';
import {
  filterTriggers, parseTriggerProposals, matchCommand, stripHeredocs,
  rebuildTriggerIndex, loadTriggerIndex, CORPUS_PATH,
} from '../src/trigger-relevance.js';
import { buildCommandCorpus } from '../src/cli/trigger-corpus.js';
import { neverAsked, revetTriggers, runTriggersBackfillCli } from '../src/cli/triggers-backfill.js';
import { UsageError } from '../src/cli/flags.js';

// 40 sessions, 20 filler lines each (git status / ls -la, no marker overlap)
// plus explicit marker injections at known session indices, so every ratio
// below is exact: session N of 40 is N/40, e.g. 3/40 = 7.5%, 1/40 = 2.5%.
const TOTAL_SESSIONS = 40;

function fillerRows() {
  const rows = [];
  for (let s = 0; s < TOTAL_SESSIONS; s += 1) {
    for (let j = 0; j < 20; j += 1) {
      rows.push({ session: `s${s}`, command: j % 2 === 0 ? 'git status --short' : 'ls -la /tmp' });
    }
  }
  return rows;
}

// [sessionIndex, lineCount] pairs -> that many corpus lines for `marker`,
// spread across those sessions. Marker sits at the START of the line so a
// single-part pattern equal to the marker anchors correctly (patterns need
// their first part at segment start, not merely present anywhere).
function markerRows(marker, sessionCounts) {
  const rows = [];
  for (const [s, count] of sessionCounts) {
    for (let k = 0; k < count; k += 1) rows.push({ session: `s${s}`, command: `${marker} run ${k}` });
  }
  return rows;
}

const CORPUS = [
  ...fillerRows(),
  ...markerRows('common-marker-cmd', [[0, 1], [1, 1], [2, 1]]), // 3/40 = 7.5% -> over ceiling
  ...markerRows('sess1-marker-cmd', [[5, 1]]), // 1/40 = 2.5% -> at/under ceiling
  ...markerRows('prose-only-cmd', [[20, 1]]), // would pass the ceiling too — isolates grounding as the blocker
  ...markerRows('cap-alpha-cmd', [[10, 1]]), // sessions=1, hits=1
  ...markerRows('cap-bravo-cmd', [[11, 2]]), // sessions=1, hits=2
  ...markerRows('cap-charlie-cmd', [[12, 1], [13, 1]]), // sessions=2, hits=2
  ...markerRows('cap-delta-cmd', [[14, 2], [15, 1]]), // sessions=2, hits=3
  // zero-hit-marker-cmd is deliberately never injected — hits=0.
];

const NOTE = {
  title: 'Dangerous invocation warnings',
  content:
    'Watch history for `common-marker-cmd`, `sess1-marker-cmd`, `cap-alpha-cmd`, `cap-bravo-cmd`, '
    + '`cap-charlie-cmd`, `cap-delta-cmd`, `zero-hit-marker-cmd`, `ceil-rare-cmd`, and `apply`. '
    + 'Also watch for prose-only-cmd, but that one is only ever prose, never inside a code span. '
    + 'Prose grounding must not work on its own: apply the fix and drop the token after a reset.',
};

describe('filterTriggers — grounding is code-spans only', () => {
  it('drops a part that appears only in prose, never inside a code span', () => {
    // Would otherwise pass every other gate (same shape as sess1-marker-cmd,
    // same 2.5% session ratio) — grounding is the only thing blocking it.
    assert.strictEqual(filterTriggers(['prose-only-cmd'], NOTE, { corpus: CORPUS }), '');
  });

  it('keeps a part inside a backtick code span', () => {
    const kept = JSON.parse(filterTriggers(['sess1-marker-cmd'], NOTE, { corpus: CORPUS }));
    assert.deepStrictEqual(kept, [{ parts: ['sess1-marker-cmd'], hits: 1, sessions: 1 }]);
  });
});

describe('filterTriggers — shape rule', () => {
  it('rejects a single plain word even when it is code-span grounded', () => {
    assert.strictEqual(filterTriggers(['apply'], NOTE, { corpus: CORPUS }), '');
  });
});

describe('filterTriggers — MIN_PART_LEN', () => {
  it('drops a part shorter than the floor', () => {
    assert.strictEqual(filterTriggers(['gh'], NOTE, { corpus: CORPUS }), '');
  });
});

describe('filterTriggers — session-level noise ceiling', () => {
  it('rejects a pattern present in 3 of 40 sessions (7.5%)', () => {
    assert.strictEqual(filterTriggers(['common-marker-cmd'], NOTE, { corpus: CORPUS }), '');
  });

  it('accepts a pattern present in 1 of 40 sessions (2.5%)', () => {
    const kept = JSON.parse(filterTriggers(['sess1-marker-cmd'], NOTE, { corpus: CORPUS }));
    assert.deepStrictEqual(kept, [{ parts: ['sess1-marker-cmd'], hits: 1, sessions: 1 }]);
  });
});

describe('filterTriggers — pinned tier', () => {
  it('a pin skips the session ceiling the learned tier enforces', () => {
    const parts = [['common-marker-cmd']]; // 3/40 sessions = 7.5%, over the 5% ceiling
    assert.strictEqual(filterTriggers(parts, NOTE, { corpus: CORPUS }), '');
    const pinnedResult = JSON.parse(filterTriggers(parts, NOTE, { corpus: CORPUS, pinned: true }));
    assert.strictEqual(pinnedResult[0].pinned, true);
    assert.strictEqual(pinnedResult[0].sessions, 3);
  });

  it('a pin skips the coverage floor and corpus adequacy', () => {
    const zeroHit = [['zero-hit-marker-cmd']];
    assert.strictEqual(filterTriggers(zeroHit, NOTE, { corpus: CORPUS }), '');
    const withCorpus = JSON.parse(filterTriggers(zeroHit, NOTE, { corpus: CORPUS, pinned: true }));
    assert.deepStrictEqual(withCorpus[0].parts, ['zero-hit-marker-cmd']);
    const noCorpus = JSON.parse(filterTriggers(zeroHit, NOTE, { corpus: [], pinned: true }));
    assert.deepStrictEqual(noCorpus[0].parts, ['zero-hit-marker-cmd']);
  });

  it('a pin never skips grounding — a command the note does not contain stays out', () => {
    assert.strictEqual(filterTriggers([['ungrounded-marker-cmd']], NOTE, { corpus: CORPUS, pinned: true }), '');
  });

  it('a pin never skips the shape rule', () => {
    // NOTE's spans do contain `apply`, so grounding passes; shape is the blocker.
    assert.strictEqual(filterTriggers([['apply']], NOTE, { corpus: CORPUS, pinned: true }), '');
  });
});

describe('filterTriggers — coverage floor', () => {
  it('rejects a pattern with zero corpus hits — unseen is not proven rare', () => {
    assert.strictEqual(filterTriggers(['zero-hit-marker-cmd'], NOTE, { corpus: CORPUS }), '');
  });
});

describe('filterTriggers — cap, order, dedup', () => {
  it('sorts by sessions then hits, caps at 3, and drops an exact duplicate', () => {
    const proposed = ['cap-alpha-cmd', 'cap-alpha-cmd', 'cap-bravo-cmd', 'cap-charlie-cmd', 'cap-delta-cmd'];
    const kept = JSON.parse(filterTriggers(proposed, NOTE, { corpus: CORPUS }));
    assert.deepStrictEqual(kept, [
      { parts: ['cap-alpha-cmd'], hits: 1, sessions: 1 },
      { parts: ['cap-bravo-cmd'], hits: 2, sessions: 1 },
      { parts: ['cap-charlie-cmd'], hits: 2, sessions: 2 },
    ]);
  });
});

describe('filterTriggers — corpus adequacy', () => {
  it('refuses fewer than 500 lines, even for a perfect pattern', () => {
    const tiny = CORPUS.slice(0, 50);
    assert.strictEqual(filterTriggers(['sess1-marker-cmd'], NOTE, { corpus: tiny }), '');
  });

  it('refuses fewer than 20 distinct sessions, even with 500+ lines', () => {
    const rows = [];
    for (let s = 0; s < 19; s += 1) {
      for (let j = 0; j < 30; j += 1) rows.push({ session: `t${s}`, command: j % 2 === 0 ? 'git status' : 'ls -la' });
    }
    rows.push({ session: 't0', command: 'ceil-rare-cmd run' });
    assert.ok(rows.length >= 500 && new Set(rows.map(r => r.session)).size === 19);
    assert.strictEqual(filterTriggers(['ceil-rare-cmd'], NOTE, { corpus: rows }), '');
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

describe('stripHeredocs', () => {
  it('drops the body but keeps the marker line, for a quoted delimiter', () => {
    const raw = "cat > x.md <<'EOF'\ngh pr merge --delete-branch\nEOF\necho done";
    assert.strictEqual(stripHeredocs(raw), "cat > x.md <<'EOF'\necho done");
  });

  it('drops the body for an unquoted delimiter too', () => {
    const raw = 'cat > x.md <<EOF\ngh pr merge --delete-branch\nEOF\necho done';
    assert.strictEqual(stripHeredocs(raw), 'cat > x.md <<EOF\necho done');
  });
});

describe('matchCommand — heredoc bodies never fire', () => {
  const entry = { id: 'a', title: 'Force-delete branch', tier: 'observed', patterns: [{ parts: ['gh pr merge', '--delete-branch'], hits: 5, sessions: 2 }] };

  it('does not fire on the same text inside a heredoc body', () => {
    const heredocCmd = 'cat > x.md <<EOF\nsome text with gh pr merge --delete-branch inside\nEOF\necho done';
    assert.deepStrictEqual(matchCommand(heredocCmd, [entry]), []);
  });

  it('fires on the same text at command position, outside any heredoc', () => {
    const hits = matchCommand('gh pr merge 78 --squash --delete-branch', [entry]);
    assert.deepStrictEqual(hits, [{ id: 'a', title: 'Force-delete branch', tier: 'observed', hits: 5 }]);
  });
});

describe('matchCommand — mention vs execution', () => {
  const entry = { id: 'a', title: 'Force-delete branch', tier: 'observed', patterns: [{ parts: ['gh pr merge', '--delete-branch'], hits: 5, sessions: 2 }] };

  it('does not fire on a grep that mentions the flag', () => {
    assert.deepStrictEqual(matchCommand("grep -- '--delete-branch' notes.md", [entry]), []);
  });

  it('does not fire on an echo that mentions the whole phrase', () => {
    assert.deepStrictEqual(matchCommand('echo "gh pr merge --delete-branch is dangerous"', [entry]), []);
  });

  it('fires when the command actually runs it', () => {
    const hits = matchCommand('gh pr merge 78 --squash --delete-branch', [entry]);
    assert.deepStrictEqual(hits, [{ id: 'a', title: 'Force-delete branch', tier: 'observed', hits: 5 }]);
  });

  it('fires at the start of a segment after &&', () => {
    const hits = matchCommand('cd /x && gh pr merge --delete-branch', [entry]);
    assert.deepStrictEqual(hits, [{ id: 'a', title: 'Force-delete branch', tier: 'observed', hits: 5 }]);
  });

  it('fires through an env-assignment + sudo wrapper', () => {
    const hits = matchCommand('KB_DIR=/tmp sudo gh pr merge --delete-branch', [entry]);
    assert.deepStrictEqual(hits, [{ id: 'a', title: 'Force-delete branch', tier: 'observed', hits: 5 }]);
  });

  it('declines when only some parts are present', () => {
    assert.deepStrictEqual(matchCommand('gh pr merge 78 --squash', [entry]), []);
  });

  it('does not read a hyphen-joined longer command as running the prefix', () => {
    const push = { id: 'p', title: 'Force push', patterns: [{ parts: ['git push', '--force'], hits: 3, sessions: 1 }] };
    assert.deepStrictEqual(matchCommand('git push-to-prod --force', [push]), []);
  });

  it('fires after a background & separator', () => {
    const hits = matchCommand('sleep 5 & gh pr merge --delete-branch', [entry]);
    assert.deepStrictEqual(hits, [{ id: 'a', title: 'Force-delete branch', tier: 'observed', hits: 5 }]);
  });
});

describe('matchCommand — token boundary vs flag substring', () => {
  const entry = { id: 'g', title: 'Watch eva mentions', tier: 'observed', patterns: [{ parts: ['grep', 'eva'], hits: 1, sessions: 1 }] };

  it('does not match "eva" embedded in relevantNotes', () => {
    assert.deepStrictEqual(matchCommand('grep relevantnotes src/hint-relevance.js', [entry]), []);
  });

  it('does not match "eva" embedded in parseVaultNote', () => {
    assert.deepStrictEqual(matchCommand('grep parsevaultnote src/vault/indexer.js', [entry]), []);
  });

  it('matches "eva" as a standalone token', () => {
    const hits = matchCommand('grep eva src/main.js', [entry]);
    assert.deepStrictEqual(hits, [{ id: 'g', title: 'Watch eva mentions', tier: 'observed', hits: 1 }]);
  });

  it('a flag-shaped part matches as a plain substring, by design', () => {
    const flagEntry = { id: 'f', title: 'Watch --delete flags', tier: 'observed', patterns: [{ parts: ['grep', '--delete'], hits: 1, sessions: 1 }] };
    const hits = matchCommand('grep --deleted-cache-dir', [flagEntry]);
    assert.deepStrictEqual(hits, [{ id: 'f', title: 'Watch --delete flags', tier: 'observed', hits: 1 }]);
  });
});

describe('matchCommand — parts must land in the same segment', () => {
  it('does not fire when a compound command straddles the pattern across segments', () => {
    const entry = { id: 'a', title: 'Force push', patterns: [{ parts: ['git push', '--force'], hits: 3, sessions: 1 }] };
    assert.deepStrictEqual(matchCommand('git push && rm --force x', [entry]), []);
  });

  it('a real newline is a statement separator, not whitespace — a pattern split across lines does not fire', () => {
    const entry = { id: 'a', title: 'Force-delete branch', tier: 'observed', patterns: [{ parts: ['gh pr merge', '--delete-branch'], hits: 5, sessions: 2 }] };
    assert.deepStrictEqual(matchCommand('gh pr merge 78\n--delete-branch now', [entry]), []);
  });

  it('the same text on one line still fires', () => {
    const entry = { id: 'a', title: 'Force-delete branch', tier: 'observed', patterns: [{ parts: ['gh pr merge', '--delete-branch'], hits: 5, sessions: 2 }] };
    const hits = matchCommand('gh pr merge 78 --delete-branch now', [entry]);
    assert.deepStrictEqual(hits, [{ id: 'a', title: 'Force-delete branch', tier: 'observed', hits: 5 }]);
  });
});

describe('matchCommand — entry handling', () => {
  it('excludes an id in alreadyFired', () => {
    const entry = { id: 'a', title: 'x', patterns: [{ parts: ['gh pr merge', '--delete-branch'], hits: 5, sessions: 2 }] };
    assert.deepStrictEqual(
      matchCommand('gh pr merge 78 --delete-branch', [entry], { alreadyFired: new Set(['a']) }),
      [],
    );
  });

  it('tolerates an entry whose patterns is empty', () => {
    const entry = { id: 'd', title: 'No patterns yet', patterns: [] };
    assert.deepStrictEqual(matchCommand('gh pr merge --delete-branch', [entry]), []);
  });

  it('sorts multiple firing entries rarest-first', () => {
    // All three must anchor on the same segment's start ('gh pr merge...'),
    // since the first part has to match at segment start — a pattern like
    // ['--delete-branch'] alone could never fire on this command, the same
    // way it can't in the "mention vs execution" tests above.
    const entryA = { id: 'a', title: 'A', patterns: [{ parts: ['gh pr merge', '--delete-branch'], hits: 5, sessions: 2 }] };
    const entryB = { id: 'b', title: 'B', patterns: [{ parts: ['gh pr merge'], hits: 1, sessions: 1 }] };
    const entryC = { id: 'c', title: 'C', patterns: [{ parts: ['gh pr merge', '--squash'], hits: 3, sessions: 2 }] };
    const hits = matchCommand('gh pr merge 78 --squash --delete-branch', [entryA, entryB, entryC]);
    assert.deepStrictEqual(hits.map(h => h.id), ['b', 'c', 'a']);
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
      JSON.stringify([{ parts: ['git push', '--force'], hits: 2, sessions: 1 }]),
    );
    insert.run('No triggers here', 'just a note', 'lesson', '', null);
    const superseded = insert.run(
      'Stale warning', 'old', 'lesson', '', JSON.stringify([{ parts: ['old'], hits: 1, sessions: 1 }]),
    );
    db.prepare("UPDATE documents SET superseded_at = datetime('now') WHERE id = ?")
      .run(superseded.lastInsertRowid);
    insert.run('Archived warning', 'archived', 'archive', '', JSON.stringify([{ parts: ['archived'], hits: 1, sessions: 1 }]));

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
      tier: 'inferred',
      patterns: [{ parts: ['git push', '--force'], hits: 2, sessions: 1 }],
    }]);
  });

  it('a missing path loads as no entries', () => {
    assert.deepStrictEqual(loadTriggerIndex(join(KB_DIR, 'does-not-exist.json')), []);
  });
});

describe('buildCommandCorpus', () => {
  it('writes TSV rows, strips heredoc bodies, and turns newlines into "; "', async () => {
    const projectsDir = mkdtempSync(join(tmpdir(), 'trigger-corpus-projects-'));
    const projectDir = join(projectsDir, 'proj1');
    mkdirSync(projectDir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: "cat > x.md <<'EOF'\ngh pr merge --delete-branch\nEOF\necho done" } },
      ] } }),
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Read', input: { file_path: '/x' } },
      ] } }),
      // Contains "Bash" so it passes the cheap pre-filter, but is truncated —
      // exercises the JSON.parse catch, not the pre-filter skip.
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"rm -rf /"',
    ];
    writeFileSync(join(projectDir, 'session1.jsonl'), lines.join('\n') + '\n');

    const outDir = mkdtempSync(join(tmpdir(), 'trigger-corpus-out-'));
    const outPath = join(outDir, 'corpus.tsv');
    const result = await buildCommandCorpus({ projectsDir, outPath });

    assert.deepStrictEqual(result, { commands: 1, files: 1 });
    const written = readFileSync(outPath, 'utf-8');
    assert.strictEqual(written, "session1\tcat > x.md <<'EOF' ; echo done\n");
    assert.ok(!written.includes('gh pr merge'), 'the heredoc body must not reach the corpus');
    const [session, command] = written.trim().split('\t');
    assert.strictEqual(session, 'session1', 'session column is the fixture filename stem');
    assert.strictEqual(command, "cat > x.md <<'EOF' ; echo done");
  });
});

describe('triggers-backfill selection', () => {
  it('asks only notes whose frontmatter has never carried a triggers key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'triggers-backfill-'));
    writeFileSync(join(dir, 'unasked.md'), '---\ntitle: A\n---\nbody');
    writeFileSync(join(dir, 'asked-empty.md'), '---\ntitle: B\ntriggers: []\n---\nbody');
    writeFileSync(join(dir, 'asked.md'), '---\ntitle: C\ntriggers: [somecmd]\n---\nbody');
    assert.strictEqual(neverAsked(join(dir, 'unasked.md')), true);
    assert.strictEqual(neverAsked(join(dir, 'asked-empty.md')), false, 'an empty list still means "asked"');
    assert.strictEqual(neverAsked(join(dir, 'asked.md')), false);
    assert.strictEqual(neverAsked(join(dir, 'missing.md')), false);
  });
});

describe('triggers-backfill — flag validation', () => {
  it('rejects a non-integer --doc', async () => {
    await assert.rejects(runTriggersBackfillCli(['--doc', 'nope']), UsageError);
  });

  it('rejects a non-positive --limit', async () => {
    await assert.rejects(runTriggersBackfillCli(['--limit', '0']), UsageError);
  });
});

describe('triggers-backfill --dry-run', () => {
  it('counts unasked candidates and writes nothing — no model call', async () => {
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
    mkdirSync(join(vaultPath, 'notes'), { recursive: true });
    writeFileSync(
      join(vaultPath, 'notes', 'dry-run-unasked.md'),
      '---\ntitle: Dry run candidate\n---\nNever run `dry-run-cmd` here.',
    );
    const doc = getDb().prepare('INSERT INTO documents (title, content, doc_type, tags) VALUES (?, ?, ?, ?)')
      .run('Dry run candidate', 'Never run `dry-run-cmd` here.', 'lesson', '');
    getDb().prepare('INSERT INTO vault_files (vault_path, content_hash, document_id, title) VALUES (?, ?, ?, ?)')
      .run('notes/dry-run-unasked.md', 'dry-run-hash', doc.lastInsertRowid, 'Dry run candidate');

    const lines = [];
    const realLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      // Completing without hanging or throwing is itself proof no model call
      // happened — --dry-run returns before runClaudeJSON is ever reached.
      await runTriggersBackfillCli(['--dry-run']);
    } finally {
      console.log = realLog;
    }

    const out = lines.join('\n');
    assert.match(out, new RegExp(`#${doc.lastInsertRowid} Dry run candidate`));
    assert.match(out, /of \d+ unasked notes would be asked this run/);
    assert.doesNotMatch(
      readFileSync(join(vaultPath, 'notes', 'dry-run-unasked.md'), 'utf-8'),
      /triggers:/,
      'dry run must not write frontmatter',
    );
    assert.strictEqual(
      getDb().prepare('SELECT triggers FROM documents WHERE id = ?').get(doc.lastInsertRowid).triggers,
      null,
      'dry run must not write the column',
    );
  });
});

describe('triggers-backfill --revet', () => {
  it('re-filters the stored column against the current corpus, without touching frontmatter', async () => {
    // 40 sessions written to the DEFAULT corpus path — revetTriggers calls
    // filterTriggers with no explicit corpus, same as the indexer.
    const lines = [];
    for (let s = 0; s < 40; s += 1) {
      for (let j = 0; j < 20; j += 1) lines.push(`s${s}\t${j % 2 === 0 ? 'git status' : 'ls -la'}`);
    }
    lines.push('s10\trare-marker-cmd run'); // 1/40 = 2.5% -> clears the ceiling
    writeFileSync(CORPUS_PATH, lines.join('\n') + '\n');

    const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
    mkdirSync(join(vaultPath, 'notes'), { recursive: true });
    const body = 'Watch for `rare-marker-cmd` in history.';
    writeFileSync(
      join(vaultPath, 'notes', 'revet-trigger.md'),
      '---\ntitle: Revet trigger note\ntriggers: [rare-marker-cmd]\n---\n' + body,
    );

    // Stored under a stale value a past filter/corpus produced — the
    // frontmatter proposal is the durable record and stays whole; only the
    // column catches up to what filterTriggers computes today.
    const stale = JSON.stringify([{ parts: ['stale-cmd'], hits: 0, sessions: 0 }]);
    const info = getDb().prepare(
      'INSERT INTO documents (title, content, doc_type, tags, triggers) VALUES (?, ?, ?, ?, ?)'
    ).run('Revet trigger note', body, 'lesson', '', stale);
    getDb().prepare('INSERT INTO vault_files (vault_path, content_hash, document_id, title) VALUES (?, ?, ?, ?)')
      .run('notes/revet-trigger.md', 'revet-hash', info.lastInsertRowid, 'Revet trigger note');

    revetTriggers();

    const stored = getDb().prepare('SELECT triggers FROM documents WHERE id = ?').get(info.lastInsertRowid).triggers;
    assert.deepStrictEqual(JSON.parse(stored).map(p => p.parts), [['rare-marker-cmd']]);
    assert.match(
      readFileSync(join(vaultPath, 'notes', 'revet-trigger.md'), 'utf-8'),
      /triggers: \[rare-marker-cmd\]/,
      'frontmatter proposal stays whole',
    );
  });
});
