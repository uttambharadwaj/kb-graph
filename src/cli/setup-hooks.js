// src/cli/setup-hooks.js — install KB briefing/hint hooks into an agent's hook config
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, renameSync } from 'fs';
import { isVersionPinned } from './runtime-node.js';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { AGENT, AGENT_FLAG, AGENTS } from '../process-ancestry.js';

// Where each agent keeps its hook config, relative to home. Claude Code's
// settings.json holds its whole configuration and Codex's hooks.json holds
// only hooks, but both carry the same `hooks` block shape, which is the only
// part anything here touches.
export const HOOK_FILES = {
  [AGENT.CLAUDE]: ['.claude', 'settings.json'],
  [AGENT.CODEX]: ['.codex', 'hooks.json'],
  [AGENT.CURSOR]: ['.cursor', 'hooks.json'],
};

// Cursor's hooks.json differs in shape, not just path: camelCase event
// names, flat `{command}` entries instead of `{hooks:[{type,command}]}`,
// and a top-level `version`. Only sessionStart is installed there —
// beforeSubmitPrompt has no context field and preToolUse only relays
// agent_message on deny, so hints and trigger warnings have no channel.
const FLAT_HOOK_AGENTS = new Set([AGENT.CURSOR]);
const PUSH_AGENTS = [AGENT.CLAUDE, AGENT.CODEX];

function hookFilePath(agent, home = homedir()) {
  const parts = HOOK_FILES[agent];
  if (!parts) throw new Error(`No hook config file known for agent: ${agent}`);
  return join(home, ...parts);
}

// Every agent hook file, whether or not it exists — callers that read decide
// what an absent file means.
const agentHookFiles = (home = homedir()) =>
  AGENTS.filter(agent => HOOK_FILES[agent]).map(agent => ({ agent, path: hookFilePath(agent, home) }));

// `script`, when present, is preferred over `subcommand`: it installs
// `${nodeBin} <dir-of-kbJsPath>/<script>` instead of
// `${nodeBin} ${kbJsPath} <subcommand>`. trigger-hook runs on every Bash call
// (~227/session median) and bin/kb.js's own dispatch machinery (flags.js,
// schema.js, runtime-node.js's re-exec check) costs real latency before
// reaching any command — bin/kb-trigger-hook.js skips all of that. `kb
// trigger-hook` (bin/kb.js) still exists as the debuggable manual-invocation
// path; only the installed hook command uses the thin entry.
//
// The PreToolUse spec carries BOTH fields: `subcommand` stays so `identifies`
// still recognizes an install from before the thin entry existed (a real
// prior commit of this stack installed `kb.js trigger-hook`) and doesn't
// double-install over it — only `commandFor`'s preference for `script` over
// `subcommand` decides what a NEW install writes.
//
// `agents` is the allowlist for the spec: the PreToolUse trigger hook is
// Claude-only until slice-1 telemetry shows Codex acts on what it is already
// handed (brief §4 Q2). `matcher` is one string when every agent shares it,
// or a per-agent map: Codex's SessionStart sources are startup|resume|clear —
// it has no `compact` source, since PreCompact/PostCompact are their own
// events there.
const HOOK_SPECS = [
  {
    event: 'PreCompact',
    matcher: 'manual|auto',
    subcommand: 'precompact-hook',
    agents: [AGENT.CLAUDE],
    // The pre-2026-08-26 inline hook printed these phrases as plain stdout.
    // Current Claude Code parses PreCompact stdout as decision JSON, so this
    // exact install must be replaced rather than left beside the silent hook.
    legacy: command => command.includes('CRITICAL PRESERVATION INSTRUCTIONS FOR THIS SUMMARY:')
      && command.includes('Git state at compaction:'),
  },
  {
    event: 'SessionStart',
    eventName: { [AGENT.CURSOR]: 'sessionStart' },
    matcher: { [AGENT.CLAUDE]: 'startup|resume|clear|compact', [AGENT.CODEX]: 'startup|resume|clear' },
    subcommand: 'wakeup-hook',
    agents: AGENTS,
  },
  { event: 'UserPromptSubmit', matcher: null, subcommand: 'prompt-hint', agents: PUSH_AGENTS },
  // Codex included since 2026-08-24 (full push parity): its PreToolUse payload is
  // Claude-shaped (tool_name/tool_input) and the emission envelope is the same.
  { event: 'PreToolUse', matcher: 'Bash', script: 'kb-trigger-hook.js', subcommand: 'trigger-hook', agents: PUSH_AGENTS },
];

