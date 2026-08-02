import { createHash } from 'crypto';
import { getBusDb } from './db.js';
import { normalizeCwd, writeBusBinding } from './context.js';
import { advanceBusNotifications, readBusNotifications, readDeliverableMessageIds } from './service.js';

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

export function makeSessionId({ channel, reader, agent, cwd }) {
  const hash = createHash('sha256')
    .update([channel, reader, agent, cwd].join('\0'))
    .digest('hex')
    .slice(0, 16);
  return `sess_${hash}`;
}

// Reader ids carry their host as a prefix (claude:architect); autobind writes them that way.
export function readerHost(reader) {
  const [host] = requireText(reader, 'reader').split(':');
  return host || reader;
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

// Sole writer of bus_sessions: a hook fire and an explicit registration must land on the same row.
function upsertSession({
  id,
  channel,
  reader,
  agent,
  adapter,
  cwd,
  tmux_pane,
  acp_session_id,
  pid,
  status,
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

  return { id: cleanId, adapter: cleanAdapter, agent: cleanAgent, cwd: cleanCwd };
}

export function registerBusSession({
  id,
  channel,
  reader,
  agent,
  adapter = 'hook',
  cwd,
  tmux_pane,
  acp_session_id,
  pid,
  status = 'registered',
}) {
  const session = upsertSession({ id, channel, reader, agent, adapter, cwd, tmux_pane, acp_session_id, pid, status });

  if (session.adapter === 'hook') {
    writeBusBinding({ agent: session.agent, cwd: session.cwd, channel, reader });
  }

  return getBusSession(session.id);
}

// The hook path resolved its subscription from the binding, so it refreshes the row without rewriting one.
// status 'active' means a hook has fired for this session; 'registered' means only that someone declared it.
export function touchBusSession({ channel, reader, agent, cwd, adapter = 'hook', status = 'active' }) {
  return getBusSession(upsertSession({ channel, reader, agent, adapter, cwd, status }).id);
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

/**
 * Take what this session has not yet been told, record the handoff, and advance its notify cursor —
 * all in one write transaction. Taking the digest inside that transaction is what makes delivery
 * at-most-once: a concurrent or replayed fire for the same session finds the cursor already past, so
 * it records nothing and gets back an empty digest to show.
 */
export function deliverToSession({ session, limit, preview_chars, capabilities_json = null, status = 'delivered' }) {
  if (!session) throw new Error('session is required');
  const db = getBusDb();
  const insert = db.prepare(`
    INSERT INTO bus_deliveries (message_id, session_id, channel, reader, adapter, status, reason, delivered_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)
    ON CONFLICT(message_id, session_id) DO NOTHING
  `);

  // IMMEDIATE, not deferred: a deferred transaction that reads first cannot upgrade to a writer
  // while another hook holds the lock, and SQLite refuses that upgrade outright instead of waiting.
  return db.transaction(() => {
    const notification = readBusNotifications({
      channel: session.channel,
      reader: session.reader,
      limit,
      preview_chars,
    });
    const messageIds = readDeliverableMessageIds({
      channel: session.channel,
      reader: session.reader,
      after_id: notification.notify_cursor,
      through_id: notification.advanced_to,
    });
    let recorded = 0;
    for (const messageId of messageIds) {
      recorded += insert.run(messageId, session.id, session.channel, session.reader, session.adapter, status).changes;
    }
    advanceBusNotifications({
      channel: session.channel,
      reader: session.reader,
      to_id: notification.advanced_to,
      capabilities_json,
    });
    return { session_id: session.id, notification, message_ids: messageIds, recorded };
  }).immediate();
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
