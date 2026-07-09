import { readFileSync } from 'fs';
import { spawn } from 'child_process';
import { clearBusBinding, readBusBinding, writeBusBinding } from './context.js';
import {
  clearBusNotifierPid,
  clearBusPending,
  readBusNotifierPid,
  readBusPending,
  writeBusNotifierPid,
  writeBusPending,
} from './pending.js';
import {
  advanceBusNotifications,
  formatBusNotificationDigest,
  readBusInbox,
  readBusNotifications,
  readBusStatus,
  sendBusMessage,
} from './service.js';
import {
  listBusDeliveries,
  listBusSessions,
  registerBusSession,
  runBusGatewayLoop,
  runBusGatewayOnce,
} from './gateway.js';
import {
  listBusAgents,
  listBusRuns,
  registerBusAgent,
  runBusAgentDaemonLoop,
  runBusAgentDaemonOnce,
} from './agentd.js';

function readHookInput() {
  if (process.stdin.isTTY) return {};
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8').trim();
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EAGAIN') {
      return {};
    }
    throw error;
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function readFlag(args, name, fallback = undefined) {
  const index = args.findIndex(arg => arg === name || arg.startsWith(`${name}=`));
  if (index === -1) return fallback;
  const arg = args[index];
  if (arg.includes('=')) return arg.split('=').slice(1).join('=');
  return args[index + 1] ?? fallback;
}

function readRepeatedFlag(args, name) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (current === name) {
      if (args[i + 1] !== undefined) values.push(args[i + 1]);
      i += 1;
    } else if (current.startsWith(`${name}=`)) {
      values.push(current.split('=').slice(1).join('='));
    }
  }
  return values;
}

function removeFlags(args, names, booleanNames = []) {
  const output = [];
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    const booleanFlag = booleanNames.find(name => current === name);
    if (booleanFlag) continue;

    const flag = names.find(name => current === name || current.startsWith(`${name}=`));
    if (!flag) {
      output.push(current);
      continue;
    }
    if (current === flag) i += 1;
  }
  return output;
}

function parseJsonObjectFlag(raw, flagName) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('must be a JSON object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`${flagName} must be valid JSON object: ${error.message}`);
  }
}

function splitListFlag(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return undefined;
  return text.split(',').map(item => item.trim()).filter(Boolean);
}

