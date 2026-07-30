import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { restartOnSourceChange } from './restart-on-change.js';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'mcp.js');
const IDLE_POLL_MS = 250;
// Taken from the client's own default rather than restated: past its timeout a
// request will never be awaited, and counting it as in-flight would block every
// reload. A copy would drift silently the first time the SDK changed it.
const REQUEST_TTL_MS = DEFAULT_REQUEST_TIMEOUT_MSEC;
// Consecutive children that died without answering anything. Past this the tree
// is broken rather than flaky, and respawning just burns the machine.
const MAX_BOOT_FAILURES = 3;
const SERVER_ERROR = -32000;
const PARKED_MESSAGE = 'knowledge-base server is not running; it restarts when its source changes';

const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

const isRequest = (msg) => msg?.id !== undefined && msg?.method !== undefined;

/**
 * Split a stream into JSON-RPC lines, discarding an unterminated tail.
 *
 * Not readline: it hands over the trailing partial as an ordinary 'line' when
 * the stream closes, so a reply cut short by a dying child would reach the
 * client as truncated JSON.
 */
function onLines(stream, handle) {
  let tail = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const lines = (tail + chunk).split('\n');
    tail = lines.pop();
    for (const line of lines) if (line.trim()) handle(line);
  });
  stream.on('close', () => {
    if (tail.trim()) console.error(`[KB] dropped ${tail.length} bytes of an unterminated message`);
    tail = '';
  });
}

/**
 * Run the MCP server as a child process and replace it when src/ changes,
 * without ever closing the connection the client holds.
 *
 * Node caches every module at import, so a server serves the code it started
 * with forever. The predecessor solved that by exiting on change, on the belief
 * that the client respawns a dead stdio server. Claude Code does not: the tools
 * vanish until someone types /mcp, which is the interruption the reload existed
 * to remove. The pipe the client holds belongs to this process, so keeping it
 * open across a child swap makes the reload invisible; replaying the recorded
 * handshake is what makes the new child a continuation rather than a stranger.
 *
 * Two things do not survive: a change to this file or to the watcher (only the
 * child is replaced), and a change to the server's declared capabilities or
 * protocol version, which are pinned by the first child's initialize response.
 * Both still need a real reconnect.
 */
