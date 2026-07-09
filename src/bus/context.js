import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { getBusHome } from './config.js';

export function normalizeCwd(cwd) {
  const value = typeof cwd === 'string' ? cwd.trim() : '';
  if (!value) return '';
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

function requireText(value, name) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function getBindingsDir() {
  return join(getBusHome(), 'bindings');
}

function getBindingPath(agent, cwd) {
  const normalizedAgent = requireText(agent, 'agent');
  const normalizedCwd = normalizeCwd(requireText(cwd, 'cwd'));
  const hash = createHash('sha256').update(normalizedCwd).digest('hex');
  return join(getBindingsDir(), `${normalizedAgent}-${hash}.json`);
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeSubscriptions(binding) {
  if (!binding || typeof binding !== 'object') return [];
  if (Array.isArray(binding.subscriptions)) {
    return binding.subscriptions
      .map(subscription => {
        try {
          return {
            channel: requireText(subscription.channel, 'channel'),
            reader: requireText(subscription.reader, 'reader'),
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
  if (binding.channel && binding.reader) {
    return [{
      channel: requireText(binding.channel, 'channel'),
      reader: requireText(binding.reader, 'reader'),
    }];
  }
  return [];
}

function readBindingFile(agent, cwd) {
  const binding = readJson(getBindingPath(agent, cwd));
  if (!binding) return null;
  const subscriptions = normalizeSubscriptions(binding);
  if (subscriptions.length === 0) return null;
  return {
    agent: requireText(binding.agent || agent, 'agent'),
    cwd: normalizeCwd(requireText(binding.cwd || cwd, 'cwd')),
    subscriptions,
    updated_at: binding.updated_at || null,
  };
}

export function writeBusBinding({ agent, cwd, channel, reader }) {
  const normalizedAgent = requireText(agent, 'agent');
  const normalizedCwd = normalizeCwd(requireText(cwd, 'cwd'));
  const nextSubscription = {
    channel: requireText(channel, 'channel'),
    reader: requireText(reader, 'reader'),
  };
  const existing = readBindingFile(normalizedAgent, normalizedCwd);
  const subscriptions = existing?.subscriptions ?? [];
  const remaining = subscriptions.filter(subscription => subscription.channel !== nextSubscription.channel);
  const binding = {
    agent: normalizedAgent,
    cwd: normalizedCwd,
    subscriptions: [...remaining, nextSubscription],
    updated_at: new Date().toISOString(),
  };
  const path = getBindingPath(normalizedAgent, normalizedCwd);
  mkdirSync(getBindingsDir(), { recursive: true });
  writeFileSync(path, JSON.stringify(binding, null, 2) + '\n', 'utf8');
  return binding;
}

export function readBusBinding({ agent, cwd }) {
  const normalizedAgent = requireText(agent, 'agent');
  let current = normalizeCwd(requireText(cwd, 'cwd'));
  while (current) {
    const binding = readBindingFile(normalizedAgent, current);
    if (binding) {
      return {
        agent: normalizedAgent,
        cwd: current,
        subscriptions: binding.subscriptions,
        updated_at: binding.updated_at || null,
      };
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function clearBusBinding({ agent, cwd, channel }) {
  const normalizedAgent = requireText(agent, 'agent');
  const normalizedCwd = normalizeCwd(requireText(cwd, 'cwd'));
  const path = getBindingPath(normalizedAgent, normalizedCwd);
  if (!existsSync(path)) return;
  if (!channel) {
    rmSync(path, { force: true });
    return;
  }

  const binding = readBindingFile(normalizedAgent, normalizedCwd);
  if (!binding) {
    rmSync(path, { force: true });
    return;
  }

  const remaining = binding.subscriptions.filter(subscription => subscription.channel !== channel);
  if (remaining.length === 0) {
    rmSync(path, { force: true });
    return;
  }

  writeFileSync(path, JSON.stringify({
    agent: normalizedAgent,
    cwd: normalizedCwd,
    subscriptions: remaining,
    updated_at: new Date().toISOString(),
  }, null, 2) + '\n', 'utf8');
}
