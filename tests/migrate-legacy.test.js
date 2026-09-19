import './helpers/tmp-kb.js';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, relative } from 'path';
import matter from 'gray-matter';

const M = await import('../src/migrate-legacy.js');
const ACTION = M.MIGRATION_ACTION;
const AUDIT_STATUS = M.MIGRATION_AUDIT_STATUS;
const MIGRATION_SOURCE = M.MIGRATION_SOURCE;
const CONFLICT_REASON = M.MIGRATION_CONFLICT_REASON;

describe('migrate-legacy helpers', () => {
  it('slugify and hash8 are stable', () => {
    assert.equal(M.slugify('A/B intent: belongs to the treated surface!'), 'a-b-intent-belongs-to-the-treated-surface');
    assert.equal(M.slugify(''), 'note');
    assert.equal(M.hash8('/a/b.md'), M.hash8('/a/b.md'));
    assert.equal(M.hash8('/a/b.md').length, 8);
    assert.notEqual(M.hash8('/a/b.md'), M.hash8('/a/c.md'));
  });

  it('dateOf accepts ISO strings, YYYY-MM-DD, and falls back to file mtime', () => {
    assert.equal(M.dateOf('2026-04-07T22:24:17.972Z'), '2026-04-07');
    assert.equal(M.dateOf('2026-06-09'), '2026-06-09');
    const dir = mkdtempSync(join(tmpdir(), 'ml-'));
    const p = join(dir, 'x.md');
    writeFileSync(p, 'x');
    assert.match(M.dateOf(undefined, p), /^\d{4}-\d{2}-\d{2}$/);
    assert.match(M.dateOf('garbage', p), /^\d{4}-\d{2}-\d{2}$/);
  });

  it('readJsonStream reads one-per-line and pretty-printed streams', () => {
    M.jsonStreamSkips.length = 0;
    const dir = mkdtempSync(join(tmpdir(), 'ml-'));
    const a = join(dir, 'a.jsonl');
    writeFileSync(a, '{"n":1}\n{"n":2}\n\n');
    assert.deepEqual(M.readJsonStream(a).map(r => r.n), [1, 2]);
    const b = join(dir, 'b.jsonl');
    writeFileSync(b, '{\n  "n": 1,\n  "s": "x"\n}\n{\n  "n": 2\n}\n');
    assert.deepEqual(M.readJsonStream(b).map(r => r.n), [1, 2]);
    const c = join(dir, 'c.jsonl');
    writeFileSync(c, '{"n":1}\n{"n":2,\n{"n":3}\n');
    assert.deepEqual(M.readJsonStream(c).map(r => r.n), [1, 3]);
    assert.equal(M.jsonStreamSkips.length, 1);
    assert.equal(M.jsonStreamSkips[0].path, c);
    assert.match(M.jsonStreamSkips[0].text, /"n":2/);
  });

  it('walkFiles skips vendored dirs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ml-'));
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'x', 'a.md'), '');
    writeFileSync(join(dir, 'src', 'b.md'), '');
    const found = M.walkFiles(dir).map(p => p.slice(dir.length + 1));
    assert.deepEqual(found, ['src/b.md']);
  });

  it('renderNote emits write-note-shaped frontmatter and noteFilename is deterministic', () => {
    const note = {
      sourceKey: 'memory-global', folder: 'agents/lessons', title: 'Quote "me"', type: 'lesson',
      created: '2026-05-01', tags: ['migrated', 'origin-memory-global'], project: 'service-a',
      source: 'file:///abs/x.md', summary: 'one line', tier: 'inferred', body: 'Body text\n', key: '/abs/x.md',
    };
    const out = M.renderNote(note);
    assert.equal(out, [
      '---',
      'title: "Quote \\"me\\""',
      'type: lesson',
      'created: "2026-05-01"',
      'updated: "2026-05-01"',
      'tags: [migrated, origin-memory-global]',
      `migration: ${M.MIGRATION_ID}`,
      `migration_key: "${M.migrationKeyFor(note)}"`,
      `migration_body_hash: "${M.hash256(note.body.trim())}"`,
      'project: service-a',
      'source: "file:///abs/x.md"',
      'summary: "one line"',
      'tier: inferred',
      'status: active',
      '---',
      '',
      'Body text',
      '',
    ].join('\n'));
    assert.equal(M.noteFilename(note), `2026-05-01-quote-me-${M.hash8('/abs/x.md')}.md`);
    const noProject = M.renderNote({ ...note, project: null, summary: null });
    assert.doesNotMatch(noProject, /^project:/m);
    assert.doesNotMatch(noProject, /^summary:/m);
  });
});

const FIX = new URL('./fixtures/legacy/', import.meta.url).pathname;
const CLAUDE = join(FIX, 'claude');
const WORKSPACE = '/home/dev/workspace';

