#!/usr/bin/env node

import { readFileSync } from 'fs';
import { lockPreferredNodeRuntime } from '../src/cli/runtime-node.js';
import 'dotenv/config';

await lockPreferredNodeRuntime(import.meta.url);

function readHookInput() {
  if (process.stdin.isTTY) return {};
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8').trim();
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EAGAIN') return {};
    throw error;
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function readFlag(args, name, fallback) {
  const index = args.findIndex(arg => arg === name || arg.startsWith(`${name}=`));
  if (index === -1) return fallback;
  const arg = args[index];
  if (arg.includes('=')) return arg.split('=').slice(1).join('=');
  return args[index + 1] ?? fallback;
}

const args = process.argv.slice(2);
const agent = readFlag(args, '--agent');
if (!agent) {
  console.error('Usage: bus-autobind --agent <claude|codex>');
  process.exit(1);
}

const hookInput = readHookInput();
const cwd = hookInput.cwd || process.cwd();

const { autobind } = await import('../src/bus/autobind.js');
const result = autobind({ agent, cwd });

const hookEventName =
  readFlag(args, '--hook-event')
  || hookInput.hook_event_name
  || hookInput.hookEventName
  || hookInput.hookSpecificOutput?.hookEventName;

if (hookEventName || Object.keys(hookInput).length > 0) {
  // Hook mode is side-effect only. Stay quiet so Codex/Claude only need to
  // validate hook JSON from the actual notification hook, not autobind.
} else {
  console.log(JSON.stringify(result, null, 2));
}
