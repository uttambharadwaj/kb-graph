import './helpers/tmp-kb.js';
import { afterEach, describe, it } from 'node:test';
import { stableNodePath } from '../src/cli/runtime-node.js';
import assert from 'node:assert';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { register } from '../src/cli/register.js';
import { registerSetupAgent } from '../src/cli/setup.js';
import {
  codexRegistrationSnippet,
  findCursorWorkspaceConfig,
  getAgentConfigPath,
  KB_ENTRYPOINT_PATH,
  parseRegisterArgs,
  registerAgents,
} from '../src/cli/mcp-register.js';

const tempDirs = [];

function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'kb-register-test-'));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path, config) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('MCP registration', () => {
  it('defaults to all supported agents', () => {
    assert.deepStrictEqual(parseRegisterArgs([]), ['claude', 'codex', 'gemini', 'cursor']);
  });

  it('parses an explicit agent subset', () => {
    assert.deepStrictEqual(parseRegisterArgs(['--agents=claude,codex,claude']), ['claude', 'codex']);
  });

  it('rejects unsupported agents', () => {
    assert.throws(() => parseRegisterArgs(['--agents=claude,foo']), /Unsupported agent/);
  });

  it('registers cursor in ~/.cursor/mcp.json using the mcpServers shape', () => {
    const homeDir = makeHome();
    const [r] = registerAgents(['cursor'], homeDir);
    assert.strictEqual(r.written, true);
    assert.strictEqual(r.path, join(homeDir, '.cursor', 'mcp.json'));
    const config = JSON.parse(readFileSync(r.path, 'utf-8'));
    assert.deepStrictEqual(config.mcpServers['knowledge-base'], {
      command: stableNodePath(),
      args: [KB_ENTRYPOINT_PATH, 'mcp-shim', '--agent=cursor'],
      env: { NODE_OPTIONS: '' },
    });
  });

  it('creates a missing config owner-only, since mcp.json conventionally carries API keys', () => {
    const homeDir = makeHome();
    const [r] = registerAgents(['cursor'], homeDir);
    assert.strictEqual(statSync(r.path).mode & 0o777, 0o600);
  });

  it('repairs broad config permissions and removes a stale legacy temp file', () => {
    const homeDir = makeHome();
    const path = getAgentConfigPath('cursor', homeDir);
    const legacyTemp = `${path}.kb-tmp`;
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{"mcpServers":{}}\n');
    chmodSync(path, 0o666);
    writeFileSync(legacyTemp, '{"headers":{"Authorization":"old-secret"}}\n');
    chmodSync(legacyTemp, 0o644);

    registerAgents(['cursor'], homeDir);

    assert.strictEqual(statSync(path).mode & 0o777, 0o600);
    assert.strictEqual(existsSync(legacyTemp), false);
  });

  it('writes config files for the agents whose configs it owns', () => {
    const homeDir = makeHome();
    const results = registerAgents(['claude', 'gemini'], homeDir);

    assert.strictEqual(results.length, 2);
    assert.ok(existsSync(getAgentConfigPath('claude', homeDir)));
    assert.ok(existsSync(getAgentConfigPath('gemini', homeDir)));

    for (const agent of ['claude', 'gemini']) {
      const config = JSON.parse(readFileSync(getAgentConfigPath(agent, homeDir), 'utf-8'));
      assert.deepStrictEqual(config.mcpServers['knowledge-base'], {
        command: stableNodePath(),
        args: [KB_ENTRYPOINT_PATH, 'mcp-shim'],
        env: { NODE_OPTIONS: '' },
      });
    }
  });
});

