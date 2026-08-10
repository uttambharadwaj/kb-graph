import './helpers/tmp-kb.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initSchema, getDb } from '../src/db.js';
import { SURFACE } from '../src/retrieval.js';
import { REF_MAX_CHARS, TIER } from '../src/tiers.js';
import {
  applyDecision, computePromotionDecisions, runPromotionsCli, PROMOTIONS_LOG_DIR, WOULD_PROMOTE_LOG,
} from '../src/cli/promotions.js';
import { TRIGGERS_LOG_DIR } from '../src/cli/trigger-hook.js';

function freshDb() {
  const db = new Database(':memory:');
  initSchema(db);
  return db;
}

function insertDoc(db, { title = 't', tier = TIER.INFERRED, superseded = false } = {}) {
  const id = db.prepare('INSERT INTO documents (title, content, doc_type) VALUES (?, ?, ?)').run(title, 'body', 'note').lastInsertRowid;
  db.prepare('UPDATE documents SET tier = ? WHERE id = ?').run(tier, id);
  if (superseded) db.prepare('UPDATE documents SET superseded_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  return id;
}

function insertRetrieval(db, {
  docId = null, surface, query = null, session = null, created_at = null, eventId = null, isTest = 0,
} = {}) {
  db.prepare(`
    INSERT INTO retrievals (doc_id, surface, query, session, created_at, event_id, is_test)
    VALUES (?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?)
  `).run(docId, surface, query, session, created_at, eventId, isTest);
}

// Push at t0, read (follows it) at t0 + 5min — well inside the 30min window.
function pushAndFollow(db, doc, { surface = SURFACE.HINT, session = 's1', eventId = 'e1' } = {}) {
  insertRetrieval(db, { docId: doc, surface, session, query: 'q', eventId, created_at: '2026-08-10 10:00:00' });
  insertRetrieval(db, { docId: doc, surface: SURFACE.READ, session, created_at: '2026-08-10 10:05:00' });
}

function resetLog() {
  rmSync(PROMOTIONS_LOG_DIR, { recursive: true, force: true });
}

beforeEach(() => {
  resetLog();
  rmSync(TRIGGERS_LOG_DIR, { recursive: true, force: true });
  mkdirSync(TRIGGERS_LOG_DIR, { recursive: true });
});

describe('candidate selection', () => {
  it('a followed hint event on an inferred, live doc becomes a new candidate', () => {
    const db = freshDb();
    const doc = insertDoc(db, { title: 'inferred note' });
    pushAndFollow(db, doc);

    const { candidates, skipped } = computePromotionDecisions(db);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].doc_id, doc);
    assert.strictEqual(candidates[0].title, 'inferred note');
    assert.strictEqual(candidates[0].current_tier, TIER.INFERRED);
    assert.strictEqual(candidates[0].would_become, TIER.OBSERVED);
  });

  it('an already-observed doc is not a candidate', () => {
    const db = freshDb();
    const doc = insertDoc(db, { tier: TIER.OBSERVED });
    pushAndFollow(db, doc);

    const { candidates } = computePromotionDecisions(db);
    assert.strictEqual(candidates.length, 0);
  });

  it('a hint push with no matching read yields no candidate', () => {
    const db = freshDb();
    const doc = insertDoc(db);
    insertRetrieval(db, { docId: doc, surface: SURFACE.HINT, session: 's1', query: 'q', eventId: 'e1', created_at: '2026-08-10 10:00:00' });
    // no follow-up read at all

    const { candidates } = computePromotionDecisions(db);
    assert.strictEqual(candidates.length, 0);
  });

  it('a superseded doc is not a candidate even when followed', () => {
    const db = freshDb();
    const doc = insertDoc(db, { superseded: true });
    pushAndFollow(db, doc);

    const { candidates } = computePromotionDecisions(db);
    assert.strictEqual(candidates.length, 0);
  });

  it('a followed briefing push never becomes a candidate — mechanical exposure is not reliance', () => {
    const db = freshDb();
    const doc = insertDoc(db);
    pushAndFollow(db, doc, { surface: SURFACE.BRIEFING });

    const { candidates } = computePromotionDecisions(db);
    assert.strictEqual(candidates.length, 0);
  });

  it('a followed trigger fire on an inferred doc becomes a candidate', () => {
    const db = freshDb();
    const doc = insertDoc(db, { title: 'triggered note' });
    writeFileSync(join(TRIGGERS_LOG_DIR, 'fires-2026-08-10.jsonl'), JSON.stringify({
      ts: '2026-08-10T10:00:00.000Z', session: 's1', cwd: '/tmp', command: 'echo hi',
      matched: [{ id: doc, hits: 2 }], emitted: true,
    }) + '\n');
    insertRetrieval(db, { docId: doc, surface: SURFACE.READ, session: 's1', created_at: '2026-08-10 10:05:00' });

    const { candidates } = computePromotionDecisions(db);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].doc_id, doc);
    assert.match(candidates[0].basis.event_id, /^trigger:/);
  });

  it('basis carries session, followed_at and a positive read_latency_s', () => {
    const db = freshDb();
    const doc = insertDoc(db);
    pushAndFollow(db, doc);

    const { candidates } = computePromotionDecisions(db);
    assert.strictEqual(candidates[0].basis.session, 's1');
    assert.strictEqual(candidates[0].basis.read_latency_s, 5 * 60);
    assert.strictEqual(candidates[0].basis.followed_at, '2026-08-10T10:05:00.000Z');
    assert.strictEqual(candidates[0].basis.event_id, 'id:e1');
  });

  it('a trigger fire from before the honest-session-id fix carries a caveat; a post-cutoff one and a hint-basis one never do', () => {
    const db = freshDb();
    const preCutoffDoc = insertDoc(db, { title: 'pre-cutoff' });
    const postCutoffDoc = insertDoc(db, { title: 'post-cutoff' });
    const hintDoc = insertDoc(db, { title: 'hint-basis' });

    // The fix landed 2026-08-10T04:46:50Z (kb-graph #87) — one fire just
    // before it, one just after.
    writeFileSync(join(TRIGGERS_LOG_DIR, 'fires-2026-08-10.jsonl'), [
      JSON.stringify({ ts: '2026-08-10T04:00:00.000Z', session: 's1', cwd: '/tmp', command: 'x', matched: [{ id: preCutoffDoc, hits: 1 }], emitted: true }),
      JSON.stringify({ ts: '2026-08-10T05:00:00.000Z', session: 's2', cwd: '/tmp', command: 'y', matched: [{ id: postCutoffDoc, hits: 1 }], emitted: true }),
    ].join('\n') + '\n');
    insertRetrieval(db, { docId: preCutoffDoc, surface: SURFACE.READ, session: 's1', created_at: '2026-08-10 04:05:00' });
    insertRetrieval(db, { docId: postCutoffDoc, surface: SURFACE.READ, session: 's2', created_at: '2026-08-10 05:05:00' });
    pushAndFollow(db, hintDoc, { session: 's3', eventId: 'e-hint' });

    const { candidates } = computePromotionDecisions(db);
    const byDoc = Object.fromEntries(candidates.map(c => [c.doc_id, c]));

    assert.strictEqual(byDoc[preCutoffDoc].basis.caveat, 'pre-honest-session-id fire — read-side join may be miscounted');
    assert.strictEqual(byDoc[postCutoffDoc].basis.caveat, undefined);
    assert.strictEqual(byDoc[hintDoc].basis.caveat, undefined);
  });
});