function mergeMetadataJson(metadataJson, extra) {
  const entries = Object.entries(extra).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== null && value !== '';
  });
  if (entries.length === 0) return metadataJson;
  return JSON.stringify({
    ...parseJsonObjectFlag(metadataJson, '--metadata'),
    ...Object.fromEntries(entries),
  });
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printHookJson(hookEventName, additionalContext = '') {
  if (!additionalContext) return;
  printJson({
    hookSpecificOutput: {
      hookEventName,
      additionalContext,
    },
  });
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function collectCurrentBusDigest({ agent, cwd, pendingOnly = false }) {
  const binding = readBusBinding({ agent, cwd });
  if (!binding) {
    return { agent, cwd, binding: null, notifications: [], digest: '', total_new: 0, pending: null };
  }

  const pending = readBusPending({ agent, cwd: binding.cwd });
  if (pendingOnly && !pending) {
    return { agent, cwd, binding, notifications: [], digest: '', total_new: 0, pending: null };
  }

  const notifications = binding.subscriptions.map(subscription => readBusNotifications({
    channel: subscription.channel,
    reader: subscription.reader,
    limit: 5,
    preview_chars: 80,
  }));
  const digests = notifications
    .map(notification => formatBusNotificationDigest(notification))
    .filter(Boolean);

  return {
    agent,
    cwd,
    binding,
    notifications,
    digest: digests.join('\n\n'),
    total_new: notifications.reduce((sum, notification) => sum + notification.total_new, 0),
    pending,
  };
}

export async function runBusSendCli(args) {
  const sender = readFlag(args, '--sender', process.env.KB_BUS_SENDER || process.env.USER || 'cli');
  const kind = readFlag(args, '--kind', 'message');
  const thread = readFlag(args, '--thread');
  const reply_to = readFlag(args, '--reply-to');
  const recipient = readFlag(args, '--recipient', readFlag(args, '--to'));
  const deadline = readFlag(args, '--deadline');
  const metadataFlag = readFlag(args, '--metadata');
  const expects_reply = args.includes('--expects-reply') ? true : undefined;
  const metadata_json = mergeMetadataJson(metadataFlag, {
    status: readFlag(args, '--status'),
    step: readFlag(args, '--step'),
    files_touched: splitListFlag(readFlag(args, '--files')),
    diff_since_last_ack: readFlag(args, '--diff-since-last-ack'),
    ack_decision: readFlag(args, '--ack-decision'),
    ack_message_id: readFlag(args, '--ack-message-id'),
    control_command: readFlag(args, '--control-command'),
    tests: splitListFlag(readFlag(args, '--tests')),
    risk: readFlag(args, '--risk'),
  });
  const valueFlags = [
    '--sender', '--kind', '--thread', '--reply-to', '--recipient', '--to', '--deadline', '--metadata',
    '--status', '--step', '--files', '--diff-since-last-ack', '--ack-decision', '--ack-message-id',
    '--control-command', '--tests', '--risk',
  ];
  const positional = removeFlags(args, valueFlags, ['--expects-reply']);
  const [channel, ...messageParts] = positional;
  const message = messageParts.join(' ').trim();

  if (!channel || !message) {
    console.error('Usage: bus-send <channel> <message> [--sender <name>] [--kind <kind>] [--thread <thread>] [--reply-to <id>] [--recipient <reader>] [--deadline <iso8601>] [--expects-reply] [--metadata <json>] [--status <text>] [--step <text>] [--files <a,b>] [--diff-since-last-ack <text>] [--ack-decision accepted|needs_changes|blocked] [--ack-message-id <id>] [--control-command pause|stop|redirect|resume] [--tests <cmd,...>] [--risk <text>]');
    process.exit(1);
  }

  printJson(sendBusMessage({
    channel,
    sender,
    message,
    kind,
    thread,
    reply_to,
    recipient,
    deadline,
    expects_reply,
    metadata_json,
  }));
}

export async function runBusStatusCli(args) {
  const readers = [];
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (current === '--reader') readers.push(args[i + 1]);
    if (current.startsWith('--reader=')) readers.push(current.split('=').slice(1).join('='));
  }
  const positional = removeFlags(args, ['--reader']);
  const [channel] = positional;

  if (!channel) {
    console.error('Usage: bus-status <channel> [--reader <name>]...');
    process.exit(1);
  }

  printJson(readBusStatus({ channel, readers }));
}

export async function runBusSessionCli(args) {
  const command = args[0];
  const rest = args.slice(1);
  if (command === 'list') {
    const channel = readFlag(rest, '--channel');
    const reader = readFlag(rest, '--reader');
    const positional = removeFlags(rest, ['--channel', '--reader']);
    printJson(listBusSessions({ channel: channel ?? positional[0], reader }));
    return;
  }

  if (command === 'register') {
    const reader = readFlag(rest, '--reader');
    const agent = readFlag(rest, '--agent');
    const adapter = readFlag(rest, '--adapter', 'hook');
    const cwd = readFlag(rest, '--cwd', process.cwd());
    const id = readFlag(rest, '--id');
    const tmux_pane = readFlag(rest, '--tmux-pane');
    const acp_session_id = readFlag(rest, '--acp-session-id');
    const pid = readFlag(rest, '--pid');
    const status = readFlag(rest, '--status', 'registered');
    const positional = removeFlags(rest, [
      '--reader', '--agent', '--adapter', '--cwd', '--id', '--tmux-pane', '--acp-session-id', '--pid', '--status',
    ]);
    const [channel] = positional;

    if (!channel || !reader || !agent) {
      console.error('Usage: bus-session register <channel> --reader <name> --agent <claude|codex|gemini> [--adapter hook|noop] [--cwd <path>] [--id <session-id>]');
      process.exit(1);
    }

    printJson(registerBusSession({
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
    }));
    return;
  }

  if (command === 'deliveries') {
    printJson(listBusDeliveries({
      channel: readFlag(rest, '--channel'),
      session_id: readFlag(rest, '--session-id'),
    }));
    return;
  }

  console.error('Usage: bus-session register <channel> --reader <name> --agent <agent> [--adapter hook|noop] | bus-session list [channel] | bus-session deliveries [--channel <channel>] [--session-id <id>]');
  process.exit(1);
}

