import { readFile, stat } from 'fs/promises';
import { z } from 'zod';
import { UsageError, readFlagValue } from './flags.js';
import { getToolDefinitions } from '../tools.js';
import { readToolResult } from '../tool-meter.js';
import { recordFallbackTool } from '../fallback-tool-meter.js';

const INPUT_MAX_BYTES = 1024 * 1024;
const USAGE = 'Usage: kb tool <name> [--input <json-file>]\n\n'
  + '  Invoke an allowlisted KB end-of-session tool with JSON from stdin or a file.';

export const FALLBACK_TOOL_NAMES = Object.freeze([
  'kb_search',
  'kb_read',
  'kb_check_duplicate',
  'kb_write',
  'kb_supersede',
  'kb_promote',
  'kb_fact_add',
  'kb_fact_invalidate',
  'kb_extract',
  'kb_capture_session',
  'kb_capture_fix',
]);

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > INPUT_MAX_BYTES) throw new UsageError(`JSON input exceeds ${INPUT_MAX_BYTES} bytes`, USAGE);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readInput(args) {
  const inputPath = readFlagValue(args, '--input');
  if (inputPath && (await stat(inputPath)).size > INPUT_MAX_BYTES) {
    throw new UsageError(`JSON input exceeds ${INPUT_MAX_BYTES} bytes`, USAGE);
  }
  const raw = inputPath ? await readFile(inputPath, 'utf8') : await readStdin();
  if (Buffer.byteLength(raw) > INPUT_MAX_BYTES) {
    throw new UsageError(`JSON input exceeds ${INPUT_MAX_BYTES} bytes`, USAGE);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new UsageError('Input must be one JSON object', USAGE);
  }
}

function toolByName(name) {
  if (!FALLBACK_TOOL_NAMES.includes(name)) {
    throw new UsageError(
      `${name || 'A tool name'} is not available through kb tool. Allowed: ${FALLBACK_TOOL_NAMES.join(', ')}`,
      USAGE,
    );
  }
  return getToolDefinitions().find(tool => tool.name === name);
}

function renderResult(result) {
  const blocks = result?.content ?? [];
  return blocks.map(block => block?.type === 'text' ? block.text : JSON.stringify(block)).join('\n');
}

export async function runToolCli(args) {
  const started = Date.now();
  const name = args[0];
  let outcome = 'exception';
  try {
    const tool = toolByName(name);
    const input = await readInput(args);
    let validated;
    try {
      validated = z.object(tool.schema).parse(input);
    } catch (err) {
      throw new UsageError(`Invalid input for ${name}: ${err.issues?.map(issue => issue.message).join('; ') || err.message}`, USAGE);
    }

    const result = await tool.handler(validated);
    const { ok } = readToolResult(result);
    outcome = ok ? 'succeeded' : 'tool_error';
    console.log(renderResult(result));
    if (!ok) process.exitCode = 1;
  } catch (err) {
    outcome = err instanceof UsageError ? 'usage_error' : 'exception';
    throw err;
  } finally {
    recordFallbackTool({
      tool: FALLBACK_TOOL_NAMES.includes(name) ? name : 'disallowed',
      ok: outcome === 'succeeded',
      durationMs: Date.now() - started,
      outcome,
    });
  }
}
