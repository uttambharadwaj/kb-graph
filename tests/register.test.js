import { afterEach, describe, it } from 'node:test';
import { stableNodePath } from '../src/cli/runtime-node.js';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  codexRegistrationSnippet,
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

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('MCP registration', () => {
  it('defaults to all supported agents', () => {
    assert.deepStrictEqual(parseRegisterArgs([]), ['claude', 'codex', 'gemini']);
  });

  it('parses an explicit agent subset', () => {
    assert.deepStrictEqual(parseRegisterArgs(['--agents=claude,codex,claude']), ['claude', 'codex']);
  });

  it('rejects unsupported agents', () => {
    assert.throws(() => parseRegisterArgs(['--agents=claude,foo']), /Unsupported agent/);
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

    const [result] = registerAgents(['claude'], homeDir, { force: true });
    assert.strictEqual(result.written, true);
    assert.strictEqual(registeredPath(homeDir), KB_ENTRYPOINT_PATH);
  });

  it('is idempotent from the checkout that already owns the config', () => {
    const homeDir = makeHome();
    registerAgents(['claude'], homeDir);

    const [result] = registerAgents(['claude'], homeDir);
    assert.strictEqual(result.written, true, 're-registering the same path is not a move');
    assert.strictEqual(registeredPath(homeDir), KB_ENTRYPOINT_PATH);
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