export async function runBusGatewayCli(args) {
  const channel = readFlag(args, '--channel');
  const interval_ms = readFlag(args, '--interval-ms', '1000');
  const once = args.includes('--once');
  const serve = args.includes('--serve');
  const positional = removeFlags(args, ['--channel', '--interval-ms'], ['--once', '--serve']);
  const targetChannel = channel ?? positional[0];

  if (once) {
    printJson(runBusGatewayOnce({ channel: targetChannel }));
    return;
  }

  if (!serve) {
    console.error('Usage: bus-gateway [--channel <channel>] --once | --serve [--interval-ms <ms>]');
    process.exit(1);
  }

  await runBusGatewayLoop({ channel: targetChannel, interval_ms });
}

export async function runBusAgentCli(args) {
  const commandName = args[0];
  const rest = args.slice(1);
  if (commandName === 'list') {
    const channel = readFlag(rest, '--channel');
    const reader = readFlag(rest, '--reader');
    const positional = removeFlags(rest, ['--channel', '--reader']);
    printJson(listBusAgents({ channel: channel ?? positional[0], reader }));
    return;
  }

  if (commandName === 'runs') {
    printJson(listBusRuns({
      channel: readFlag(rest, '--channel'),
      agent_id: readFlag(rest, '--agent-id'),
    }));
    return;
  }

  if (commandName === 'register') {
    const reader = readFlag(rest, '--reader');
    const agent = readFlag(rest, '--agent');
    const adapter = readFlag(rest, '--adapter', 'exec');
    const cwd = readFlag(rest, '--cwd', process.cwd());
    const id = readFlag(rest, '--id');
    const command = readFlag(rest, '--command');
    const args_json = readFlag(rest, '--args-json');
    const argsList = readRepeatedFlag(rest, '--arg');
    const prompt_template = readFlag(rest, '--prompt-template');
    const max_concurrency = readFlag(rest, '--max-concurrency', '1');
    const cooldown_ms = readFlag(rest, '--cooldown-ms', '0');
    const status = readFlag(rest, '--status', 'enabled');
    const positional = removeFlags(rest, [
      '--reader', '--agent', '--adapter', '--cwd', '--id', '--command', '--args-json',
      '--arg', '--prompt-template', '--max-concurrency', '--cooldown-ms', '--status',
    ]);
    const [channel] = positional;

    if (!channel || !reader || !agent) {
      console.error('Usage: bus-agent register <channel> --reader <name> --agent <claude|codex> [--command <cmd>] [--arg <arg>...] [--args-json <json-array>]');
      process.exit(1);
    }

    printJson(registerBusAgent({
      id,
      channel,
      reader,
      agent,
      adapter,
      cwd,
      command,
      args: argsList,
      args_json,
      prompt_template,
      max_concurrency,
      cooldown_ms,
      status,
    }));
    return;
  }

  console.error('Usage: bus-agent register <channel> --reader <name> --agent <agent> [--command <cmd>] [--arg <arg>...] | bus-agent list [channel] | bus-agent runs [--channel <channel>] [--agent-id <id>]');
  process.exit(1);
}

export async function runBusAgentdCli(args) {
  const channel = readFlag(args, '--channel');
  const interval_ms = readFlag(args, '--interval-ms', '1000');
  const limit = readFlag(args, '--limit', '50');
  const once = args.includes('--once');
  const dry_run = args.includes('--dry-run');
  const serve = args.includes('--serve');
  const positional = removeFlags(args, ['--channel', '--interval-ms', '--limit'], ['--once', '--serve', '--dry-run']);
  const targetChannel = channel ?? positional[0];

  if (once || dry_run) {
    printJson(await runBusAgentDaemonOnce({ channel: targetChannel, limit, dry_run }));
    return;
  }

  if (!serve) {
    console.error('Usage: bus-agentd [--channel <channel>] --once | --dry-run | --serve [--interval-ms <ms>]');
    process.exit(1);
  }

  await runBusAgentDaemonLoop({ channel: targetChannel, interval_ms });
}

