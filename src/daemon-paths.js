// Socket path constants, split out of daemon.js so they can be imported by
// trigger-hook.js's cold path (bin/kb-trigger-hook.js, ~227 calls/session)
// without pulling in daemon.js -> mcp-factory.js -> db.js. daemon.js
// re-exports both for existing importers (serve.js, mcp-shim.js).
import { join } from 'path';
import { KB_DIR } from './paths.js';

export const DAEMON_SOCKET_PATH = join(KB_DIR, 'daemon.sock');

// Second socket, separate from the MCP one: line-delimited JSON request/response
// for hook fast-path ops (prompt-hint, trigger-hook, wakeup-hook), so the public
// MCP tool surface stays unpolluted by internal hook plumbing.
export const CONTROL_SOCKET_PATH = join(KB_DIR, 'daemon-ctl.sock');
