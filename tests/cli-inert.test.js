import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { assertKnownFlags, UsageError, wantsHelp } from '../src/cli/flags.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Every entry point a user or a hook can invoke. `--help` on any of them must
// print usage and write nothing — the whole point of the command.
const KB_COMMANDS = [
  'start', 'stop', 'mcp', 'migrate', 'register', 'ingest', 'search', 'status', 'tags', 'tier',
  'retrieval-report', 'wakeup-hook', 'prompt-hint', 'trigger-hook', 'link-backfill', 'stale-servers', 'aliases-backfill', 'trigger-corpus', 'triggers-backfill',
  'fold-inverses', 'canonicalize-entities', 'harvest', 'consolidate-state', 'entity-merge',
  'capture-x', 'classify', 'summarize', 'setup', 'safety-check', 'vault', 'meters',
  'bus-send', 'bus-read', 'bus-status', 'bus-session', 'bus-agent', 'bus-agentd',
  'bus-hook', 'bus-bind', 'bus-unbind', 'bus-hook-current', 'bus-notifier',
];

const STANDALONE_BINS = [
  'bus-agent', 'bus-agentd', 'bus-autobind', 'bus-bind', 'bus-hook-current', 'bus-hook',
  'bus-notifier', 'bus-read', 'bus-send', 'bus-session', 'bus-status', 'bus-unbind',
  'generate-codemap', 'weekly-synthesis',
];

let home;

function run(args) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    input: '',
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      KB_SKIP_NODE_REEXEC: '1',
      KB_DIR: join(home, 'kb'),
      KB_BUS_HOME: join(home, 'bus'),
      OBSIDIAN_VAULT_PATH: join(home, 'vault'),
      // `kb register` writes agent configs under homedir(), which no KB_* var
      // redirects. If the help guard ever regresses, this test must catch it by
      // failing — not by rewriting the developer's real MCP configuration.
      HOME: home,
      USERPROFILE: home,
    },
  });
}

// One number per database that any write would move.
function rowCounts() {
  const counts = {};
  for (const [name, file, tables] of [
    ['kb', join(home, 'kb', 'kb.db'), ['documents', 'harvest_log', 'vault_files', 'facts', 'meta', 'retrievals', 'embeddings', 'extractions']],
    ['bus', join(home, 'bus', 'bus.db'), ['bus_messages', 'bus_readers', 'bus_sessions', 'bus_deliveries']],
  ]) {
    const db = new Database(file, { readonly: true });
    for (const table of tables) counts[`${name}.${table}`] = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
    db.close();
  }
  return counts;
}

describe('--help is inert at every entry point', () => {
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'kb-cli-inert-'));
    const seeded = run([join(ROOT, 'bin', 'kb.js'), 'migrate']);
    assert.strictEqual(seeded.status, 0, seeded.stderr);
  });

  after(() => rmSync(home, { recursive: true, force: true }));

  for (const command of KB_COMMANDS) {
    it(`kb ${command} --help prints usage and writes nothing`, () => {
      const before = rowCounts();
      const result = run([join(ROOT, 'bin', 'kb.js'), command, '--help']);
      assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /^Usage: /m);
      assert.deepStrictEqual(rowCounts(), before);
    });
  }

  for (const bin of STANDALONE_BINS) {
    it(`${bin} --help prints usage and writes nothing`, () => {
      const before = rowCounts();
      const result = run([join(ROOT, 'bin', `${bin}.js`), '--help']);
      assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /^Usage: /m);
      assert.deepStrictEqual(rowCounts(), before);
    });
  }

  it('kb --help and bare kb both print the command list', () => {
    for (const args of [['--help'], []]) {
      const result = run([join(ROOT, 'bin', 'kb.js'), ...args]);
      assert.strictEqual(result.status, 0);
      assert.match(result.stdout, /Usage: kb <command>/);
      for (const command of KB_COMMANDS) assert.ok(result.stdout.includes(command), `missing ${command}`);
    }
  });

  // The row of the audit this test file exists for: `kb register --help` used to
  // rewrite the real Claude/Codex/Gemini MCP configs, which live under homedir()
  // and which no KB_* variable redirects. Assert the file, not the exit code.
  it('kb register --help leaves the agent configs untouched', () => {
    const config = join(home, '.claude.json');
    const canonical = JSON.stringify({
      mcpServers: { 'knowledge-base': { command: 'node', args: ['/canonical/bin/kb.js', 'mcp'] } },
    });
    writeFileSync(config, canonical);

    const result = run([join(ROOT, 'bin', 'kb.js'), 'register', '--help']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(readFileSync(config, 'utf8'), canonical, 'help must not re-register anything');
  });

  it('-h is help too, and reaches the command that would otherwise run', () => {
    const result = run([join(ROOT, 'bin', 'kb.js'), 'harvest', '-h']);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /Usage: kb harvest/);
  });
});

