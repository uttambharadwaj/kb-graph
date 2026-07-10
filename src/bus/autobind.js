import { existsSync, realpathSync } from 'fs';
import { dirname, basename } from 'path';
import { execFileSync } from 'child_process';
import { readBusBinding, writeBusBinding } from './context.js';
import { getTicketRegex } from './config.js';

function normalizeCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return '';
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

export function findTicketInPath(cwd) {
  const re = getTicketRegex();
  let current = normalizeCwd(cwd);
  while (current) {
    const match = re.exec(basename(current));
    if (match) {
      return { ticket: match[1] ?? match[0], matched: match[0], anchor: current };
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function findTicketInGitBranch(cwd) {
  const dir = normalizeCwd(cwd);
  if (!dir || !existsSync(dir)) return null;
  try {
    const branch = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = getTicketRegex().exec(branch);
    if (!match) return null;
    const topLevel = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { ticket: match[1] ?? match[0], matched: match[0], anchor: normalizeCwd(topLevel) };
  } catch {
    return null;
  }
}

function defaultReader(agent) {
  const role = (process.env.CLAUDE_BUS_ROLE || '').trim();
  if (role) return `${agent}:${role}`;
  return `${agent}:operator`;
}

export function autobind({ agent, cwd, env = process.env }) {
  if (!agent) return { bound: false, reason: 'missing-agent' };
  const dir = normalizeCwd(cwd);
  if (!dir) return { bound: false, reason: 'missing-cwd' };

  const existing = readBusBinding({ agent, cwd: dir });
  if (existing) {
    return { bound: false, reason: 'existing-binding', cwd: existing.cwd };
  }

  const discovered = findTicketInPath(dir) ?? findTicketInGitBranch(dir);
  if (!discovered) return { bound: false, reason: 'no-ticket' };

  const channel = 'ws:' + discovered.matched.toLowerCase();
  const role = (env.CLAUDE_BUS_ROLE || '').trim();
  const reader = role ? `${agent}:${role}` : defaultReader(agent);

  const binding = writeBusBinding({
    agent,
    cwd: discovered.anchor,
    channel,
    reader,
  });

  return {
    bound: true,
    channel,
    reader,
    cwd: binding.cwd,
    source: findTicketInPath(dir) ? 'path' : 'git-branch',
  };
}
