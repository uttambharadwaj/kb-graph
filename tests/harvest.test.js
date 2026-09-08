import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync, utimesSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'kb-harvest-'));
process.env.KB_DIR = tmp;
process.env.OBSIDIAN_VAULT_PATH = tmp;  // else a real run would touch the live vault
delete process.env.KB_HARVEST_FACTS;    // a host that opted in must not fail the suite

// A claude that answers instantly, so the harvest runs end to end without the
// real CLI. Set before importing: claude-cli reads CLAUDE_PATH once. One reply
// answers both prompts — no lessons, one fact — and the fact carries a call
// counter so every call contributes a distinct row rather than a duplicate.
// The counter picks a predicate from the vocabulary rather than minting one per
// call: an unlisted predicate is refused at the write boundary now, and a
// per-call-unique predicate is the exact shape the closed vocabulary exists to
// stop. Subject and object stay as the transcript words them, or the grounding
// filter drops the triple before consolidation ever sees it.
const stub = join(tmp, 'claude-stub');
const counter = join(tmp, 'calls');
writeFileSync(stub, [
  '#!/usr/bin/env node',
  "import { readFileSync, writeFileSync } from 'node:fs';",
  "let prompt = '';",
  "process.stdin.setEncoding('utf8');",
  "for await (const chunk of process.stdin) prompt += chunk;",
  `const counterPath = ${JSON.stringify(counter)};`,
  "let prior = '0';",
  "try { prior = readFileSync(counterPath, 'utf8'); } catch {}",
  "const n = Number.parseInt(prior || '0', 10) + 1;",
  "writeFileSync(counterPath, `${n}`);",
  // Long enough that no two harvest runs in this file reuse one: 8 chunks a run
  // (MAX_CONCURRENT_CALLS) plus a lessons call, three runs. A repeat would land
  // as a duplicate and the fact count would stop moving for the wrong reason.
  'const predicates = "owns uses contains provides includes supports tracks documents calls talks_to runs_on stored_in depends_on gates gated_by defaults_to bypasses excludes enables prevents causes breaks returns indicates drops lacks replaces reverts proposes chose rejects addresses".split(" ");',
  'const predicate = predicates[(n - 1) % predicates.length];',
  'const notes = prompt.includes("MIDDLE_SENTINEL") ? [{ title: "Middle sentinel", type: "lesson", content: "MIDDLE_SENTINEL was covered.", tags: "test", project: "knowledge-base-server" }] : [];',
  'const inner = { notes, facts: [{ subject: "billing service", predicate, object: "payments team", category: "status" }], skipped: [] };',
  'process.stdout.write(JSON.stringify({ result: JSON.stringify(inner) }));',
].join('\n') + '\n');
chmodSync(stub, 0o755);
process.env.CLAUDE_PATH = stub;

const { extractTranscriptText, chunkText, chunkTextWithIdentity, runHarvest, runHarvestCli, factsRequested, stillPending, selectWork, isPrintModeTranscript, buildLessonsPrompt, findTranscripts, MAX_SESSIONS_PER_RUN } = await import('../src/harvest.js');
const { getDb, getHealth } = await import('../src/db.js');

