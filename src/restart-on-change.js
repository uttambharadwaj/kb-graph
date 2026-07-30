import { execFileSync } from 'child_process';
import { existsSync, watch } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_FILE = /\.(js|mjs|cjs)$/;
const DEBOUNCE_MS = 1000;
const IDLE_POLL_MS = 250;

// Half-written files parse as garbage, so a `git checkout` caught mid-flight
// would otherwise exit every live server into a broken tree. Deleted files are
// filtered out before this runs; a failure here means "wait", not "give up".
function parses(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Exit when the server's own source changes, so the next tool call gets a
 * process running the new code.
 *
 * A stdio MCP server serves the code it was spawned with, forever: Node caches
 * every module at import, so a fix reaches a running session only when someone
 * reconnects by hand. The client, though, respawns a dead stdio server
 * transparently on the next tool call. So exiting *is* the reload, and it picks
 * up renamed tools and changed schemas too, which swapping handlers in place
 * cannot.
 *
 * Never exits mid-tool-call: `isBusy` gates it, and a pending restart waits.
 * Returns the watcher, or null where recursive watch is unavailable.
 */
export function restartOnSourceChange({
  isBusy,
  exit = () => process.exit(0),
  dir = SRC_DIR,
  debounceMs = DEBOUNCE_MS,
  idlePollMs = IDLE_POLL_MS,
}) {
  const changed = new Set();
  let timer = null;

  const exitWhenIdle = () => {
    if (!isBusy()) return exit();
    timer = setTimeout(exitWhenIdle, idlePollMs);
    timer.unref();
  };

  const settled = () => {
    const files = [...changed].map((f) => join(dir, f)).filter(existsSync);
    changed.clear();
    if (files.every(parses)) exitWhenIdle();
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
