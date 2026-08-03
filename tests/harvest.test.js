import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, utimesSync } from 'fs';
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
const stub = join(tmp, 'claude-stub');
const counter = join(tmp, 'calls');
writeFileSync(stub, [
  '#!/bin/sh',
  'cat > /dev/null',
  `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}`,
  `printf '{"result":"{\\\\"notes\\\\":[],\\\\"facts\\\\":[{\\\\"subject\\\\":\\\\"tkt-%s\\\\",\\\\"predicate\\\\":\\\\"blocks\\\\",\\\\"object\\\\":\\\\"tkt-x\\\\",\\\\"category\\\\":\\\\"status\\\\"}],\\\\"skipped\\\\":[]}"}' "$n"`,
].join('\n') + '\n');
chmodSync(stub, 0o755);
process.env.CLAUDE_PATH = stub;

const { extractTranscriptText, chunkText, runHarvest, runHarvestCli, factsRequested, stillPending, selectWork, isPrintModeTranscript, MAX_SESSIONS_PER_RUN } = await import('../src/harvest.js');
const { getDb, getHealth } = await import('../src/db.js');

describe('harvest transcript parsing', () => {
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

  // PF-3187: the harvest read a session that was still open and wrote near-
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

  // The lessons pass keeps the head and the tail of a long session and drops
  // what is between — which on a long session is the work itself. A note count
  // cannot show that, so the run has to.
  // A session of `chars` characters of assistant text, in its own discovery root.
  const sessionOf = (name, chars) => {
    const root = mkdtempSync(join(tmpdir(), 'kb-roots-'));
    writeTranscript(join(root, name), [
      JSON.stringify({ type: 'attachment', entrypoint: 'cli' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(chars) }] } }),
    ].join('\n'));
    return root;
  };

  it('reports the middle of a long session as unread', async () => {
    // 'ASSISTANT: ' is prepended, so the extracted text is 11 chars longer.
    const chars = 100000;
    const root = sessionOf('long.jsonl', chars);

    const summary = await runHarvest({ searchRoots: [root], sinceHours: 24 });

    assert.strictEqual(summary.sessions, 1);
    assert.strictEqual(summary.partial, 1, 'a session whose middle was never sent is not fully read');
    // 6,000 head + 20,000 tail is all the lessons pass sees.
    assert.strictEqual(summary.unreadByLessons, chars + 11 - 26000);
    rmSync(root, { recursive: true, force: true });
  });

  // The two passes read different spans, and the fact pass keeps a strict
  // superset. Reporting one number for both claimed the lessons gap as unread
  // even when the fact pass had read every character of it.
  it('reports the two passes separately, because they read different spans', async () => {
    const chars = 100000;
    const root = sessionOf('both-passes.jsonl', chars);

    // dryRun: the fact pass still chunks and still calls, it just does not write
    // — otherwise these rows would leak into the fact-extraction tests below.
    const summary = await runHarvest({ searchRoots: [root], sinceHours: 24, facts: true, dryRun: true });

    assert.strictEqual(summary.unreadByLessons, chars + 11 - 26000, 'the lessons pass still missed the middle');
    assert.strictEqual(summary.unreadByFacts, 0, 'but the fact pass read all of it — 9 chunks, under the cap');
    rmSync(root, { recursive: true, force: true });
  });

  it('reports the fact pass gap once a session outruns the chunk cap', async () => {
    // 20 chunks of 12,000 is the ceiling. 300,011 chars is 26 chunks, so the 6
    // in the middle are dropped — 72,000 characters, not 60,011, because the
    // last chunk is a short remainder.
    const root = sessionOf('enormous.jsonl', 300000);

    const summary = await runHarvest({ searchRoots: [root], sinceHours: 24, facts: true, dryRun: true });

    assert.strictEqual(summary.unreadByFacts, 6 * 12000, 'a session past the chunk cap loses its middle to the fact pass too');
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

  it('caps long texts to head + tail chunks', () => {
    const text = 'a'.repeat(12000 * 30);
    const chunks = chunkText(text);
    assert.strictEqual(chunks.length, 20);
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