describe('a mistyped flag stops the command instead of running with defaults', () => {
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'kb-cli-flags-'));
    run([join(ROOT, 'bin', 'kb.js'), 'migrate']);
  });

  after(() => rmSync(home, { recursive: true, force: true }));

  const cases = [
    [['harvest', '--dryrun'], /Unknown flag: --dryrun/],
    [['status', '--verbose'], /Unknown flag: --verbose/],
    [['vault', 'reindex', '--no-embedings'], /Unknown flag: --no-embedings/],
    [['harvest', '--since-hours', '26'], /--since-hours needs a value/],
    [['register', '--agents', 'claude'], /--agents needs a value/],
    [['meters', 'prune'], /refuses to run without --keep-days/],
    [['meters', 'prune', '--keep-days', '7', '--table', 'model_calls'], /Refusing to prune model_calls/],
    [['nosuchcommand'], /Unknown command: nosuchcommand/],
  ];

  for (const [args, expected] of cases) {
    it(`kb ${args.join(' ')} exits 2`, () => {
      const before = rowCounts();
      const result = run([join(ROOT, 'bin', 'kb.js'), ...args]);
      assert.strictEqual(result.status, 2, result.stdout);
      assert.match(result.stderr, expected);
      assert.deepStrictEqual(rowCounts(), before);
    });
  }

  it('a standalone bin rejects its own unknown flags', () => {
    const result = run([join(ROOT, 'bin', 'bus-send.js'), 'chan', 'hello', '--sendr', 'me']);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /Unknown flag: --sendr/);
    assert.match(result.stderr, /Usage: bus-send/);
  });

  it('a missing required argument is a usage error, not a crash', () => {
    const result = run([join(ROOT, 'bin', 'bus-send.js')]);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /bus-send needs a channel and a message/);
  });
});

describe('a command run against a database that is behind', () => {
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'kb-cli-behind-'));
    run([join(ROOT, 'bin', 'kb.js'), 'migrate']);
    const db = new Database(join(home, 'kb', 'kb.db'));
    db.prepare("INSERT INTO documents (title, content, doc_type) VALUES ('keep', 'me', 'note')").run();
    db.exec('ALTER TABLE documents DROP COLUMN superseded_at');
    db.close();
  });

  after(() => rmSync(home, { recursive: true, force: true }));

  it('names the migration command instead of migrating', () => {
    const result = run([join(ROOT, 'bin', 'kb.js'), 'status']);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /is behind this code/);
    assert.match(result.stderr, /kb migrate/);
    assert.doesNotMatch(result.stdout, /not initialized/, 'a behind database is not an uninitialized one');

    const db = new Database(join(home, 'kb', 'kb.db'), { readonly: true });
    const columns = db.prepare('PRAGMA table_info(documents)').all().map(c => c.name);
    db.close();
    assert.ok(!columns.includes('superseded_at'), 'the refused command must not have migrated anything');
  });

  it('kb migrate --dry-run reports the gap without closing it', () => {
    const result = run([join(ROOT, 'bin', 'kb.js'), 'migrate', '--dry-run']);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /pending\s+3\. document supersession lifecycle/);

    const db = new Database(join(home, 'kb', 'kb.db'), { readonly: true });
    const columns = db.prepare('PRAGMA table_info(documents)').all().map(c => c.name);
    db.close();
    assert.ok(!columns.includes('superseded_at'));
  });

  it('kb migrate closes it, keeps the rows, and unblocks the command', () => {
    assert.strictEqual(run([join(ROOT, 'bin', 'kb.js'), 'migrate']).status, 0);

    const after = run([join(ROOT, 'bin', 'kb.js'), 'status']);
    assert.strictEqual(after.status, 0, after.stderr);
    assert.match(after.stdout, /Documents: 1/);
  });
});

describe('the flag gate itself', () => {
  const spec = { usage: 'Usage: x', value: ['--reader'], valueEq: ['--limit'], boolean: ['--wait'] };

  it('accepts both spellings of a value flag', () => {
    assert.doesNotThrow(() => assertKnownFlags(['--reader', 'me'], spec));
    assert.doesNotThrow(() => assertKnownFlags(['--reader=me'], spec));
  });

  it('does not mistake a flag value for a flag', () => {
    assert.doesNotThrow(() => assertKnownFlags(['--reader', '--wat'], spec));
  });

  it('rejects the separated form of an =-only flag rather than dropping it', () => {
    assert.throws(() => assertKnownFlags(['--limit', '5'], spec), UsageError);
    assert.doesNotThrow(() => assertKnownFlags(['--limit=5'], spec));
  });

  it('rejects a value on a boolean flag', () => {
    assert.throws(() => assertKnownFlags(['--wait=yes'], spec), UsageError);
  });

  it('leaves positionals alone, including ones that start with a dash', () => {
    assert.doesNotThrow(() => assertKnownFlags(['channel', '-- done', '-5'], spec));
  });

  it('treats a bare -- as the end of flags', () => {
    assert.doesNotThrow(() => assertKnownFlags(['--', '--not-a-flag'], spec));
    assert.strictEqual(wantsHelp(['--', '--help']), false);
  });

  it('carries the usage text on the error so the caller can print it', () => {
    assert.throws(() => assertKnownFlags(['--nope'], spec), err => err.usage === 'Usage: x');
  });
});
