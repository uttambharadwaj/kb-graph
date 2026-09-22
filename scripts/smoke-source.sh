#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/kb source smoke.XXXXXX")"

cleanup() {
  local status=$?
  if (( status != 0 )); then
    for log in setup status; do
      if [[ -s "$TMP/$log.log" ]]; then
        printf '%s\n' "--- $log output ---" >&2
        cat "$TMP/$log.log" >&2
      fi
    done
  fi
  rm -rf "$TMP"
  return "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$TMP/home" "$TMP/state" "$TMP/vault"
HOME="$(cd "$TMP/home" && pwd -P)"
KB_DIR="$(cd "$TMP/state" && pwd -P)"
VAULT="$(cd "$TMP/vault" && pwd -P)"
export HOME KB_DIR
export KB_EMBEDDING_CACHE_DIR="$TMP/embedding-cache"

cd "$ROOT"
node bin/kb.js --help >/dev/null
node bin/kb.js setup --auto \
  --agents=claude \
  --deploy=manual \
  --host=127.0.0.1 \
  --port=3838 \
  --password=source-smoke-password \
  --vault="$VAULT" >"$TMP/setup.log"
node bin/kb.js status >"$TMP/status.log"

node --input-type=module - \
  "$TMP/setup.log" \
  "$TMP/status.log" \
  "$KB_DIR/.env" \
  "$HOME" \
  "$KB_DIR" \
  "$VAULT" \
  "$KB_EMBEDDING_CACHE_DIR" \
  "$ROOT" <<'NODE'
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const [
  setupLogPath,
  statusLogPath,
  envPath,
  home,
  kbDir,
  vault,
  embeddingCache,
  root,
] = process.argv.slice(2);
const setupLog = readFileSync(setupLogPath, 'utf8');
const statusLog = readFileSync(statusLogPath, 'utf8');
const env = readFileSync(envPath, 'utf8');

assert.match(setupLog, /Setup Complete/);
const ingestPrefix = '2. Run: node bin/kb.js ingest ';
const ingestLine = setupLog.split('\n').find(line => line.trimStart().startsWith(ingestPrefix));
const quotedVault = `'${vault.replaceAll("'", "'\"'\"'")}'`;
assert.ok(ingestLine, 'setup did not print an ingest command');
assert.ok(
  [vault, quotedVault].includes(ingestLine.trimStart().slice(ingestPrefix.length)),
  'setup printed an unusable ingest path',
);
assert.match(setupLog, /Run: node bin\/kb\.js start/);
assert.match(setupLog, /Skipped scheduled jobs for custom KB_DIR/);
assert.match(setupLog, /Registered MCP for claude/);
assert.match(setupLog, /Installed Claude Code hooks/);
assert.match(statusLog, /Knowledge Base Status/);
assert.match(statusLog, /Server: stopped/);
assert.match(statusLog, /Documents: 0/);
assert.ok(env.split('\n').includes(`OBSIDIAN_VAULT_PATH=${vault}`));

const claudeConfigPath = join(home, '.claude.json');
const claudeHooksPath = join(home, '.claude', 'settings.json');
const installedPaths = [
  claudeConfigPath,
  claudeHooksPath,
  join(home, '.claude', 'skills', 'debrief', 'SKILL.md'),
  join(home, '.claude', 'skills', 'kb-workflow', 'SKILL.md'),
];
for (const path of installedPaths) {
  assert.ok(resolve(path).startsWith(`${resolve(home)}${sep}`), `${path} escaped the sandbox`);
  assert.ok(existsSync(path), `${path} was not installed`);
}
const claudeConfig = JSON.parse(readFileSync(claudeConfigPath, 'utf8'));
assert.equal(
  claudeConfig.mcpServers['knowledge-base'].args[0],
  join(root, 'bin', 'kb.js'),
);
assert.equal(claudeConfig.mcpServers['knowledge-base'].env.KB_DIR, kbDir);
const claudeHooks = readFileSync(claudeHooksPath, 'utf8');
assert.ok(claudeHooks.includes(join(root, 'bin', 'kb.js')));
assert.ok(claudeHooks.includes(kbDir));

assert.ok(existsSync(join(kbDir, 'kb.db')), 'status did not initialize the database');
assert.ok(!existsSync(join(home, '.knowledge-base')), 'default KB directory was touched');
assert.ok(!existsSync(join(home, '.cursor')), 'Cursor config was touched');
assert.ok(!existsSync(join(root, '.cursor', 'mcp.json')), 'Cursor workspace config was touched');
assert.ok(!existsSync(join(home, '.config', 'systemd')), 'systemd config was touched');
assert.ok(!existsSync(join(home, 'Library', 'LaunchAgents')), 'launchd config was touched');
assert.ok(!existsSync(embeddingCache), 'embedding model was downloaded');
NODE

echo "source setup smoke passed"