describe('harvest transcript parsing', () => {
  it('keeps evidence-strength guidance in the production lessons prompt', () => {
    const prompt = buildLessonsPrompt('A customer reported a number through a chat UI.');
    assert.match(prompt, /Preserve evidence strength and measurement method/);
    assert.match(prompt, /anecdotal unless the transcript explicitly describes a controlled measurement/);
    assert.match(prompt, /Never upgrade a report into a benchmark/);
    assert.match(prompt, /# Transcript\nA customer reported a number through a chat UI\./);
  });

  it('extracts Claude Code user/assistant text turns', () => {
    const raw = [
      JSON.stringify({ type: 'user', message: { content: 'fix the login bug' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Found it: stale token.' }, { type: 'tool_use', name: 'Bash' }] } }),
      JSON.stringify({ type: 'permission-mode', permissionMode: 'default' }),
    ].join('\n');
    const text = extractTranscriptText(raw);
    assert.match(text, /USER: fix the login bug/);
    assert.match(text, /ASSISTANT: Found it: stale token\./);
    assert.doesNotMatch(text, /permission/);
  });

  it('skips sidechain (subagent) turns and system reminders', () => {
    const raw = [
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent noise' }] } }),
      JSON.stringify({ type: 'user', message: { content: '<system-reminder>injected</system-reminder>' } }),
      JSON.stringify({ type: 'user', message: { content: 'real question' } }),
    ].join('\n');
    const text = extractTranscriptText(raw);
    assert.doesNotMatch(text, /subagent noise/);
    assert.doesNotMatch(text, /injected/);
    assert.match(text, /real question/);
  });

  it('extracts Codex rollout message payloads', () => {
    const raw = JSON.stringify({
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'codex says hi' }] },
    });
    assert.match(extractTranscriptText(raw), /ASSISTANT: codex says hi/);
  });

  it('extracts Cursor agent transcript turns (top-level role, no type)', () => {
    const raw = [
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'why is the build red' }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'Missing dep.' }, { type: 'tool_use', name: 'Shell', input: { command: 'npm ci' } }] } }),
    ].join('\n');
    const text = extractTranscriptText(raw);
    assert.match(text, /USER: why is the build red/);
    assert.match(text, /ASSISTANT: Missing dep\./);
    assert.doesNotMatch(text, /npm ci/);
  });

  it('tolerates malformed lines', () => {
    assert.strictEqual(extractTranscriptText('not json\n{"broken":'), '');
  });
});

