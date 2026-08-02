import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

function readInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getBusHome() {
  return process.env.KB_BUS_HOME || join(homedir(), '.claude', 'bus');
}

export function getBusDbPath() {
  return process.env.KB_BUS_DB_PATH || join(getBusHome(), 'bus.db');
}

export function getBusRetentionMessages() {
  return readInt('KB_BUS_RETENTION_MESSAGES', 200);
}

export function getBusPollMs() {
  return readInt('KB_BUS_POLL_MS', 250);
}

export function getBusResourceLimit() {
  return readInt('KB_BUS_RESOURCE_LIMIT', 50);
}

export function getBusNotifierIntervalMs() {
  return readInt('KB_BUS_NOTIFIER_INTERVAL_MS', 1000);
}

// 15 minutes of an unchanging digest. Safe to exit that early because hooks
// re-launch a notifier and refresh the digest on the very next prompt.
export function getBusNotifierIdleMs() {
  return readInt('KB_BUS_NOTIFIER_IDLE_MS', 900000);
}

// Any short alphabetic prefix, so this works unconfigured whatever a project
// calls its tickets. The prefix must start a path segment or a branch component:
// unanchored, this matches the tail of ordinary names ("kb-bus-test-12ab34" ->
// "test-12") and binds a channel nobody reads. A name that is genuinely
// ticket-shaped ("node-22") still matches; set KB_TICKET_REGEX when that matters.
// Capturing only the digits keeps ticket and channel distinct, as before.
const DEFAULT_TICKET_RE = /(?<=^|[/_])[a-z]{2,6}-(\d+)/i;
let ticketRegexWarned = false;

// Read at use time; invalid pattern warns once then falls back to default.
export function getTicketRegex() {
  const pattern = (process.env.KB_TICKET_REGEX || '').trim();
  if (!pattern) return DEFAULT_TICKET_RE;
  try {
    return new RegExp(pattern, 'i');
  } catch (err) {
    if (!ticketRegexWarned) {
      console.error(`kb: invalid KB_TICKET_REGEX ${JSON.stringify(pattern)} (${err.message}); using default ${DEFAULT_TICKET_RE}`);
      ticketRegexWarned = true;
    }
    return DEFAULT_TICKET_RE;
  }
}

export function ensureBusStorage() {
  mkdirSync(dirname(getBusDbPath()), { recursive: true });
}
