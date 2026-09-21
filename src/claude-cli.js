import { spawn } from 'child_process';
import { onChildDone } from './child-exit.js';
import { logModelCall } from './model-meter.js';

// Shared "run the local claude CLI in print mode, get JSON back" helper.
// Reuses the OAuth session — no API key needed. Factored out of classify/classifier.js
// so kb_extract and the classifier share one code path.

const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';
const DEFAULT_MODEL = process.env.CLASSIFY_MODEL || 'claude-haiku-4-5-20251001';

// A ceiling, not a target. Wall time on these calls is generated tokens, and
// the adaptive budget spends 1,821 of them on one call and 10,163 on the next
// for identical input — that tail is what walks a chunk past its timeout and
// drops its facts. Never set this to 0: the deliberation is what applies the
// past-tense rule, and without it the extractor dates dead states as current
// (4 stale facts per run, 3 of 3 runs).
const THINKING_BUDGET = process.env.MAX_THINKING_TOKENS || '4096';

// The environment every model subprocess here runs under, shared so a second
// caller cannot quietly opt out of the ceiling.
export const modelEnv = () => ({
  ...process.env,
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  MAX_THINKING_TOKENS: THINKING_BUDGET,
  // Safe mode keeps session hooks out of these calls. This flag additionally
  // marks them as batch work for callers that inspect their environment.
  KB_BATCH: '1',
});

// Read where it is set, so the two cannot drift apart.
export const isBatchCall = () => process.env.KB_BATCH === '1';

// `caller` identifies who is asking, for the model_calls meter (model-meter.js)
// below — required, not defaulted, so a new call site cannot go dark by
// forgetting to pass one.
// The longest a single tool call can block on the model. Exported so callers
// that have to outlast one — the daemon's shutdown drain — size themselves
// against it rather than restating the number.
export const CLAUDE_CALL_TIMEOUT_MS = 120000;
export const CLAUDE_MAX_STDOUT_BYTES = 2 * 1024 * 1024;
export const CLAUDE_MAX_STDERR_BYTES = 64 * 1024;
const FORCE_KILL_DELAY_MS = 1000;

function createAbortError(message) {
  return Object.assign(new Error(message), { name: 'AbortError', code: 'ABORT_ERR' });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseClaudeJSON(stdout) {
  let outer;
  try {
    outer = JSON.parse(stdout); // --output-format json envelope
  } catch {
    throw new Error(`claude returned a malformed JSON envelope (${Buffer.byteLength(stdout)} bytes)`);
  }
  if (!isObject(outer) || typeof outer.result !== 'string') {
    throw new Error('claude returned a malformed JSON envelope');
  }

  const resultText = outer.result;
  const jsonStr = resultText.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    const start = jsonStr.indexOf('{');
    const end = jsonStr.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new Error(`no JSON object in model response (${Buffer.byteLength(resultText)} bytes)`);
    }
    try {
      parsed = JSON.parse(jsonStr.slice(start, end + 1));
    } catch {
      throw new Error(`malformed JSON object in model response (${Buffer.byteLength(resultText)} bytes)`);
    }
  }
  if (!isObject(parsed)) {
    throw new Error('claude result must be a JSON object');
  }
  return parsed;
}