// Codex CLI (0.148) reads [mcp_servers.*] from config.toml and never loads
// ~/.codex/mcp.json — which is what `kb register` used to write, so every
// codex registration since has been a file nothing reads. config.toml is
// hand-curated (enabled_tools, per-tool approval blocks) and there is no TOML
// parser here, so the block is printed rather than written.
describe('codex registration', () => {
  it('targets config.toml, writes nothing, and hands back the block to paste', () => {
    const homeDir = makeHome();
    const [result] = registerAgents(['codex'], homeDir);

    assert.strictEqual(result.path, join(homeDir, '.codex', 'config.toml'));
    assert.strictEqual(result.written, false);
    assert.strictEqual(result.manual, true);
    assert.strictEqual(result.snippet, codexRegistrationSnippet());
    assert.ok(!existsSync(join(homeDir, '.codex')), 'not even the directory');
    assert.ok(!existsSync(join(homeDir, '.codex', 'mcp.json')), 'the dead file must not come back');
  });

  it('leaves a hand-curated config.toml byte-for-byte alone, with or without --force', () => {
    const homeDir = makeHome();
    const path = join(homeDir, '.codex', 'config.toml');
    const curated = [
      '[mcp_servers.knowledge-base]',
      'command = "/old/node"',
      'enabled_tools = ["kb_search", "kb_read"]',
      '',
      '[mcp_servers.knowledge-base.tools.kb_write]',
      'approval_mode = "never"',
      '',
    ].join('\n');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, curated);

    registerAgents(['codex'], homeDir);
    registerAgents(['codex'], homeDir, { force: true });
    assert.strictEqual(readFileSync(path, 'utf8'), curated);
  });

  it('prints a block naming the shim, the checkout and a startup timeout', () => {
    const snippet = codexRegistrationSnippet();
    assert.match(snippet, /^\[mcp_servers\.knowledge-base\]$/m);
    assert.ok(snippet.includes(`command = ${JSON.stringify(stableNodePath())}`));
    assert.ok(snippet.includes(`args = [${JSON.stringify(KB_ENTRYPOINT_PATH)}, "mcp-shim"]`));
    assert.ok(snippet.includes(`cwd = ${JSON.stringify(join(KB_ENTRYPOINT_PATH, '..', '..'))}`));
    assert.match(snippet, /^startup_timeout_sec = 20\.0$/m);
    assert.match(snippet, /^\[mcp_servers\.knowledge-base\.env\]\nNODE_OPTIONS = ""$/m);
  });
});

// The registration outlives the shell that wrote it. A Homebrew Cellar path
// names one patch release, so the next upgrade deletes the runtime and the MCP
// server fails at spawn — before bin/kb.js, and before any re-exec logic in it.
it('registers a node path that survives a package upgrade', () => {
  const homeDir = makeHome();
  registerAgents(['claude'], homeDir);
  const config = JSON.parse(readFileSync(getAgentConfigPath('claude', homeDir), 'utf-8'));
  assert.doesNotMatch(config.mcpServers['knowledge-base'].command, /\/Cellar\/[^/]+\/[^/]+\//,
    'a version-pinned interpreter must not be written into a persisted registration');
});

