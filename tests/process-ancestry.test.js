import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  isClaudeHarness, findClaudeAncestor, parseProcessTable, resolveClaudeAncestry, psExecOptions,
} from '../src/process-ancestry.js';

// This runs on a hook's critical path (every UserPromptSubmit) — a hung `ps`
// must not be able to block a hook forever. No mocking of child_process (this
// repo has no mocking convention): psExecOptions is the exact object passed
// to execFileSync, exported so the bound is asserted directly rather than by
// reading the source.
describe('psExecOptions', () => {
  it('bounds ps with a timeout, a hard kill signal and a generous but finite maxBuffer', () => {
    const opts = psExecOptions();
    assert.ok(Number.isFinite(opts.timeout) && opts.timeout > 0 && opts.timeout <= 5000, 'timeout should be a few seconds at most');
    assert.strictEqual(opts.killSignal, 'SIGKILL');
    assert.ok(Number.isFinite(opts.maxBuffer) && opts.maxBuffer > 0);
    assert.strictEqual(opts.encoding, 'utf8');
  });
});

// Real comm values captured with `ps -eo pid,ppid,lstart,comm` against a live,
// heavily-nested Claude Code process tree (a daemon/multiplexer setup: CLI
// wrapper -> bg-pty-host -> versioned binary invoked with argv0 rewritten to
// a bare version number, plus the separate Electron desktop app and its
// helpers, and an unrelated orchestrator that merely shells out to a command
// named "claude-hook"). isClaudeHarness must say yes to exactly the CLI
// binary layers and no to everything else in this tree.
describe('isClaudeHarness', () => {
  const cases = [
    ['/Users/uttambharadwaj/.local/bin/claude', true],
    ['/Users/uttambharadwaj/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude', true],
    ['claude', true], // bg-pty-host/bg-spare children: argv0 rewritten to a bare name
    ['claude bg-pty-host', false], // argv0 + args landing in comm on some ps builds — basename check is exact
    ['/Users/uttambharadwaj/.local/share/claude/versions/2.1.226', false], // versioned binary, argv0 is the version
    ['/Applications/Claude.app/Contents/MacOS/Claude', false], // desktop app: capital C
    ['/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)', false],
    ['cmux', false], // orchestrator that shells out to a command named "claude-hook"
    ['/opt/homebrew/Cellar/node@22/22.23.1/bin/node', false],
    [null, false],
    ['', false],
  ];
  for (const [comm, expected] of cases) {
    it(`${JSON.stringify(comm)} -> ${expected}`, () => {
      assert.strictEqual(isClaudeHarness(comm), expected);
    });
  }
});

describe('parseProcessTable', () => {
  const LSTART = 'Sun Aug  9 20:39:20 2026'; // real macOS ps -o lstart= sample: double space pads single-digit days

  it('parses pid, ppid, lstart and comm from a real ps -eo pid,ppid,lstart,comm line', () => {
    const raw = `  123     1 ${LSTART} /Users/uttambharadwaj/.local/bin/claude`;
    assert.deepStrictEqual(parseProcessTable(raw), [
      { pid: 123, ppid: 1, lstart: LSTART, comm: '/Users/uttambharadwaj/.local/bin/claude' },
    ]);
  });

  it('keeps embedded spaces in comm intact (Electron helper paths)', () => {
    const raw = `  789   1 ${LSTART} /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)`;
    const [row] = parseProcessTable(raw);
    assert.strictEqual(row.comm, '/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)');
  });

  it('parses multiple lines and skips the header row', () => {
    const raw = [
      '  PID  PPID STARTED                      COMM',
      `    1     0 ${LSTART} /sbin/launchd`,
      `  200   100 ${LSTART} node`,
    ].join('\n');
    assert.deepStrictEqual(parseProcessTable(raw), [
      { pid: 1, ppid: 0, lstart: LSTART, comm: '/sbin/launchd' },
      { pid: 200, ppid: 100, lstart: LSTART, comm: 'node' },
    ]);
  });

  it('skips a line whose lstart does not parse (unrecognisable ps output)', () => {
    assert.deepStrictEqual(parseProcessTable('  1 0 not-a-date node'), []);
  });
});

describe('findClaudeAncestor', () => {
  const LSTART = 'Sun Aug  9 20:00:00 2026';
  const row = (pid, ppid, comm, lstart = LSTART) => ({ pid, ppid, comm, lstart });

  it('finds a claude ancestor one hop up (the common, non-nested case) and returns its row', () => {
    const table = [
      row(200, 100, '/opt/homebrew/bin/node'), // the hook/MCP subprocess itself
      row(100, 1, '/Users/uttambharadwaj/.local/bin/claude', 'Sun Aug  9 19:00:00 2026'),
    ];
    assert.deepStrictEqual(findClaudeAncestor(200, table), row(100, 1, '/Users/uttambharadwaj/.local/bin/claude', 'Sun Aug  9 19:00:00 2026'));
  });

  it('skips a non-matching intermediate layer to find the CLI wrapper further up (daemon nesting)', () => {
    const table = [
      row(300, 200, '/opt/homebrew/bin/node'), // subprocess
      row(200, 100, '/Users/uttambharadwaj/.local/share/claude/versions/2.1.226'), // versioned binary, no match
      row(100, 1, '/Users/uttambharadwaj/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude'), // wrapper, matches
    ];
    assert.strictEqual(findClaudeAncestor(300, table)?.pid, 100);
  });

  it('returns null when no ancestor matches (e.g. a desktop-app-spawned MCP subprocess)', () => {
    const table = [
      row(400, 300, '/opt/homebrew/bin/node'),
      row(300, 1, '/Applications/Claude.app/Contents/MacOS/Claude'), // capital C, no match
    ];
    assert.strictEqual(findClaudeAncestor(400, table), null);
  });

  it('returns null for a pid not present in the table', () => {
    assert.strictEqual(findClaudeAncestor(999, []), null);
  });

  it('does not loop forever on a cyclic ppid chain', () => {
    const table = [row(1, 2, 'node'), row(2, 1, 'node')];
    assert.strictEqual(findClaudeAncestor(1, table), null);
  });
});

describe('resolveClaudeAncestry', () => {
  it('returns the matched pid and its start time on success, from one ps call', () => {
    const result = resolveClaudeAncestry({
      pid: 50,
      listProcesses: () => [
        { pid: 50, ppid: 10, comm: 'node', lstart: 'irrelevant-for-node' },
        { pid: 10, ppid: 1, comm: '/usr/local/bin/claude', lstart: 'Sun Aug  9 20:00:00 2026' },
      ],
    });
    assert.deepStrictEqual(result, { claudePid: 10, pidStart: 'Sun Aug  9 20:00:00 2026' });
  });

  it('returns nulls when no ancestor matches', () => {
    const result = resolveClaudeAncestry({
      pid: 50,
      listProcesses: () => [{ pid: 50, ppid: 1, comm: 'node', lstart: 'x' }],
    });
    assert.deepStrictEqual(result, { claudePid: null, pidStart: null });
  });

  it('never throws — a listProcesses failure collapses to nulls', () => {
    const result = resolveClaudeAncestry({
      pid: 50,
      listProcesses: () => { throw new Error('ps not found'); },
    });
    assert.deepStrictEqual(result, { claudePid: null, pidStart: null });
  });
});
