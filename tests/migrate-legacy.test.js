import './helpers/tmp-kb.js';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';

const M = await import('../src/migrate-legacy.js');

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
    assert.ok(!rf[0].source.includes('worktrees'), 'non-worktree copy survives the dedupe');
    assert.ok(rf[1].source.includes('worktrees'));
    assert.equal(rf[0].folder, 'research');
    assert.ok(!notes.some(n => n.source.includes('node_modules')));
  });
});

describe('writer and orchestrator', () => {
  it('writes native notes, dedupes identical bodies, logs, and is idempotent', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const log = join(mkdtempSync(join(tmpdir(), 'ml-log-')), 'migrate-legacy.jsonl');
    const r1 = await M.runMigrateLegacy({ claudeDir: CLAUDE, gstackDir: GSTACK, workspace: WS, vaultPath: vault, logPath: log });
    assert.equal(r1.counts['repo-findings'].total, 2);
    assert.equal(r1.counts['repo-findings'].written, 1);
    assert.equal(r1.counts['repo-findings'].duplicates, 1);
    assert.equal(r1.counts['memory-global'].written, 5);
    const lessons = readdirSync(join(vault, 'agents', 'lessons'));
    assert.ok(lessons.some(f => /use-ascii-in-aws-descriptions-[0-9a-f]{8}\.md$/.test(f)));
    const file = join(vault, 'agents', 'lessons', lessons.find(f => f.includes('use-ascii')));
    const txt = readFileSync(file, 'utf8');
    assert.match(txt, /^title: "Use ASCII in AWS descriptions"$/m);
    assert.match(txt, /^tier: inferred$/m);
    assert.match(txt, /^source: "file:\/\/\//m);
    assert.ok(existsSync(join(vault, 'inbox')));
    const logLines = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(logLines.some(l => l.action === 'written' && l.source === 'memory-global'));
    assert.ok(logLines.some(l => l.action === 'duplicate'));

    M.jsonStreamSkips.push({ path: '/x/y.jsonl', text: '{"n":2,' });
    M.writeNotes([], { vaultPath: vault, logPath: log });
    const skipLines = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(skipLines.some(l => l.action === 'unparseable' && l.path === '/x/y.jsonl'));
    assert.equal(M.jsonStreamSkips.length, 0);

    const before = readdirSync(join(vault, 'agents', 'lessons')).sort();
    // A prior note for the same key under an older derived name must be
    // replaced, not left behind as an orphan.
    const decoy = join(vault, 'agents', 'lessons', `1999-01-01-old-${M.hash8(join(CLAUDE, 'memory', 'feedback_a.md'))}.md`);
    writeFileSync(decoy, 'stale');
    const r2 = await M.runMigrateLegacy({ claudeDir: CLAUDE, gstackDir: GSTACK, workspace: WS, vaultPath: vault, logPath: log });
    assert.equal(existsSync(decoy), false);
    assert.deepEqual(readdirSync(join(vault, 'agents', 'lessons')).sort(), before);
    assert.equal(r2.counts['memory-global'].written, 5);
    const replayLines = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(replayLines.some(l => l.action === 'replaced' && l.out === `agents/lessons/${basename(decoy)}`));
  });

  it('dry run writes nothing and logs planned; --only filters sources', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'ml-vault-'));
    const log = join(mkdtempSync(join(tmpdir(), 'ml-log-')), 'migrate-legacy.jsonl');
    const r = await M.runMigrateLegacy({ claudeDir: CLAUDE, gstackDir: GSTACK, workspace: WS, vaultPath: vault, dryRun: true, only: ['gstack-decisions'], logPath: log });
    assert.deepEqual(Object.keys(r.counts), ['gstack-decisions']);
    assert.equal(readdirSync(vault).length, 0);
    const logLines = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(logLines.every(l => l.action === 'planned' || l.action === 'planned-unparseable'));
    await assert.rejects(M.runMigrateLegacy({ claudeDir: CLAUDE, gstackDir: GSTACK, workspace: WS, vaultPath: vault, dryRun: true, only: ['nope'], logPath: log }), /unknown source/);
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
});
