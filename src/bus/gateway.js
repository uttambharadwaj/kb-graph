import { createHash } from 'crypto';
import { getBusDb } from './db.js';
import { getBusPollMs } from './config.js';
import { normalizeCwd, writeBusBinding } from './context.js';
import { clearBusPending, writeBusPending } from './pending.js';
import { formatBusNotificationDigest, getMessageById, readBusNotifications } from './service.js';

const WAKE_KINDS = new Set(['question', 'control', 'announce', 'handoff', 'blocked']);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requireText(value, name) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function normalizeOptionalText(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
}

function normalizeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function normalizeBoolean(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function makeSessionId({ channel, reader, agent, cwd }) {
  const hash = createHash('sha256')
    .update([channel, reader, agent, cwd].join('\0'))
    .digest('hex')
    .slice(0, 16);
  return `sess_${hash}`;
}

function mapSession(row) {
  return row ? {
    id: row.id,
    channel: row.channel,
    reader: row.reader,
    agent: row.agent,
    adapter: row.adapter,
    cwd: row.cwd,
    tmux_pane: row.tmux_pane ?? null,
    acp_session_id: row.acp_session_id ?? null,
    pid: row.pid ?? null,
    status: row.status,
    last_seen_at: row.last_seen_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  } : null;
}

export function registerBusSession({
  id,
  channel,
  reader,
  agent,
  adapter = 'hook',
  cwd = process.cwd(),
  tmux_pane,
  acp_session_id,
  pid,
  status = 'registered',
}) {
  const cleanChannel = requireText(channel, 'channel');
  const cleanReader = requireText(reader, 'reader');
  const cleanAgent = requireText(agent, 'agent');
  const cleanCwd = normalizeCwd(requireText(cwd, 'cwd'));
  const cleanAdapter = requireText(adapter, 'adapter');
  const cleanId = normalizeOptionalText(id) ?? makeSessionId({
    channel: cleanChannel,
    reader: cleanReader,
    agent: cleanAgent,
    cwd: cleanCwd,
  });

  getBusDb().prepare(`
    INSERT INTO bus_sessions (id, channel, reader, agent, adapter, cwd, tmux_pane, acp_session_id, pid, status, last_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      channel = excluded.channel,
      reader = excluded.reader,
      agent = excluded.agent,
      adapter = excluded.adapter,
      cwd = excluded.cwd,
      tmux_pane = excluded.tmux_pane,
      acp_session_id = excluded.acp_session_id,
      pid = excluded.pid,
      status = excluded.status,
      last_seen_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    cleanId,
    cleanChannel,
    cleanReader,
    cleanAgent,
    cleanAdapter,
    cleanCwd,
    normalizeOptionalText(tmux_pane),
    normalizeOptionalText(acp_session_id),
    normalizeInteger(pid),
    requireText(status, 'status'),
  );

  if (cleanAdapter === 'hook') {
    writeBusBinding({
      agent: cleanAgent,
      cwd: cleanCwd,
      channel: cleanChannel,
      reader: cleanReader,
    });
  }

  return getBusSession(cleanId);
}

export function getBusSession(id) {
  return mapSession(getBusDb().prepare(`
    SELECT id, channel, reader, agent, adapter, cwd, tmux_pane, acp_session_id, pid, status, last_seen_at, created_at, updated_at
    FROM bus_sessions
    WHERE id = ?
  `).get(requireText(id, 'id')));
}

export function listBusSessions({ channel, reader } = {}) {
  const filters = [];
  const params = [];
  if (channel) {
    filters.push('channel = ?');
    params.push(requireText(channel, 'channel'));
  }
  if (reader) {
    filters.push('reader = ?');
    params.push(requireText(reader, 'reader'));
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  return getBusDb().prepare(`
    SELECT id, channel, reader, agent, adapter, cwd, tmux_pane, acp_session_id, pid, status, last_seen_at, created_at, updated_at
    FROM bus_sessions
    ${where}
    ORDER BY channel ASC, reader ASC, updated_at DESC
  `).all(...params).map(mapSession);
}

function messageTargetsSession(message, session) {
  if (message.sender === session.reader) return false;
  const recipient = message.recipient ?? message.to_reader ?? null;
  return !recipient || recipient === '*' || recipient === session.reader;
}

function messageNeedsDelivery(message) {
  if (WAKE_KINDS.has(message.kind)) return true;
  if (message.expects_reply) return true;
  if (message.recipient && message.recipient !== '*') return true;
  const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
  return normalizeBoolean(metadata.needs_attention);
}

function pendingMessagesForSession(session, limit) {
  const rows = getBusDb().prepare(`
    SELECT id
    FROM bus_messages
    WHERE channel = ?
      AND NOT EXISTS (
        SELECT 1 FROM bus_deliveries
        WHERE bus_deliveries.message_id = bus_messages.id
          AND bus_deliveries.session_id = ?
      )
    ORDER BY id ASC
    LIMIT ?
  `).all(session.channel, session.id, limit);

  return rows
    .map(row => getMessageById(row.id))
    .filter(message => message && messageTargetsSession(message, session) && messageNeedsDelivery(message));
}

function recordDelivery({ message, session, status, reason = null }) {
  getBusDb().prepare(`
    INSERT INTO bus_deliveries (message_id, session_id, channel, reader, adapter, status, reason, delivered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(message_id, session_id) DO NOTHING
  `).run(message.id, session.id, session.channel, session.reader, session.adapter, status, reason);
  return { message_id: message.id, session_id: session.id, status, reason };
}

function deliverHook(session, messages) {
  const notification = readBusNotifications({
    channel: session.channel,
    reader: session.reader,
    limit: Math.max(5, messages.length),
    preview_chars: 120,
  });
  const digest = formatBusNotificationDigest(notification);
  if (!digest) {
    clearBusPending({ agent: session.agent, cwd: session.cwd });
    return { status: 'skipped', reason: 'no_digest' };
  }
  writeBusPending({
    agent: session.agent,
    cwd: session.cwd,
    digest,
    total_new: notification.total_new,
    channels: [session.channel],
  });
  return { status: 'pending_digest', reason: 'hook_pending_file' };
}

function deliverMessages(session, messages) {
  if (messages.length === 0) return [];
  if (session.adapter === 'hook') {
    const result = deliverHook(session, messages);
    return messages.map(message => recordDelivery({ message, session, ...result }));
  }
  if (session.adapter === 'noop') {
    return messages.map(message => recordDelivery({ message, session, status: 'skipped', reason: 'noop_adapter' }));
  }
  return messages.map(message => recordDelivery({ message, session, status: 'unsupported', reason: `${session.adapter}_adapter_unavailable` }));
}

export function runBusGatewayOnce({ channel, limit = 50 } = {}) {
  const sessions = listBusSessions({ channel });
  const deliveries = [];
  for (const session of sessions) {
    const messages = pendingMessagesForSession(session, limit);
    deliveries.push(...deliverMessages(session, messages));
  }
  return {
    sessions: sessions.length,
    deliveries,
    delivered: deliveries.filter(delivery => delivery.status === 'pending_digest').length,
    skipped: deliveries.filter(delivery => delivery.status === 'skipped').length,
    unsupported: deliveries.filter(delivery => delivery.status === 'unsupported').length,
  };
}

export async function runBusGatewayLoop({ channel, interval_ms, once = false }) {
  const sleepMs = normalizeInteger(interval_ms) ?? getBusPollMs();
  if (once) return runBusGatewayOnce({ channel });
  while (true) {
    runBusGatewayOnce({ channel });
    await sleep(sleepMs);
  }
}

export function listBusDeliveries({ channel, session_id } = {}) {
  const filters = [];
  const params = [];
  if (channel) {
    filters.push('channel = ?');
    params.push(requireText(channel, 'channel'));
  }
  if (session_id) {
    filters.push('session_id = ?');
    params.push(requireText(session_id, 'session_id'));
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  return getBusDb().prepare(`
    SELECT id, message_id, session_id, channel, reader, adapter, status, reason, delivered_at, created_at
    FROM bus_deliveries
    ${where}
    ORDER BY id DESC
    LIMIT 100
  `).all(...params);
}
