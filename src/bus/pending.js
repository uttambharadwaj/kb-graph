import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getBusHome } from './config.js';
import { normalizeCwd } from './context.js';

function requireText(value, name) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function getScopedPath(dirName, agent, cwd, extension = 'json') {
  const normalizedAgent = requireText(agent, 'agent');
  const normalizedCwd = normalizeCwd(requireText(cwd, 'cwd'));
  const hash = createHash('sha256').update(normalizedCwd).digest('hex');
  return join(getBusHome(), dirName, `${normalizedAgent}-${hash}.${extension}`);
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function getBusPendingPath({ agent, cwd }) {
  return getScopedPath('pending', agent, cwd);
}

export function readBusPending({ agent, cwd }) {
  return readJson(getBusPendingPath({ agent, cwd }));
}

export function writeBusPending({ agent, cwd, digest, total_new = 0, channels = [] }) {
  const path = getBusPendingPath({ agent, cwd });
  mkdirSync(join(getBusHome(), 'pending'), { recursive: true });
  const payload = {
    agent: requireText(agent, 'agent'),
    cwd: normalizeCwd(requireText(cwd, 'cwd')),
    digest: String(digest ?? ''),
    total_new: Number(total_new) || 0,
    channels: Array.isArray(channels) ? channels : [],
    updated_at: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}

export function clearBusPending({ agent, cwd }) {
  rmSync(getBusPendingPath({ agent, cwd }), { force: true });
}

export function getBusNotifierPidPath({ agent, cwd }) {
  return getScopedPath('notifiers', agent, cwd, 'pid');
}

export function readBusNotifierPid({ agent, cwd }) {
  const path = getBusNotifierPidPath({ agent, cwd });
  if (!existsSync(path)) return null;
  const value = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function writeBusNotifierPid({ agent, cwd, pid }) {
  const path = getBusNotifierPidPath({ agent, cwd });
  mkdirSync(join(getBusHome(), 'notifiers'), { recursive: true });
  writeFileSync(path, `${Number(pid) || process.pid}\n`, 'utf8');
}

export function clearBusNotifierPid({ agent, cwd }) {
  rmSync(getBusNotifierPidPath({ agent, cwd }), { force: true });
}