describe('memory readers', () => {
  it('maps global memory types to folders and tiers, skips MEMORY.md, catches broken frontmatter', () => {
    const notes = M.readMemoryGlobal(CLAUDE);
    const by = Object.fromEntries(notes.map(n => [basename(n.source), n]));
    assert.equal(notes.length, 5);
    assert.equal(by['feedback_a.md'].folder, 'agents/lessons');
    assert.equal(by['feedback_a.md'].type, 'lesson');
    assert.equal(by['feedback_a.md'].tier, 'inferred');
    assert.equal(by['feedback_a.md'].title, 'Use ASCII in AWS descriptions');
    assert.equal(by['feedback_a.md'].summary, 'AWS rejects em-dashes in security group descriptions');
    assert.equal(by['feedback_a.md'].project, null);
    assert.deepEqual(by['feedback_a.md'].tags, ['migrated', 'origin-memory-global', 'foo-bar', 'a-b']);
    assert.match(by['feedback_a.md'].body, /Scan Terraform/);
    assert.match(by['feedback_a.md'].source, /^file:\/\/\/.*feedback_a\.md$/);
    assert.equal(by['reference_b.md'].folder, 'sources');
    assert.equal(by['reference_b.md'].tier, 'observed');
    assert.equal(by['user_me.md'].folder, 'agents/lessons');
    assert.ok(by['user_me.md'].tags.includes('user-pref'));
    assert.equal(by['broken.md'].folder, 'inbox');
    assert.equal(by['broken.md'].type, 'capture');
    assert.ok(by['broken.md'].tags.includes('migrate-error'));
    assert.match(by['broken.md'].body, /Still worth keeping/);
    assert.equal(by['untyped.md'].folder, 'inbox');
    assert.ok(by['untyped.md'].tags.includes('migrate-unmapped-type'));
    assert.ok(!by['untyped.md'].tags.includes('migrate-error'));
    assert.ok(!by['broken.md'].tags.includes('migrate-unmapped-type'));
    assert.ok(!('MEMORY.md' in by));
  });

  it('reads nested metadata.type in project memory and derives project slug', () => {
    const notes = M.readMemoryProjects(CLAUDE, WORKSPACE);
    assert.equal(notes.length, 1);
    const n = notes[0];
    assert.equal(n.project, 'gateway');
    assert.equal(n.type, 'project');
    assert.equal(n.folder, 'projects/gateway');
    assert.equal(n.title, 'Gateway cutover status');
    assert.deepEqual(n.tags, ['migrated', 'origin-memory-project']);
  });

  it('projectSlugFromDir decodes the encoded cwd against the real tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'ml-root-'));
    mkdirSync(join(root, 'ws', 'alpha', 'web-site'), { recursive: true });
    mkdirSync(join(root, 'ws', 'infra-control-prod'), { recursive: true });
    const ws = join(root, 'ws');
    assert.equal(M.projectSlugFromDir('-ws-alpha-web-site', ws, root), 'web-site');
    assert.equal(M.projectSlugFromDir('-ws-infra-control-prod', ws, root), 'infra-control-prod');
    assert.equal(M.projectSlugFromDir('-ws-alpha-gateway', ws, root), 'gateway');
    assert.equal(M.projectSlugFromDir('-ws', ws, root), null);
  });
});

const GSTACK = join(FIX, 'gstack');

