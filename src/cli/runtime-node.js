import { existsSync, readFileSync, realpathSync } from 'fs';
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

const KB_SERVER_NAME = 'knowledge-base';
const KB_SKIP_NODE_REEXEC_ENV = 'KB_SKIP_NODE_REEXEC';
const KB_ENTRYPOINT_SUFFIX = `${join('bin', 'kb.js')}`;
const KB_CONFIG_PATHS = [
  ['.claude.json'],
  ['.codex', 'mcp.json'],
  ['.gemini', 'mcp.json'],
];

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function normalizePath(path) {
  if (!path || !existsSync(path)) return path;
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isKnowledgeBaseEntrypoint(config) {
  return Boolean(
    config &&
    typeof config.command === 'string' &&
    Array.isArray(config.args) &&
    typeof config.args[0] === 'string' &&
    normalizePath(config.args[0])?.endsWith(KB_ENTRYPOINT_SUFFIX)
  );
}

export function findPreferredKnowledgeBaseNode(homeDir = homedir()) {
  for (const pathParts of KB_CONFIG_PATHS) {
    const config = readJson(join(homeDir, ...pathParts));
    const server = config?.mcpServers?.[KB_SERVER_NAME];
    if (!isKnowledgeBaseEntrypoint(server)) continue;
    return server.command;
  }
  return null;
}

export function shouldReexecWithPreferredNode(preferredNode, currentNode = process.execPath) {
  if (!preferredNode) return false;
  return normalizePath(preferredNode) !== normalizePath(currentNode);
}

export async function lockPreferredNodeRuntime(scriptUrl, homeDir = homedir()) {
  if (process.env[KB_SKIP_NODE_REEXEC_ENV] === '1') return;

  const preferredNode = findPreferredKnowledgeBaseNode(homeDir);
  if (!shouldReexecWithPreferredNode(preferredNode)) return;

  const scriptPath = fileURLToPath(scriptUrl);
  const result = spawnSync(preferredNode, [scriptPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, [KB_SKIP_NODE_REEXEC_ENV]: '1' },
  });

  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
