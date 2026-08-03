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

// Homebrew keeps a versioned Cellar directory plus an `opt` symlink that
// follows upgrades. Writing the Cellar path into a job, hook or MCP
// registration pins it to one patch release, and the next `brew upgrade`
// deletes that directory out from under every one of them in the same hour —
// the MCP server fails at spawn, before any of this file can run and re-exec.
//
// Not hypothetical: the bus Stop hook on the machine this was found on pins
// node@22/22.21.1_4, which no longer exists, and has been a silent no-op since.
const CELLAR_PATH = /^(?<prefix>.*)\/Cellar\/(?<pkg>[^/]+)\/[^/]+\/(?<rest>.+)$/;

// One owner for "this path names a single package version". The hook check asks
// the same question about paths it did not produce, and two spellings of it
// would drift into disagreeing about what is safe.
export const isVersionPinned = (path) => CELLAR_PATH.test(path);

export function stableNodePath(execPath = process.execPath, { exists = existsSync, resolve = realpathSync } = {}) {
  const cellar = CELLAR_PATH.exec(execPath);
  if (!cellar) return execPath;
  const { prefix, pkg, rest } = cellar.groups;
  const stable = `${prefix}/opt/${pkg}/${rest}`;
  try {
    // Same binary, or nothing: an opt symlink pointing at a different version
    // would quietly move every artifact onto a runtime nobody chose.
    if (exists(stable) && resolve(stable) === resolve(execPath)) return stable;
  } catch { /* unreadable link — the literal path is the safe answer */ }
  return execPath;
}