describe('harvest candidate selection', () => {
  // The harvest holds back transcripts touched in the last half hour, so a
  // fixture written just now looks like a session still in progress. Every
  // fixture is backdated unless the test is specifically about that guard.
  const quiesce = (path) => {
    const old = (Date.now() - 3 * 60 * 60 * 1000) / 1000;
    utimesSync(path, old, old);
    return path;
  };
  const writeTranscript = (path, lines) => quiesce((writeFileSync(path, lines), path));

  const jsonl = (name, lines) => {
    const path = join(tmp, name);
    writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n'));
    return path;
  };

  it('discovers only Cursor agent-transcripts trees by default', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'kb-cursor-home-'));
    const transcriptDir = join(homeDir, '.cursor', 'projects', 'repo', 'agent-transcripts', 'session');
    const unrelatedDir = join(homeDir, '.cursor', 'projects', 'repo', 'other-state');
    mkdirSync(transcriptDir, { recursive: true });
    mkdirSync(unrelatedDir, { recursive: true });
    const transcript = join(transcriptDir, 'conversation.jsonl');
    const unrelated = join(unrelatedDir, 'cache.jsonl');
    writeFileSync(transcript, '{}\n');
    writeFileSync(unrelated, '{}\n');

    const found = findTranscripts({ sinceMs: 0, homeDir });

    assert.deepStrictEqual(found.map(candidate => candidate.path), [transcript]);
    rmSync(homeDir, { recursive: true, force: true });
  });

  // Every claude -p this server runs leaves a transcript, so without this the
  // harvest reads its own prompts and each run manufactures the next run's input.
  it('tells print-mode transcripts apart from interactive sessions', () => {
    const own = jsonl('own-call.jsonl', [
      { type: 'queue-operation', operation: 'enqueue', content: 'You are a knowledge base summarizer.' },
      { type: 'attachment', entrypoint: 'sdk-cli', cwd: '/' },
    ]);
    const real = jsonl('real-session.jsonl', [
      { type: 'attachment', entrypoint: 'cli', cwd: '/Users/someone/code' },
      { type: 'user', message: { content: 'fix the login bug' } },
    ]);

    assert.strictEqual(isPrintModeTranscript(own), true);
    assert.strictEqual(isPrintModeTranscript(real), false);
  });

  // Every way of not recognising a transcript has to end in harvesting it. A
  // detector that drops what it cannot read loses the work it exists to keep.
  it('harvests anything it cannot positively identify', () => {
    const cases = {
      'no marker at all': jsonl('no-marker.jsonl', [{ type: 'user', message: { content: 'hi' } }]),
      'a third entrypoint value': jsonl('desktop.jsonl', [{ type: 'attachment', entrypoint: 'claude-desktop' }]),
      'the marker quoted inside user content': jsonl('quoted.jsonl', [
        { type: 'user', message: { content: 'the file said {"entrypoint":"sdk-cli"} which confused me' } },
      ]),
      'a file that does not exist': join(tmp, 'does-not-exist.jsonl'),
    };
    for (const [what, path] of Object.entries(cases)) {
      assert.strictEqual(isPrintModeTranscript(path), false, `${what} must be harvested`);
    }

    // Only the head is read, so a marker pushed past the window is invisible.
    // Harvesting is the safe answer; dropping would lose a real session.
    const buried = jsonl('buried-marker.jsonl', [
      { type: 'user', message: { content: 'x'.repeat(70000) } },
      { type: 'attachment', entrypoint: 'sdk-cli' },
    ]);
    assert.strictEqual(isPrintModeTranscript(buried), false, 'a marker past the scan window must not drop the file');
  });

  // The queue has to drain in arrival order. Taking the newest starves the tail
  // permanently, because a session that ages out of the window is gone for good.
  it('takes the oldest pending sessions, not the newest', () => {
    // Shuffled, so this pins the ordering rather than "slices from the front".
    const shuffled = [17, 3, 41, 0, 28, 9, 33, 22, 5, 38]
      .flatMap(base => Array.from({ length: 4 }, (_, i) => ({ path: `/t/${base}-${i}.jsonl`, mtime: base * 10 + i })));
    const work = selectWork(shuffled);

    assert.strictEqual(work.length, MAX_SESSIONS_PER_RUN);
    const oldest = shuffled.map(c => c.mtime).sort((a, b) => a - b).slice(0, MAX_SESSIONS_PER_RUN);
    assert.deepStrictEqual(work.map(c => c.mtime), oldest);
  });

  it('leaves a shorter queue alone', () => {
    const candidates = Array.from({ length: 4 }, (_, i) => ({ path: `/t/${i}.jsonl`, mtime: i }));
    assert.strictEqual(selectWork(candidates).length, 4);
  });

  // TKT-3187: the harvest read a session that was still open and wrote near-
  // duplicates of notes that session's human was writing by hand. The automatic
  // copy arrives first, so the deliberate note is the one dedup then refuses.
  it('leaves a session that is still being written for the next run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-roots-'));
    const live = join(root, 'in-progress.jsonl');
    const done = join(root, 'finished.jsonl');
    const body = (t) => [
      JSON.stringify({ type: 'attachment', entrypoint: 'cli' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t.repeat(500) }] } }),
    ].join('\n');
    writeFileSync(live, body('still typing '));      // keeps its real mtime: in flight
    writeTranscript(done, body('long finished '));   // backdated: quiescent

    const summary = await runHarvest({ searchRoots: [root], sinceHours: 24 });

    assert.strictEqual(summary.inFlight, 1, 'the open session must be held back');
    assert.strictEqual(summary.sessions, 1, 'and the quiet one must still be harvested');
    // Held back, not consumed: no watermark, so the next run sees it again.
    const logged = getDb().prepare('SELECT transcript_path FROM harvest_log WHERE transcript_path = ?').get(live);
    assert.strictEqual(logged, undefined, 'an unharvested session must not be watermarked');
    rmSync(root, { recursive: true, force: true });
  });

  // The wiring, not the pieces: that the filter is applied at all, that the
  // count reported is the number dropped, and that the backlog math adds up.
  it('counts what it passed over rather than reporting only what it did', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-roots-'));
    writeTranscript(join(root, 'own.jsonl'), JSON.stringify({ type: 'attachment', entrypoint: 'sdk-cli' }));
    writeTranscript(join(root, 'short.jsonl'), [
      JSON.stringify({ type: 'attachment', entrypoint: 'cli' }),
      JSON.stringify({ type: 'user', message: { content: 'too short to be worth a note' } }),
    ].join('\n'));

    const summary = await runHarvest({ searchRoots: [root], sinceHours: 24 });

    assert.strictEqual(summary.printModeCalls, 1, 'the print-mode transcript must be counted, not just dropped');
    assert.strictEqual(summary.pending, 1, 'and must not reach the pending queue');
    assert.strictEqual(summary.tooShort, 1, 'a session passed over for length is still passed over');
    assert.strictEqual(summary.sessions, 0);
    rmSync(root, { recursive: true, force: true });
  });

  // The lessons pass now advances through content-stable chunks. A note count
  // still cannot show coverage, so the run has to report pending spans.
  // A session of `chars` characters of assistant text, in its own discovery root.
  const sessionOf = (name, chars) => {
    const root = mkdtempSync(join(tmpdir(), 'kb-roots-'));
    writeTranscript(join(root, name), [
      JSON.stringify({ type: 'attachment', entrypoint: 'cli' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(chars) }] } }),
    ].join('\n'));
    return root;
  };

  it('reports pending lesson coverage without marking the transcript complete', async () => {
    // 'ASSISTANT: ' is prepended, so the extracted text is 11 chars longer.
    const chars = 100000;
    const root = sessionOf('long.jsonl', chars);
    const path = join(root, 'long.jsonl');

    const summary = await runHarvest({ searchRoots: [root], sinceHours: 24 });

    assert.strictEqual(summary.sessions, 1);
    assert.strictEqual(summary.partial, 1, 'a session with unprocessed chunks is not fully read');
    assert.strictEqual(summary.coverageComplete, false);
    assert.strictEqual(summary.partialProgress, true);
    assert.strictEqual(summary.unreadByLessons, chars + 11 - (26000 * 2));
    assert.strictEqual(
      getDb().prepare('SELECT 1 FROM harvest_log WHERE transcript_path = ?').get(path),
      undefined,
      'a partial coverage pass must not receive a complete watermark',
    );
    rmSync(root, { recursive: true, force: true });
  });

  it('learns from a middle lesson chunk on a later pass', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-roots-'));
    const path = join(root, 'middle.jsonl');
    writeTranscript(path, [
      JSON.stringify({ type: 'attachment', entrypoint: 'cli' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `${'x'.repeat(53000)} MIDDLE_SENTINEL ${'z'.repeat(10000)}` }] },
      }),
    ].join('\n'));

    const first = await runHarvest({ searchRoots: [root], sinceHours: 24 });
    assert.strictEqual(first.notes, 0);
    assert.strictEqual(first.coverageComplete, false);

    const second = await runHarvest({ searchRoots: [root], sinceHours: 24 });
    assert.strictEqual(second.coverageComplete, true);
    assert.strictEqual(second.notes, 1);
    assert.ok(getDb().prepare("SELECT 1 FROM documents WHERE title = 'Middle sentinel'").get());
    assert.strictEqual(getDb().prepare('SELECT notes_added FROM harvest_log WHERE transcript_path = ?').get(path).notes_added, 1);
    rmSync(root, { recursive: true, force: true });
  });

  it('resumes stable prefix chunks after append instead of replaying them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-roots-'));
    const path = join(root, 'append.jsonl');
    writeTranscript(path, [
      JSON.stringify({ type: 'attachment', entrypoint: 'cli' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(70000) }] } }),
    ].join('\n'));

    const first = await runHarvest({ searchRoots: [root], sinceHours: 24 });
    assert.strictEqual(first.coverageComplete, false);
    assert.strictEqual(getDb().prepare("SELECT COUNT(*) n FROM harvest_chunk_log WHERE transcript_path = ? AND pass = 'lessons'").get(path).n, 2);

    writeTranscript(path, [
      JSON.stringify({ type: 'attachment', entrypoint: 'cli' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `${'x'.repeat(70000)}${'y'.repeat(30000)}` }] } }),
    ].join('\n'));
    const second = await runHarvest({ searchRoots: [root], sinceHours: 24 });

    assert.strictEqual(second.coverageComplete, true);
    assert.strictEqual(getDb().prepare("SELECT COUNT(*) n FROM harvest_chunk_log WHERE transcript_path = ? AND pass = 'lessons'").get(path).n, 4);
    assert.ok(getDb().prepare('SELECT 1 FROM harvest_log WHERE transcript_path = ?').get(path));
    rmSync(root, { recursive: true, force: true });
  });

  it('resumes fact extraction after the per-run chunk cap', async () => {
    const root = sessionOf('enormous.jsonl', 300000);
    const path = join(root, 'enormous.jsonl');

    const first = await runHarvest({ searchRoots: [root], sinceHours: 24, facts: true });
    assert.strictEqual(first.coverageComplete, false);
    assert.strictEqual(first.unreadByFacts, 60011);
    assert.strictEqual(getDb().prepare("SELECT COUNT(*) n FROM harvest_chunk_log WHERE transcript_path = ? AND pass = 'facts'").get(path).n, 20);

    const second = await runHarvest({ searchRoots: [root], sinceHours: 24, facts: true });
    assert.strictEqual(second.unreadByFacts, 0);
    assert.strictEqual(second.unreadByLessons > 0, true, 'lesson coverage still advances on its own smaller per-run budget');
    assert.strictEqual(getDb().prepare("SELECT COUNT(*) n FROM harvest_chunk_log WHERE transcript_path = ? AND pass = 'facts'").get(path).n, 26);
    rmSync(root, { recursive: true, force: true });
  });

  it('records retrieval outcomes only after an eligible transcript reaches complete coverage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-roots-'));
    const partialPath = join(root, 'partial.jsonl');
    const completePath = join(root, 'complete.jsonl');
    const sdkPath = join(root, 'sdk.jsonl');
    const calls = [];
    const recordOutcomes = async (args) => { calls.push(args); return { recorded: 0 }; };

    writeTranscript(partialPath, [
      JSON.stringify({ type: 'attachment', entrypoint: 'cli' }),
      JSON.stringify({ session_id: 'sess-partial', type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(70000) }] } }),
    ].join('\n'));
    writeTranscript(completePath, [
      JSON.stringify({ type: 'attachment', entrypoint: 'cli' }),
      JSON.stringify({ session_id: 'sess-complete', type: 'assistant', message: { content: [{ type: 'text', text: 'a complete session. '.repeat(400) }] } }),
    ].join('\n'));
    writeTranscript(sdkPath, [
      JSON.stringify({ type: 'attachment', entrypoint: 'sdk-cli' }),
      JSON.stringify({ session_id: 'sess-sdk', type: 'assistant', message: { content: [{ type: 'text', text: 'sdk transcript. '.repeat(400) }] } }),
    ].join('\n'));
    const completeMtime = statSync(completePath).mtimeMs;

    const summary = await runHarvest({ searchRoots: [root], sinceHours: 24, recordOutcomes });

    assert.strictEqual(summary.sessions, 2, 'the sdk-cli transcript must be excluded before harvest and feedback');
    assert.strictEqual(summary.printModeCalls, 1);
    assert.strictEqual(calls.length, 1, 'only the fully covered eligible transcript records retrieval feedback');
    assert.deepStrictEqual(calls[0], {
      sessionId: null,
      transcriptPath: completePath,
      transcriptMtime: completeMtime,
    });
    rmSync(root, { recursive: true, force: true });
  });

  it('skips nightly maintenance when called for capture-only harvesting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-roots-'));
    const path = join(root, 'capture-maintenance.jsonl');
    let maintenanceCalls = 0;
    writeTranscript(path, [
      JSON.stringify({ type: 'attachment', entrypoint: 'cli' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'a complete capture-only session. '.repeat(400) }] } }),
    ].join('\n'));

    await runHarvest({ onlyPath: path, maintenance: false, runMaintenance: async () => { maintenanceCalls++; } });

    assert.strictEqual(maintenanceCalls, 0);
    assert.ok(getDb().prepare("SELECT value FROM meta WHERE key = 'last_harvest'").get(), 'the run heartbeat still records capture harvest activity');
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps nightly maintenance on by default', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-roots-'));
    const path = join(root, 'nightly-maintenance.jsonl');
    const calls = [];
    writeTranscript(path, [
      JSON.stringify({ type: 'attachment', entrypoint: 'cli' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'a complete nightly session. '.repeat(400) }] } }),
    ].join('\n'));

    await runHarvest({ onlyPath: path, runMaintenance: async args => calls.push(args) });

    assert.deepStrictEqual(calls, [{ vaultPath: process.env.OBSIDIAN_VAULT_PATH }]);
    rmSync(root, { recursive: true, force: true });
  });

  it('passes explicit capture session ids to retrieval outcome recording', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-roots-'));
    const path = join(root, 'capture.jsonl');
    const calls = [];
    writeTranscript(path, [
      JSON.stringify({ type: 'attachment', entrypoint: 'cli' }),
      JSON.stringify({ session_id: 'parser-session', type: 'assistant', message: { content: [{ type: 'text', text: 'a complete capture session. '.repeat(400) }] } }),
    ].join('\n'));
    const mtime = statSync(path).mtimeMs;

    await runHarvest({ onlyPath: path, sessionId: 'hook-session', recordOutcomes: async args => calls.push(args) });

    assert.deepStrictEqual(calls, [{ sessionId: 'hook-session', transcriptPath: path, transcriptMtime: mtime }]);
    rmSync(root, { recursive: true, force: true });
  });

  it('rereads rewritten or truncated content at the same path instead of trusting stale checkpoints', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-roots-'));
    const path = join(root, 'rotated.jsonl');
    writeTranscript(path, [
      JSON.stringify({ type: 'attachment', entrypoint: 'cli' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(70000) }] } }),
    ].join('\n'));

    await runHarvest({ searchRoots: [root], sinceHours: 24 });
    assert.strictEqual(getDb().prepare("SELECT COUNT(*) n FROM harvest_chunk_log WHERE transcript_path = ? AND pass = 'lessons'").get(path).n, 2);

    writeTranscript(path, [
      JSON.stringify({ type: 'attachment', entrypoint: 'cli' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'y'.repeat(40000) }] } }),
    ].join('\n'));
    const second = await runHarvest({ searchRoots: [root], sinceHours: 24 });

    assert.strictEqual(second.coverageComplete, true);
    assert.strictEqual(getDb().prepare("SELECT COUNT(*) n FROM harvest_chunk_log WHERE transcript_path = ? AND pass = 'lessons'").get(path).n, 4);
    assert.ok(getDb().prepare('SELECT 1 FROM harvest_log WHERE transcript_path = ?').get(path));
    rmSync(root, { recursive: true, force: true });
  });

  it('deduplicates a replay after a note write succeeds but the chunk checkpoint is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-roots-'));
    const path = join(root, 'crash-replay.jsonl');
    getDb().prepare("DELETE FROM documents WHERE title = 'Middle sentinel'").run();
    writeTranscript(path, [
      JSON.stringify({ type: 'attachment', entrypoint: 'cli' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `${'x'.repeat(5000)} MIDDLE_SENTINEL ${'z'.repeat(5000)}` }] } }),
    ].join('\n'));

    const first = await runHarvest({ onlyPath: path });
    assert.strictEqual(first.notes, 1);
    assert.strictEqual(getDb().prepare("SELECT COUNT(*) n FROM documents WHERE title = 'Middle sentinel'").get().n, 1);

    getDb().prepare('DELETE FROM harvest_log WHERE transcript_path = ?').run(path);
    getDb().prepare('DELETE FROM harvest_chunk_log WHERE transcript_path = ?').run(path);
    const replay = await runHarvest({ onlyPath: path });

    assert.strictEqual(replay.coverageComplete, true);
    assert.strictEqual(replay.notes, 0, 'the existing note is deduped on replay');
    assert.strictEqual(getDb().prepare("SELECT COUNT(*) n FROM documents WHERE title = 'Middle sentinel'").get().n, 1);
    assert.strictEqual(getDb().prepare("SELECT COUNT(*) n FROM harvest_chunk_log WHERE transcript_path = ? AND pass = 'lessons'").get(path).n, 1);
    rmSync(root, { recursive: true, force: true });
  });

  it('revisits legacy long harvest rows until their chunks are covered', async () => {
    const root = sessionOf('legacy.jsonl', 60000);
    const path = join(root, 'legacy.jsonl');
    getDb().prepare('INSERT OR REPLACE INTO harvest_log (transcript_path, mtime, facts_added, notes_added) VALUES (?, ?, NULL, 0)')
      .run(path, 1);

    const summary = await runHarvest({ searchRoots: [], sinceHours: 24 });

    assert.strictEqual(summary.pending, 1);
    assert.strictEqual(summary.partialProgress, true);
    assert.strictEqual(getDb().prepare("SELECT COUNT(*) n FROM harvest_chunk_log WHERE transcript_path = ? AND pass = 'lessons'").get(path).n, 2);
    rmSync(root, { recursive: true, force: true });
  });

  it('does not call a session partial when all of it was read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-roots-'));
    writeTranscript(join(root, 'short-enough.jsonl'), [
      JSON.stringify({ type: 'attachment', entrypoint: 'cli' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'a fine session. '.repeat(400) }] } }),
    ].join('\n'));

    const summary = await runHarvest({ searchRoots: [root], sinceHours: 24 });

    assert.strictEqual(summary.sessions, 1);
    assert.strictEqual(summary.partial, 0);
    rmSync(root, { recursive: true, force: true });
  });

  // The heartbeat has to record that the job ran, not what it found. Derived
  // from harvested rows, a quiet weekend looked identical to a dead launchd
  // job — and skipping print-mode transcripts makes quiet runs the normal case.
  it('is healthy after a run with nothing to harvest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-roots-'));
    writeTranscript(join(root, 'own.jsonl'), JSON.stringify({ type: 'attachment', entrypoint: 'sdk-cli' }));
    // Nothing has ever been harvested here, so harvest_log cannot supply the
    // timestamp and only the heartbeat can. Runs last in this file.
    getDb().prepare('DELETE FROM harvest_log').run();

    await runHarvest({ searchRoots: [root], sinceHours: 24 });

    const health = getHealth();
    assert.ok(health.last_harvest, 'a run that found nothing still ran');
    assert.deepStrictEqual(health.warnings.filter(w => w.includes('harvest')), [],
      'finding nothing is not a broken job');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('harvest chunking', () => {
  it('keeps short texts as sequential chunks', () => {
    const chunks = chunkText('x'.repeat(25000));
    assert.strictEqual(chunks.length, 3);
    assert.strictEqual(chunks[0].length, 12000);
  });

  it('caps fact chunks per run from the front of the remaining coverage', () => {
    const text = 'a'.repeat(12000 * 30);
    const chunks = chunkText(text);
    assert.strictEqual(chunks.length, 20);
  });

  it('gives chunks stable offset and content identities', () => {
    const chunks = chunkTextWithIdentity('abc'.repeat(10000), { size: 12000 });
    assert.strictEqual(chunks[0].index, 0);
    assert.strictEqual(chunks[0].start, 0);
    assert.strictEqual(chunks[0].end, 12000);
    assert.match(chunks[0].hash, /^[a-f0-9]{64}$/);
    assert.strictEqual(chunks[1].start, 12000);
  });
});

