// The outcome eval spends real agent sessions, so its tasks must be proven
// before a run: every check fails on the untouched fixture and on the
// solution that follows the repo's own patterns, and passes on the solution
// the task's lesson leads to. None of this starts an agent.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARMS, currentLessons, loadLessons, loadTasks, parseArgs, prepareRepo, rulesFile,
  runCheck, seededLessons, summarize, wilson,
} from '../scripts/outcome-eval.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const lessons = loadLessons();
const tasks = loadTasks(undefined, lessons);

function withRepo(task, overlay, fn) {
  const dir = mkdtempSync(join(tmpdir(), `kb-outcome-${task.id}-`));
  try {
    prepareRepo(task, dir, overlay);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('outcome eval tasks', () => {
  it('covers lessons, a supersession, and a control', () => {
    assert.ok(tasks.filter(task => task.kind === 'lesson').length >= 4);
    assert.ok(tasks.some(task => task.kind === 'supersession'));
    assert.ok(tasks.some(task => task.kind === 'control' && task.lessons.length === 0));
    for (const task of tasks) {
      assert.ok(task.promptB, `${task.id} has no promptB`);
      if (task.lessons.length) assert.ok(task.promptA, `${task.id} has lessons but no promptA`);
    }
  });

  for (const task of tasks) {
    describe(task.id, () => {
      it('fails on the untouched fixture', () => {
        withRepo(task, null, dir => assert.strictEqual(runCheck(task, dir).pass, false));
      });

      it('fails on the solution that follows the repo’s own patterns', () => {
        withRepo(task, 'naive', dir => assert.strictEqual(runCheck(task, dir).pass, false));
      });

      it('passes on the reference solution, whose fixture tests still pass', () => {
        withRepo(task, 'reference', dir => {
          assert.deepStrictEqual(runCheck(task, dir), { pass: true, detail: 'PASS' });
          execFileSync(process.execPath, ['--test'], { cwd: dir, stdio: 'ignore' });
        });
      });
    });
  }
});

describe('outcome eval arms', () => {
  it('gives the rules arm only current lessons', () => {
    const rules = rulesFile(lessons);
    assert.ok(rules.includes('/v2/accounts/<id>/balance'));
    assert.ok(!rules.includes('Ledger balances come from /v1/balances'));
    assert.strictEqual(currentLessons(lessons).length, lessons.length - 1);
  });

  it('withholds a task’s own lessons from the end-to-end arm only', () => {
    const task = tasks.find(t => t.id === 'ledger-balance-supersession');
    const ids = arm => seededLessons(arm, task, lessons).map(lesson => lesson.id);
    assert.strictEqual(ids('kb-seeded').length, lessons.length);
    assert.ok(!ids('kb-e2e').includes('ledger-balance-v2'));
    assert.ok(ids('kb-e2e').includes('ledger-balance-v1'), 'the superseded note is already in the KB');
    assert.deepStrictEqual(ids('cold'), []);
  });

  it('rejects an unknown arm and accepts every known one', () => {
    assert.throws(() => parseArgs(['--arms', 'cold,warm']), /unknown arm warm/);
    assert.deepStrictEqual(parseArgs(['--arms', Object.keys(ARMS).join(',')]).arms, Object.keys(ARMS));
  });

  it('builds isolated run directories without starting a session', () => {
    const out = mkdtempSync(join(tmpdir(), 'kb-outcome-dry-'));
    try {
      execFileSync(process.execPath, [
        join(ROOT, 'scripts', 'outcome-eval.mjs'),
        '--dry-run', '--out', out, '--tasks', 'refund-no-retry', '--arms', 'cold,rules,kb-seeded',
      ], { stdio: 'ignore' });
      const run = arm => join(out, 'runs', `refund-no-retry--${arm}--1`);

      assert.ok(!existsSync(join(run('cold'), 'repo', 'CLAUDE.md')));
      assert.match(readFileSync(join(run('rules'), 'repo', 'CLAUDE.md'), 'utf8'), /use sendOnce/);
      assert.deepStrictEqual(JSON.parse(readFileSync(join(run('cold'), 'mcp.json'), 'utf8')), { mcpServers: {} });

      const kbRun = run('kb-seeded');
      const server = JSON.parse(readFileSync(join(kbRun, 'mcp.json'), 'utf8')).mcpServers['knowledge-base'];
      assert.strictEqual(server.env.KB_DIR, join(kbRun, 'kb'));
      assert.strictEqual(server.env.OBSIDIAN_VAULT_PATH, join(kbRun, 'vault'));
      const settings = readFileSync(join(kbRun, 'home', '.claude', 'settings.json'), 'utf8');
      assert.ok(settings.includes(`KB_DIR='${join(kbRun, 'kb')}'`), 'hooks write to the run’s own KB');
      assert.ok(existsSync(join(kbRun, 'home', '.claude', 'skills', 'debrief', 'SKILL.md')));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('outcome eval summary', () => {
  it('reports pass rates with Wilson intervals and total spend', () => {
    const [lo, hi] = wilson(0, 5);
    assert.strictEqual(lo, 0);
    assert.ok(hi > 0.4 && hi < 0.5);
    const summary = summarize([
      { task: 't', arm: 'cold', pass: false, cost_usd: 0.5 },
      { task: 't', arm: 'kb-e2e', pass: true, cost_usd: 1, session_a: { cost_usd: 2 } },
      { task: 't', arm: 'cold', error: 'boom' },
    ]);
    assert.strictEqual(summary.by_arm.cold.n, 1);
    assert.strictEqual(summary.by_arm['kb-e2e'].pass, 1);
    assert.strictEqual(summary.total_cost_usd, 3.5);
  });
});
