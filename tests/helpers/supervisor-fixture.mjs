// Entry point for the end-to-end supervisor tests. The real SDK client spawns
// this over a real pipe, so the supervisor is exercised as a process rather
// than as a function with fake streams.
import { superviseMcpServer } from '../../src/mcp-supervisor.js';

superviseMcpServer({
  childCommand: [process.env.KB_TEST_CHILD],
  watchDir: process.env.KB_TEST_WATCH_DIR,
  debounceMs: 20,
  idlePollMs: 10,
  migrationRecheckMs: Number(process.env.KB_TEST_RECHECK_MS) || undefined,
});