export async function runBusReadCli(args) {
  const reader = readFlag(args, '--reader');
  const limit = readFlag(args, '--limit', '50');
  const timeout_ms = readFlag(args, '--timeout-ms', '30000');
  const wait = args.includes('--wait');
  const peek = args.includes('--peek');
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (current === '--wait' || current === '--peek') continue;
    const flagWithValue = ['--reader', '--limit', '--timeout-ms'].find(
      name => current === name || current.startsWith(`${name}=`)
    );
    if (flagWithValue) {
      if (current === flagWithValue) i += 1;
      continue;
    }
    positional.push(current);
  }
  const [channel] = positional;

  if (!channel || !reader) {
    console.error('Usage: bus-read <channel> --reader <name> [--wait] [--timeout-ms <ms>] [--limit <n>] [--peek]');
    process.exit(1);
  }

  printJson(await readBusInbox({
    channel,
    reader,
    wait,
    timeout_ms: Number(timeout_ms),
    limit: Number(limit),
    peek,
  }));
}

export async function runBusHookCli(args) {
  const reader = readFlag(args, '--reader');
  const limit = readFlag(args, '--limit', '5');
  const preview_chars = readFlag(args, '--preview-chars', '80');
  const format = readFlag(args, '--format', 'hook');
  const hookEventName = readFlag(args, '--hook-event', 'UserPromptSubmit');
  const capabilities_json = readFlag(args, '--capabilities');
  const dryRun = args.includes('--dry-run');
  const positional = removeFlags(args, ['--reader', '--limit', '--preview-chars', '--format', '--hook-event', '--capabilities']);
  const filtered = positional.filter(arg => arg !== '--dry-run');
  const [channel] = filtered;

  if (!channel || !reader) {
    console.error('Usage: bus-hook <channel> --reader <name> [--format hook|json|text] [--limit <n>] [--preview-chars <n>] [--hook-event <name>] [--capabilities <json>] [--dry-run]');
    process.exit(1);
  }

  const notifications = readBusNotifications({
    channel,
    reader,
    limit: Number(limit),
    preview_chars: Number(preview_chars),
  });

  if (!dryRun) {
    advanceBusNotifications({ channel, reader, to_id: notifications.advanced_to, capabilities_json });
  }

  if (format === 'json') {
    printJson(notifications);
    return;
  }

  const digest = formatBusNotificationDigest(notifications);
  if (format === 'text') {
    if (digest) console.log(digest);
    return;
  }

  printHookJson(hookEventName, digest);
}

export async function runBusBindCli(args) {
  const reader = readFlag(args, '--reader');
  const agent = readFlag(args, '--agent');
  const list = args.includes('--list');
  const positional = removeFlags(args, ['--reader', '--agent']);
  const [channel] = positional;
  const cwd = process.cwd();

  if (!agent) {
    console.error('Usage: bus-bind <channel> --reader <name> --agent <claude|codex> | bus-bind --list --agent <claude|codex>');
    process.exit(1);
  }

  if (list) {
    printJson(readBusBinding({ agent, cwd }) ?? { agent, cwd, subscriptions: [] });
    return;
  }

  if (!channel || !reader) {
    console.error('Usage: bus-bind <channel> --reader <name> --agent <claude|codex>');
    process.exit(1);
  }

  printJson(writeBusBinding({ agent, cwd, channel, reader }));
}

export async function runBusUnbindCli(args) {
  const agent = readFlag(args, '--agent');
  const channel = readFlag(args, '--channel');
  const cwd = process.cwd();
  if (!agent) {
    console.error('Usage: bus-unbind --agent <claude|codex> [--channel <channel>]');
    process.exit(1);
  }
  clearBusBinding({ agent, cwd, channel });
  printJson({ ok: true, agent, cwd, channel: channel || null });
}

