// `kb trigger-corpus` — extract the historical Bash command corpus that
// filterTriggers (src/trigger-relevance.js) grades noise ceilings against.
// Real session transcripts, not a curated sample, so the ceiling reflects
// what people actually run. ~1.6GB across transcripts, so every file is
// streamed line by line — a readFileSync here is the outage this command
// exists to avoid.
import { readdirSync, createReadStream, writeFileSync, renameSync } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import { homedir } from 'os';
import { CORPUS_PATH } from '../trigger-relevance.js';
import { acceptFlags, readFlagValue } from './flags.js';

const USAGE = 'Usage: kb trigger-corpus [--projects <dir>]';
// A command past this length is a heredoc or a generated blob, not a pattern
// anyone would trigger on — capped so one giant line can't dominate df math.
const MAX_LINE_CHARS = 400;

// One level: each direct subdirectory of projectsDir is a Claude Code
// project, and its transcripts sit flat inside it.
function jsonlFiles(projectsDir) {
  let subdirs;
  try {
    subdirs = readdirSync(projectsDir, { withFileTypes: true }).filter(e => e.isDirectory());
  } catch {
    return [];
  }
  const files = [];
  for (const dir of subdirs) {
    let entries;
    try {
      entries = readdirSync(join(projectsDir, dir.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) files.push(join(projectsDir, dir.name, e.name));
    }
  }
  return files;
}

async function commandsFromFile(filePath) {
  const commands = [];
  const rl = createInterface({ input: createReadStream(filePath, 'utf-8'), crlfDelay: Infinity });
  for await (const line of rl) {
    // Cheap pre-filter before paying for JSON.parse — most lines are not a
    // Bash tool_use at all.
    if (!line.includes('"Bash"')) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // one malformed line must not lose the rest of the transcript
    }
    const content = parsed?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item?.type !== 'tool_use' || item?.name !== 'Bash') continue;
      const command = item?.input?.command;
      if (typeof command !== 'string' || !command.trim()) continue;
      commands.push(command.replace(/\n/g, ' ').slice(0, MAX_LINE_CHARS));
    }
  }
  return commands;
}

// Duplicates are kept — frequency IS the measurement filterTriggers reads.
export async function buildCommandCorpus({ projectsDir, outPath = CORPUS_PATH }) {
  const files = jsonlFiles(projectsDir);
  const commands = [];
  for (const file of files) commands.push(...await commandsFromFile(file));

  const tmp = `${outPath}.tmp`;
  writeFileSync(tmp, commands.length ? commands.join('\n') + '\n' : '');
  renameSync(tmp, outPath);
  return { commands: commands.length, files: files.length };
}

export async function runTriggerCorpusCli(args = []) {
  if (!acceptFlags(args, { usage: USAGE, value: ['--projects'] })) return;
  const projectsDir = readFlagValue(args, '--projects') || join(homedir(), '.claude', 'projects');
  const { commands, files } = await buildCommandCorpus({ projectsDir });
  console.log(`${commands} commands from ${files} transcripts -> ${CORPUS_PATH}`);
}
