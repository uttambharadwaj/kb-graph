#!/usr/bin/env node
// Outcome eval: does a coding session do better when an earlier session
// learned something it needs? Each run copies a task's fixture repo, gives
// one arm's knowledge to a fresh headless Claude Code session (session B),
// and scores B's work with the task's deterministic check. See
// eval/outcome/README.md for the design and how to read the results.
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const EVAL_DIR = join(ROOT, 'eval', 'outcome');
const KB_JS = join(ROOT, 'bin', 'kb.js');

export const ARMS = Object.freeze({
  // No knowledge: what B does from the repo alone.
  cold: 'no knowledge',
  // Every current lesson in the repo's CLAUDE.md: a hand-curated rules file,
  // the best case for the simpler approach the README compares against.
  rules: 'current lessons in CLAUDE.md',
  // Every lesson written through kb_write (supersessions included), with the
  // MCP server, hooks, and skills that `kb setup` installs.
  'kb-seeded': 'lessons written to kb-graph',
  // As kb-seeded, except the task's own lessons are not written: session A
  // meets them in its prompt, and only what A's session leaves behind — its
  // own kb_write calls plus a harvest of its transcript — can reach B.
  'kb-e2e': 'task lessons learned by an earlier session',
});
const KB_ARMS = new Set(['kb-seeded', 'kb-e2e']);

// B may edit files and run node, npm, and git in its own scratch repo, and use
// the knowledge base. Nothing else, so a run cannot reach past its directory.
const ALLOWED_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Skill',
  'Bash(node:*)', 'Bash(npm:*)', 'Bash(git:*)', 'Bash(ls:*)', 'Bash(cat:*)',
  'mcp__knowledge-base',
].join(',');
// Session state the parent Claude Code process exports. A child that inherits
// it reports itself as the parent's session, which corrupts transcript and
// hook attribution for the KB arms.
const PARENT_SESSION_ENV = [
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED',
];

export function loadLessons(evalDir = EVAL_DIR) {
  const { lessons } = JSON.parse(readFileSync(join(evalDir, 'lessons.json'), 'utf8'));
  const ids = new Set();
  for (const lesson of lessons) {
    if (ids.has(lesson.id)) throw new Error(`duplicate lesson id ${lesson.id}`);
    if (lesson.supersedes && !ids.has(lesson.supersedes)) {
      throw new Error(`${lesson.id} supersedes ${lesson.supersedes}, which must come earlier`);
    }
    ids.add(lesson.id);
  }
  return lessons;
}