// The command derives its target from wherever it was invoked, and a checkout
// is a thing people delete — a worktree pruned after its PR merges would take
// three agents' knowledge base down with it.
describe('registering from a second checkout', () => {
  function registeredPath(homeDir, agent = 'claude') {
    const config = JSON.parse(readFileSync(getAgentConfigPath(agent, homeDir), 'utf8'));
    return config.mcpServers['knowledge-base'].args[0];
  }

  function alreadyRegisteredElsewhere(homeDir, elsewhere = '/somewhere/else/worktrees/x/bin/kb.js') {
    registerAgents(['claude'], homeDir);
    const path = getAgentConfigPath('claude', homeDir);
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.mcpServers['knowledge-base'].args[0] = elsewhere;
    writeFileSync(path, JSON.stringify(config, null, 2));
    return elsewhere;
  }

  it('refuses to move a registration that points somewhere else', () => {
    const homeDir = makeHome();
    const elsewhere = alreadyRegisteredElsewhere(homeDir);

    const [result] = registerAgents(['claude'], homeDir);
    assert.strictEqual(result.written, false);
    assert.strictEqual(result.from, elsewhere);
    assert.strictEqual(result.to, KB_ENTRYPOINT_PATH);
    assert.strictEqual(registeredPath(homeDir), elsewhere, 'a refusal must not have written');
  });

  it('moves it when told to', () => {
    const homeDir = makeHome();
    alreadyRegisteredElsewhere(homeDir);
    const path = getAgentConfigPath('claude', homeDir);
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.mcpServers['knowledge-base'].env = { KB_REPO_ROOTS: '/workspace/repos' };
    writeFileSync(path, JSON.stringify(config, null, 2));

    const [result] = registerAgents(['claude'], homeDir, { force: true });
    assert.strictEqual(result.written, true);
    assert.strictEqual(registeredPath(homeDir), KB_ENTRYPOINT_PATH);
    assert.deepStrictEqual(
      JSON.parse(readFileSync(path, 'utf8')).mcpServers['knowledge-base'].env,
      { KB_REPO_ROOTS: '/workspace/repos', NODE_OPTIONS: '' },
    );
  });

  it('is idempotent from the checkout that already owns the config', () => {
    const homeDir = makeHome();
    registerAgents(['claude'], homeDir);

    const [result] = registerAgents(['claude'], homeDir);
    assert.strictEqual(result.written, true, 're-registering the same path is not a move');
    assert.strictEqual(registeredPath(homeDir), KB_ENTRYPOINT_PATH);
  });

  it('preserves existing MCP env while replacing inherited NODE_OPTIONS', () => {
    const homeDir = makeHome();
    registerAgents(['claude'], homeDir);
    const path = getAgentConfigPath('claude', homeDir);
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.mcpServers['knowledge-base'].env = {
      KB_REPO_ROOTS: '/workspace/repos',
      NODE_OPTIONS: '--require=/deleted/preload.cjs',
    };
    writeFileSync(path, JSON.stringify(config, null, 2));

    registerAgents(['claude'], homeDir);

    const updated = JSON.parse(readFileSync(path, 'utf8')).mcpServers['knowledge-base'];
    assert.deepStrictEqual(updated.env, {
      KB_REPO_ROOTS: '/workspace/repos',
      NODE_OPTIONS: '',
    });
  });

  it('reports an outcome for every agent asked for, so a refusal cannot pass for a write', () => {
    const homeDir = makeHome();
    alreadyRegisteredElsewhere(homeDir);

    const results = registerAgents(['claude', 'gemini', 'codex'], homeDir);
    assert.deepStrictEqual(results.map(r => [r.agent, r.written, r.manual ?? false]), [
      ['claude', false, false],
      ['gemini', true, false],
      ['codex', false, true],
    ]);
  });

  // Both were "empty config" before, so one bad parse rewrote ~/.claude.json as
  // nothing but our own entry, taking every project and setting in it.
  it('refuses a config file that does not parse, rather than replacing it', () => {
    const homeDir = makeHome();
    const path = getAgentConfigPath('claude', homeDir);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{"mcpServers": {"other": {}}, tru');

    assert.throws(() => registerAgents(['claude'], homeDir), /not valid JSON/);
    assert.strictEqual(readFileSync(path, 'utf8'), '{"mcpServers": {"other": {}}, tru');
  });
});

describe('Cursor workspace registration', () => {
  function cursorConfig(entrypoint = KB_ENTRYPOINT_PATH, extra = {}) {
    return {
      ...extra,
      mcpServers: {
        ...extra.mcpServers,
        'knowledge-base': {
          command: '/old/node',
          args: [entrypoint, 'mcp'],
          env: { PRESERVED: 'yes', NODE_OPTIONS: '--require=/old/preload.cjs' },
        },
      },
    };
  }

  function workspaceFixture() {
    const homeDir = makeHome();
    const workspace = join(homeDir, 'dev', 'workspace');
    const cwd = join(workspace, 'repos', 'service');
    mkdirSync(cwd, { recursive: true });
    return {
      homeDir,
      workspace,
      cwd,
      homePath: getAgentConfigPath('cursor', homeDir),
      workspacePath: join(workspace, '.cursor', 'mcp.json'),
    };
  }

  it('finds the nearest matching Cursor workspace config', () => {
    const { homeDir, workspace, cwd } = workspaceFixture();
    const outerPath = join(homeDir, 'dev', '.cursor', 'mcp.json');
    const nearestPath = join(workspace, '.cursor', 'mcp.json');
    writeJson(outerPath, cursorConfig());
    writeJson(nearestPath, cursorConfig());

    assert.strictEqual(findCursorWorkspaceConfig(cwd, homeDir), nearestPath);
  });

  it('skips a valid nearer config without a knowledge-base entry', () => {
    const { homeDir, workspace, cwd } = workspaceFixture();
    const matchingPath = join(homeDir, 'dev', '.cursor', 'mcp.json');
    writeJson(matchingPath, cursorConfig());
    writeJson(join(workspace, '.cursor', 'mcp.json'), {
      theme: 'dark',
      mcpServers: { foreign: { command: 'foreign' } },
    });

    assert.strictEqual(findCursorWorkspaceConfig(cwd, homeDir), matchingPath);
  });

  it('fails closed on a malformed workspace candidate before writing either target', () => {
    const { homeDir, cwd, homePath, workspacePath } = workspaceFixture();
    writeJson(homePath, cursorConfig());
    const homeConfig = readFileSync(homePath, 'utf8');
    mkdirSync(join(workspacePath, '..'), { recursive: true });
    const malformed = '{"mcpServers":{"knowledge-base":';
    writeFileSync(workspacePath, malformed);

    assert.throws(
      () => registerAgents(['cursor'], homeDir, { cwd }),
      /not valid JSON/,
    );
    assert.strictEqual(readFileSync(homePath, 'utf8'), homeConfig);
    assert.strictEqual(readFileSync(workspacePath, 'utf8'), malformed);
  });

  it('fails before writing another requested agent when Cursor discovery is malformed', () => {
    const { homeDir, cwd, workspacePath } = workspaceFixture();
    const claudePath = getAgentConfigPath('claude', homeDir);
    mkdirSync(join(workspacePath, '..'), { recursive: true });
    writeFileSync(workspacePath, '{"mcpServers":{"knowledge-base":');

    assert.throws(
      () => registerAgents(['claude', 'cursor'], homeDir, { cwd }),
      /cannot be safely inspected/,
    );
    assert.strictEqual(existsSync(claudePath), false);
  });

  it('rejects an array-shaped config root before writing any requested agent', () => {
    const { homeDir, cwd, workspacePath } = workspaceFixture();
    const claudePath = getAgentConfigPath('claude', homeDir);
    mkdirSync(join(workspacePath, '..'), { recursive: true });
    writeFileSync(workspacePath, '[]');

    assert.throws(
      () => registerAgents(['claude', 'cursor'], homeDir, { cwd }),
      err => err.message.includes(workspacePath)
        && /JSON object/.test(err.message)
        && /safely inspected/.test(err.message),
    );
    assert.strictEqual(existsSync(claudePath), false);
    assert.strictEqual(readFileSync(workspacePath, 'utf8'), '[]');
  });

  it('rejects an array-shaped mcpServers before writing any requested agent', () => {
    const { homeDir, cwd, workspacePath } = workspaceFixture();
    const claudePath = getAgentConfigPath('claude', homeDir);
    mkdirSync(join(workspacePath, '..'), { recursive: true });
    writeFileSync(workspacePath, '{"mcpServers":[]}');

    assert.throws(
      () => registerAgents(['claude', 'cursor'], homeDir, { cwd }),
      err => err.message.includes(workspacePath)
        && /mcpServers/.test(err.message)
        && /JSON object/.test(err.message)
        && /safely inspected/.test(err.message),
    );
    assert.strictEqual(existsSync(claudePath), false);
    assert.strictEqual(readFileSync(workspacePath, 'utf8'), '{"mcpServers":[]}');
  });

  it('does not inspect Cursor workspace config for other agents', () => {
    const { homeDir, cwd, workspacePath } = workspaceFixture();
    mkdirSync(join(workspacePath, '..'), { recursive: true });
    writeFileSync(workspacePath, '{"mcpServers":{"knowledge-base":');

    const [result] = registerAgents(['claude'], homeDir, { cwd });

    assert.strictEqual(result.written, true);
    assert.ok(existsSync(getAgentConfigPath('claude', homeDir)));
  });

  it('preserves both configs while synchronizing the Cursor registration', () => {
    const { homeDir, cwd, homePath, workspacePath } = workspaceFixture();
    const homeConfig = cursorConfig(KB_ENTRYPOINT_PATH, {
      editor: { fontSize: 14 },
      mcpServers: { homeOnly: { command: 'home' } },
    });
    homeConfig.mcpServers['knowledge-base'].type = 'stdio';
    homeConfig.mcpServers['knowledge-base'].disabled = true;
    writeJson(homePath, homeConfig);
    const workspaceConfig = cursorConfig(KB_ENTRYPOINT_PATH, {
      workspace: true,
      mcpServers: { workspaceOnly: { command: 'workspace' } },
    });
    workspaceConfig.mcpServers['knowledge-base'].type = 'stdio';
    workspaceConfig.mcpServers['knowledge-base'].disabled = true;
    writeJson(workspacePath, workspaceConfig);

    const results = registerAgents(['cursor'], homeDir, { cwd });

    assert.deepStrictEqual(results.map(result => result.path), [homePath, workspacePath]);
    for (const [path, topLevelKey, foreignServer] of [
      [homePath, 'editor', 'homeOnly'],
      [workspacePath, 'workspace', 'workspaceOnly'],
    ]) {
      const config = JSON.parse(readFileSync(path, 'utf8'));
      assert.ok(config[topLevelKey]);
      assert.ok(config.mcpServers[foreignServer]);
      assert.deepStrictEqual(config.mcpServers['knowledge-base'], {
        type: 'stdio',
        disabled: true,
        command: stableNodePath(),
        args: [KB_ENTRYPOINT_PATH, 'mcp-shim', '--agent=cursor'],
        env: { PRESERVED: 'yes', NODE_OPTIONS: '' },
      });
    }
  });

  it('is semantically idempotent across home and workspace configs', () => {
    const { homeDir, cwd, homePath, workspacePath } = workspaceFixture();
    writeJson(homePath, cursorConfig());
    writeJson(workspacePath, cursorConfig());
    registerAgents(['cursor'], homeDir, { cwd, force: true });
    const once = [homePath, workspacePath].map(path => JSON.parse(readFileSync(path, 'utf8')));

    registerAgents(['cursor'], homeDir, { cwd });
    const twice = [homePath, workspacePath].map(path => JSON.parse(readFileSync(path, 'utf8')));

    assert.deepStrictEqual(twice, once);
  });

  it('refuses both writes when either target belongs to another checkout', () => {
    const { homeDir, cwd, homePath, workspacePath } = workspaceFixture();
    writeJson(homePath, cursorConfig('/other/checkout/bin/kb.js'));
    writeJson(workspacePath, cursorConfig());
    const before = [homePath, workspacePath].map(path => readFileSync(path, 'utf8'));

    const results = registerAgents(['cursor'], homeDir, { cwd });

    assert.strictEqual(results.length, 2);
    assert.ok(results.every(result => result.written === false));
    assert.deepStrictEqual(
      [homePath, workspacePath].map(path => readFileSync(path, 'utf8')),
      before,
    );
  });

  it('refuses both writes when home is clean and the workspace belongs to another checkout', () => {
    const { homeDir, cwd, homePath, workspacePath } = workspaceFixture();
    writeJson(workspacePath, cursorConfig('/other/workspace/bin/kb.js'));
    const workspaceBefore = readFileSync(workspacePath, 'utf8');

    const results = registerAgents(['cursor'], homeDir, { cwd });

    assert.deepStrictEqual(results.map(result => [result.path, result.written, result.from]), [
      [homePath, false, null],
      [workspacePath, false, '/other/workspace/bin/kb.js'],
    ]);
    assert.strictEqual(existsSync(homePath), false);
    assert.strictEqual(readFileSync(workspacePath, 'utf8'), workspaceBefore);
  });

  it('rejects a workspace symlink before writing the home config', {
    skip: process.platform === 'win32',
  }, () => {
    const { homeDir, cwd, homePath, workspacePath } = workspaceFixture();
    writeJson(homePath, cursorConfig());
    const homeBefore = readFileSync(homePath, 'utf8');
    const target = join(homeDir, 'workspace-target.json');
    writeJson(target, cursorConfig());
    mkdirSync(join(workspacePath, '..'), { recursive: true });
    symlinkSync(target, workspacePath);

    assert.throws(
      () => registerAgents(['cursor'], homeDir, { cwd }),
      /symbolic link/,
    );
    assert.strictEqual(readFileSync(homePath, 'utf8'), homeBefore);
    assert.strictEqual(readFileSync(target, 'utf8'), JSON.stringify(cursorConfig(), null, 2));
  });

  it('leaves an earlier agent unchanged when the Cursor workspace is a symlink', {
    skip: process.platform === 'win32',
  }, () => {
    const { homeDir, cwd, homePath, workspacePath } = workspaceFixture();
    const claudePath = getAgentConfigPath('claude', homeDir);
    writeJson(claudePath, {
      mcpServers: {
        'knowledge-base': {
          command: '/old/node',
          args: [KB_ENTRYPOINT_PATH, 'mcp'],
        },
      },
    });
    writeJson(homePath, cursorConfig());
    const before = [claudePath, homePath].map(path => readFileSync(path, 'utf8'));
    const target = join(homeDir, 'workspace-target.json');
    writeJson(target, cursorConfig());
    const targetBefore = readFileSync(target, 'utf8');
    mkdirSync(join(workspacePath, '..'), { recursive: true });
    symlinkSync(target, workspacePath);

    assert.throws(
      () => registerAgents(['claude', 'cursor'], homeDir, { cwd }),
      /symbolic link/,
    );
    assert.deepStrictEqual(
      [claudePath, homePath].map(path => readFileSync(path, 'utf8')),
      before,
    );
    assert.strictEqual(readFileSync(target, 'utf8'), targetBefore);
  });

  it('leaves every agent unchanged when Cursor workspace staging is unwritable', {
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  }, () => {
    const { homeDir, cwd, homePath, workspacePath } = workspaceFixture();
    const claudePath = getAgentConfigPath('claude', homeDir);
    writeJson(claudePath, {
      mcpServers: {
        'knowledge-base': {
          command: '/old/node',
          args: [KB_ENTRYPOINT_PATH, 'mcp'],
        },
      },
    });
    writeJson(homePath, cursorConfig());
    writeJson(workspacePath, cursorConfig());
    const paths = [claudePath, homePath, workspacePath];
    const before = paths.map(path => readFileSync(path, 'utf8'));
    const workspaceConfigDir = join(workspacePath, '..');
    chmodSync(workspaceConfigDir, 0o500);
    try {
      assert.throws(
        () => registerAgents(['claude', 'cursor'], homeDir, { cwd }),
        /EACCES|permission denied/i,
      );
    } finally {
      chmodSync(workspaceConfigDir, 0o700);
    }
    assert.deepStrictEqual(
      paths.map(path => readFileSync(path, 'utf8')),
      before,
    );
  });

  it('rolls back every agent when the final Cursor commit fails', () => {
    const { homeDir, cwd, homePath, workspacePath } = workspaceFixture();
    const claudePath = getAgentConfigPath('claude', homeDir);
    writeJson(claudePath, {
      mcpServers: {
        'knowledge-base': {
          command: '/old/node',
          args: [KB_ENTRYPOINT_PATH, 'mcp'],
        },
      },
    });
    writeJson(homePath, cursorConfig());
    writeJson(workspacePath, cursorConfig());
    const paths = [claudePath, homePath, workspacePath];
    const before = paths.map(path => readFileSync(path, 'utf8'));
    let failed = false;

    assert.throws(
      () => registerAgents(['claude', 'cursor'], homeDir, {
        cwd,
        privateFileOptions: {
          rename(from, to) {
            if (!failed && to === workspacePath) {
              failed = true;
              throw new Error('injected final Cursor commit failure');
            }
            return renameSync(from, to);
          },
        },
      }),
      /injected final Cursor commit failure/,
    );
    assert.deepStrictEqual(
      paths.map(path => readFileSync(path, 'utf8')),
      before,
    );
  });

  it('force-updates both home and workspace registrations', () => {
    const { homeDir, cwd, homePath, workspacePath } = workspaceFixture();
    writeJson(homePath, cursorConfig('/other/home/bin/kb.js'));
    writeJson(workspacePath, cursorConfig('/other/workspace/bin/kb.js'));

    const results = registerAgents(['cursor'], homeDir, { cwd, force: true });

    assert.ok(results.every(result => result.written === true));
    for (const path of [homePath, workspacePath]) {
      assert.deepStrictEqual(
        JSON.parse(readFileSync(path, 'utf8')).mcpServers['knowledge-base'].args,
        [KB_ENTRYPOINT_PATH, 'mcp-shim', '--agent=cursor'],
      );
    }
  });

  it('CLI refusal output names both Cursor config paths', () => {
    const { homeDir, cwd, homePath, workspacePath } = workspaceFixture();
    writeJson(homePath, cursorConfig('/other/checkout/bin/kb.js'));
    writeJson(workspacePath, cursorConfig());
    const errors = [];
    const originalError = console.error;
    const originalExitCode = process.exitCode;
    console.error = (...parts) => errors.push(parts.join(' '));
    try {
      register(['--agents=cursor'], { homeDir, cwd });
    } finally {
      console.error = originalError;
      process.exitCode = originalExitCode;
    }

    const output = errors.join('\n');
    assert.ok(output.includes(homePath));
    assert.ok(output.includes(workspacePath));
  });
});

describe('setup MCP registration', () => {
  it('passes the effective cwd and reports every Cursor target', () => {
    const calls = [];
    const steps = registerSetupAgent('cursor', {
      homeDir: '/test/home',
      cwd: '/test/workspace/repo',
      register(agents, homeDir, options) {
        calls.push({ agents, homeDir, options });
        return [
          { agent: 'cursor', path: '/test/home/.cursor/mcp.json', written: true },
          {
            agent: 'cursor',
            path: '/test/workspace/.cursor/mcp.json',
            written: false,
            from: '/other/bin/kb.js',
          },
        ];
      },
    });

    assert.deepStrictEqual(calls, [{
      agents: ['cursor'],
      homeDir: '/test/home',
      options: { cwd: '/test/workspace/repo' },
    }]);
    assert.deepStrictEqual(steps, [
      { action: 'Registered MCP for cursor', path: '/test/home/.cursor/mcp.json' },
      {
        action: 'Refused to move the MCP registration for cursor',
        path: '/test/workspace/.cursor/mcp.json',
        error: "points at /other/bin/kb.js — re-register from that checkout, or 'kb register --force'",
      },
    ]);
  });

  it('preserves setup reporting for hand-managed Codex config', () => {
    const steps = registerSetupAgent('codex', {
      register: () => [{
        agent: 'codex',
        path: '/test/home/.codex/config.toml',
        manual: true,
        written: false,
      }],
    });

    assert.deepStrictEqual(steps, [{
      action: 'MCP config for codex is hand-managed — not written',
      path: '/test/home/.codex/config.toml',
      hint: "Run 'kb register --agents=codex' to print the block to paste",
    }]);
  });
});
