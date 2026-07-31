// Where an extraction call spends its wall time, measured from the CLI's own
// usage envelope rather than from the length of the prompt we wrote.
//
//   node tests/bench/extract-call-cost.mjs [runs]
//
// The prompt is the obvious suspect and the wrong one: it is ~1,700 of the
// ~36,000 input tokens a call sends, and input is not what the clock tracks.
// Generated tokens are, and on a model that thinks by default most of those are
// thinking. This prints the split per call with the thinking budget effectively
// unbounded and at the shipped ceiling, so the tail that walks a chunk past its
// timeout is visible. Real model calls, no writes to any knowledge base.
//
// Each measurement runs in its own child process: claude-cli.js reads the
// budget once at module load, so a parent that reassigns it after importing
// would measure the same setting twice.

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SELF = fileURLToPath(import.meta.url);
const UNBOUNDED = '32000'; // the model's own max output, i.e. no ceiling of ours

// Dense with identifiers and with one state the following sentence retires,
// which is the shape that makes the extractor deliberate.
const SAMPLE = 'The duplicate threshold was declared in three modules and the skill instructed '
  + 'callers to use 0.7, while the write used 0.85. Pull request #22 moved the threshold into a '
  + 'single module and added a shared verdict function that both paths call.';

async function measureOnce() {
  process.env.KB_DIR = mkdtempSync(join(tmpdir(), 'kb-bench-'));
  const { buildExtractPrompt, chunkForExtract } = await import('../../src/extract.js');
  const { runClaude } = await import('../../src/claude-cli.js');
  const chunks = chunkForExtract(SAMPLE);
  const started = Date.now();
  const envelope = JSON.parse(await runClaude(buildExtractPrompt(chunks[0], { after: chunks[1] ?? '' })));
  const u = envelope.usage ?? {};
  console.log(JSON.stringify({
    wall: Date.now() - started,
    input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    generated: u.output_tokens ?? 0,
    answer: String(envelope.result ?? '').length,
  }));
}

const runChild = budget => new Promise((resolve, reject) => {
  const proc = spawn(process.execPath, [SELF, '--one'], {
    env: { ...process.env, MAX_THINKING_TOKENS: budget },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.on('close', code => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child exited ${code}`))));
  proc.on('error', reject);
});

if (process.argv.includes('--one')) {
  await measureOnce();
} else {
  const runs = Number(process.argv[2] || 3);
  console.log(`${runs} runs per budget\n`);
  console.log('budget          wall   input tok   generated   answer chars');
  for (const budget of [UNBOUNDED, '4096']) {
    for (let i = 0; i < runs; i++) {
      const r = await runChild(budget);
      const label = budget === '4096' ? '4096 (ship)' : `${UNBOUNDED} (none)`;
      console.log(`${label.padEnd(13)} ${`${r.wall}ms`.padStart(7)} ${String(r.input).padStart(11)} ${String(r.generated).padStart(11)} ${String(r.answer).padStart(14)}`);
    }
  }
  console.log('\nInput barely moves between runs; generated tokens are the whole spread,');
  console.log('and the answer is a few hundred characters of it either way.');
}
