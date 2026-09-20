#!/usr/bin/env node
// Thin installed PostToolUse checkpoint entry point. Keep module-load failures
// silent to the host while recording them for KB health diagnostics.
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

try {
  const { checkpointHook } = await import('../src/cli/checkpoint-hook.js');
  await checkpointHook(process.argv.slice(2));
} catch (err) {
  try {
    const kbDir = process.env.KB_DIR || join(homedir(), '.knowledge-base');
    const logDir = join(kbDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    const detail = String(err?.stack || err).replace(/\s*\n\s*/g, ' | ');
    appendFileSync(
      join(logDir, 'hook-errors.log'),
      `${new Date().toISOString()} checkpoint-hook-bin: ${detail}\n`,
    );
  } catch {
    // A fallback logger that fails must not outshout the hook failure.
  }
  process.exit(0);
}