export function superviseMcpServer({
  stdin = process.stdin,
  stdout = process.stdout,
  childCommand = [SERVER],
  watchDir,
  debounceMs,
  idlePollMs = IDLE_POLL_MS,
  now = Date.now,
} = {}) {
  const pending = new Map(); // client request id -> when it was forwarded
  const queued = []; // client traffic held while a child comes up
  const warned = new Set();
  let handshake = null; // { initialize, id, initialized } replayed into every child
  let child = null;
  let swapping = false;
  let awaitingInit = false;
  let dirty = false; // source changed while a swap was already running
  let parked = false;
  let bootFailures = 0;

  const send = (msg) => stdout.write(JSON.stringify(msg) + '\n');
  const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: SERVER_ERROR, message } });
  const warnOnce = (key, message) => {
    if (warned.has(key)) return;
    warned.add(key);
    console.error(`[KB] ${message}`);
  };

  // Prunes as it counts: a request the client has already given up on must not
  // hold the reload open forever.
  const isBusy = () => {
    for (const [id, at] of pending) if (now() - at > REQUEST_TTL_MS) pending.delete(id);
    return pending.size > 0;
  };

  const failEverything = (message) => {
    queued.length = 0; // every queued request is already counted in `pending`
    for (const id of pending.keys()) fail(id, message);
    pending.clear();
  };

  const fromChild = (line) => {
    const msg = parse(line);
    // A library that console.logs to stdout would otherwise reach the client as
    // a protocol violation and take the session down.
    if (!msg) {
      warnOnce('non-json', `dropped non-JSON server output: ${line.slice(0, 120)}`);
      return;
    }
    if (isRequest(msg)) {
      // Each side numbers its own requests from zero, so a server-initiated id
      // issued before a swap is indistinguishable from one issued after, and a
      // late client response could land on the wrong request. No code path
      // reaches this today; it is here so adding one is not silent.
      warnOnce('server-request', 'the server sent a request to the client — those ids do not survive a reload');
    }
    if (msg.id !== undefined && msg.method === undefined) {
      pending.delete(msg.id);
      bootFailures = 0; // it answered something, so it booted
    }
    if (awaitingInit) {
      awaitingInit = false;
      if (msg.id !== handshake.id) {
        warnOnce('init-id', `replayed initialize answered with id ${JSON.stringify(msg.id)}, expected ${JSON.stringify(handshake.id)}`);
      }
      if (handshake.initialized) child.stdin.write(`${handshake.initialized}\n`);
      finishSwap();
      return; // the client already has an initialize response; this one is a duplicate
    }
    stdout.write(`${line}\n`);
  };

  const spawnChild = () => {
    const started = spawn(process.execPath, childCommand, {
      stdio: ['pipe', 'pipe', 'inherit'],
      // Tells the child this process owns reloading, so it does not also watch
      // src/ and exit out from under the connection.
      env: { ...process.env, KB_SUPERVISED: '1' },
    });
    started.stdin.on('error', (err) => {
      // EPIPE is the ordinary race — a child that died between being current
      // and being written to — and the exit handler below is what deals with
      // it. Anything else is not expected and must not vanish.
      if (err.code !== 'EPIPE') console.error(`[KB] writing to the server: ${err.message}`);
    });
    onLines(started.stdout, (line) => {
      if (started === child) fromChild(line);
    });
    started.on('exit', () => {
      if (started === child) onChildLost();
    });
    return started;
  };

  const finishSwap = () => {
    swapping = false;
    while (queued.length) child.stdin.write(`${queued.shift()}\n`);
    // Tool names and schemas travel with the code, so the list the client
    // cached belongs to the process that just went away. Skipped before the
    // client has initialized, when there is nothing yet to invalidate.
    if (handshake) {
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      send({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' });
    }
    if (dirty) {
      dirty = false;
      swapWhenIdle();
    }
  };

  const replaceChild = () => {
    swapping = true;
    child = spawnChild();
    if (!handshake) return finishSwap();
    awaitingInit = true;
    child.stdin.write(`${handshake.initialize}\n`);
  };

  const onChildLost = () => {
    // A crashed child may have half-run a write, so its calls are never
    // re-dispatched to the replacement — the client is told they failed.
    failEverything('knowledge-base server exited mid-call');
    bootFailures += 1;
    if (bootFailures >= MAX_BOOT_FAILURES) {
      // Parking, not exiting: exiting takes the whole toolset away, which is
      // the interruption this supervisor exists to prevent, and it would happen
      // exactly during a half-finished checkout. The watcher stays armed, so
      // repairing the tree brings the session back with no reconnect.
      parked = true;
      swapping = false;
      child = null;
      console.error(`[KB] server died ${bootFailures} times before starting; parked until src/ changes again`);
      return;
    }
    replaceChild();
  };

  const swap = () => {
    if (swapping) {
      dirty = true;
      return;
    }
    // Set before the kill so that anything the client sends from this instant
    // is queued rather than written into a process that is going away.
    swapping = true;
    const old = child;
    child = null; // also disarms `old`'s exit handler: this is not a crash
    old?.kill();
    replaceChild();
  };

  const swapWhenIdle = () => {
    if (!isBusy()) return swap();
    setTimeout(swapWhenIdle, idlePollMs).unref();
  };

  const onSourceChange = () => {
    if (parked) {
      parked = false;
      bootFailures = 0;
    }
    swap();
  };

  const fromClient = (line) => {
    const msg = parse(line);
    if (msg?.method === 'initialize') handshake = { initialize: line, id: msg.id, initialized: null };
    else if (msg?.method === 'notifications/initialized' && handshake) handshake.initialized = line;
    else if (msg?.method === 'notifications/cancelled') {
      // A cancelled request never gets a response — the SDK returns silently
      // once the abort fires — so without this its id counts as in-flight
      // forever and no reload ever runs again.
      pending.delete(msg.params?.requestId);
    } else if (msg?.method === 'logging/setLevel' || msg?.method === 'resources/subscribe') {
      // Per-session state a new child would not have. Neither is reachable with
      // the capabilities this server declares; warn so that changing that is
      // not silent.
      warnOnce(msg.method, `${msg.method} does not survive a reload`);
    }

    if (isRequest(msg)) pending.set(msg.id, now());
    if (parked) {
      // Answer now rather than let the call sit until the client's own timeout.
      if (isRequest(msg)) {
        pending.delete(msg.id);
        fail(msg.id, PARKED_MESSAGE);
      }
      return;
    }
    if (swapping) queued.push(line);
    else child.stdin.write(`${line}\n`);
  };

  const shutdown = () => {
    const old = child;
    child = null;
    old?.kill();
    process.exit(0);
  };

  onLines(stdin, fromClient);
  // The client closing its end is the session ending, and the child is ours to reap.
  stdin.on('end', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  replaceChild();
  const watcher = restartOnSourceChange({
    isBusy,
    onChange: onSourceChange,
    dir: watchDir,
    debounceMs,
    idlePollMs,
  });
  return { watcher, shutdown };
}
