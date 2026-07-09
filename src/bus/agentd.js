import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { getBusDb } from './db.js';
import { getBusPollMs } from './config.js';
import { normalizeCwd } from './context.js';
import { getMessageById } from './service.js';

const RUN_KINDS = new Set(['task', 'question', 'control', 'announce', 'handoff', 'blocked']);
const OUTPUT_LIMIT = 20000;

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

function normalizeInteger(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function normalizeBoolean(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function parseJsonArray(value, fallback = []) {
  if (Array.isArray(value)) return value.map(item => String(item));
  const text = normalizeOptionalText(value);
  if (!text) return fallback;
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('args_json must be a JSON array');
  return parsed.map(item => String(item));
}

function makeAgentId({ channel, reader, agent, cwd }) {
  const hash = createHash('sha256')
    .update([channel, reader, agent, cwd].join('\0'))
    .digest('hex')
    .slice(0, 16);
  return `agent_${hash}`;
}

function mapAgent(row) {
  return row ? {
    id: row.id,
    channel: row.channel,
    reader: row.reader,
    agent: row.agent,
    adapter: row.adapter,
    cwd: row.cwd,
    command: row.command,
    args: parseJsonArray(row.args_json),
    prompt_template: row.prompt_template,
    max_concurrency: Number(row.max_concurrency ?? 1),
    cooldown_ms: Number(row.cooldown_ms ?? 0),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  } : null;
}

function mapRun(row) {
  return row ? {
    id: row.id,
    agent_id: row.agent_id,
    trigger_message_id: row.trigger_message_id,
    channel: row.channel,
    reader: row.reader,
    status: row.status,
    pid: row.pid ?? null,
    command: row.command,
    stdout: row.stdout ?? '',
    stderr: row.stderr ?? '',
    exit_code: row.exit_code ?? null,
    error: row.error ?? null,
    started_at: row.started_at ?? null,
    completed_at: row.completed_at ?? null,
    created_at: row.created_at,
  } : null;
}

function defaultPromptTemplate() {
  return [
    'You are {reader} on workstream {channel}.',
    '',
    'A bus message needs your attention:',
    '- id: {message_id}',
    '- sender: {sender}',
    '- kind: {kind}',
    '- recipient: {recipient}',
    '',
    '{body}',
    '',
    'Start by reading your bus inbox for {channel} as {reader}.',
    'Post any answer, artifact, blocker, or done status back to the same channel.',
  ].join('\n');
}

function renderTemplate(template, agent, message) {
  const values = {
    channel: agent.channel,
    reader: agent.reader,
    agent: agent.agent,
    message_id: String(message.id),
    sender: message.sender,
    kind: message.kind,
    recipient: message.recipient ?? message.to_reader ?? '',
    thread: message.thread ?? '',
    body: message.body,
  };
  return String(template ?? defaultPromptTemplate()).replace(/\{([a-z_]+)\}/g, (_, key) => values[key] ?? '');
}

function renderArgs(args, prompt) {
  return args.length > 0
    ? args.map(arg => arg.replaceAll('{prompt}', prompt))
    : [prompt];
}

function messageTargetsAgent(message, agent) {
  if (message.sender === agent.reader) return false;
  const recipient = message.recipient ?? message.to_reader ?? null;
  return !recipient || recipient === '*' || recipient === agent.reader;
}

function messageNeedsAgent(message) {
  if (RUN_KINDS.has(message.kind)) return true;
  if (message.expects_reply) return true;
  if (message.recipient && message.recipient !== '*') return true;
  const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
  return normalizeBoolean(metadata.needs_agent ?? metadata.needs_attention);
}

function activeRunCount(agent) {
  const row = getBusDb().prepare(`
    SELECT COUNT(*) AS count
    FROM bus_runs
    WHERE agent_id = ? AND status = 'running'
  `).get(agent.id);
  return Number(row?.count ?? 0);
}

function isCoolingDown(agent) {
  if (!agent.cooldown_ms) return false;
  const row = getBusDb().prepare(`
    SELECT COALESCE(completed_at, created_at) AS last_run_at
    FROM bus_runs
    WHERE agent_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(agent.id);
  const lastRunAt = row?.last_run_at ? Date.parse(row.last_run_at) : NaN;
  return Number.isFinite(lastRunAt) && Date.now() - lastRunAt < agent.cooldown_ms;
}

function pendingMessagesForAgent(agent, limit) {
  const rows = getBusDb().prepare(`
    SELECT id
    FROM bus_messages
    WHERE channel = ?
      AND NOT EXISTS (
        SELECT 1 FROM bus_runs
        WHERE bus_runs.trigger_message_id = bus_messages.id
          AND bus_runs.agent_id = ?
      )
    ORDER BY id ASC
    LIMIT ?
  `).all(agent.channel, agent.id, normalizeInteger(limit, 50));

  return rows
    .map(row => getMessageById(row.id))
    .filter(message => message && messageTargetsAgent(message, agent) && messageNeedsAgent(message));
}

function insertRun(agent, message, commandText) {
  const result = getBusDb().prepare(`
    INSERT INTO bus_runs (agent_id, trigger_message_id, channel, reader, status, command, started_at)
    VALUES (?, ?, ?, ?, 'running', ?, CURRENT_TIMESTAMP)
  `).run(agent.id, message.id, agent.channel, agent.reader, commandText);
  return result.lastInsertRowid;
}

function updateRun(id, updates) {
  getBusDb().prepare(`
    UPDATE bus_runs
    SET status = ?, pid = ?, stdout = ?, stderr = ?, exit_code = ?, error = ?, completed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    updates.status,
    updates.pid ?? null,
    updates.stdout ?? '',
    updates.stderr ?? '',
    updates.exit_code ?? null,
    updates.error ?? null,
    id,
  );
}

function truncateOutput(value) {
  const text = String(value ?? '');
  return text.length <= OUTPUT_LIMIT ? text : text.slice(-OUTPUT_LIMIT);
}

async function runExecAgent(agent, message) {
  const prompt = renderTemplate(agent.prompt_template, agent, message);
  const args = renderArgs(agent.args, prompt);
  const commandText = [agent.command, ...(agent.args.length ? agent.args : ['{prompt}'])].join(' ');
  const runId = insertRun(agent, message, commandText);

  return new Promise(resolve => {
    let child;
    let stdout = '';
    let stderr = '';
    try {
      child = spawn(agent.command, args, {
        cwd: agent.cwd,
        env: {
          ...process.env,
          BUS_CHANNEL: agent.channel,
          BUS_READER: agent.reader,
          BUS_TRIGGER_MESSAGE_ID: String(message.id),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      updateRun(runId, { status: 'failed', error: error.message });
      resolve(getBusRun(runId));
      return;
    }

    child.stdout.on('data', chunk => { stdout = truncateOutput(stdout + chunk.toString()); });
    child.stderr.on('data', chunk => { stderr = truncateOutput(stderr + chunk.toString()); });
    child.on('error', error => {
      updateRun(runId, { status: 'failed', pid: child.pid, stdout, stderr, error: error.message });
      resolve(getBusRun(runId));
    });
    child.on('close', code => {
      updateRun(runId, {
        status: code === 0 ? 'completed' : 'failed',
        pid: child.pid,
        stdout,
        stderr,
        exit_code: code,
      });
      resolve(getBusRun(runId));
    });
  });
}

async function runAgentForMessage(agent, message) {
  if (agent.adapter !== 'exec') {
    const runId = insertRun(agent, message, `${agent.adapter}:unsupported`);
    updateRun(runId, { status: 'skipped', error: `${agent.adapter}_adapter_unavailable` });
    return getBusRun(runId);
  }
  return runExecAgent(agent, message);
}

export function registerBusAgent({
  id,
  channel,
  reader,
  agent,
  adapter = 'exec',
  cwd = process.cwd(),
  command,
  args = [],
  args_json,
  prompt_template,
  max_concurrency = 1,
  cooldown_ms = 0,
  status = 'enabled',
}) {
  const cleanChannel = requireText(channel, 'channel');
  const cleanReader = requireText(reader, 'reader');
  const cleanAgent = requireText(agent, 'agent');
  const cleanCwd = normalizeCwd(requireText(cwd, 'cwd'));
  const cleanId = normalizeOptionalText(id) ?? makeAgentId({ channel: cleanChannel, reader: cleanReader, agent: cleanAgent, cwd: cleanCwd });
  const cleanCommand = requireText(command ?? cleanAgent, 'command');
  const cleanArgs = parseJsonArray(args_json, Array.isArray(args) ? args : []);

  getBusDb().prepare(`
    INSERT INTO bus_agents (id, channel, reader, agent, adapter, cwd, command, args_json, prompt_template, max_concurrency, cooldown_ms, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      channel = excluded.channel,
      reader = excluded.reader,
      agent = excluded.agent,
      adapter = excluded.adapter,
      cwd = excluded.cwd,
      command = excluded.command,
      args_json = excluded.args_json,
      prompt_template = excluded.prompt_template,
      max_concurrency = excluded.max_concurrency,
      cooldown_ms = excluded.cooldown_ms,
      status = excluded.status,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    cleanId,
    cleanChannel,
    cleanReader,
    cleanAgent,
    requireText(adapter, 'adapter'),
    cleanCwd,
    cleanCommand,
    JSON.stringify(cleanArgs),
    normalizeOptionalText(prompt_template) ?? defaultPromptTemplate(),
    Math.max(1, normalizeInteger(max_concurrency, 1)),
    normalizeInteger(cooldown_ms, 0),
    requireText(status, 'status'),
  );

  return getBusAgent(cleanId);
}

export function getBusAgent(id) {
  return mapAgent(getBusDb().prepare(`
    SELECT id, channel, reader, agent, adapter, cwd, command, args_json, prompt_template, max_concurrency, cooldown_ms, status, created_at, updated_at
    FROM bus_agents
    WHERE id = ?
  `).get(requireText(id, 'id')));
}

export function listBusAgents({ channel, reader } = {}) {
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
    SELECT id, channel, reader, agent, adapter, cwd, command, args_json, prompt_template, max_concurrency, cooldown_ms, status, created_at, updated_at
    FROM bus_agents
    ${where}
    ORDER BY channel ASC, reader ASC, updated_at DESC
  `).all(...params).map(mapAgent);
}

export function getBusRun(id) {
  return mapRun(getBusDb().prepare(`
    SELECT id, agent_id, trigger_message_id, channel, reader, status, pid, command, stdout, stderr, exit_code, error, started_at, completed_at, created_at
    FROM bus_runs
    WHERE id = ?
  `).get(id));
}

export function listBusRuns({ channel, agent_id } = {}) {
  const filters = [];
  const params = [];
  if (channel) {
    filters.push('channel = ?');
    params.push(requireText(channel, 'channel'));
  }
  if (agent_id) {
    filters.push('agent_id = ?');
    params.push(requireText(agent_id, 'agent_id'));
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  return getBusDb().prepare(`
    SELECT id, agent_id, trigger_message_id, channel, reader, status, pid, command, stdout, stderr, exit_code, error, started_at, completed_at, created_at
    FROM bus_runs
    ${where}
    ORDER BY id DESC
    LIMIT 100
  `).all(...params).map(mapRun);
}

export async function runBusAgentDaemonOnce({ channel, limit = 50, dry_run = false } = {}) {
  const agents = listBusAgents({ channel }).filter(agent => agent.status === 'enabled');
  const runs = [];
  const candidates = [];

  for (const agent of agents) {
    if (activeRunCount(agent) >= agent.max_concurrency) continue;
    if (isCoolingDown(agent)) continue;
    const messages = pendingMessagesForAgent(agent, limit);
    for (const message of messages) {
      candidates.push({ agent_id: agent.id, message_id: message.id, reader: agent.reader });
      if (dry_run) continue;
      runs.push(await runAgentForMessage(agent, message));
    }
  }

  return {
    agents: agents.length,
    candidates,
    launched: runs.length,
    completed: runs.filter(run => run.status === 'completed').length,
    failed: runs.filter(run => run.status === 'failed').length,
    skipped: runs.filter(run => run.status === 'skipped').length,
    runs,
  };
}

export async function runBusAgentDaemonLoop({ channel, interval_ms, once = false }) {
  const sleepMs = normalizeInteger(interval_ms, getBusPollMs());
  if (once) return runBusAgentDaemonOnce({ channel });
  while (true) {
    await runBusAgentDaemonOnce({ channel });
    await sleep(sleepMs);
  }
}