const matcherFor = (spec, agent) =>
  (spec.matcher && typeof spec.matcher === 'object') ? (spec.matcher[agent] ?? null) : (spec.matcher ?? null);

const eventFor = (spec, agent) => spec.eventName?.[agent] ?? spec.event;

// Every command in a hook group, whichever shape the file uses.
const groupCommands = (group) => (group.hooks ?? [group]).map(h => h.command);

// Claude is the flag's default (every hook installed before the flag existed
// passes nothing — see readAgentFlag), so its command carries no `--agent`.
const agentSuffix = (agent) => agent === AGENT.CLAUDE ? '' : ` ${AGENT_FLAG} ${agent}`;

const commandFor = (spec, { nodeBin, kbJsPath, agent }) => (spec.script
  ? `${nodeBin} ${join(dirname(kbJsPath), spec.script)}`
  : `${nodeBin} ${kbJsPath} ${spec.subcommand}`) + agentSuffix(agent);

// The agent a command was installed for, read the same way readAgentFlag
// reads it at runtime: the flag when present, claude otherwise.
const AGENT_IN_COMMAND = new RegExp(`\\s${AGENT_FLAG}[\\s=]+(\\S+)`);

const agentOf = (command) => command.match(AGENT_IN_COMMAND)?.[1] ?? AGENT.CLAUDE;

// The identity a command must end with to count as "this spec already
// installed", once its `--agent` flag is set aside. Checks the script form
// first (the script's own filename — the full path always ends with it, so
// this works whether kbJsPath is the dev checkout or a deployed one), then
// the subcommand form (the trailing token), so either a current or a legacy
// install is recognized and neither gets duplicated.
//
// The agent is part of the identity, not noise to strip: the Claude command
// and the Codex command differ only by the flag, and treating them as one
// hook would silently skip installing the second if both ever landed in one
// file.
const identifies = (spec, command, agent) => {
  const cmd = command ?? '';
  if (agentOf(cmd) !== agent) return false;
  const base = cmd.replace(AGENT_IN_COMMAND, '').trimEnd();
  if (spec.script && base.endsWith(spec.script)) return true;
  if (spec.subcommand && base.endsWith(` ${spec.subcommand}`)) return true;
  return false;
};

// Pure merge: dedup by the spec's own identity so re-runs and prior manual installs never duplicate.
export function mergeAgentHooks(settings, { nodeBin, kbJsPath, agent = AGENT.CLAUDE }) {
  const next = structuredClone(settings ?? {});
  next.hooks = next.hooks ?? {};
  const flat = FLAT_HOOK_AGENTS.has(agent);
  if (flat) next.version = next.version ?? 1;
  for (const spec of HOOK_SPECS) {
    if (!spec.agents.includes(agent)) continue;
    const event = eventFor(spec, agent);
    const entries = (next.hooks[event] = next.hooks[event] ?? []);
    if (spec.legacy) {
      for (let i = entries.length - 1; i >= 0; i--) {
        entries[i].hooks = (entries[i].hooks ?? []).filter(hook => !spec.legacy(hook.command ?? ''));
        if (entries[i].hooks.length === 0) entries.splice(i, 1);
      }
    }
    const already = entries.some(e => groupCommands(e).some(c => identifies(spec, c, agent)));
    if (already) continue;
    const command = commandFor(spec, { nodeBin, kbJsPath, agent });
    const entry = flat ? { command } : { hooks: [{ type: 'command', command }] };
    const matcher = matcherFor(spec, agent);
    if (matcher) entry.matcher = matcher;
    entries.push(entry);
  }
  return next;
}

export function installAgentHooks({ home, nodeBin, kbJsPath, agent = AGENT.CLAUDE }) {
  const path = hookFilePath(agent, home);
  mkdirSync(dirname(path), { recursive: true });
  let settings = {};
  let backup = null;
  if (existsSync(path)) {
    // Parse before backup/write: a malformed file must abort with zero side effects.
    try {
      settings = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`Cannot parse ${path}: ${err.message} — fix or remove the file and re-run setup`, { cause: err });
    }
    backup = `${path}.kb-backup`;
    copyFileSync(path, backup);
  }
  const json = JSON.stringify(mergeAgentHooks(settings, { nodeBin, kbJsPath, agent }), null, 2) + '\n';
  // Write-to-temp-then-rename so a crash can't half-write the config.
  writeFileSync(`${path}.kb-tmp`, json);
  renameSync(`${path}.kb-tmp`, path);
  return { path, backup };
}

