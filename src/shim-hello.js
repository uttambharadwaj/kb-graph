// The one line `kb mcp-shim` writes before any JSON-RPC: which harness owns
// this connection. The daemon is a launchd child, so its own ancestry walk
// names launchd and nothing else — every MCP-surface retrieval it logged
// after the cutover carried session=NULL and agent=NULL. The shim IS a child
// of the harness, so it is the only process in the chain that can answer,
// and the connection is the only place the answer can live (one daemon,
// many concurrent harnesses).
//
// Both sides of that line are spelled here so the shape cannot drift: the
// shim encodes, the daemon parses, nobody restates the key.
import { AGENTS } from './process-ancestry.js';

// Deliberately not a JSON-RPC method name: the daemon must be able to tell
// this from the first line of a client that speaks straight JSON-RPC (an
// older shim, `kb serve --status`, the liveness probe), and a message the
// MCP SDK would recognize is exactly what that client sends.
export const HELLO_KEY = 'kb_shim_hello';
export const HELLO_VERSION = 1;

// The hello is ~120 bytes. The bound is not about the hello — it is the point
// past which a first line with no newline in it is declared NOT a hello, so a
// client that opens with a large JSON-RPC message (or never sends a newline
// at all) cannot grow the daemon's pre-transport buffer without limit. Being
// declared not-a-hello costs nothing: those bytes are handed to the transport
// untouched.
export const MAX_HELLO_LINE_BYTES = 8 * 1024;

/**
 * @param {{harnessPid?: number|null, pidStart?: string|null, agent?: string|null}} ancestry
 *   Field names match resolveHarnessAncestry's return shape — the shim passes
 *   its result straight through.
 * @returns {string} one newline-terminated line, ready to write to the socket.
 */
export function encodeHello({ harnessPid = null, pidStart = null, agent = null } = {}) {
  return `${JSON.stringify({ [HELLO_KEY]: HELLO_VERSION, harnessPid, pidStart, agent })}\n`;
}

/**
 * The identity a hello line carries, or null if the line is not a hello.
 *
 * Every field is re-validated rather than trusted: a malformed field must
 * degrade to NULL (identity unverifiable, same as today) instead of putting a
 * bad pid into a session-map lookup or an unknown string into the agent
 * column, which the reports read as a bucket name.
 *
 * @param {string} line one line, newline already stripped
 * @returns {{harnessPid: number|null, pidStart: string|null, agent: string|null}|null}
 */
export function parseHelloLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || parsed[HELLO_KEY] !== HELLO_VERSION) return null;
  return {
    harnessPid: Number.isInteger(parsed.harnessPid) && parsed.harnessPid > 0 ? parsed.harnessPid : null,
    pidStart: typeof parsed.pidStart === 'string' && parsed.pidStart ? parsed.pidStart : null,
    agent: AGENTS.includes(parsed.agent) ? parsed.agent : null,
  };
}