describe('harvest fact extraction', () => {
  after(() => rmSync(tmp, { recursive: true, force: true }));

  // The stub answers with a fact whatever it is asked, so whether a row lands
  // is decided entirely by the flag and not by what the transcript says. Long
  // enough to clear MIN_TEXT_CHARS and to span more than one chunk, so the
  // per-chunk loop and its running total are both exercised.
  const write = name => {
    const path = join(tmp, name);
    writeFileSync(path, [
      JSON.stringify({ type: 'user', message: { content: 'who owns the billing service?' } }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'The billing service is owned by the payments team. '.repeat(300) }] },
      }),
    ].join('\n'));
    return path;
  };
  const factCount = () => getDb().prepare('SELECT COUNT(*) AS n FROM facts').get().n;

  it('is off by default', async () => {
    const summary = await runHarvest({ onlyPath: write('default.jsonl') });

    assert.strictEqual(summary.sessions, 1, 'the session must actually be harvested, not skipped as too short');
    assert.strictEqual(summary.facts, 0);
    assert.strictEqual(factCount(), 0);
  });

  it('extracts when asked', async () => {
    const summary = await runHarvest({ onlyPath: write('opted-in.jsonl'), facts: true });

    assert.ok(summary.facts > 1, `expected the chunks to add up, got ${summary.facts}`);
    assert.strictEqual(summary.facts, factCount(), 'the reported count must be the total written, not the last chunk');
  });

  it('takes the last fact flag on the command line', async () => {
    await runHarvestCli(['--no-facts', `--path=${write('cli-off.jsonl')}`]);
    const before = factCount();
    await runHarvestCli(['--no-facts', '--facts', `--path=${write('cli-on.jsonl')}`]);

    assert.ok(factCount() > before, '--facts last must win over an earlier --no-facts');
  });

  // Turning the flag on must not be a no-op for everything already swept for
  // lessons — the mtime has not changed, but the facts pass has not run.
  it('re-offers a transcript that was harvested before extraction was enabled', () => {
    const db = getDb();
    const rows = [{ path: '/t/lessons-only.jsonl', mtime: 10 }, { path: '/t/both.jsonl', mtime: 10 }];
    const log = db.prepare('INSERT OR REPLACE INTO harvest_log (transcript_path, mtime, facts_added) VALUES (?, ?, ?)');
    log.run('/t/lessons-only.jsonl', 10, null);
    log.run('/t/both.jsonl', 10, 0);   // ran, found none — final

    assert.deepStrictEqual(stillPending(db, rows, false).map(r => r.path), [],
      'a lessons-only run must not re-read either of them');
    assert.deepStrictEqual(stillPending(db, rows, true).map(r => r.path), ['/t/lessons-only.jsonl']);
    assert.deepStrictEqual(stillPending(db, [{ path: '/t/both.jsonl', mtime: 11 }], false).map(r => r.path),
      ['/t/both.jsonl'], 'a newer mtime is still work regardless of the flag');
  });

  it('reads KB_HARVEST_FACTS when the caller says nothing', () => {
    const prev = process.env.KB_HARVEST_FACTS;
    try {
      delete process.env.KB_HARVEST_FACTS;
      assert.strictEqual(factsRequested({}), false);
      process.env.KB_HARVEST_FACTS = '1';
      assert.strictEqual(factsRequested({}), true);
      process.env.KB_HARVEST_FACTS = 'true';
      assert.strictEqual(factsRequested({}), true, 'a plausible spelling must not silently mean off');
      // An explicit argument still wins, so --no-facts works on an opted-in host.
      assert.strictEqual(factsRequested({ facts: false }), false);
    } finally {
      if (prev === undefined) delete process.env.KB_HARVEST_FACTS; else process.env.KB_HARVEST_FACTS = prev;
    }
  });
});