export async function runBusHookCurrentCli(args) {
  const agent = readFlag(args, '--agent');
  const format = readFlag(args, '--format', 'hook');
  const hookEventName = readFlag(args, '--hook-event', 'UserPromptSubmit');
  const capabilities_json = readFlag(args, '--capabilities');
  const dryRun = args.includes('--dry-run');
  const pendingOnly = args.includes('--pending-only');
  const hookInput = readHookInput();
  const cwd = hookInput.cwd || process.cwd();

  if (!agent) {
    console.error('Usage: bus-hook-current --agent <claude|codex> [--hook-event <name>] [--format hook|json|text] [--dry-run] [--pending-only]');
    process.exit(1);
  }

  const { binding, notifications, digest, total_new, pending } = collectCurrentBusDigest({ agent, cwd, pendingOnly });
  if (!binding) {
    if (format === 'json') {
      printJson({ agent, cwd, binding: null, total_new: 0 });
      return;
    }
    if (format === 'text') return;
    printHookJson(hookEventName, '');
    return;
  }

  if (!dryRun) {
    notifications.forEach(notification => {
      advanceBusNotifications({
        channel: notification.channel,
        reader: notification.reader,
        to_id: notification.advanced_to,
        capabilities_json,
      });
    });
    clearBusPending({ agent, cwd: binding.cwd });
  }

  if (format === 'json') {
    printJson({
      agent,
      cwd,
      binding,
      notifications,
      total_new,
      pending: Boolean(pending),
    });
    return;
  }

  if (format === 'text') {
    if (digest) console.log(digest);
    return;
  }

  printHookJson(hookEventName, digest);
}

export async function runBusNotifierCli(args) {
  const agent = readFlag(args, '--agent');
  const interval_ms = Number(readFlag(args, '--interval-ms', '1000'));
  const hookInput = readHookInput();
  const cwd = readFlag(args, '--cwd', hookInput.cwd || process.cwd());
  const once = args.includes('--once');
  const daemonize = args.includes('--daemonize');
  const serve = args.includes('--serve');

  if (!agent) {
    console.error('Usage: bus-notifier --agent <claude|codex> [--cwd <path>] [--interval-ms <ms>] [--once|--daemonize|--serve]');
    process.exit(1);
  }

  const state = collectCurrentBusDigest({ agent, cwd, pendingOnly: false });
  const scopeCwd = state.binding?.cwd || cwd;

  if (daemonize) {
    const existingPid = readBusNotifierPid({ agent, cwd: scopeCwd });
    if (existingPid && isPidAlive(existingPid)) {
      printJson({ ok: true, agent, cwd: scopeCwd, pid: existingPid, started: false });
      return;
    }
    clearBusNotifierPid({ agent, cwd: scopeCwd });
    const childArgs = process.argv[1].endsWith('kb.js')
      ? [process.argv[1], 'bus-notifier', '--agent', agent, '--cwd', cwd, '--interval-ms', String(interval_ms), '--serve']
      : [process.argv[1], '--agent', agent, '--cwd', cwd, '--interval-ms', String(interval_ms), '--serve'];
    const child = spawn(process.execPath, childArgs, {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    writeBusNotifierPid({ agent, cwd: scopeCwd, pid: child.pid });
    printJson({ ok: true, agent, cwd: scopeCwd, pid: child.pid, started: true });
    return;
  }

  const syncPending = () => {
    const current = collectCurrentBusDigest({ agent, cwd, pendingOnly: false });
    const currentScope = current.binding?.cwd || cwd;
    if (!current.binding || !current.digest) {
      clearBusPending({ agent, cwd: currentScope });
      return {
        agent,
        cwd: currentScope,
        binding: current.binding,
        total_new: current.total_new,
        pending: false,
      };
    }

    const payload = writeBusPending({
      agent,
      cwd: current.binding.cwd,
      digest: current.digest,
      total_new: current.total_new,
      channels: current.binding.subscriptions.map(subscription => subscription.channel),
    });
    return {
      agent,
      cwd: current.binding.cwd,
      binding: current.binding,
      total_new: current.total_new,
      pending: true,
      pending_state: payload,
    };
  };

  if (once) {
    printJson(syncPending());
    return;
  }

  if (!serve) {
    console.error('Usage: bus-notifier --agent <claude|codex> [--cwd <path>] [--interval-ms <ms>] [--once|--daemonize|--serve]');
    process.exit(1);
  }

  writeBusNotifierPid({ agent, cwd: scopeCwd, pid: process.pid });
  const cleanup = () => clearBusNotifierPid({ agent, cwd: scopeCwd });
  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  const sleepMs = Number.isFinite(interval_ms) && interval_ms > 0 ? interval_ms : 1000;
  while (true) {
    syncPending();
    await new Promise(resolve => setTimeout(resolve, sleepMs));
  }
}
