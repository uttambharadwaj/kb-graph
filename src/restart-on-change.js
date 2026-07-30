import { execFileSync } from 'child_process';
import { existsSync, readFileSync, watch } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
// predicates.json is read once at import like any module, so it is source for
// reload purposes. kb stale-servers imports this to stay on the same definition.
export const SOURCE_FILE = /\.(js|mjs|cjs|json)$/;
const DEBOUNCE_MS = 1000;
const IDLE_POLL_MS = 250;

// Half-written files parse as garbage, so a `git checkout` caught mid-flight
// would otherwise exit every live server into a broken tree. Deleted files are
// filtered out before this runs; a failure here means "wait", not "give up".
function parses(file) {
  try {
    // `node --check` treats JSON as JS and rejects it, so json needs its own gate.
    if (file.endsWith('.json')) JSON.parse(readFileSync(file, 'utf8'));
    else execFileSync(process.execPath, ['--check', file], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Call `onChange` when the server's own source changes and nothing is in
 * flight, so the running code can be replaced with what is on disk.
 *
 * A stdio MCP server serves the code it was spawned with, forever: Node caches
 * every module at import, so a fix reaches a running session only when the
 * process holding it is replaced. Who does the replacing is the caller's
 * business — mcp-supervisor.js swaps a child process underneath a connection it
 * keeps open, while a server run directly exits and is reconnected by hand.
 *
 * Never fires mid-tool-call: `isBusy` gates it, and a pending change waits.
 * Returns the watcher, or null where recursive watch is unavailable.
 */
export function restartOnSourceChange({
  isBusy,
  onChange,
  dir = SRC_DIR,
  debounceMs = DEBOUNCE_MS,
  idlePollMs = IDLE_POLL_MS,
}) {
  const changed = new Set();
  let timer = null;

  const fireWhenIdle = () => {
    if (!isBusy()) return onChange();
    timer = setTimeout(fireWhenIdle, idlePollMs);
    timer.unref();
  };

  const settled = () => {
    const files = [...changed].map((f) => join(dir, f)).filter(existsSync);
    changed.clear();
    if (files.every(parses)) fireWhenIdle();
  };

  try {
    const watcher = watch(dir, { recursive: true }, (_event, file) => {
      // Skips a `node --check` fork per README/JSON write. Not a correctness
      // gate — `parses` rejects anything else anyway, extension included.
      if (!SOURCE_FILE.test(file ?? '')) return;
      changed.add(file);
      clearTimeout(timer);
      timer = setTimeout(settled, debounceMs);
      timer.unref();
    });
    watcher.unref();
    return watcher;
  } catch (err) {
    // Recursive watch is unavailable on Node 18 + Linux. Degrading to the old
    // reconnect-by-hand behaviour is fine; doing it silently is not.
    console.error('[KB] source watch unavailable, /mcp is needed to pick up changes:', err.message);
    return null;
  }
}
