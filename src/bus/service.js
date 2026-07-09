import { getBusDb } from './db.js';
import { getBusPollMs, getBusResourceLimit, getBusRetentionMessages } from './config.js';

const PRESENCE_STALE_MS = 5 * 60 * 1000;
const busListeners = new Set();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseMetadata(metadataJson) {
  if (!metadataJson) return null;
  try {
    return JSON.parse(metadataJson);
  } catch {
    return null;
  }
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

function normalizeBoolean(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function normalizeReplyTo(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function clampLimit(limit, fallback = 50, max = 500) {
  const value = Number(limit);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

function normalizeSince(since) {
  const value = Number(since);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function normalizeTimeout(timeoutMs) {
  return clampLimit(timeoutMs, 30000, 300000);
}

function getEnvelope(metadata, overrides = {}) {
  return {
    thread: normalizeOptionalText(overrides.thread ?? metadata?.thread),
    reply_to: normalizeReplyTo(overrides.reply_to ?? metadata?.reply_to),
    recipient: normalizeOptionalText(
      overrides.recipient
      ?? overrides.to_reader
      ?? overrides.to
      ?? metadata?.recipient
      ?? metadata?.to_reader
      ?? metadata?.to
    ),
    deadline: normalizeOptionalText(overrides.deadline ?? metadata?.deadline),
    expects_reply: overrides.expects_reply === undefined
      ? normalizeBoolean(metadata?.expects_reply)
      : normalizeBoolean(overrides.expects_reply),
  };
}

function normalizeProtocolList(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  const text = normalizeOptionalText(value);
  if (!text) return null;
  return text.split(',').map(item => item.trim()).filter(Boolean);
}

function getProtocol(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;

  const protocol = {
    status: normalizeOptionalText(metadata.status),
    step: normalizeOptionalText(metadata.step),
    files_touched: normalizeProtocolList(metadata.files_touched ?? metadata.files),
    diff_since_last_ack: normalizeOptionalText(metadata.diff_since_last_ack),
    ack_decision: normalizeOptionalText(metadata.ack_decision),
    ack_message_id: normalizeReplyTo(metadata.ack_message_id),
    control_command: normalizeOptionalText(metadata.control_command),
    tests: normalizeProtocolList(metadata.tests),
    risk: normalizeOptionalText(metadata.risk),
  };

  const entries = Object.entries(protocol).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    return value !== null && value !== undefined && value !== '';
  });
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function parseJsonObject(raw) {
  const parsed = parseMetadata(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

function mapMessage(row) {
  const metadata = parseMetadata(row.metadata_json);
  const envelope = getEnvelope(metadata, row);
  return {
    id: row.id,
    channel: row.channel,
    sender: row.sender,
    kind: row.kind,
    body: row.body,
    metadata,
    protocol: getProtocol(metadata),
    thread: envelope.thread,
    reply_to: envelope.reply_to,
    recipient: envelope.recipient,
    to_reader: envelope.recipient,
    deadline: envelope.deadline,
    expects_reply: envelope.expects_reply,
    created_at: row.created_at,
  };
}

function readReaderState(reader, channel) {
  const row = getBusDb().prepare(`
    SELECT last_seen_id, notify_cursor, last_hook_at, capabilities_json
    FROM bus_readers
    WHERE reader = ? AND channel = ?
  `).get(reader, channel);

  return {
    last_seen_id: normalizeSince(row?.last_seen_id ?? 0),
    notify_cursor: normalizeSince(row?.notify_cursor ?? row?.last_seen_id ?? 0),
    last_hook_at: row?.last_hook_at ?? null,
    capabilities_json: row?.capabilities_json ?? null,
  };
}

function writeReaderState(reader, channel, {
  last_seen_id,
  notify_cursor,
  last_hook_at = null,
  capabilities_json = null,
}) {
  getBusDb().prepare(`
    INSERT INTO bus_readers (reader, channel, last_seen_id, notify_cursor, last_hook_at, capabilities_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(reader, channel) DO UPDATE SET
      last_seen_id = CASE
        WHEN excluded.last_seen_id > bus_readers.last_seen_id THEN excluded.last_seen_id
        ELSE bus_readers.last_seen_id
      END,
      notify_cursor = CASE
        WHEN excluded.notify_cursor > bus_readers.notify_cursor THEN excluded.notify_cursor
        ELSE bus_readers.notify_cursor
      END,
      last_hook_at = COALESCE(excluded.last_hook_at, bus_readers.last_hook_at),
      capabilities_json = COALESCE(excluded.capabilities_json, bus_readers.capabilities_json),
      updated_at = CURRENT_TIMESTAMP
  `).run(
    reader,
    channel,
    normalizeSince(last_seen_id),
    normalizeSince(notify_cursor),
    last_hook_at,
    capabilities_json,
  );
}

function readBusPresence(channel) {
  const cleanChannel = requireText(channel, 'channel');
  const rows = getBusDb().prepare(`
    SELECT reader, last_hook_at
    FROM bus_readers
    WHERE channel = ?
      AND last_hook_at IS NOT NULL
    ORDER BY reader ASC
  `).all(cleanChannel);

  const now = Date.now();
  const live = [];
  const stale = [];
  for (const row of rows) {
    const lastSeenAt = Date.parse(row.last_hook_at);
    const bucket = Number.isFinite(lastSeenAt) && now - lastSeenAt <= PRESENCE_STALE_MS ? live : stale;
    bucket.push(row.reader);
  }
  return { live, stale };
}

function emitBusMessage(message) {
  for (const listener of busListeners) {
    listener(message);
  }
}

export function onBusMessage(listener) {
  busListeners.add(listener);
  return () => busListeners.delete(listener);
}

export function sendBusMessage({
  channel,
  sender,
  message,
  kind = 'message',
  metadata_json,
  thread,
  reply_to,
  recipient,
  to_reader,
  deadline,
  expects_reply,
}) {
  const db = getBusDb();
  const cleanChannel = requireText(channel, 'channel');
  const cleanSender = requireText(sender, 'sender');
  const cleanMessage = requireText(message, 'message');
  const cleanKind = requireText(kind, 'kind');
  const metadata = parseMetadata(metadata_json);
  const serializedMetadata = metadata ? JSON.stringify(metadata) : null;
  const envelope = getEnvelope(metadata, { thread, reply_to, recipient, to_reader, deadline, expects_reply });

  const result = db.prepare(`
    INSERT INTO bus_messages (channel, sender, kind, body, metadata_json, thread, reply_to, recipient, to_reader, deadline, expects_reply)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cleanChannel,
    cleanSender,
    cleanKind,
    cleanMessage,
    serializedMetadata,
    envelope.thread,
    envelope.reply_to,
    envelope.recipient,
    envelope.recipient,
    envelope.deadline,
    envelope.expects_reply ? 1 : 0,
  );

  pruneChannel(cleanChannel);
  const created = getMessageById(result.lastInsertRowid);
  emitBusMessage(created);
  return created;
}

function pruneChannel(channel) {
  const keep = getBusRetentionMessages();
  const db = getBusDb();
  db.prepare(`
    DELETE FROM bus_messages
    WHERE channel = ?
      AND id NOT IN (
        SELECT id FROM bus_messages
        WHERE channel = ?
        ORDER BY id DESC
        LIMIT ?
      )
  `).run(channel, channel, keep);
}

export function getMessageById(id) {
  const row = getBusDb().prepare(`
    SELECT id, channel, sender, kind, body, metadata_json, thread, reply_to, recipient, to_reader, deadline, expects_reply, created_at
    FROM bus_messages
    WHERE id = ?
  `).get(id);
  return row ? mapMessage(row) : null;
}

function readChannelMessages({ channel, since = 0, limit = 50 }) {
  const cleanChannel = requireText(channel, 'channel');
  const cursor = normalizeSince(since);
  const pageSize = clampLimit(limit);
  const db = getBusDb();

  const rows = db.prepare(`
    SELECT id, channel, sender, kind, body, metadata_json, thread, reply_to, recipient, to_reader, deadline, expects_reply, created_at
    FROM bus_messages
    WHERE channel = ? AND id > ?
    ORDER BY id ASC
    LIMIT ?
  `).all(cleanChannel, cursor, pageSize);

  const messages = rows.map(mapMessage);
  const latest = db.prepare(`
    SELECT MAX(id) AS latest_id
    FROM bus_messages
    WHERE channel = ?
  `).get(cleanChannel);

  return {
    channel: cleanChannel,
    messages,
    count: messages.length,
    next_since: messages.at(-1)?.id ?? cursor,
    latest_id: latest?.latest_id ?? cursor,
  };
}

async function waitForChannelMessages({ channel, since = 0, timeout_ms = 30000, limit = 50 }) {
  const cleanChannel = requireText(channel, 'channel');
  const cursor = normalizeSince(since);
  const timeout = normalizeTimeout(timeout_ms);
  const deadline = Date.now() + timeout;

  while (Date.now() <= deadline) {
    const inbox = readChannelMessages({ channel: cleanChannel, since: cursor, limit });
    if (inbox.count > 0) {
      return { ...inbox, timed_out: false };
    }
    await sleep(getBusPollMs());
  }

  const latest = readChannelMessages({ channel: cleanChannel, since: cursor, limit: 1 });
  return {
    channel: cleanChannel,
    messages: [],
    count: 0,
    next_since: cursor,
    latest_id: latest.latest_id,
    timed_out: true,
  };
}

export async function readBusInbox({ channel, reader, limit = 50, wait = false, timeout_ms = 30000, peek = false }) {
  const cleanChannel = requireText(channel, 'channel');
  const cleanReader = requireText(reader, 'reader');
  const shouldWait = wait === true || wait === 'true';
  const shouldPeek = peek === true || peek === 'true';
  const { last_seen_id: cursor } = readReaderState(cleanReader, cleanChannel);

  const inbox = shouldWait
    ? await waitForChannelMessages({ channel: cleanChannel, since: cursor, timeout_ms, limit })
    : readChannelMessages({ channel: cleanChannel, since: cursor, limit });

  if (!shouldPeek && inbox.count > 0) {
    writeReaderState(cleanReader, cleanChannel, {
      last_seen_id: inbox.next_since,
      notify_cursor: inbox.next_since,
    });
  }

  return {
    reader: cleanReader,
    ...inbox,
    cursor,
    advanced: shouldPeek ? false : inbox.count > 0,
  };
}

function readNotificationRows(channel, reader, since, limit) {
  const db = getBusDb();
  const rows = db.prepare(`
    SELECT id, channel, sender, kind, body, metadata_json, thread, reply_to, recipient, to_reader, deadline, expects_reply, created_at
    FROM bus_messages
    WHERE channel = ?
      AND sender != ?
      AND id > ?
      AND (COALESCE(recipient, to_reader) IS NULL OR COALESCE(recipient, to_reader) = ? OR COALESCE(recipient, to_reader) = '*')
    ORDER BY id ASC
    LIMIT ?
  `).all(channel, reader, since, reader, limit);

  const stats = db.prepare(`
    SELECT
      SUM(CASE
        WHEN sender != ?
         AND (COALESCE(recipient, to_reader) IS NULL OR COALESCE(recipient, to_reader) = ? OR COALESCE(recipient, to_reader) = '*')
        THEN 1
        ELSE 0
      END) AS total_new,
      MAX(id) AS latest_id
    FROM bus_messages
    WHERE channel = ? AND id > ?
  `).get(reader, reader, channel, since);

  return {
    rows,
    total_new: Number(stats?.total_new ?? 0),
    latest_id: normalizeSince(stats?.latest_id ?? since),
  };
}

function sanitizeDigestText(value) {
  return String(value ?? '')
    .replace(/[<>\`]/g, '')
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizePreview(body, maxChars = 80) {
  const firstLine = String(body ?? '').split(/\r?\n/, 1)[0] ?? '';
  const normalized = sanitizeDigestText(firstLine);
  if (!normalized) return '(no preview)';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

export function readBusNotifications({ channel, reader, limit = 5, preview_chars = 80 }) {
  const cleanChannel = requireText(channel, 'channel');
  const cleanReader = requireText(reader, 'reader');
  const pageSize = clampLimit(limit, 5, 20);
  const previewChars = clampLimit(preview_chars, 80, 240);
  const { last_seen_id, notify_cursor, last_hook_at } = readReaderState(cleanReader, cleanChannel);
  const { rows, total_new, latest_id } = readNotificationRows(cleanChannel, cleanReader, notify_cursor, pageSize);

  return {
    reader: cleanReader,
    channel: cleanChannel,
    last_seen_id,
    notify_cursor,
    last_hook_at,
    total_new,
    latest_id,
    returned_count: rows.length,
    advanced_to: latest_id,
    presence: readBusPresence(cleanChannel),
    messages: rows.map(row => ({
      id: row.id,
      sender: row.sender,
      kind: row.kind,
      recipient: row.recipient ?? row.to_reader ?? null,
      expects_reply: Boolean(row.expects_reply),
      preview: sanitizePreview(row.body, previewChars),
    })),
  };
}

export function advanceBusNotifications({ channel, reader, to_id, capabilities_json = null }) {
  const cleanChannel = requireText(channel, 'channel');
  const cleanReader = requireText(reader, 'reader');
  const cursor = normalizeSince(to_id);
  writeReaderState(cleanReader, cleanChannel, {
    last_seen_id: readReaderState(cleanReader, cleanChannel).last_seen_id,
    notify_cursor: cursor,
    last_hook_at: new Date().toISOString(),
    capabilities_json: capabilities_json ? JSON.stringify(JSON.parse(capabilities_json)) : null,
  });

  const state = readReaderState(cleanReader, cleanChannel);
  return {
    reader: cleanReader,
    channel: cleanChannel,
    last_seen_id: state.last_seen_id,
    notify_cursor: state.notify_cursor,
    last_hook_at: state.last_hook_at,
  };
}

export function formatBusNotificationDigest(notificationState) {
  if (!notificationState || notificationState.total_new === 0) return '';

  const noun = notificationState.total_new === 1 ? 'message' : 'messages';
  const lines = [`[bus] ${sanitizeDigestText(notificationState.channel)} — ${notificationState.total_new} new ${noun}:`];
  const live = notificationState.presence?.live ?? [];
  const stale = notificationState.presence?.stale ?? [];
  if (live.length > 0 || stale.length > 0) {
    const presenceBits = [];
    if (live.length > 0) presenceBits.push(`live: ${live.join(', ')}`);
    if (stale.length > 0) presenceBits.push(`stale: ${stale.join(', ')}`);
    lines.push(`  • presence — ${presenceBits.join(' | ')}`);
  }
  for (const message of notificationState.messages) {
    const recipient = message.recipient ? ` → ${sanitizeDigestText(message.recipient)}` : '';
    lines.push(`  • #${message.id} ${sanitizeDigestText(message.sender)} (${sanitizeDigestText(message.kind)}${recipient}) — "${message.preview}"`);
  }
  if (notificationState.total_new > notificationState.messages.length) {
    lines.push(`  • …and ${notificationState.total_new - notificationState.messages.length} more`);
  }
  lines.push(`Run bus_read ${sanitizeDigestText(notificationState.channel)} --reader ${sanitizeDigestText(notificationState.reader)} to consume.`);
  return lines.join('\n');
}

function getChannelLatest(channel) {
  const db = getBusDb();
  const row = db.prepare(`
    SELECT MAX(id) AS latest_id, COUNT(*) AS message_count
    FROM bus_messages
    WHERE channel = ?
  `).get(channel);
  return {
    latest_id: normalizeSince(row?.latest_id ?? 0),
    message_count: Number(row?.message_count ?? 0),
  };
}

function mapStatusMessage(row) {
  if (!row) return null;
  const message = mapMessage(row);
  return {
    id: message.id,
    sender: message.sender,
    kind: message.kind,
    body: message.body,
    metadata: message.metadata,
    protocol: message.protocol,
    created_at: message.created_at,
  };
}

function getLatestSenderMessage(channel, sender, kinds = null) {
  const db = getBusDb();
  const kindClause = kinds?.length
    ? `AND kind IN (${kinds.map(() => '?').join(', ')})`
    : '';
  const row = db.prepare(`
    SELECT id, channel, sender, kind, body, metadata_json, thread, reply_to, recipient, to_reader, deadline, expects_reply, created_at
    FROM bus_messages
    WHERE channel = ? AND sender = ? ${kindClause}
    ORDER BY id DESC
    LIMIT 1
  `).get(channel, sender, ...(kinds ?? []));
  return mapStatusMessage(row);
}

function countUnreadMessages(channel, cursor) {
  const row = getBusDb().prepare(`
    SELECT COUNT(*) AS count
    FROM bus_messages
    WHERE channel = ? AND id > ?
  `).get(channel, normalizeSince(cursor));
  return Number(row?.count ?? 0);
}

function countUnreadNotifications(channel, reader, cursor) {
  const row = getBusDb().prepare(`
    SELECT COUNT(*) AS count
    FROM bus_messages
    WHERE channel = ?
      AND sender != ?
      AND id > ?
      AND (COALESCE(recipient, to_reader) IS NULL OR COALESCE(recipient, to_reader) = ? OR COALESCE(recipient, to_reader) = '*')
  `).get(channel, reader, normalizeSince(cursor), reader);
  return Number(row?.count ?? 0);
}

export function readBusStatus({ channel, readers = [] } = {}) {
  const cleanChannel = requireText(channel, 'channel');
  const requestedReaders = Array.isArray(readers)
    ? readers.map(reader => normalizeOptionalText(reader)).filter(Boolean)
    : [];
  const { latest_id, message_count } = getChannelLatest(cleanChannel);
  const db = getBusDb();

  const participantRows = db.prepare(`
    SELECT sender, MAX(id) AS last_message_id, COUNT(*) AS message_count
    FROM bus_messages
    WHERE channel = ?
    GROUP BY sender
    ORDER BY last_message_id DESC
  `).all(cleanChannel);

  const storedReaderRows = db.prepare(`
    SELECT reader, last_seen_id, notify_cursor, last_hook_at, capabilities_json, updated_at
    FROM bus_readers
    WHERE channel = ?
    ORDER BY reader ASC
  `).all(cleanChannel);
  const storedByReader = new Map(storedReaderRows.map(row => [row.reader, row]));
  const readerNames = new Set([...storedByReader.keys(), ...requestedReaders]);
  const now = Date.now();

  const readerStatuses = [...readerNames].sort().map(reader => {
    const row = storedByReader.get(reader) ?? {
      reader,
      last_seen_id: 0,
      notify_cursor: 0,
      last_hook_at: null,
      capabilities_json: null,
      updated_at: null,
    };
    const lastHookAtMs = row.last_hook_at ? Date.parse(row.last_hook_at) : NaN;
    const live = Number.isFinite(lastHookAtMs) && now - lastHookAtMs <= PRESENCE_STALE_MS;
    return {
      reader,
      last_seen_id: normalizeSince(row.last_seen_id),
      notify_cursor: normalizeSince(row.notify_cursor),
      unread_messages: countUnreadMessages(cleanChannel, row.last_seen_id),
      unread_notifications: countUnreadNotifications(cleanChannel, reader, row.notify_cursor),
      last_hook_at: row.last_hook_at ?? null,
      presence: row.last_hook_at ? (live ? 'live' : 'stale') : 'unknown',
      capabilities: parseJsonObject(row.capabilities_json),
      updated_at: row.updated_at ?? null,
      last_heartbeat: getLatestSenderMessage(cleanChannel, reader, ['heartbeat', 'status']),
    };
  });

  return {
    channel: cleanChannel,
    latest_id,
    message_count,
    readers: readerStatuses,
    participants: participantRows.map(row => ({
      sender: row.sender,
      message_count: Number(row.message_count ?? 0),
      last_message_id: normalizeSince(row.last_message_id),
      last_message: getLatestSenderMessage(cleanChannel, row.sender),
      last_heartbeat: getLatestSenderMessage(cleanChannel, row.sender, ['heartbeat', 'status']),
    })),
    last_control: mapStatusMessage(db.prepare(`
      SELECT id, channel, sender, kind, body, metadata_json, thread, reply_to, recipient, to_reader, deadline, expects_reply, created_at
      FROM bus_messages
      WHERE channel = ? AND kind = 'control'
      ORDER BY id DESC
      LIMIT 1
    `).get(cleanChannel)),
  };
}

export function readBusChannel(channel, limit = getBusResourceLimit()) {
  const cleanChannel = requireText(channel, 'channel');
  const db = getBusDb();
  const rows = db.prepare(`
    SELECT id, channel, sender, kind, body, metadata_json, thread, reply_to, recipient, to_reader, deadline, expects_reply, created_at
    FROM bus_messages
    WHERE channel = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(cleanChannel, clampLimit(limit, getBusResourceLimit()));

  const messages = rows.reverse().map(mapMessage);
  return {
    channel: cleanChannel,
    messages,
    count: messages.length,
    latest_id: messages.at(-1)?.id ?? 0,
  };
}

export function listBusChannels(limit = 100) {
  return getBusDb().prepare(`
    SELECT channel, MAX(id) AS latest_id, COUNT(*) AS message_count
    FROM bus_messages
    GROUP BY channel
    ORDER BY latest_id DESC
    LIMIT ?
  `).all(clampLimit(limit, 100, 500));
}