describe('gstack readers', () => {
  it('learnings: title from key, tier from 0-10 confidence, raw record preserved', () => {
    const notes = M.readGstackLearnings(GSTACK);
    assert.equal(notes.length, 2);
    const [hi, lo] = notes;
    assert.equal(hi.title, 'gateway-inmemory-cache-unnecessary');
    assert.equal(hi.tier, 'observed');
    assert.equal(lo.tier, 'inferred');
    assert.equal(hi.project, 'alpha');
    assert.equal(hi.folder, 'agents/lessons');
    assert.equal(hi.created, '2026-04-07');
    assert.match(hi.body, /Drop to Redis/);
    assert.match(hi.body, /Files:\n- gateway\/api\//);
    assert.match(hi.body, /```json\n\{"skill":"plan-eng-review"/);
    assert.notEqual(hi.key, lo.key);
    assert.equal(hi.sourceKey, 'gstack-learnings');
    assert.deepEqual(lo.tags, ['migrated', 'origin-gstack-learnings', 'api-pitfall']);
    assert.ok(hi.key.endsWith('learnings.jsonl#0'));
    assert.ok(lo.key.endsWith('learnings.jsonl#1'));
    assert.ok(hi.source.startsWith('file://'));
  });

  it('decisions: decision folder, rationale in body', () => {
    const [n] = M.readGstackDecisions(GSTACK);
    assert.equal(n.folder, 'decisions');
    assert.equal(n.type, 'decision');
    assert.equal(n.tier, 'observed');
    assert.equal(n.title, 'Ship 0.0.0.1 (MICRO)');
    assert.equal(n.created, '2026-06-09');
    assert.match(n.body, /Rationale: 8-line/);
    assert.deepEqual(n.tags, ['migrated', 'origin-gstack-decisions']);
    assert.ok(n.key.endsWith('decisions.jsonl#0'));
  });

  it('reviews: one note per file (= per branch) with one section per run', () => {
    const notes = M.readGstackReviews(GSTACK);
    assert.equal(notes.length, 1);
    const [n] = notes;
    assert.equal(n.folder, 'builds/reviews/alpha');
    assert.equal(n.type, 'build');
    assert.equal(n.title, 'Reviews: alpha / dev-feature-x');
    assert.equal(n.created, '2026-06-08');
    assert.match(n.body, /## 2026-06-08T18:29:33Z 60db054 issues_found/);
    assert.match(n.body, /\| informational \| fixed \| abc123 \|/);
    assert.match(n.body, /2026-06-09T10:00:00Z 71ee055 clean \(0 issues\)/);
    assert.deepEqual(n.tags, ['migrated', 'origin-gstack-reviews']);
    assert.ok(n.key.endsWith('dev-feature-x-reviews.jsonl'));
  });

  it('analytics: pretty-printed eureka -> ideas, spec-review -> decisions', () => {
    const notes = M.readGstackAnalytics(GSTACK);
    const ideas = notes.filter(n => n.type === 'idea');
    const decs = notes.filter(n => n.type === 'decision');
    assert.equal(ideas.length, 2);
    assert.equal(decs.length, 1);
    assert.equal(ideas[0].folder, 'ideas');
    assert.equal(ideas[0].title, 'Search cutover needs a product-route adapter, not a generic proxy');
    assert.equal(decs[0].title, 'Spec review: plan-ceo-review 2026-03-31');
    assert.deepEqual(ideas[0].tags, ['migrated', 'origin-gstack-analytics', 'eureka']);
    assert.deepEqual(decs[0].tags, ['migrated', 'origin-gstack-analytics', 'spec-review']);
    assert.ok(ideas[1].key.endsWith('eureka.jsonl#1'));
  });

  it('md artifacts: recursive, title from heading or filename', () => {
    const notes = M.readGstackMd(GSTACK);
    assert.equal(notes.length, 2);
    const by = Object.fromEntries(notes.map(n => [basename(n.source), n]));
    assert.equal(by['plan-1.md'].title, 'Growth plan Q3');
    assert.equal(by['plan-1.md'].folder, 'builds/alpha');
    assert.equal(by['dev-feature-x-eng-review-test-plan-20260525-171723.md'].title, 'dev-feature-x-eng-review-test-plan-20260525-171723');
    assert.deepEqual(by['plan-1.md'].tags, ['migrated', 'origin-gstack-md']);
    assert.equal(by['plan-1.md'].sourceKey, 'gstack-md');
  });
});

const WS = join(FIX, 'workspace');

describe('workspace readers', () => {
  it('openspec: repo and change from path, proposal/design->decision, tasks->session, archive tagged', () => {
    const notes = M.readWorkspace(WS).filter(n => n.sourceKey === 'openspec');
    assert.equal(notes.length, 3);
    const by = Object.fromEntries(notes.map(n => [n.source.split('/openspec/')[1], n]));
    const prop = by['changes/add-x/proposal.md'];
    assert.equal(prop.folder, 'decisions/openspec/repo1/add-x');
    assert.equal(prop.type, 'decision');
    assert.equal(prop.project, 'repo1');
    assert.equal(prop.title, 'Add X');
    assert.equal(by['changes/add-x/tasks.md'].type, 'session');
    assert.equal(by['changes/add-x/tasks.md'].title, 'add-x tasks');
    const old = by['changes/archive/old-y/design.md'];
    assert.equal(old.folder, 'decisions/openspec/repo1/old-y');
    assert.ok(old.tags.includes('archived'));
  });

  it('superpowers specs and repo findings go to research; vendored dirs skipped', () => {
    const notes = M.readWorkspace(WS);
    const sp = notes.filter(n => n.sourceKey === 'superpowers');
    assert.equal(sp.length, 1);
    assert.equal(sp[0].folder, 'research');
    assert.equal(sp[0].title, 'X design');
    assert.equal(sp[0].created, '2026-01-01', 'dated filename beats mtime');
    const rf = notes.filter(n => n.sourceKey === 'repo-findings');
    assert.equal(rf.length, 2, 'reader returns both copies; writer dedupes by body hash');
    assert.ok(rf.every(n => n.project === 'repo1'), 'worktree segment stripped before deriving repo');
    assert.ok(rf.every(n => n.created === '2026-08-11'), 'dated filename beats mtime');
    assert.ok(!rf[0].source.includes('/.claude/worktrees/'), 'non-worktree copy survives the dedupe');
    assert.ok(rf[1].source.includes('/.claude/worktrees/'));
    assert.equal(rf[0].folder, 'research');
    assert.ok(!notes.some(n => n.source.includes('node_modules')));
  });
});

describe('writer and orchestrator', () => {
  function note(overrides = {}) {
    return {
      sourceKey: 'memory-global',
      folder: 'agents/lessons',
      title: 'Migrated lesson',
      type: 'lesson',
      created: '2026-05-01',
      tags: ['migrated', 'origin-memory-global'],
      project: null,
      source: 'file:///legacy/lesson.md',
      summary: null,
      tier: 'inferred',
      body: 'Legacy body',
      key: '/legacy/lesson.md',
      ...overrides,
    };
  }

  function snapshot(root) {
    const entries = {};
    function visit(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(dir, entry.name);
        const key = relative(root, path);
        if (entry.isDirectory()) {
          entries[`${key}/`] = statSync(path).mode & 0o777;
          visit(path);
        } else {
          entries[key] = readFileSync(path, 'utf8');
        }
      }
    }
    visit(root);
    return entries;
  }

  it('writes native notes with ownership markers and full-body dedupe', () => {
    const vault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const first = note();
    const duplicate = note({
      sourceKey: 'repo-findings',
      source: 'file:///workspace/findings.md',
      key: '/workspace/findings.md',
    });

    const result = M.writeNotes([first, duplicate], { vaultPath: vault });

    assert.equal(result.written, 1);
    assert.equal(result.duplicates, 1);
    const [written] = M.walkFiles(vault);
    const text = readFileSync(written, 'utf8');
    assert.match(text, new RegExp(`^migration: ${M.MIGRATION_ID}$`, 'm'));
    assert.match(text, /^migration_key: "[0-9a-f]{64}"$/m);
    assert.match(text, /^migration_body_hash: "[0-9a-f]{64}"$/m);
    assert.equal(result.actions.find(action => action.action === ACTION.DUPLICATE).duplicate_of, relative(vault, written));
  });

  it('creates a missing vault for a real run but not for a dry run', () => {
    const root = mkdtempSync(join(tmpdir(), 'ml-root-'));
    const realVault = join(root, 'real-vault');
    const dryVault = join(root, 'dry-vault');

    M.writeNotes([note({})], { vaultPath: realVault });
    assert.equal(M.walkFiles(realVault).length, 1);

    const dry = M.writeNotes([note({})], { vaultPath: dryVault, dryRun: true });
    assert.equal(dry.actions[0].action, ACTION.WRITE);
    assert.equal(existsSync(dryVault), false);
  });

  it('does not conflate distinct bodies with the same legacy hash8', () => {
    const vault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const bodyA = 'distinct legacy body 25960';
    const bodyB = 'distinct legacy body 85797';
    assert.equal(M.hash8(bodyA), M.hash8(bodyB), 'fixture must collide under the old 32-bit digest');

    const result = M.writeNotes([
      note({ title: 'Collision A', body: bodyA, key: '/legacy/a.md', source: 'file:///legacy/a.md' }),
      note({ title: 'Collision B', body: bodyB, key: '/legacy/b.md', source: 'file:///legacy/b.md' }),
    ], { vaultPath: vault });

    assert.equal(result.written, 2);
    assert.equal(result.duplicates, 0);
    const bodies = M.walkFiles(vault).map(path => readFileSync(path, 'utf8'));
    assert.ok(bodies.some(body => body.endsWith(`${bodyA}\n`)));
    assert.ok(bodies.some(body => body.endsWith(`${bodyB}\n`)));
  });

  it('relocates only migration-owned output and preserves unrelated collisions', () => {
    const vault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const original = note({ folder: 'inbox', title: 'Old title' });
    const initial = M.writeNotes([original], { vaultPath: vault });
    const oldOut = initial.actions.find(action => action.action === ACTION.WRITE).out;
    const moved = { ...original, folder: 'agents/lessons', title: 'New title', body: 'Updated body' };
    const exactCollision = join(vault, moved.folder, M.noteFilename(moved));
    const suffixCollision = join(vault, moved.folder, `hand-written-${M.hash8(moved.key)}.md`);
    mkdirSync(join(vault, moved.folder), { recursive: true });
    writeFileSync(exactCollision, 'unrelated exact-path sentinel');
    writeFileSync(suffixCollision, 'unrelated suffix sentinel');

    const result = M.writeNotes([moved], { vaultPath: vault });
    const replace = result.actions.find(action => action.action === ACTION.REPLACE);

    assert.ok(replace);
    assert.notEqual(replace.out, relative(vault, exactCollision));
    assert.deepEqual(replace.remove, [oldOut]);
    assert.equal(readFileSync(exactCollision, 'utf8'), 'unrelated exact-path sentinel');
    assert.equal(readFileSync(suffixCollision, 'utf8'), 'unrelated suffix sentinel');
    assert.equal(existsSync(join(vault, oldOut)), false);
    assert.match(readFileSync(join(vault, replace.out), 'utf8'), /Updated body/);
  });

  it('keeps dry-run and real plans equal, then reruns without filesystem changes', () => {
    const vault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const log = join(mkdtempSync(join(tmpdir(), 'ml-log-')), 'migrate-legacy.jsonl');
    const unchanged = note({ title: 'Unchanged', key: '/legacy/unchanged.md', source: 'file:///legacy/unchanged.md' });
    const beforeMove = note({
      title: 'Before move',
      folder: 'inbox',
      key: '/legacy/move.md',
      source: 'file:///legacy/move.md',
      body: 'Body before relocation',
    });
    M.writeNotes([unchanged, beforeMove], { vaultPath: vault, logPath: log });
    const moved = { ...beforeMove, title: 'After move', folder: 'research', body: 'Moved body' };
    const added = note({
      title: 'New note',
      key: '/legacy/new.md',
      source: 'file:///legacy/new.md',
      body: 'Brand new body',
    });
    const sentinel = join(vault, 'manual.md');
    writeFileSync(sentinel, 'manual sentinel');
    const beforeDryRun = snapshot(vault);
    const logBeforeDryRun = readFileSync(log, 'utf8');

    const dry = M.writeNotes([unchanged, moved, added], { vaultPath: vault, logPath: log, dryRun: true });
    assert.deepEqual(snapshot(vault), beforeDryRun);
    assert.equal(readFileSync(log, 'utf8'), logBeforeDryRun);

    const real = M.writeNotes([unchanged, moved, added], { vaultPath: vault, logPath: log });
    assert.deepEqual(real.actions, dry.actions);
    assert.equal(readFileSync(sentinel, 'utf8'), 'manual sentinel');
    const afterReal = snapshot(vault);
    const logAfterReal = readFileSync(log, 'utf8');

    const rerun = M.writeNotes([unchanged, moved, added], { vaultPath: vault, logPath: log });
    assert.ok(rerun.actions.every(action => action.action === ACTION.SKIP));
    assert.deepEqual(snapshot(vault), afterReal);
    assert.equal(readFileSync(log, 'utf8'), logAfterReal);
  });

  it('normalizes project names consistently so reruns converge', () => {
    const vault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const log = join(mkdtempSync(join(tmpdir(), 'ml-log-')), 'migrate-legacy.jsonl');
    const source = note({ project: ' Gateway ' });

    M.writeNotes([source], { vaultPath: vault, logPath: log });
    const logAfterWrite = readFileSync(log, 'utf8');
    const rerun = M.writeNotes([source], { vaultPath: vault, logPath: log });

    assert.equal(rerun.actions[0].action, ACTION.SKIP);
    assert.equal(readFileSync(log, 'utf8'), logAfterWrite);
    assert.match(readFileSync(M.walkFiles(vault)[0], 'utf8'), /^project: gateway$/m);
  });

  it('preserves summaries, triggers, aliases, and promotion metadata on rerun', () => {
    const vault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const source = note({ title: 'Enriched note', body: 'Original imported body' });
    const first = M.writeNotes([source], { vaultPath: vault });
    const out = first.actions.find(action => action.action === ACTION.WRITE).out;
    const path = join(vault, out);
    const enriched = readFileSync(path, 'utf8').replace(
      'status: active',
      [
        'status: active',
        'summary: "Generated summary"',
        'key_topics: [migration, safety]',
        'triggers: ["legacy imports"]',
        'aliases: ["old lesson"]',
        'tier_ref: "fact:123"',
      ].join('\n')
    );
    writeFileSync(path, enriched);

    const unchanged = M.writeNotes([source], { vaultPath: vault });
    assert.equal(unchanged.actions[0].action, ACTION.SKIP);
    assert.equal(readFileSync(path, 'utf8'), enriched);

    const changed = M.writeNotes([{ ...source, body: 'Updated imported body' }], { vaultPath: vault });
    assert.equal(changed.actions[0].action, ACTION.REPLACE);
    const updated = readFileSync(path, 'utf8');
    const parsed = matter(updated);
    assert.equal(parsed.data.summary, 'Generated summary');
    assert.deepEqual(parsed.data.key_topics, ['migration', 'safety']);
    assert.deepEqual(parsed.data.triggers, ['legacy imports']);
    assert.deepEqual(parsed.data.aliases, ['old lesson']);
    assert.equal(parsed.data.tier_ref, 'fact:123');
    assert.match(parsed.content, /Updated imported body/);
  });

  it('removes a stale owned output when its body collapses into a duplicate', () => {
    const vault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const first = note({ title: 'First', body: 'Canonical body', key: '/legacy/first.md', source: 'file:///legacy/first.md' });
    const second = note({ title: 'Second', body: 'Formerly distinct', key: '/legacy/second.md', source: 'file:///legacy/second.md' });
    const initial = M.writeNotes([first, second], { vaultPath: vault });
    const secondOut = initial.actions.find(action => action.path === second.source).out;

    const result = M.writeNotes([first, { ...second, body: first.body }], { vaultPath: vault });
    const collapse = result.actions.find(action => action.action === ACTION.COLLAPSE);

    assert.ok(collapse);
    assert.deepEqual(collapse.remove, [secondOut]);
    assert.equal(existsSync(join(vault, secondOut)), false);
    assert.equal(M.walkFiles(vault).length, 1);
  });

  it('refuses to collapse a duplicate that has user-added enrichment', () => {
    const vault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const first = note({ title: 'First enriched', body: 'Canonical body', key: '/legacy/first.md', source: 'file:///legacy/first.md' });
    const second = note({ title: 'Second enriched', body: 'Formerly distinct', key: '/legacy/second.md', source: 'file:///legacy/second.md' });
    const initial = M.writeNotes([first, second], { vaultPath: vault });
    const secondOut = initial.actions.find(action => action.path === second.source).out;
    const secondPath = join(vault, secondOut);
    writeFileSync(secondPath, readFileSync(secondPath, 'utf8').replace(
      'status: active',
      'status: active\nsummary: "Keep this summary"'
    ));

    const result = M.writeNotes([first, { ...second, body: first.body }], { vaultPath: vault });

    assert.equal(result.actions[1].action, ACTION.CONFLICT);
    assert.deepEqual(result.actions[1].retained, [secondOut]);
    assert.equal(existsSync(secondPath), true);
    assert.match(readFileSync(secondPath, 'utf8'), /Keep this summary/);
    assert.equal(M.walkFiles(vault).length, 2);
  });

  it('refuses replacement cleanup when another owned copy has enrichment', () => {
    const vault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const source = note({ title: 'Owned copies', body: 'Original source body' });
    const initial = M.writeNotes([source], { vaultPath: vault });
    const originalOut = initial.actions[0].out;
    const originalPath = join(vault, originalOut);
    const copyOut = join('research', 'annotated-copy.md');
    const copyPath = join(vault, copyOut);
    mkdirSync(dirname(copyPath), { recursive: true });
    writeFileSync(copyPath, readFileSync(originalPath, 'utf8').replace(
      'status: active',
      'status: active\nsummary: "Human annotation"\naliases: ["working copy"]'
    ));
    const before = snapshot(vault);

    const result = M.writeNotes([{ ...source, body: 'Changed source body' }], { vaultPath: vault });

    assert.equal(result.actions[0].action, ACTION.CONFLICT);
    assert.deepEqual(result.actions[0].retained, [copyOut]);
    assert.deepEqual(snapshot(vault), before);
  });

  it('refuses replacement cleanup when another owned copy has edited body content', () => {
    const vault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const source = note({ title: 'Body-edited copy', body: 'Original imported body' });
    const initial = M.writeNotes([source], { vaultPath: vault });
    const original = matter(readFileSync(join(vault, initial.actions[0].out), 'utf8'));
    const copyOut = join('research', 'body-edited-copy.md');
    const copyPath = join(vault, copyOut);
    mkdirSync(dirname(copyPath), { recursive: true });
    writeFileSync(copyPath, matter.stringify('Human-authored body analysis\n', original.data));

    const result = M.writeNotes([{ ...source, body: 'Changed source body' }], { vaultPath: vault });

    assert.equal(result.actions[0].action, ACTION.CONFLICT);
    assert.deepEqual(result.actions[0].retained, [copyOut]);
    assert.match(readFileSync(copyPath, 'utf8'), /Human-authored body analysis/);
  });

  it('refuses to overwrite body edits in the primary owned output', () => {
    const vault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const source = note({ title: 'Primary body edit', body: 'Imported body' });
    const initial = M.writeNotes([source], { vaultPath: vault });
    const path = join(vault, initial.actions[0].out);
    const parsed = matter(readFileSync(path, 'utf8'));
    writeFileSync(path, matter.stringify('Human-edited primary body\n', parsed.data));

    const result = M.writeNotes([{ ...source, body: 'New source body' }], { vaultPath: vault });

    assert.equal(result.actions[0].action, ACTION.CONFLICT);
    assert.deepEqual(result.actions[0].retained, [initial.actions[0].out]);
    assert.match(readFileSync(path, 'utf8'), /Human-edited primary body/);
  });

  it('upgrades unchanged legacy-owned notes but refuses ambiguous legacy body divergence', () => {
    const source = note({ title: 'Legacy marker upgrade', body: 'Legacy imported body' });

    const cleanVault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const cleanInitial = M.writeNotes([source], { vaultPath: cleanVault });
    const cleanPath = join(cleanVault, cleanInitial.actions[0].out);
    writeFileSync(cleanPath, readFileSync(cleanPath, 'utf8')
      .replace(/^migration(?:_key|_body_hash)?:.*\n/gm, ''));
    const upgraded = M.writeNotes([source], { vaultPath: cleanVault });
    assert.equal(upgraded.actions[0].action, ACTION.REPLACE);
    assert.match(readFileSync(cleanPath, 'utf8'), /^migration_body_hash: ['"]?[0-9a-f]{64}['"]?$/m);
    assert.equal(M.writeNotes([source], { vaultPath: cleanVault }).actions[0].action, ACTION.SKIP);

    const editedVault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const editedInitial = M.writeNotes([source], { vaultPath: editedVault });
    const editedPath = join(editedVault, editedInitial.actions[0].out);
    const legacy = matter(readFileSync(editedPath, 'utf8'));
    delete legacy.data.migration;
    delete legacy.data.migration_key;
    delete legacy.data.migration_body_hash;
    writeFileSync(editedPath, matter.stringify('Unknown legacy body edit\n', legacy.data));
    const before = readFileSync(editedPath, 'utf8');

    const refused = M.writeNotes([source], { vaultPath: editedVault });
    assert.equal(refused.actions[0].action, ACTION.CONFLICT);
    assert.equal(readFileSync(editedPath, 'utf8'), before);
  });

  it('keeps the old owned output when writing its relocation fails', () => {
    const vault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const original = note({ folder: 'inbox', title: 'Before failure' });
    const initial = M.writeNotes([original], { vaultPath: vault });
    const oldOut = initial.actions[0].out;
    const writeError = Object.assign(new Error('disk full'), { code: 'ENOSPC' });

    assert.throws(
      () => M.writeNotes([{ ...original, folder: 'research', title: 'After failure' }], {
        vaultPath: vault,
        write: () => { throw writeError; },
      }),
      error => error === writeError,
    );
    assert.equal(existsSync(join(vault, oldOut)), true);
    assert.equal(M.walkFiles(vault).length, 1);
  });

  it('rechecks ownership before overwriting or deleting a planned output', () => {
    const overwriteVault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const source = note({ title: 'Ownership race', body: 'Original' });
    const initial = M.writeNotes([source], { vaultPath: overwriteVault });
    const out = initial.actions[0].out;
    const path = join(overwriteVault, out);
    assert.throws(
      () => M.writeNotes([{ ...source, body: 'Changed' }], {
        vaultPath: overwriteVault,
        beforeExecute: () => writeFileSync(path, 'unrelated overwrite sentinel'),
      }),
      /refusing to replace unowned vault note/,
    );
    assert.equal(readFileSync(path, 'utf8'), 'unrelated overwrite sentinel');

    const deleteVault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const old = M.writeNotes([source], { vaultPath: deleteVault }).actions[0].out;
    const oldPath = join(deleteVault, old);
    assert.throws(
      () => M.writeNotes([{ ...source, folder: 'research', title: 'Moved race' }], {
        vaultPath: deleteVault,
        beforeExecute: () => writeFileSync(oldPath, 'unrelated delete sentinel'),
      }),
      /refusing to remove unowned vault note/,
    );
    assert.equal(readFileSync(oldPath, 'utf8'), 'unrelated delete sentinel');
  });

  it('refuses to overwrite a file that appears after planning a new write', () => {
    const vault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    let collisionPath;

    assert.throws(
      () => M.writeNotes([note({ title: 'Late collision' })], {
        vaultPath: vault,
        beforeExecute: actions => {
          collisionPath = join(vault, actions[0].out);
          mkdirSync(dirname(collisionPath), { recursive: true });
          writeFileSync(collisionPath, 'late unrelated sentinel');
        },
      }),
      error => error?.code === 'EEXIST',
    );
    assert.equal(readFileSync(collisionPath, 'utf8'), 'late unrelated sentinel');
  });

  it('rechecks the retained output before duplicate or relocation cleanup', () => {
    const relocationVault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const source = note({ title: 'Retained relocation' });
    const initial = M.writeNotes([source], { vaultPath: relocationVault });
    const retainedOut = initial.actions[0].out;
    const retainedPath = join(relocationVault, retainedOut);
    const extraOut = join('inbox', 'owned-extra.md');
    mkdirSync(dirname(join(relocationVault, extraOut)), { recursive: true });
    writeFileSync(join(relocationVault, extraOut), readFileSync(retainedPath, 'utf8'));

    assert.throws(
      () => M.writeNotes([source], {
        vaultPath: relocationVault,
        beforeExecute: () => {
          const retained = matter(readFileSync(retainedPath, 'utf8'));
          writeFileSync(retainedPath, matter.stringify('changed retained body\n', retained.data));
        },
      }),
      /retained vault note changed/,
    );
    assert.equal(existsSync(join(relocationVault, extraOut)), true);

    const collapseVault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const first = note({ title: 'Collapse survivor', body: 'Shared later', key: '/legacy/survivor.md', source: 'file:///legacy/survivor.md' });
    const second = note({ title: 'Collapse removed', body: 'Different first', key: '/legacy/removed.md', source: 'file:///legacy/removed.md' });
    const outputs = M.writeNotes([first, second], { vaultPath: collapseVault }).actions;
    const survivorPath = join(collapseVault, outputs.find(action => action.path === first.source).out);
    const removedPath = join(collapseVault, outputs.find(action => action.path === second.source).out);

    assert.throws(
      () => M.writeNotes([first, { ...second, body: first.body }], {
        vaultPath: collapseVault,
        beforeExecute: () => {
          const survivor = matter(readFileSync(survivorPath, 'utf8'));
          writeFileSync(survivorPath, matter.stringify('changed survivor body\n', survivor.data));
        },
      }),
      /retained vault note changed/,
    );
    assert.equal(existsSync(removedPath), true);
  });

  it('audits completed and interrupted operations during a partial run', () => {
    const vault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const log = join(mkdtempSync(join(tmpdir(), 'ml-log-')), 'migrate-legacy.jsonl');
    const moving = note({ title: 'Moving', folder: 'inbox', body: 'Moving body' });
    M.writeNotes([moving], { vaultPath: vault });
    const moved = { ...moving, title: 'Moved', folder: 'research' };
    const added = note({ title: 'Fails', body: 'Second body', key: '/legacy/fails.md', source: 'file:///legacy/fails.md' });
    let writes = 0;
    const write = (path, content) => {
      writes += 1;
      if (writes === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, { flag: 'wx' });
    };

    assert.throws(() => M.writeNotes([moved, added], { vaultPath: vault, logPath: log, write }), /disk full/);
    const rows = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(rows.some(row => row.path === moved.source && row.status === AUDIT_STATUS.COMPLETED));
    assert.ok(rows.some(row => row.path === added.source && row.status === AUDIT_STATUS.STARTED));
    assert.ok(!rows.some(row => row.path === added.source && row.status === AUDIT_STATUS.COMPLETED));
  });

  it('logs repeated genuine mutations even when their actions are identical', () => {
    const vault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const log = join(mkdtempSync(join(tmpdir(), 'ml-log-')), 'migrate-legacy.jsonl');
    const source = note({ title: 'Restored note' });
    const first = M.writeNotes([source], { vaultPath: vault, logPath: log });
    const out = first.actions[0].out;
    const rowsAfterFirst = readFileSync(log, 'utf8').trim().split('\n').length;
    unlinkSync(join(vault, out));

    const second = M.writeNotes([source], { vaultPath: vault, logPath: log });
    const rowsAfterSecond = readFileSync(log, 'utf8').trim().split('\n').length;

    assert.equal(second.actions[0].action, ACTION.WRITE);
    assert.equal(rowsAfterFirst, 2);
    assert.equal(rowsAfterSecond, 4);
  });

  it('refuses to follow a vault symlink outside the vault', () => {
    const vault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const outside = mkdtempSync(join(tmpdir(), 'ml-outside-'));
    symlinkSync(outside, join(vault, 'linked'), 'dir');

    assert.throws(
      () => M.writeNotes([note({ folder: 'linked' })], { vaultPath: vault }),
      /refusing to follow a path outside the vault/,
    );
    assert.deepEqual(readdirSync(outside), []);
  });

  it('refuses to delete through a directory swapped to an external symlink', () => {
    const vault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const outside = mkdtempSync(join(tmpdir(), 'ml-outside-'));
    const source = note({ folder: 'inbox', title: 'Symlink removal' });
    const initial = M.writeNotes([source], { vaultPath: vault });
    const oldOut = initial.actions[0].out;
    const movedDir = join(outside, 'moved-inbox');

    assert.throws(
      () => M.writeNotes([{ ...source, folder: 'research', title: 'Moved safely' }], {
        vaultPath: vault,
        beforeExecute: () => {
          renameSync(join(vault, 'inbox'), movedDir);
          symlinkSync(movedDir, join(vault, 'inbox'), 'dir');
        },
      }),
      /refusing to follow a path outside the vault/,
    );
    assert.equal(existsSync(join(movedDir, basename(oldOut))), true);
  });

  it('preserves and reports corrupt stream records in dry and real runs', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const gstack = mkdtempSync(join(tmpdir(), 'ml-gstack-'));
    const project = join(gstack, 'projects', 'alpha');
    const source = join(project, 'learnings.jsonl');
    const log = join(mkdtempSync(join(tmpdir(), 'ml-log-')), 'migrate-legacy.jsonl');
    mkdirSync(project, { recursive: true });
    const original = [
      '{"key":"first","insight":"valid one","confidence":9}',
      '{"key":"broken",',
      '{"key":"second","insight":"valid two","confidence":7}',
      '',
    ].join('\n');
    writeFileSync(source, original);

    const args = {
      claudeDir: '/nonexistent',
      gstackDir: gstack,
      workspace: '/nonexistent',
      vaultPath: vault,
      only: ['gstack-learnings'],
      logPath: log,
    };
    const dry = await M.runMigrateLegacy({ ...args, dryRun: true });
    assert.equal(existsSync(log), false);
    assert.equal(readFileSync(source, 'utf8'), original);
    assert.equal(dry.actions.filter(action => action.action === ACTION.WRITE).length, 2);
    assert.equal(dry.actions.filter(action => action.action === ACTION.UNPARSEABLE).length, 1);
    assert.equal(dry.actions.find(action => action.action === ACTION.UNPARSEABLE).path, source);
    assert.deepEqual(dry.counts['gstack-learnings'], {
      total: 2,
      written: 2,
      replaced: 0,
      skipped: 0,
      duplicates: 0,
      conflicts: 0,
      unparseable: 0,
    });
    assert.deepEqual(dry.counts[MIGRATION_SOURCE.JSON_STREAM], {
      total: 1,
      written: 0,
      replaced: 0,
      skipped: 0,
      duplicates: 0,
      conflicts: 0,
      unparseable: 1,
    });

    const real = await M.runMigrateLegacy(args);
    assert.deepEqual(real.actions, dry.actions);
    assert.equal(M.walkFiles(vault).length, 2);
    assert.equal(readFileSync(source, 'utf8'), original);
    assert.ok(readFileSync(log, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line))
      .some(entry => entry.action === ACTION.UNPARSEABLE));
    const logAfterReal = readFileSync(log, 'utf8');
    await M.runMigrateLegacy(args);
    assert.equal(readFileSync(log, 'utf8'), logAfterReal);
  });

  it('missing roots are reported, not thrown', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const r = await M.runMigrateLegacy({ claudeDir: '/nonexistent', gstackDir: '/nonexistent', workspace: '/nonexistent', vaultPath: vault, dryRun: true, logPath: join(vault, 'log.jsonl') });
    assert.ok(Object.values(r.counts).every(c => c.total === 0));
    assert.ok(r.missing.length >= 3);
  });
});

describe('cli arg parsing', () => {
  it('parses --dry-run, --only=, --workspace=', async () => {
    const { parseMigrateLegacyArgs } = await import('../src/cli/migrate-legacy.js');
    const { UsageError } = await import('../src/cli/flags.js');
    assert.deepEqual(parseMigrateLegacyArgs([]), { dryRun: false, only: null, workspace: undefined });
    assert.deepEqual(parseMigrateLegacyArgs(['--dry-run', '--only=openspec,gstack-md', '--workspace=/w']),
      { dryRun: true, only: ['openspec', 'gstack-md'], workspace: '/w' });
    assert.throws(() => parseMigrateLegacyArgs(['--only=nope']), err => err instanceof UsageError && /unknown source/.test(err.message));
    assert.throws(() => parseMigrateLegacyArgs(['--only=']), UsageError);
    assert.throws(() => parseMigrateLegacyArgs(['--workspace=']), UsageError);
  });

  it('reports every destructive dry-run action and corrupt record', async () => {
    const { runMigrateLegacyCli } = await import('../src/cli/migrate-legacy.js');
    const output = [];
    const errors = [];
    const result = {
      counts: {
        'memory-global': {
          total: 3,
          written: 0,
          replaced: 1,
          skipped: 0,
          duplicates: 1,
          conflicts: 1,
          unparseable: 0,
        },
      },
      actions: [
        {
          action: ACTION.REPLACE,
          source: 'memory-global',
          path: 'file:///legacy/a.md',
          out: 'research/new.md',
          remove: ['inbox/old.md'],
          write: true,
        },
        {
          action: ACTION.COLLAPSE,
          source: 'memory-global',
          path: 'file:///legacy/duplicate.md',
          out: 'research/new.md',
          remove: ['inbox/duplicate.md'],
          duplicate_of: 'research/new.md',
        },
        {
          action: ACTION.CONFLICT,
          source: 'memory-global',
          path: 'file:///legacy/enriched.md',
          out: 'research/new.md',
          retained: ['inbox/enriched.md'],
          reason: CONFLICT_REASON.ENRICHED_DUPLICATE,
        },
        {
          action: ACTION.UNPARSEABLE,
          source: MIGRATION_SOURCE.JSON_STREAM,
          path: '/legacy/broken.jsonl',
          text: '{"broken":',
        },
      ],
      missing: [],
    };
    let runOptions;

    await assert.rejects(runMigrateLegacyCli(['--dry-run'], {
      env: { OBSIDIAN_VAULT_PATH: '/vault' },
      log: line => output.push(line),
      error: line => errors.push(line),
      run: async options => {
        runOptions = options;
        return result;
      },
    }), /migration incomplete: 2 unresolved record/);

    assert.ok(output.includes('  replace: inbox/old.md -> research/new.md'));
    assert.ok(output.includes('  collapse: inbox/duplicate.md -> research/new.md'));
    assert.ok(output.includes('(dry run — no files or logs written)'));
    assert.ok(output.includes('Migration incomplete: resolve reported records and rerun before reindexing.'));
    assert.deepEqual(errors, [
      'conflict: file:///legacy/enriched.md: refusing destructive cleanup of enriched output inbox/enriched.md',
      'unparseable: /legacy/broken.jsonl: {"broken":',
    ]);
    assert.equal(runOptions.vaultPath, '/vault');

    const incompleteOutput = [];
    await assert.rejects(runMigrateLegacyCli([], {
      env: { OBSIDIAN_VAULT_PATH: '/vault' },
      log: line => incompleteOutput.push(line),
      error: () => {},
      run: async () => ({
        ...result,
        actions: result.actions.filter(action => action.action !== ACTION.UNPARSEABLE),
      }),
    }), /migration incomplete: 1 unresolved record/);
    assert.ok(!incompleteOutput.includes('Next: kb vault reindex'));

    const realOutput = [];
    await runMigrateLegacyCli([], {
      env: { OBSIDIAN_VAULT_PATH: '/vault' },
      log: line => realOutput.push(line),
      error: () => {},
      run: async () => ({
        ...result,
        actions: result.actions.filter(action =>
          action.action !== ACTION.UNPARSEABLE && action.action !== ACTION.CONFLICT
        ),
      }),
    });
    assert.ok(realOutput.includes('  replace: inbox/old.md -> research/new.md'));
    assert.ok(realOutput.includes('  collapse: inbox/duplicate.md -> research/new.md'));
    assert.ok(realOutput.includes('Next: kb vault reindex'));
  });
});
