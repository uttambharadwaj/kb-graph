#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/kb-graph-smoke.XXXXXX")"
SERVER_PID=""

cleanup() {
  local status=$?
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if (( status != 0 )) && [[ -s "$TMP/server.log" ]]; then
    cat "$TMP/server.log" >&2
  fi
  rm -rf "$TMP"
  return "$status"
}
trap cleanup EXIT HUP INT TERM

if (( $# > 1 )); then
  echo "usage: $0 [tarball-path-or-registry-spec]" >&2
  exit 2
fi

mkdir -p "$TMP/pack" "$TMP/home" "$TMP/state" "$TMP/vault" "$TMP/prefix" "$TMP/npm-cache"
touch "$TMP/npmrc"

if (( $# == 1 )); then
  SPEC="$1"
else
  npm pack "$ROOT" \
    --ignore-scripts \
    --json \
    --pack-destination "$TMP/pack" \
    --userconfig "$TMP/npmrc" >"$TMP/pack.json"
  FILENAME="$(node -e \
    "const fs=require('fs'); console.log(JSON.parse(fs.readFileSync(process.argv[1], 'utf8'))[0].filename)" \
    "$TMP/pack.json")"
  SPEC="$TMP/pack/$FILENAME"
fi

export HOME="$TMP/home"
export KB_DIR
KB_DIR="$(cd "$TMP/state" && pwd -P)"
export npm_config_audit=false
export npm_config_cache="$TMP/npm-cache"
export npm_config_fund=false
export npm_config_prefix="$TMP/prefix"
export npm_config_userconfig="$TMP/npmrc"
export PATH="$TMP/prefix/bin:$PATH"
export KB_SMOKE_PORT
KB_SMOKE_PORT="$(node -e \
  "const net=require('net'); const s=net.createServer(); s.listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); })")"

npm install --global --prefix "$TMP/prefix" --userconfig "$TMP/npmrc" "$SPEC"

KB_BIN="$TMP/prefix/bin/kb"
PACKAGE_ROOT="$(node -e \
  "const {dirname}=require('path'); const {realpathSync}=require('fs'); console.log(dirname(dirname(realpathSync(process.argv[1]))))" \
  "$KB_BIN")"

cd "$TMP"
kb --help >/dev/null
kb setup --auto --no-load-jobs \
  --agents=cursor \
  --deploy=manual \
  --host=127.0.0.1 \
  --port="$KB_SMOKE_PORT" \
  --password=smoke-password \
  --vault="$TMP/vault" >"$TMP/setup-first.log"

node --input-type=module - "$TMP/state/.env" "$TMP/secrets.json" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const values = Object.fromEntries(
  readFileSync(process.argv[2], 'utf8')
    .split('\n')
    .map(line => line.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map(([, key, value]) => [key, value]),
);
writeFileSync(
  process.argv[3],
  JSON.stringify({
    password: values.KB_PASSWORD,
    authSecret: values.BETTER_AUTH_SECRET,
    cursorKey: values.KB_API_KEY_CURSOR,
  }),
);
NODE

mkdir -p "$KB_DIR/models"
touch "$KB_DIR/models/upgrade-sentinel"
npm install --global --prefix "$TMP/prefix" --userconfig "$TMP/npmrc" "$SPEC" >/dev/null
test -f "$KB_DIR/.env"
test -f "$KB_DIR/models/upgrade-sentinel"

kb setup --auto --no-load-jobs \
  --agents=cursor \
  --deploy=manual \
  --host=127.0.0.1 \
  --port="$KB_SMOKE_PORT" \
  --vault="$TMP/vault" >"$TMP/setup-second.log"

node --input-type=module - \
  "$TMP/state/.env" \
  "$TMP/secrets.json" \
  "$HOME/.cursor/mcp.json" \
  "$HOME/.cursor/hooks.json" \
  "$PACKAGE_ROOT" <<'NODE'
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [envPath, secretPath, mcpPath, hooksPath, packageRoot] = process.argv.slice(2);
const values = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .map(line => line.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map(([, key, value]) => [key, value]),
);
const before = JSON.parse(readFileSync(secretPath, 'utf8'));
assert.deepEqual({
  password: values.KB_PASSWORD,
  authSecret: values.BETTER_AUTH_SECRET,
  cursorKey: values.KB_API_KEY_CURSOR,
}, before, 'setup rotated an existing secret');

const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
assert.equal(
  mcp.mcpServers['knowledge-base'].args[0],
  join(packageRoot, 'bin', 'kb.js'),
);
assert.equal(mcp.mcpServers['knowledge-base'].env.KB_DIR, process.env.KB_DIR);
const hooks = readFileSync(hooksPath, 'utf8');
assert.match(hooks, new RegExp(
  join(packageRoot, 'bin', 'kb.js').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
));
assert.ok(hooks.includes(`KB_DIR='${process.env.KB_DIR}'`));
const jobPath = process.platform === 'darwin'
  ? join(process.env.HOME, 'Library', 'LaunchAgents', 'com.kb.harvest.plist')
  : join(process.env.HOME, '.config', 'systemd', 'user', 'kb-harvest.service');
assert.ok(readFileSync(jobPath, 'utf8').includes(process.env.KB_DIR));
assert.ok(existsSync(join(process.env.HOME, '.claude', 'skills', 'debrief', 'SKILL.md')));
assert.ok(existsSync(join(process.env.HOME, '.claude', 'skills', 'kb-workflow', 'SKILL.md')));
assert.ok(existsSync(join(packageRoot, 'openapi.json')));
assert.ok(existsSync(join(packageRoot, 'src', 'public', 'index.html')));
assert.ok(!existsSync(join(packageRoot, '.env')));
NODE

kb migrate >/dev/null
kb status >/dev/null

kb start >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';

let lastError;
for (let attempt = 0; attempt < 50; attempt += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.KB_SMOKE_PORT}/openapi.json`);
    assert.equal(response.status, 200);
    const spec = await response.json();
    assert.equal(spec.openapi, '3.1.0');
    process.exit(0);
  } catch (error) {
    lastError = error;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
throw lastError;
NODE

kill "$SERVER_PID"
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

test -f "$KB_DIR/auth.db"
test ! -e "$HOME/.knowledge-base"

echo "tarball smoke passed: $SPEC"
