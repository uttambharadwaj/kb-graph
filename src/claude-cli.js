import { spawn } from 'child_process';

// Shared "run the local claude CLI in print mode, get JSON back" helper.
// Reuses the OAuth session — no API key needed. Factored out of classify/classifier.js
// so kb_extract and the classifier share one code path.

const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';
const DEFAULT_MODEL = process.env.CLASSIFY_MODEL || 'claude-haiku-4-5-20251001';

export function runClaude(prompt, { model = DEFAULT_MODEL, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const proc = spawn(CLAUDE_PATH, [
      '-p', '--model', model,
      '--output-format', 'json',
      '--max-turns', '1',
      // Text-only task: don't let the nested CLI connect MCP servers (which
      // would spawn a second kb-server per call and pay their startup cost).
      '--strict-mcp-config',
    ], {
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli' },
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', (code, signal) => {
      if (code === 0) return resolve(stdout);
      const elapsed = Date.now() - started;
      // spawn's timeout kills with SIGTERM; the claude shim surfaces that as
      // exit 143 (128+15). Name the timeout instead of a bare exit code.
      const timedOut = elapsed >= timeout && (signal === 'SIGTERM' || code === 143);
      const what = timedOut
        ? `claude timed out after ${elapsed}ms (limit ${timeout}ms)`
        : `claude exited ${code ?? `signal ${signal}`}`;
      reject(new Error(`${what}: ${stderr}`));
    });
    proc.on('error', reject);
    // If the child dies before reading stdin, the write EPIPEs — swallow it;
    // the failure itself is reported by the 'close' (or 'error') handler.
    proc.stdin.on('error', () => {});
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// Run claude and parse a JSON object out of its result, tolerating markdown
// fencing and prose around the JSON ("Understood, here's the extraction: {...}").
export async function runClaudeJSON(prompt, opts = {}) {
  const stdout = await runClaude(prompt, opts);
  const outer = JSON.parse(stdout);                  // --output-format json envelope
  const resultText = outer.result || '';
  const jsonStr = resultText.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
  try {
    return JSON.parse(jsonStr);
  } catch {
    const start = jsonStr.indexOf('{');
    const end = jsonStr.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new Error(`no JSON object in model response: ${jsonStr.slice(0, 120)}`);
    }
    return JSON.parse(jsonStr.slice(start, end + 1));
  }
}