export function runClaude(prompt, {
  model = DEFAULT_MODEL,
  timeout = CLAUDE_CALL_TIMEOUT_MS,
  caller,
  signal,
  validateOutput,
  maxStdoutBytes = CLAUDE_MAX_STDOUT_BYTES,
  maxStderrBytes = CLAUDE_MAX_STDERR_BYTES,
} = {}) {
  if (!caller) throw new Error('runClaude requires a caller label');
  if (signal?.aborted) return Promise.reject(createAbortError('claude call aborted before spawn'));
  const promptChars = prompt.length;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const proc = spawn(CLAUDE_PATH, [
      '-p', '--model', model,
      '--output-format', 'json',
      '--max-turns', '1',
      // Text-only task: don't let the nested CLI connect MCP servers (which
      // would spawn a second kb-server per call and pay their startup cost).
      '--strict-mcp-config',
      // Nested model calls are infrastructure, not interactive Claude Code
      // sessions. Safe mode keeps normal auth while disabling user/project
      // hooks, plugins, skills and CLAUDE.md discovery. An empty hooks object in
      // --settings is merged with higher-precedence settings and did not stop
      // SessionEnd hooks from running.
      '--safe-mode',
    ], {
      env: modelEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let responseReadyAt = null;
    let settled = false;
    let forceKillTimer;
    const kill = signalName => {
      if (process.platform !== 'win32') {
        try {
          process.kill(-proc.pid, signalName);
          return;
        } catch {}
      }
      proc.kill(signalName);
    };
    const stop = () => {
      if (proc.exitCode === null && proc.signalCode === null) {
        kill('SIGTERM');
        forceKillTimer = setTimeout(() => kill('SIGKILL'), FORCE_KILL_DELAY_MS);
        forceKillTimer.unref?.();
      }
    };

    proc.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        fail(new Error(`claude stdout exceeded ${maxStdoutBytes} bytes`));
        return;
      }
      stdout += chunk;
      if (responseReadyAt === null) {
        try {
          JSON.parse(stdout);
          responseReadyAt = Date.now();
        } catch {}
      }
    });
    proc.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderrBytes) {
        fail(new Error(`claude stderr exceeded ${maxStderrBytes} bytes`));
      }
    });

    // One place every settle path (success, non-zero exit, timeout, the
    // orphan-flush path in child-exit.js, and a spawn error below) runs
    // through, so metering cannot drift out of parity with the outcomes it
    // describes. Never changes what gets resolved/rejected. Once-guarded:
    // a failed spawn can emit 'error' AND still fire the close path, and a
    // double reject is a no-op where a double meter row is a wrong count.
    const finish = (ok, { responseChars = null, error = null } = {}) => {
      const finishedAt = Date.now();
      const responseReadyMs = responseReadyAt === null ? null : responseReadyAt - started;
      const shutdownTailMs = responseReadyMs === null ? null : finishedAt - responseReadyAt;
      logModelCall({
        caller,
        model,
        ok,
        durationMs: finishedAt - started,
        promptChars,
        responseChars,
        responseReadyMs,
        shutdownTailMs,
        error,
      });
    };
    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      signal?.removeEventListener('abort', onAbort);
    };
    const succeed = () => {
      if (settled) return;
      let result = stdout;
      try {
        result = validateOutput ? validateOutput(stdout) : stdout;
      } catch (err) {
        fail(err);
        return;
      }
      settled = true;
      cleanup();
      finish(true, { responseChars: stdout.length });
      resolve(result);
    };
    const fail = err => {
      if (settled) return;
      settled = true;
      cleanup();
      stop();
      finish(false, { error: err.message });
      reject(err);
    };
    const onAbort = () => fail(createAbortError('claude call aborted'));
    const timeoutTimer = setTimeout(
      () => fail(new Error(`claude timed out after ${Date.now() - started}ms (limit ${timeout}ms)`)),
      timeout,
    );
    timeoutTimer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });

    onChildDone(proc, (code, signal) => {
      clearTimeout(forceKillTimer);
      if (code === 0) {
        succeed();
        return;
      }
      const what = `claude exited ${code ?? `signal ${signal}`}`;
      fail(new Error(stderrBytes ? `${what} (stderr ${stderrBytes} bytes)` : what));
    });
    proc.on('error', fail);
    // If the child dies before reading stdin, the write EPIPEs — swallow it;
    // the failure itself is reported by the 'close' (or 'error') handler.
    proc.stdin.on('error', () => {});
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// Run claude and parse a JSON object out of its result, tolerating markdown
// fencing and prose around the JSON ("Understood, here's the extraction: {...}").
export async function runClaudeJSON(prompt, { validateResult, ...opts } = {}) {
  return runClaude(prompt, {
    ...opts,
    validateOutput(stdout) {
      const parsed = parseClaudeJSON(stdout);
      return validateResult ? validateResult(parsed) : parsed;
    },
  });
}