export function loadTasks(evalDir = EVAL_DIR, lessons = loadLessons(evalDir)) {
  const known = new Set(lessons.map(lesson => lesson.id));
  const tasksDir = join(evalDir, 'tasks');
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const dir = join(tasksDir, entry.name);
      const task = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf8'));
      if (task.id !== entry.name) throw new Error(`${dir}: task id ${task.id} does not match its directory`);
      for (const id of task.lessons) {
        if (!known.has(id)) throw new Error(`${task.id}: unknown lesson ${id}`);
      }
      return { ...task, dir };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

// A lesson something later in the pool supersedes is history, not guidance.
export function currentLessons(lessons) {
  const superseded = new Set(lessons.map(lesson => lesson.supersedes).filter(Boolean));
  return lessons.filter(lesson => !superseded.has(lesson.id));
}

export function rulesFile(lessons) {
  const sections = currentLessons(lessons).map(lesson => `## ${lesson.title}\n\n${lesson.content}\n`);
  return `# Team notes\n\n${sections.join('\n')}`;
}

// What a knowledge arm writes before B starts, in pool order.
export function seededLessons(arm, task, lessons) {
  if (arm === 'kb-seeded') return lessons;
  if (arm === 'kb-e2e') return lessons.filter(lesson => !task.lessons.includes(lesson.id));
  return [];
}

export function prepareRepo(task, repoDir, overlay = null) {
  cpSync(join(task.dir, 'repo'), repoDir, { recursive: true });
  if (overlay) cpSync(join(task.dir, overlay), repoDir, { recursive: true });
}

export function runCheck(task, repoDir) {
  try {
    const output = execFileSync(process.execPath, [join(task.dir, 'check.mjs'), repoDir], {
      encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { pass: true, detail: output.trim().split('\n').at(-1) };
  } catch (err) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    return { pass: false, detail: output.split('\n').find(line => line.startsWith('FAIL')) ?? output.split('\n')[0] };
  }
}

function git(repoDir, ...args) {
  execFileSync('git', args, {
    cwd: repoDir,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'eval', GIT_AUTHOR_EMAIL: 'eval@example.invalid',
      GIT_COMMITTER_NAME: 'eval', GIT_COMMITTER_EMAIL: 'eval@example.invalid',
    },
  });
}

function childEnv(base, extra) {
  const env = { ...base, ...extra };
  for (const key of PARENT_SESSION_ENV) delete env[key];
  return env;
}

function kbEnv(runDir, options) {
  return {
    KB_DIR: join(runDir, 'kb'),
    OBSIDIAN_VAULT_PATH: join(runDir, 'vault'),
    // One model download shared by every run, not one per run.
    KB_EMBEDDING_CACHE_DIR: options.embeddingCache,
  };
}

async function installKb(runDir, home, env) {
  const { mergeAgentHooks } = await import('../src/cli/setup-hooks.js');
  const { mcpServerConfig, KB_MCP_SERVER_NAME } = await import('../src/cli/mcp-register.js');
  mkdirSync(env.KB_DIR, { recursive: true });
  mkdirSync(env.OBSIDIAN_VAULT_PATH, { recursive: true });
  writeFileSync(join(env.KB_DIR, '.env'), `OBSIDIAN_VAULT_PATH=${env.OBSIDIAN_VAULT_PATH}\n`);
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), `${JSON.stringify(
    mergeAgentHooks({}, { nodeBin: process.execPath, kbJsPath: KB_JS, kbDir: env.KB_DIR }),
    null, 2,
  )}\n`);
  cpSync(join(ROOT, 'skills'), join(home, '.claude', 'skills'), { recursive: true });
  const server = mcpServerConfig();
  return { mcpServers: { [KB_MCP_SERVER_NAME]: { ...server, env: { ...server.env, ...env } } } };
}

function kbTool(name, input, env) {
  return execFileSync(process.execPath, [KB_JS, 'tool', name], {
    input: JSON.stringify(input), encoding: 'utf8', env, timeout: 300_000,
  });
}

function seedLessons(lessons, env) {
  const ids = new Map();
  for (const lesson of lessons) {
    const supersedes = lesson.supersedes ? ids.get(lesson.supersedes) : undefined;
    const output = kbTool('kb_write', {
      title: lesson.title,
      content: lesson.content,
      type: lesson.type,
      tags: lesson.tags,
      ...(supersedes == null ? {} : { supersedes }),
    }, env);
    const id = output.match(/Note #(\d+) saved/)?.[1];
    if (!id) throw new Error(`seeding ${lesson.id} did not write a note: ${output.trim()}`);
    ids.set(lesson.id, Number(id));
  }
  return ids;
}

// One headless session. stream-json keeps every tool call for the record; the
// final `result` event carries cost, turns, and the session id.
function runSession({ prompt, cwd, env, mcpConfigPath, transcriptPath, options }) {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--max-turns', String(options.maxTurns),
    '--permission-mode', 'acceptEdits',
    '--allowedTools', ALLOWED_TOOLS,
    '--strict-mcp-config', '--mcp-config', mcpConfigPath,
  ];
  if (options.model) args.push('--model', options.model);
  return new Promise((resolveRun, reject) => {
    const child = spawn(options.claudeBin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs);
    let buffer = '';
    let stderr = '';
    const events = [];
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        appendFileSync(transcriptPath, `${line}\n`);
        try { events.push(JSON.parse(line)); } catch { /* the transcript keeps it */ }
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      resolveRun({ code, events, stderr: stderr.slice(-2000) });
    });
  });
}

