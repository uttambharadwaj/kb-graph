import Database from 'better-sqlite3';
import { ensureBusStorage, getBusDbPath } from './config.js';

let db = null;
let dbPath = null;

function addColumnIfMissing(database, table, name, ddl) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(column => column.name === name)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl};`);
  }
}

function migrateBusReaders(database) {
  const columns = database.prepare(`PRAGMA table_info(bus_readers)`).all();
  const columnNames = new Set(columns.map(column => column.name));
  const needsRebuild =
    !columnNames.has('notify_cursor')
    || !columnNames.has('last_hook_at')
    || !columnNames.has('capabilities_json');

  if (!needsRebuild) return;

  const notifyCursorExpression = columnNames.has('notify_cursor')
    ? `CASE
        WHEN COALESCE(notify_cursor, 0) > COALESCE(last_seen_id, 0) THEN COALESCE(notify_cursor, 0)
        ELSE COALESCE(last_seen_id, 0)
      END`
    : 'COALESCE(last_seen_id, 0)';

  database.exec(`
    CREATE TABLE bus_readers_v4 (
      reader TEXT NOT NULL,
      channel TEXT NOT NULL,
      last_seen_id INTEGER NOT NULL DEFAULT 0,
      notify_cursor INTEGER NOT NULL DEFAULT 0,
      last_hook_at TEXT,
      capabilities_json TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (reader, channel)
    );

    INSERT INTO bus_readers_v4 (reader, channel, last_seen_id, notify_cursor, last_hook_at, capabilities_json, updated_at)
    SELECT
      reader,
      channel,
      COALESCE(last_seen_id, 0),
      ${notifyCursorExpression},
      NULL,
      NULL,
      COALESCE(updated_at, CURRENT_TIMESTAMP)
    FROM bus_readers;

    DROP TABLE bus_readers;
    ALTER TABLE bus_readers_v4 RENAME TO bus_readers;

    CREATE INDEX IF NOT EXISTS idx_bus_readers_channel
      ON bus_readers(channel);
  `);
}

function initSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS bus_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      sender TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'message',
      body TEXT NOT NULL,
      metadata_json TEXT,
      thread TEXT,
      reply_to INTEGER,
      recipient TEXT,
      to_reader TEXT,
      deadline TEXT,
      expects_reply INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_bus_messages_channel_id
      ON bus_messages(channel, id);

    CREATE INDEX IF NOT EXISTS idx_bus_messages_created_at
      ON bus_messages(created_at);

    CREATE TABLE IF NOT EXISTS bus_readers (
      reader TEXT NOT NULL,
      channel TEXT NOT NULL,
      last_seen_id INTEGER NOT NULL DEFAULT 0,
      notify_cursor INTEGER NOT NULL DEFAULT 0,
      last_hook_at TEXT,
      capabilities_json TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (reader, channel)
    );

    CREATE INDEX IF NOT EXISTS idx_bus_readers_channel
      ON bus_readers(channel);

    CREATE TABLE IF NOT EXISTS bus_sessions (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      reader TEXT NOT NULL,
      agent TEXT NOT NULL,
      adapter TEXT NOT NULL DEFAULT 'hook',
      cwd TEXT NOT NULL,
      tmux_pane TEXT,
      acp_session_id TEXT,
      pid INTEGER,
      status TEXT NOT NULL DEFAULT 'registered',
      last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_bus_sessions_channel
      ON bus_sessions(channel, reader);

    CREATE TABLE IF NOT EXISTS bus_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      reader TEXT NOT NULL,
      adapter TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(message_id, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_bus_deliveries_session
      ON bus_deliveries(session_id, message_id);

    CREATE TABLE IF NOT EXISTS bus_agents (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      reader TEXT NOT NULL,
      agent TEXT NOT NULL,
      adapter TEXT NOT NULL DEFAULT 'exec',
      cwd TEXT NOT NULL,
      command TEXT NOT NULL,
      args_json TEXT NOT NULL DEFAULT '[]',
      prompt_template TEXT,
      max_concurrency INTEGER NOT NULL DEFAULT 1,
      cooldown_ms INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'enabled',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_bus_agents_channel
      ON bus_agents(channel, reader);

    CREATE TABLE IF NOT EXISTS bus_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      trigger_message_id INTEGER NOT NULL,
      channel TEXT NOT NULL,
      reader TEXT NOT NULL,
      status TEXT NOT NULL,
      pid INTEGER,
      command TEXT,
      stdout TEXT,
      stderr TEXT,
      exit_code INTEGER,
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(agent_id, trigger_message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_bus_runs_agent_status
      ON bus_runs(agent_id, status);

    CREATE INDEX IF NOT EXISTS idx_bus_runs_channel
      ON bus_runs(channel, id);
  `);

  addColumnIfMissing(database, 'bus_messages', 'thread', 'thread TEXT');
  addColumnIfMissing(database, 'bus_messages', 'reply_to', 'reply_to INTEGER');
  addColumnIfMissing(database, 'bus_messages', 'recipient', 'recipient TEXT');
  addColumnIfMissing(database, 'bus_messages', 'to_reader', 'to_reader TEXT');
  addColumnIfMissing(database, 'bus_messages', 'deadline', 'deadline TEXT');
  addColumnIfMissing(database, 'bus_messages', 'expects_reply', 'expects_reply INTEGER NOT NULL DEFAULT 0');
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_bus_messages_channel_recipient_id
      ON bus_messages(channel, recipient, id);
  `);
  migrateBusReaders(database);
  database.exec('DROP TABLE IF EXISTS bus_presence;');
}

export function getBusDb() {
  const nextPath = getBusDbPath();
  if (!db || dbPath !== nextPath) {
    closeBusDb();
    ensureBusStorage();
    db = new Database(nextPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    dbPath = nextPath;
  }
  return db;
}

export function closeBusDb() {
  if (db) {
    db.close();
    db = null;
    dbPath = null;
  }
}
