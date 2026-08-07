// `kb trigger-corpus` — extract the historical Bash command corpus that
// filterTriggers (src/trigger-relevance.js) grades noise ceilings against.
// Real session transcripts, not a curated sample, so the ceiling reflects
// what people actually run. ~1.6GB across transcripts, so every file is
// streamed line by line — a readFileSync here is the outage this command
// exists to avoid.
//
// TSV output (`<session>\t<command>`): the ceiling is graded per session
// (see filterTriggers), so the session id has to travel with every line, not
// just get flattened away. Heredoc-stripping and newline-flattening happen
// here, per command, before the line ever reaches the corpus file — the same
// transform stripHeredocs/commandSegments apply again at grading and match
// time, so doing it once here is optimization, not a second source of truth.
import { readdirSync, createReadStream, writeFileSync, renameSync } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import { homedir } from 'os';
import { CORPUS_PATH, stripHeredocs } from '../trigger-relevance.js';
import { acceptFlags, readFlagValue } from './flags.js';

const USAGE = 'Usage: kb trigger-corpus [--projects <dir>]';
// A command past this length is a generated blob (31% of raw commands
// exceeded the old 400-char cut, worst for the heredoc class) — capped high
// enough to keep those intact rather than undergrading them.
const MAX_LINE_CHARS = 8000;

// One level: each direct subdirectory of projectsDir is a Claude Code
// project, and its transcripts sit flat inside it. Session id is the
// filename without its extension — stable, and what the hook's own log
// will key dedupe against later.
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
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        files.push({ session: e.name.slice(0, -'.jsonl'.length), path: join(projectsDir, dir.name, e.name) });
      }
    }
  }
  return files;
}

// Heredoc bodies stripped, real newlines turned into '; ' (a shell statement
// separator, not whitespace — collapsing it to a space would let a heredoc's
// closing marker glue onto the next statement), tabs flattened, then capped.
function processCommand(raw) {
  const stripped = stripHeredocs(raw);
  const flattened = stripped.replace(/\t/g, ' ').replace(/\n/g, ' ; ');
  return flattened.slice(0, MAX_LINE_CHARS);
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
      const raw = item?.input?.command;
      if (typeof raw !== 'string' || !raw.trim()) continue;
      commands.push(processCommand(raw));
    }
  }
  return commands;
}

// Duplicates are kept — frequency IS the measurement filterTriggers reads.
export async function buildCommandCorpus({ projectsDir, outPath = CORPUS_PATH }) {
  const files = jsonlFiles(projectsDir);
  const rows = [];
  for (const { session, path } of files) {
    for (const command of await commandsFromFile(path)) rows.push(`${session}\t${command}`);
  }

  const tmp = `${outPath}.tmp`;
  writeFileSync(tmp, rows.length ? rows.join('\n') + '\n' : '');
  renameSync(tmp, outPath);
  return { commands: rows.length, files: files.length };
}

export async function runTriggerCorpusCli(args = []) {
  if (!acceptFlags(args, { usage: USAGE, value: ['--projects'] })) return;
  const projectsDir = readFlagValue(args, '--projects') || join(homedir(), '.claude', 'projects');
  const { commands, files } = await buildCommandCorpus({ projectsDir });
  console.log(`${commands} commands from ${files} transcripts -> ${CORPUS_PATH}`);
}
