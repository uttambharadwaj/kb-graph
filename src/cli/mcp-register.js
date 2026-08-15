import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { stableNodePath } from './runtime-node.js';
import { fileURLToPath } from 'url';

export const SUPPORTED_AGENTS = ['claude', 'codex', 'gemini'];
export const KB_MCP_SERVER_NAME = 'knowledge-base';
export const KB_ENTRYPOINT_PATH = fileURLToPath(new URL('../../bin/kb.js', import.meta.url));
export const KB_MCP_SERVER_CONFIG = {
  command: stableNodePath(),
  // mcp-shim connects to the resident `kb serve` daemon when one is running
  // and falls back to a full in-process server when none is — so this default
  // is correct whether or not the machine has the daemon set up.
  args: [KB_ENTRYPOINT_PATH, 'mcp-shim'],
};

// Absent and unreadable are different answers. Treating both as "empty config"
// means one bad parse rewrites the file as nothing but our own entry, and
// ~/.claude.json holds the user's whole Claude Code configuration.
function readJson(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${err.message}). Refusing to overwrite it.`);
  }
}

export function getAgentConfigPath(agent, homeDir = homedir()) {
  if (agent === 'claude') return join(homeDir, '.claude.json');
  if (agent === 'codex') return join(homeDir, '.codex', 'mcp.json');
  if (agent === 'gemini') return join(homeDir, '.gemini', 'mcp.json');
  throw new Error(`Unsupported agent: ${agent}`);
}

export function parseRegisterArgs(args = []) {
  const flag = args.find(arg => arg.startsWith('--agents='));
  if (!flag) return [...SUPPORTED_AGENTS];

  const agents = flag
    .split('=')
    .slice(1)
    .join('=')
    .split(',')
    .map(agent => agent.trim().toLowerCase())
    .filter(Boolean);

  const invalid = agents.filter(agent => !SUPPORTED_AGENTS.includes(agent));
  if (invalid.length > 0) {
    throw new Error(`Unsupported agent(s): ${invalid.join(', ')}. Supported: ${SUPPORTED_AGENTS.join(', ')}`);
  }
  if (agents.length === 0) {
    throw new Error('No agents provided. Example: kb register --agents=claude,codex');
  }
  return [...new Set(agents)];
}

// Where a config currently points, or null if this agent has no registration
// yet. The entrypoint is the whole question: everything else in the entry is
// derived from it.
function registeredEntrypoint(config) {
  const args = config?.mcpServers?.[KB_MCP_SERVER_NAME]?.args;
  return Array.isArray(args) ? args[0] ?? null : null;
}

/**
 * Registering is idempotent from the checkout that already owns the config, and
 * refuses from any other one.
 *
 * The command derives its target from wherever it was invoked, so running it
 * from a second checkout silently repoints every agent at that copy — and a
 * checkout is a thing people delete. A worktree pruned after its pull request
 * merges would take three agents' knowledge base down with it, with the cause a
 * long way from the symptom.
 *
 * Every agent comes back with an outcome, so a caller cannot mistake a refusal
 * for a write it simply didn't look at.
 */
export function registerAgents(agents, homeDir = homedir(), { force = false } = {}) {
  return agents.map(agent => {
    const path = getAgentConfigPath(agent, homeDir);
    const config = readJson(path);
    const from = registeredEntrypoint(config);
    if (from !== null && from !== KB_ENTRYPOINT_PATH && !force) {
      return { agent, path, written: false, from, to: KB_ENTRYPOINT_PATH };
    }

    mkdirSync(join(path, '..'), { recursive: true });
    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers[KB_MCP_SERVER_NAME] = KB_MCP_SERVER_CONFIG;
    writeFileSync(path, JSON.stringify(config, null, 2));
    return { agent, path, written: true, from, to: KB_ENTRYPOINT_PATH };
  });
}