// Hook commands whose absolute paths no longer exist.
//
// A hook is a fire-and-forget subprocess: the host runs it, ignores what it
// prints, and carries on. So a command naming a checkout that has moved, or a
// Node binary a `brew upgrade` replaced, fails identically to one that had
// nothing to say — and the surface it powers goes quiet with nothing anywhere
// reporting it.
//
// One level of indirection is followed, because that is where this has actually
// bitten: the hook command named a shell script that existed, and the dead
// paths were the interpreter and target pinned inside it. Checking only the
// command would have passed that install clean.
// Two segments minimum: a slash-prefixed word with no second segment is a
// slash-command, not a path.
const ABSOLUTE_PATH = /(?:^|[\s"'=])(\/[^\s"':]+\/[^\s"':]+)/g;

const absolutePathsIn = (text) => [...text.matchAll(ABSOLUTE_PATH)]
  .map(m => m[1])
  .filter(path => !path.includes('$'));

export function unresolvableHookCommands(settings, { exists = existsSync, read = readFileSync } = {}) {
  const out = [];
  const scriptPaths = (path) => {
    if (!path.endsWith('.sh')) return [];
    // Assignments only. A path in a comment or a usage string is documentation,
    // and warning about it would train the reader to ignore this line.
    try {
      return [...read(path, 'utf8').matchAll(/^\s*[A-Za-z_][A-Za-z0-9_]*=("?)(\/[^\s"']+)\1/gm)].map(m => m[2]);
    } catch { return []; }
  };

  for (const [event, groups] of Object.entries(settings?.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const command of groupCommands(group).map(c => c ?? '')) {
        const direct = absolutePathsIn(command);
        const indirect = direct.filter(exists).flatMap(scriptPaths);
        const all = [...new Set([...direct, ...indirect])];
        const missing = all.filter(path => !exists(path));
        // Resolves today, stops the moment that package is upgraded: a death already
        // scheduled rather than one that has happened.
        const pinned = all.filter(path => !missing.includes(path) && isVersionPinned(path));
        if (missing.length || pinned.length) out.push({ event, command, missing, pinned });
      }
    }
  }
  return out;
}

// Every agent hook file that exists and parses, as { agent, path, settings }.
// Unreadable and malformed are both skipped: the only caller is the session
// briefing, and a hook config someone is mid-edit on must not be the reason a
// briefing fails to print.
export function readAgentHookFiles(home = homedir()) {
  return agentHookFiles(home).flatMap(({ agent, path }) => {
    if (!existsSync(path)) return [];
    try {
      return [{ agent, path, settings: JSON.parse(readFileSync(path, 'utf8')) }];
    } catch { return []; }
  });
}

// The briefing's stale-hook line. One line per file per failure kind, not one
// per hook: a single dead interpreter shows up in every entry of a file (14 of
// them in a real ~/.codex/hooks.json), and fourteen near-identical clauses
// joined into the health line is a briefing nobody reads.
//
// This runs inside the briefing and must never be the reason one fails to
// print — every read is already best-effort, and the whole thing is wrapped.
const PATHS_SHOWN = 3;

const summarize = (paths) => {
  const shown = paths.slice(0, PATHS_SHOWN).join(', ');
  return paths.length > PATHS_SHOWN ? `${shown} and ${paths.length - PATHS_SHOWN} more` : shown;
};

// `io` reaches unresolvableHookCommands only: the hook files themselves are
// read from the real filesystem (a caller injecting `exists` is faking the
// paths INSIDE the commands, not the config file that holds them).
export function staleHookWarnings(home = homedir(), io = {}) {
  try {
    return readAgentHookFiles(home).flatMap(({ path, settings }) => {
      const where = path.startsWith(home) ? `~${path.slice(home.length)}` : path;
      const found = unresolvableHookCommands(settings, io);
      const hooks = (n) => `${n} hook${n === 1 ? '' : 's'}`;
      const collect = (kind) => {
        const hits = found.filter(h => h[kind].length);
        return { count: hits.length, paths: [...new Set(hits.flatMap(h => h[kind]))] };
      };
      const missing = collect('missing');
      const pinned = collect('pinned');
      return [
        ...(missing.count ? [`${hooks(missing.count)} in ${where} cannot run: ${summarize(missing.paths)} missing — re-run 'kb setup' if this is a moved checkout`] : []),
        ...(pinned.count ? [`${hooks(pinned.count)} in ${where} pinned to one package version, dying on the next upgrade: ${summarize(pinned.paths)} — re-run 'kb setup'`] : []),
      ];
    });
  } catch {
    return [];
  }
}