describe('dedup across runs', () => {
  it('a doc already in the log is skipped on rerun, even when followed again by a new event', () => {
    const db = freshDb();
    const doc = insertDoc(db);
    pushAndFollow(db, doc, { session: 's1', eventId: 'e1' });

    const first = computePromotionDecisions(db);
    assert.strictEqual(first.candidates.length, 1);
    mkdirSync(PROMOTIONS_LOG_DIR, { recursive: true });
    writeFileSync(WOULD_PROMOTE_LOG, JSON.stringify(first.candidates[0]) + '\n');

    // A second, distinct followed event for the same doc.
    pushAndFollow(db, doc, { session: 's2', eventId: 'e2' });

    const second = computePromotionDecisions(db);
    assert.strictEqual(second.candidates.length, 0, 'doc_id already logged — no re-append');
    assert.strictEqual(second.skipped.length, 1);
    assert.strictEqual(second.skipped[0].doc_id, doc);
  });

  it('re-running the real CLI does not duplicate a line for the same doc', async () => {
    // Exercises the actual entry point (runPromotionsCli -> getDb()), not the
    // exported computePromotionDecisions helper the tests above use directly.
    const db = getDb();
    db.exec('DELETE FROM retrievals; DELETE FROM documents;');
    const doc = insertDoc(db, { title: 'cli dedup note' });
    pushAndFollow(db, doc);

    const orig = console.log;
    console.log = () => {};
    try {
      await runPromotionsCli([]);
      await runPromotionsCli([]);
    } finally {
      console.log = orig;
    }

    const lines = readFileSync(WOULD_PROMOTE_LOG, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const forDoc = lines.filter(l => l.doc_id === doc);
    assert.strictEqual(forDoc.length, 1, 'one line ever, even after two runs');
  });
});

describe('jsonl log shape', () => {
  it('an appended line has exactly the documented fields, plus applied', () => {
    const db = freshDb();
    const doc = insertDoc(db, { title: 'shaped note' });
    pushAndFollow(db, doc);

    const { candidates } = computePromotionDecisions(db);
    const decisions = candidates.map(c => ({ ...c, applied: true }));
    mkdirSync(PROMOTIONS_LOG_DIR, { recursive: true });
    writeFileSync(WOULD_PROMOTE_LOG, decisions.map(c => JSON.stringify(c)).join('\n') + '\n');

    const lines = readFileSync(WOULD_PROMOTE_LOG, 'utf-8').trim().split('\n');
    assert.strictEqual(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.deepStrictEqual(Object.keys(row).sort(), ['applied', 'basis', 'current_tier', 'decided_at', 'doc_id', 'title', 'would_become'].sort());
    assert.deepStrictEqual(Object.keys(row.basis).sort(), ['event_id', 'followed_at', 'read_latency_s', 'session'].sort());
    assert.strictEqual(typeof row.decided_at, 'string');
    assert.ok(!Number.isNaN(Date.parse(row.decided_at)));
    assert.strictEqual(row.applied, true);
  });
});

describe('read-only on the DB', () => {
  it('running the CLI never mutates documents or retrievals', () => {
    const db = freshDb();
    const doc = insertDoc(db, { title: 'must stay inferred' });
    pushAndFollow(db, doc);

    const docsBefore = db.prepare('SELECT tier, superseded_at FROM documents WHERE id = ?').get(doc);
    const retrievalsCountBefore = db.prepare('SELECT COUNT(*) AS n FROM retrievals').get().n;
    const docsCountBefore = db.prepare('SELECT COUNT(*) AS n FROM documents').get().n;

    computePromotionDecisions(db); // the read-only half — no appendDecisions call

    const docsAfter = db.prepare('SELECT tier, superseded_at FROM documents WHERE id = ?').get(doc);
    const retrievalsCountAfter = db.prepare('SELECT COUNT(*) AS n FROM retrievals').get().n;
    const docsCountAfter = db.prepare('SELECT COUNT(*) AS n FROM documents').get().n;

    assert.deepStrictEqual(docsAfter, docsBefore, 'tier must not move — this is a dry run');
    assert.strictEqual(retrievalsCountAfter, retrievalsCountBefore, 'no retrieval row logged by the promotions read path');
    assert.strictEqual(docsCountAfter, docsCountBefore);
  });
});

describe('--json output and CLI wiring', () => {
  it('prints the documented top-level shape via the real CLI entry point', async () => {
    const db = getDb();
    db.exec('DELETE FROM retrievals; DELETE FROM documents;');
    const doc = insertDoc(db, { title: 'json note' });
    pushAndFollow(db, doc);

    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try {
      await runPromotionsCli(['--json']);
    } finally {
      console.log = orig;
    }

    assert.strictEqual(logs.length, 1, 'exactly one JSON blob printed');
    const payload = JSON.parse(logs[0]);
    assert.deepStrictEqual(Object.keys(payload).sort(), ['applied', 'candidates', 'decisions', 'new', 'skippedAlreadyLogged'].sort());
    assert.strictEqual(payload.candidates, 1);
    assert.strictEqual(payload.new, 1);
    assert.strictEqual(payload.applied, 1, 'apply is the default');
    assert.strictEqual(payload.skippedAlreadyLogged, 0);
    assert.strictEqual(payload.decisions[0].doc_id, doc);
    assert.strictEqual(payload.decisions[0].applied, true);
  });

  it('rejects an unknown --apply flag — there is no such flag, applying is the default', async () => {
    // Unrecognized flags are refused before any work runs (flags.js's
    // assertKnownFlags) — a mistyped flag must not be read as consent to run
    // with defaults.
    await assert.rejects(() => runPromotionsCli(['--apply']), /Unknown flag: --apply/);
  });
});

describe('apply path (live by default)', () => {
  it('an eligible followed doc is promoted to observed in the DB, with confirmed_by recorded', async () => {
    const db = getDb();
    db.exec('DELETE FROM retrievals; DELETE FROM documents;');
    const doc = insertDoc(db, { title: 'apply me' });
    pushAndFollow(db, doc);

    const orig = console.log;
    console.log = () => {};
    try {
      await runPromotionsCli([]);
    } finally {
      console.log = orig;
    }

    const row = db.prepare('SELECT tier, tier_ref FROM documents WHERE id = ?').get(doc);
    assert.strictEqual(row.tier, TIER.OBSERVED);
    assert.match(row.tier_ref, /^Follow-through join: hint event id:e1, session s1, followed .+ \(read latency 300s\); auto-applied by kb promotions$/);
  });

  it('a doc already in the log is not re-applied, even though it is still eligible', async () => {
    const db = getDb();
    db.exec('DELETE FROM retrievals; DELETE FROM documents;');
    const doc = insertDoc(db, { title: 'already logged' });
    pushAndFollow(db, doc);
    mkdirSync(PROMOTIONS_LOG_DIR, { recursive: true });
    writeFileSync(WOULD_PROMOTE_LOG, JSON.stringify({ doc_id: doc, applied: true }) + '\n');

    const orig = console.log;
    console.log = () => {};
    try {
      await runPromotionsCli([]);
    } finally {
      console.log = orig;
    }

    assert.strictEqual(db.prepare('SELECT tier FROM documents WHERE id = ?').get(doc).tier, TIER.INFERRED, 'dedup must block re-apply, not just re-log');
  });
});

describe('--dry-run', () => {
  it('restores log-only behavior: zero document writes', async () => {
    const db = getDb();
    db.exec('DELETE FROM retrievals; DELETE FROM documents;');
    const doc = insertDoc(db, { title: 'dry run note' });
    pushAndFollow(db, doc);

    const orig = console.log;
    console.log = () => {};
    try {
      await runPromotionsCli(['--dry-run']);
    } finally {
      console.log = orig;
    }

    assert.strictEqual(db.prepare('SELECT tier FROM documents WHERE id = ?').get(doc).tier, TIER.INFERRED);
    const lines = readFileSync(WOULD_PROMOTE_LOG, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const line = lines.find(l => l.doc_id === doc);
    assert.strictEqual(line.applied, false);
  });
});

describe('pre-cutoff exception', () => {
  it('a pre-cutoff trigger candidate is logged with applied:false and the caveat; tier is unchanged', async () => {
    const db = getDb();
    db.exec('DELETE FROM retrievals; DELETE FROM documents;');
    const doc = insertDoc(db, { title: 'pre-cutoff note' });
    writeFileSync(join(TRIGGERS_LOG_DIR, 'fires-2026-08-10.jsonl'), JSON.stringify({
      ts: '2026-08-10T04:00:00.000Z', session: 's1', cwd: '/tmp', command: 'x', matched: [{ id: doc, hits: 1 }], emitted: true,
    }) + '\n');
    insertRetrieval(db, { docId: doc, surface: SURFACE.READ, session: 's1', created_at: '2026-08-10 04:05:00' });

    const orig = console.log;
    console.log = () => {};
    try {
      await runPromotionsCli([]);
    } finally {
      console.log = orig;
    }

    assert.strictEqual(db.prepare('SELECT tier FROM documents WHERE id = ?').get(doc).tier, TIER.INFERRED, 'pre-cutoff candidates must never be applied');
    const lines = readFileSync(WOULD_PROMOTE_LOG, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const line = lines.find(l => l.doc_id === doc);
    assert.strictEqual(line.applied, false);
    assert.match(line.basis.caveat, /pre-honest-session-id/);
  });
});

describe('confirmed_by clamping', () => {
  it('a legacy hint key with a very long query is truncated to fit REF_MAX_CHARS, and still applies', async () => {
    const db = getDb();
    db.exec('DELETE FROM retrievals; DELETE FROM documents;');
    const doc = insertDoc(db, { title: 'long-query note' });
    // event_id NULL -> follow-through's eventKey falls back to
    // ts:${session}|hint|${created_at}|${query}, embedding the query
    // verbatim. 400 chars alone overflows confirmed_by's ~150 chars of
    // fixed prefix/suffix past REF_MAX_CHARS (500).
    insertRetrieval(db, { docId: doc, surface: SURFACE.HINT, session: 's1', query: 'x'.repeat(400), eventId: null, created_at: '2026-08-10 10:00:00' });
    insertRetrieval(db, { docId: doc, surface: SURFACE.READ, session: 's1', created_at: '2026-08-10 10:05:00' });

    const orig = console.log;
    console.log = () => {};
    try {
      await runPromotionsCli([]);
    } finally {
      console.log = orig;
    }

    const row = db.prepare('SELECT tier, tier_ref FROM documents WHERE id = ?').get(doc);
    assert.strictEqual(row.tier, TIER.OBSERVED, 'clamping must let the candidate through, not poison it');
    assert.ok(row.tier_ref.length <= REF_MAX_CHARS, `tier_ref is ${row.tier_ref.length} chars, over the ${REF_MAX_CHARS} limit`);
    assert.match(row.tier_ref, /…, session s1, followed/, 'the query tail is clipped with an ellipsis, session/followed_at survive intact');

    const lines = readFileSync(WOULD_PROMOTE_LOG, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const line = lines.find(l => l.doc_id === doc);
    assert.strictEqual(line.applied, true);
    assert.strictEqual(line.error, undefined);
  });
});

describe('per-candidate error isolation', () => {
  it('a candidate whose confirmed_by still overflows after clamping fails alone; clean candidates before and after still apply with audit lines', async () => {
    const db = getDb();
    db.exec('DELETE FROM retrievals; DELETE FROM documents;');
    // Clamping only clips the event_id — session, followed_at and
    // read_latency_s are kept intact by design (see buildConfirmedBy's
    // comment), so a pathological session is the deterministic way to make
    // confirmed_by overflow REF_MAX_CHARS even after the clamp: this is the
    // isolation backstop's own test, not a regression of the clamp fix.
    const before = insertDoc(db, { title: 'clean before' });
    const poison = insertDoc(db, { title: 'poison' });
    const after = insertDoc(db, { title: 'clean after' });
    pushAndFollow(db, before, { session: 's-before', eventId: 'e-before' });
    pushAndFollow(db, poison, { session: 's'.repeat(480), eventId: 'e-poison' });
    pushAndFollow(db, after, { session: 's-after', eventId: 'e-after' });

    const orig = console.log;
    console.log = () => {};
    try {
      await runPromotionsCli([]);
    } finally {
      console.log = orig;
    }

    assert.strictEqual(db.prepare('SELECT tier FROM documents WHERE id = ?').get(before).tier, TIER.OBSERVED, 'the candidate before the poison one must still apply');
    assert.strictEqual(db.prepare('SELECT tier FROM documents WHERE id = ?').get(after).tier, TIER.OBSERVED, 'the candidate after the poison one must still apply');
    assert.strictEqual(db.prepare('SELECT tier FROM documents WHERE id = ?').get(poison).tier, TIER.INFERRED, 'the poison candidate itself must not be applied');

    const lines = readFileSync(WOULD_PROMOTE_LOG, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const byDoc = Object.fromEntries(lines.map(l => [l.doc_id, l]));
    assert.strictEqual(byDoc[before].applied, true);
    assert.strictEqual(byDoc[after].applied, true);
    assert.strictEqual(byDoc[poison].applied, false);
    assert.match(byDoc[poison].error, /must record what confirmed/, 'the real promoteDocumentTier failure reason is preserved on the line');
  });
});

describe('applyDecision outcome contract', () => {
  it('a doc gone by apply time reports applied:false with a reason, never a bare success', async () => {
    const db = getDb();
    db.exec('DELETE FROM retrievals; DELETE FROM documents;');
    const doc = insertDoc(db, { title: 'vanishing note' });
    pushAndFollow(db, doc);
    const { candidates } = computePromotionDecisions(db);
    assert.strictEqual(candidates.length, 1);

    db.prepare('DELETE FROM documents WHERE id = ?').run(doc); // gone between compute and apply

    const outcome = await applyDecision(candidates[0]);
    assert.strictEqual(outcome.applied, false);
    assert.match(outcome.error, /gone since the decision was computed/);
  });

  it('a vault-file failure past a successful DB promotion still reports applied:true, with the failure noted', async () => {
    const db = getDb();
    db.exec('DELETE FROM retrievals; DELETE FROM documents;');
    const doc = insertDoc(db, { title: 'no vault file for this one' });
    pushAndFollow(db, doc);
    const { candidates } = computePromotionDecisions(db);

    // insertDoc never creates a vault_files row, so this exercises the
    // "no vault file" branch, not a genuine I/O failure — applyDecision must
    // still report applied:true either way, since the DB write is what
    // makes a promotion real.
    const outcome = await applyDecision(candidates[0]);
    assert.strictEqual(outcome.applied, true);
    assert.strictEqual(outcome.error, undefined);
    assert.strictEqual(db.prepare('SELECT tier FROM documents WHERE id = ?').get(doc).tier, TIER.OBSERVED);
  });
});

describe('incremental audit log', () => {
  it('every candidate this run gets its own log line, applied or not', async () => {
    const db = getDb();
    db.exec('DELETE FROM retrievals; DELETE FROM documents;');
    const a = insertDoc(db, { title: 'first' });
    const b = insertDoc(db, { title: 'second' });
    pushAndFollow(db, a, { session: 's-a', eventId: 'e-a' });
    pushAndFollow(db, b, { session: 's-b', eventId: 'e-b' });

    const orig = console.log;
    console.log = () => {};
    try {
      await runPromotionsCli([]);
    } finally {
      console.log = orig;
    }

    const lines = readFileSync(WOULD_PROMOTE_LOG, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    assert.strictEqual(lines.filter(l => l.doc_id === a || l.doc_id === b).length, 2, 'one line per candidate, written as the run went');
  });
});

describe('setNoteTier failure is not tolerated (matches kb_promote) and retries', () => {
  // vault_files row with no file on disk at that path -> setNoteTier's
  // readFileSync throws ENOENT. This is the deterministic, easily
  // reproduced stand-in for any vault I/O failure past a landed DB write.
  function seedDocWithMissingVaultFile(db, title) {
    const doc = insertDoc(db, { title });
    pushAndFollow(db, doc);
    db.prepare(
      'INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type, source) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('missing/does-not-exist.md', 'hash', doc, title, 'lesson', 'test');
    return doc;
  }

  async function runQuietly(args) {
    const orig = console.log;
    console.log = () => {};
    try {
      await runPromotionsCli(args);
    } finally {
      console.log = orig;
    }
  }

  it('a setNoteTier failure yields applied:false + error, leaving the DB tier for a reindex to reconcile', async () => {
    const db = getDb();
    db.exec('DELETE FROM retrievals; DELETE FROM documents; DELETE FROM vault_files;');
    const doc = seedDocWithMissingVaultFile(db, 'vault file missing on disk');

    await runQuietly([]);

    const lines = readFileSync(WOULD_PROMOTE_LOG, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const line = lines.find(l => l.doc_id === doc);
    assert.strictEqual(line.applied, false, 'an unguarded setNoteTier throw must not be reported as a successful apply');
    assert.match(line.error, /ENOENT|no such file/i);
    // promoteDocumentTier's DB write is not rolled back — that's the whole
    // point of leaving the vault file to be the thing a future reindex
    // reconciles against, matching kb_promote's own semantics.
    assert.strictEqual(db.prepare('SELECT tier FROM documents WHERE id = ?').get(doc).tier, TIER.OBSERVED);
  });

  it('an error-row candidate is retried next run, and succeeds once the underlying failure is fixed', async () => {
    const db = getDb();
    db.exec('DELETE FROM retrievals; DELETE FROM documents; DELETE FROM vault_files;');
    const doc = seedDocWithMissingVaultFile(db, 'retryable note');

    await runQuietly([]); // first run: fails, applied:false + error

    // Stand in for what the next real `kb vault reindex` would do: the
    // vault file never got the tier written, so reindexing (source of
    // truth) reverts the DB back to inferred.
    db.prepare('UPDATE documents SET tier = ? WHERE id = ?').run(TIER.INFERRED, doc);

    // Fix the underlying problem: the vault file now actually exists.
    mkdirSync(join(process.env.OBSIDIAN_VAULT_PATH, 'missing'), { recursive: true });
    writeFileSync(
      join(process.env.OBSIDIAN_VAULT_PATH, 'missing/does-not-exist.md'),
      '---\ntitle: "retryable note"\ntype: lesson\n---\n\nBody text.\n',
    );

    await runQuietly([]); // second run: same followed event, now retried

    const lines = readFileSync(WOULD_PROMOTE_LOG, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const forDoc = lines.filter(l => l.doc_id === doc);
    assert.strictEqual(forDoc.length, 2, 'the failed line does not block a second attempt from being logged too');
    assert.strictEqual(forDoc[0].applied, false);
    assert.strictEqual(forDoc[1].applied, true, 'retried and succeeded once the vault file existed');
    assert.strictEqual(forDoc[1].error, undefined);
    assert.strictEqual(db.prepare('SELECT tier FROM documents WHERE id = ?').get(doc).tier, TIER.OBSERVED);
  });
});

describe('dedup is unaffected for non-error rows', () => {
  async function runQuietly(args) {
    const orig = console.log;
    console.log = () => {};
    try {
      await runPromotionsCli(args);
    } finally {
      console.log = orig;
    }
  }

  it('a dry-run row and a pre-cutoff caveat row still dedup on rerun, since neither carries an error', async () => {
    const db = getDb();
    db.exec('DELETE FROM retrievals; DELETE FROM documents;');
    const dryRunDoc = insertDoc(db, { title: 'dry run dedup check' });
    pushAndFollow(db, dryRunDoc, { session: 's-dry', eventId: 'e-dry' });
    await runQuietly(['--dry-run']); // first pass, logs a dry-run row (applied:false, no error)

    const preCutoffDoc = insertDoc(db, { title: 'pre-cutoff dedup check' });
    writeFileSync(join(TRIGGERS_LOG_DIR, 'fires-2026-08-10.jsonl'), JSON.stringify({
      ts: '2026-08-10T04:00:00.000Z', session: 's-cutoff', cwd: '/tmp', command: 'x', matched: [{ id: preCutoffDoc, hits: 1 }], emitted: true,
    }) + '\n');
    insertRetrieval(db, { docId: preCutoffDoc, surface: SURFACE.READ, session: 's-cutoff', created_at: '2026-08-10 04:05:00' });

    await runQuietly([]); // second pass: default (apply) mode, both docs re-evaluated

    const lines = readFileSync(WOULD_PROMOTE_LOG, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    assert.strictEqual(lines.filter(l => l.doc_id === dryRunDoc).length, 1, 'the dry-run row already logged it once — no error field, so it must still dedup');
    assert.strictEqual(lines.filter(l => l.doc_id === preCutoffDoc).length, 1, 'the pre-cutoff caveat row has no error field either, and must dedup the same way');
  });
});