export function summarizeSession(events) {
  const result = events.findLast(event => event.type === 'result') ?? {};
  const toolCalls = events
    .filter(event => event.type === 'assistant')
    .flatMap(event => event.message?.content ?? [])
    .filter(block => block.type === 'tool_use')
    .map(block => block.name);
  return {
    session_id: result.session_id ?? null,
    completed: result.subtype === 'success',
    cost_usd: result.total_cost_usd ?? null,
    turns: result.num_turns ?? null,
    duration_ms: result.duration_ms ?? null,
    tool_calls: toolCalls.length,
    kb_tool_calls: toolCalls.filter(name => name.startsWith('mcp__knowledge-base__')).length,
  };
}

function findTranscript(home, sessionId) {
  const projects = join(home, '.claude', 'projects');
  if (!sessionId || !existsSync(projects)) return null;
  for (const dir of readdirSync(projects)) {
    const candidate = join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function runOne({ task, arm, rep, lessons, options }) {
  const runDir = join(options.out, 'runs', `${task.id}--${arm}--${rep}`);
  const repoDir = join(runDir, 'repo');
  const home = join(runDir, 'home');
  mkdirSync(home, { recursive: true });
  prepareRepo(task, repoDir);
  if (arm === 'rules') writeFileSync(join(repoDir, 'CLAUDE.md'), rulesFile(lessons));
  git(repoDir, 'init', '-q');
  git(repoDir, 'add', '-A');
  git(repoDir, 'commit', '-q', '-m', 'fixture');

  const row = { task: task.id, kind: task.kind, arm, rep, started_at: new Date().toISOString() };
  let env = childEnv(process.env, { HOME: home });
  let mcpConfig = { mcpServers: {} };
  if (KB_ARMS.has(arm)) {
    const kb = kbEnv(runDir, options);
    env = { ...env, ...kb };
    mcpConfig = await installKb(runDir, home, kb);
  }
  const mcpConfigPath = join(runDir, 'mcp.json');
  writeFileSync(mcpConfigPath, `${JSON.stringify(mcpConfig, null, 2)}\n`);

  if (options.dryRun) return { ...row, dry_run: true, run_dir: runDir };

  if (KB_ARMS.has(arm)) seedLessons(seededLessons(arm, task, lessons), env);

  if (arm === 'kb-e2e') {
    if (!task.promptA) return { ...row, skipped: 'task has no promptA' };
    const repoA = join(runDir, 'repo-a');
    prepareRepo(task, repoA);
    git(repoA, 'init', '-q');
    git(repoA, 'add', '-A');
    git(repoA, 'commit', '-q', '-m', 'fixture');
    const a = await runSession({
      prompt: task.promptA, cwd: repoA, env, mcpConfigPath,
      transcriptPath: join(runDir, 'session-a.jsonl'), options,
    });
    row.session_a = summarizeSession(a.events);
    const transcript = findTranscript(home, row.session_a.session_id);
    if (transcript) {
      execFileSync(process.execPath, [KB_JS, 'harvest', `--path=${transcript}`], {
        env: { ...env, KB_HARVEST_SDK_SESSIONS: '1' }, stdio: 'ignore', timeout: 900_000,
      });
    }
    row.harvested = Boolean(transcript);
  }

  const b = await runSession({
    prompt: task.promptB, cwd: repoDir, env, mcpConfigPath,
    transcriptPath: join(runDir, 'session-b.jsonl'), options,
  });
  if (b.code !== 0) row.exit_code = b.code;
  if (b.code !== 0 && b.stderr) row.stderr = b.stderr;
  return {
    ...row,
    ...summarizeSession(b.events),
    ...runCheck(task, repoDir),
    finished_at: new Date().toISOString(),
  };
}

// 95% Wilson interval: honest at the small n a pilot has.
export function wilson(pass, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = pass / n;
  const center = (p + z * z / (2 * n)) / (1 + z * z / n);
  const half = (z / (1 + z * z / n)) * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export function summarize(rows) {
  const scored = rows.filter(row => typeof row.pass === 'boolean');
  const mean = values => {
    const present = values.filter(value => typeof value === 'number');
    return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
  };
  const cell = group => {
    const pass = group.filter(row => row.pass).length;
    const [lo, hi] = wilson(pass, group.length);
    return {
      n: group.length,
      pass,
      rate: group.length ? pass / group.length : null,
      ci95: [lo, hi],
      mean_cost_usd: mean(group.map(row => row.cost_usd)),
      mean_turns: mean(group.map(row => row.turns)),
      mean_kb_tool_calls: mean(group.map(row => row.kb_tool_calls)),
    };
  };
  const keys = (field) => [...new Set(scored.map(row => row[field]))].sort();
  return {
    by_arm: Object.fromEntries(keys('arm').map(arm => [arm, cell(scored.filter(row => row.arm === arm))])),
    by_task: Object.fromEntries(keys('task').map(task => [task, Object.fromEntries(
      keys('arm').map(arm => [arm, cell(scored.filter(row => row.task === task && row.arm === arm))]),
    )])),
    total_cost_usd: rows.reduce((sum, row) => sum + (row.cost_usd ?? 0) + (row.session_a?.cost_usd ?? 0), 0),
  };
}

export function renderSummary(summary) {
  const pct = value => (value == null ? '—' : `${Math.round(value * 100)}%`);
  const money = value => (value == null ? '—' : `$${value.toFixed(2)}`);
  const num = value => (value == null ? '—' : value.toFixed(1));
  const arms = Object.keys(summary.by_arm);
  const lines = [
    '# Outcome eval results', '',
    '| Arm | Pass | Rate (95% CI) | Mean cost | Mean turns | Mean KB calls |',
    '| --- | --- | --- | --- | --- | --- |',
    ...arms.map(arm => {
      const c = summary.by_arm[arm];
      return `| ${arm} | ${c.pass}/${c.n} | ${pct(c.rate)} (${pct(c.ci95[0])}–${pct(c.ci95[1])}) | ${money(c.mean_cost_usd)} | ${num(c.mean_turns)} | ${num(c.mean_kb_tool_calls)} |`;
    }),
    '', '## By task', '',
    `| Task | ${arms.join(' | ')} |`,
    `| --- | ${arms.map(() => '---').join(' | ')} |`,
    ...Object.entries(summary.by_task).map(([task, cells]) =>
      `| ${task} | ${arms.map(arm => (cells[arm]?.n ? `${cells[arm].pass}/${cells[arm].n}` : '—')).join(' | ')} |`),
    '', `Total spend: ${money(summary.total_cost_usd)}`, '',
  ];
  return lines.join('\n');
}

const USAGE = `Usage: node scripts/outcome-eval.mjs [options]

  --arms <list>         comma-separated, from: ${Object.keys(ARMS).join(', ')} (default: cold,rules,kb-seeded)
  --tasks <list>        comma-separated task ids (default: all)
  --reps <n>            runs per task and arm (default: 1)
  --concurrency <n>     sessions at once (default: 2)
  --budget-usd <n>      stop starting runs once spend reaches this (default: 25)
  --model <id>          model for every session (default: the CLI's default)
  --max-turns <n>       per session (default: 40)
  --out <dir>           results directory (default: a new temp directory)
  --dry-run             build every run directory, start no sessions
  --summarize <dir>     re-render summary.md from an existing results.jsonl`;

export function parseArgs(argv) {
  const options = {
    arms: ['cold', 'rules', 'kb-seeded'], tasks: null, reps: 1, concurrency: 2, budgetUsd: 25,
    model: null, maxTurns: 40, out: null, dryRun: false, summarize: null,
    claudeBin: process.env.CLAUDE_BIN || 'claude', timeoutMs: 20 * 60_000,
  };
  const positive = (flag, value) => {
    const n = Number(value);
    if (!(n > 0)) throw new Error(`${flag} needs a positive number`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
      i += 1;
      return argv[i];
    };
    if (flag === '--arms') options.arms = value().split(',');
    else if (flag === '--tasks') options.tasks = value().split(',');
    else if (flag === '--reps') options.reps = positive(flag, value());
    else if (flag === '--concurrency') options.concurrency = positive(flag, value());
    else if (flag === '--budget-usd') options.budgetUsd = positive(flag, value());
    else if (flag === '--model') options.model = value();
    else if (flag === '--max-turns') options.maxTurns = positive(flag, value());
    else if (flag === '--out') options.out = resolve(value());
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--summarize') options.summarize = resolve(value());
    else if (flag === '--help' || flag === '-h') options.help = true;
    else throw new Error(`unknown option ${flag}`);
  }
  for (const arm of options.arms) {
    if (!ARMS[arm]) throw new Error(`unknown arm ${arm}`);
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (options.summarize) {
    const rows = readFileSync(join(options.summarize, 'results.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(line => JSON.parse(line));
    const markdown = renderSummary(summarize(rows));
    writeFileSync(join(options.summarize, 'summary.md'), markdown);
    console.log(markdown);
    return;
  }

  const lessons = loadLessons();
  const tasks = loadTasks(EVAL_DIR, lessons)
    .filter(task => !options.tasks || options.tasks.includes(task.id));
  options.out ??= join(tmpdir(), `kb-outcome-eval-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  // The harness imports kb-graph modules to build each run's configuration.
  // Point them at scratch state so no run can touch the operator's own KB.
  process.env.KB_DIR = join(options.out, 'harness-kb');
  options.embeddingCache ??= process.env.KB_EMBEDDING_CACHE_DIR || join(ROOT, '.cache', 'test-embedding');
  mkdirSync(options.out, { recursive: true });
  const resultsPath = join(options.out, 'results.jsonl');

  const queue = [];
  for (let rep = 1; rep <= options.reps; rep += 1) {
    for (const task of tasks) for (const arm of options.arms) queue.push({ task, arm, rep });
  }
  console.log(`${queue.length} runs → ${options.out}${options.dryRun ? ' (dry run)' : ''}`);

  const rows = [];
  let spent = 0;
  let stopped = false;
  const worker = async () => {
    while (queue.length && !stopped) {
      if (spent >= options.budgetUsd) {
        stopped = true;
        console.log(`budget of $${options.budgetUsd} reached; ${queue.length} runs not started`);
        return;
      }
      const job = queue.shift();
      let row;
      try {
        row = await runOne({ ...job, lessons, options });
      } catch (err) {
        row = { task: job.task.id, arm: job.arm, rep: job.rep, error: err.message };
      }
      spent += (row.cost_usd ?? 0) + (row.session_a?.cost_usd ?? 0);
      rows.push(row);
      appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
      const verdict = row.error ? `ERROR ${row.error}` : row.dry_run ? 'prepared' : `${row.pass ? 'PASS' : 'FAIL'} ${row.detail ?? ''}`;
      console.log(`[${rows.length}] ${job.task.id} ${job.arm} #${job.rep}: ${verdict}`);
    }
  };
  await Promise.all(Array.from({ length: options.concurrency }, worker));

  if (options.dryRun) return;
  const markdown = renderSummary(summarize(rows));
  writeFileSync(join(options.out, 'summary.md'), markdown);
  console.log(`\n${markdown}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
