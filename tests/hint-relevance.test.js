// The prompt-hint surface used to fire on 100% of prompts — 94 of 94 logged
// prompts returned exactly three notes, and the "nothing matched" path had
// never once run. These tests pin the behaviour that makes it a signal: it has
// to be able to say no, and each threshold that lets it say no is exercised by
// a case that fails if that threshold is removed.
import './helpers/tmp-kb.js';
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { getDb } from '../src/db.js';
import { relevantNotes, tokenize } from '../src/hint-relevance.js';

// Distinctive: its vocabulary appears in a couple of notes, so it clears the
// singleton floor and still carries real information.
const RARE_NOTE = ['Sundial calibration drifts after a leap second', 'the offset is reapplied on restart', 'lesson', 'timekeeping'];
const RARE_SIBLING = ['Leap second handling in the sundial exporter', 'calibration offsets are emitted per reading', 'note', 'timekeeping'];
// Identity built from words this corpus is saturated with, plus one rare word.
const DILUTE_NOTE = ['Workflow queue depth', 'queue depth under a workflow', 'lesson', ''];
const singleton = (i) => `zq${i}xj${i}kv`;

before(() => {
  const db = getDb();
  const insert = db.prepare('INSERT INTO documents (title, content, doc_type, tags) VALUES (?, ?, ?, ?)');
  insert.run(...RARE_NOTE);
  insert.run(...RARE_SIBLING);
  insert.run(...DILUTE_NOTE);
  for (let i = 0; i < 5; i++) insert.run(`Workflow note ${i}`, 'workflow body', 'note', 'process');
  // Vocabulary shared with nothing else in the fixture, so what surfaces these
  // is the coverage rule and not the candidate ordering.
  insert.run('Logic gates', 'boolean reduction', 'note', '');
  insert.run('Logic gates revisited', 'so neither term is a singleton', 'note', '');
  // "queue" and "depth" land in ~13% of the corpus: frequent enough to be weak
  // evidence, rare enough to survive the query's document-frequency ceiling.
  for (let i = 0; i < 40; i++) insert.run(`Queue depth report ${i}`, 'periodic capacity readout', 'note', 'ops');
  // Each filler carries one token found nowhere else — the fixture's stand-in
  // for the commit hashes and paths a real prompt is full of.
  for (let i = 0; i < 260; i++) insert.run(`Filler ${i}`, `unremarkable prose ${singleton(i)}`, 'note', 'misc');
});

describe('tokenize', () => {
  it('produces only terms the FTS index actually holds', () => {
    // The comment on tokenize() claims parity with unicode61. Check it against
    // a real FTS5 table rather than against the regex.
    const text = 'café naïve Ünicode co-operate re_entrant Sundial/rate-cards';
    const fts = new Database(':memory:');
    fts.exec('CREATE VIRTUAL TABLE t USING fts5(x)');
    fts.prepare('INSERT INTO t VALUES(?)').run(text);
    fts.exec("CREATE VIRTUAL TABLE v USING fts5vocab(t,'row')");
    const indexed = new Set(fts.prepare('SELECT term FROM v').all().map(r => r.term));
    const orphans = tokenize(text).filter(t => !indexed.has(t));
    assert.deepStrictEqual(orphans, [], 'these terms can never match anything in the index');
  });

  it('splits on every non-alphanumeric, so a hyphenated title matches its parts', () => {
    assert.deepStrictEqual(tokenize('bot-triage/queue_depth'), ['bot', 'triage', 'queue', 'depth']);
  });
});

describe('relevantNotes declines', () => {
  it('returns nothing for a prompt about something the store does not hold', () => {
    assert.deepStrictEqual(relevantNotes('what is the weather forecast for tomorrow afternoon'), []);
  });

  it('returns nothing for a long prompt that is about none of it', () => {
    // The original defect in one assertion: relevance was scored with bm25,
    // which sums a contribution per matched term, so a long enough prompt
    // cleared any fixed threshold on incidental overlap alone.
    const long = 'unremarkable prose about filler and misc topics '.repeat(300);
    assert.deepStrictEqual(relevantNotes(long), []);
  });

  it('does not hint on a single shared word', () => {
    const hits = relevantNotes('can you tell me about the sundial in the courtyard garden');
    assert.deepStrictEqual(hits, [], 'one shared identity term is a coincidence, not a subject');
  });

  it('does not hint when the shared words are too common to mean anything', () => {
    // Covers two identity terms — enough to pass the count gate — but both are
    // weak evidence, so their combined information stays under the bar.
    const hits = relevantNotes('pull the queue depth numbers for me and chart them by hour');
    assert.ok(!hits.some(h => h.title === 'Workflow queue depth'),
      `weak-evidence overlap surfaced a note: ${JSON.stringify(hits)}`);
  });

  it('does not let a three-letter word stand in for a longer one', () => {
    // "log" must not be evidence for "logic": the shared prefix is too short to
    // be an inflection.
    const hits = relevantNotes('the gates need a log line added to them today');
    assert.ok(!hits.some(h => h.title.startsWith('Logic gates')),
      `"log" was allowed to cover "logic": ${JSON.stringify(hits)}`);
  });

  it('does not treat a word as covered by an unrelated longer word', () => {
    // "work" must not cover "workflow". If it did, the rare term would push
    // this same weak overlap over the bar.
    const hits = relevantNotes('how much work does the queue depth reporting take each morning');
    assert.ok(!hits.some(h => h.title === 'Workflow queue depth'),
      `"work" was allowed to cover "workflow": ${JSON.stringify(hits)}`);
  });
});

describe('relevantNotes fires', () => {
  it('surfaces the note a prompt is actually about', () => {
    const hits = relevantNotes('the sundial calibration drifts every time we take a leap second');
    assert.ok(hits.length > 0, 'expected a hit for a prompt squarely about a stored note');
    assert.strictEqual(hits[0].title, RARE_NOTE[0]);
  });

  it('matches across inflection', () => {
    const hits = relevantNotes('our sundials keep drifting after leap seconds are applied');
    assert.ok(hits.some(h => h.title === RARE_NOTE[0]), JSON.stringify(hits));
  });

  it('lets the rare word carry the weak ones once the prompt names it', () => {
    const hits = relevantNotes('the workflow queue depth number looks wrong again today');
    assert.ok(hits.some(h => h.title === 'Workflow queue depth'), JSON.stringify(hits));
  });

  it('is not crowded out of its own query by one-off identifiers', () => {
    // A real prompt carries commit hashes, paths and ids that appear in one
    // note or none. Ranked purely by rarity they are the most "informative"
    // terms there are, and they fill the query budget before any topic word.
    const noise = Array.from({ length: 60 }, (_, i) => singleton(i)).join(' ');
    const hits = relevantNotes(`${noise} sundial calibration drift after the leap second`);
    assert.ok(hits.some(h => h.title === RARE_NOTE[0]),
      `noise terms displaced the topic terms: ${JSON.stringify(hits)}`);
  });

  it('honours the limit', () => {
    const hits = relevantNotes('the workflow queue depth number looks wrong again today', { limit: 1 });
    assert.ok(hits.length <= 1);
  });
});

describe('the hint count is not a constant', () => {
  it('varies across prompts instead of always returning the cap', () => {
    const prompts = [
      'what is the weather forecast for tomorrow afternoon',
      'the sundial calibration drifts every time we take a leap second',
      'the workflow queue depth number looks wrong again today',
      'please summarise yesterday for me in a couple of sentences',
      'sundial calibration and workflow queue depth both drifted after the leap second',
    ];
    const counts = new Set(prompts.map(p => relevantNotes(p).length));
    assert.ok(counts.size > 1, `every prompt returned the same number of hints: ${[...counts]}`);
    assert.ok(counts.has(0), 'no prompt was ever declined');
  });
});

function ensureOutcomeSchema(db) {
  const columns = db.prepare('PRAGMA table_info(retrievals)').all().map(c => c.name);
  if (!columns.includes('doc_version')) db.exec('ALTER TABLE retrievals ADD COLUMN doc_version TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS retrieval_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      retrieval_id INTEGER NOT NULL,
      doc_id INTEGER NOT NULL,
      doc_version TEXT,
      session TEXT,
      event_id TEXT,
      outcome TEXT NOT NULL,
      evidence_kind TEXT NOT NULL,
      evidence_ref TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session, doc_id, doc_version, outcome, evidence_ref)
    );
  `);
}

function insertOutcomeNote(db, title, hash) {
  const id = db.prepare('INSERT INTO documents (title, content, doc_type, tags) VALUES (?, ?, ?, ?)')
    .run(title, 'outcome compass calibration body', 'note', 'outcomes').lastInsertRowid;
  db.prepare("INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type) VALUES (?, ?, ?, ?, 'note')")
    .run(`${hash}.md`, hash, id, title);
  return id;
}

function recordOutcome(db, { docId, version, outcome, evidence = outcome }) {
  const retrievalId = db.prepare(`
    INSERT INTO retrievals (doc_id, doc_version, surface, session, is_test)
    VALUES (?, ?, 'kb_read', ?, 0)
  `).run(docId, version, `sess-${evidence}`).lastInsertRowid;
  db.prepare(`
    INSERT INTO retrieval_outcomes
      (retrieval_id, doc_id, doc_version, session, outcome, evidence_kind, evidence_ref, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(retrievalId, docId, version, `sess-${evidence}`, outcome, 'test', evidence, 'test');
}

describe('relevantNotes outcome feedback', () => {
  it('uses grounded helped outcomes as a conservative ordering signal only after admission', () => {
    const db = getDb();
    ensureOutcomeSchema(db);
    const first = insertOutcomeNote(db, 'Outcome compass calibration alpha', 'hint-helped-a');
    const second = insertOutcomeNote(db, 'Outcome compass calibration beta', 'hint-helped-b');
    recordOutcome(db, { docId: second, version: 'hint-helped-b', outcome: 'helped', evidence: 'helped-beta' });

    const hits = relevantNotes('outcome compass calibration needs review', { limit: 5, explain: true });

    assert.ok(hits.some(hit => hit.id === first), JSON.stringify(hits));
    assert.ok(hits.some(hit => hit.id === second), JSON.stringify(hits));
    assert.strictEqual(hits[0].id, second);
    assert.strictEqual(hits[0].outcome_adjustment, 0.5);
  });

  it('does not let helped history outrank much stronger prompt coverage', () => {
    const db = getDb();
    ensureOutcomeSchema(db);
    const weak = insertOutcomeNote(db, 'Outcome compass calibration alpha', 'hint-weak-helped');
    const strong = insertOutcomeNote(db, 'Outcome compass calibration vector matrix', 'hint-strong-lexical');
    recordOutcome(db, { docId: weak, version: 'hint-weak-helped', outcome: 'helped', evidence: 'weak-helped' });

    const hits = relevantNotes('outcome compass calibration vector matrix needs review', { limit: 5, explain: true });

    assert.ok(hits.findIndex(hit => hit.id === strong) < hits.findIndex(hit => hit.id === weak), JSON.stringify(hits));
  });

  it('does not admit an off-topic note just because it has helped history', () => {
    const db = getDb();
    ensureOutcomeSchema(db);
    const docId = insertOutcomeNote(db, 'Outcome unrelated zebra fixture', 'hint-offtopic');
    recordOutcome(db, { docId, version: 'hint-offtopic', outcome: 'helped', evidence: 'offtopic-helped' });

    const hits = relevantNotes('what is the weather forecast for tomorrow afternoon', { explain: true });

    assert.deepStrictEqual(hits, []);
  });

  it('demotes corrected outcomes without changing the note tier', () => {
    const db = getDb();
    ensureOutcomeSchema(db);
    const helped = insertOutcomeNote(db, 'Outcome compass correction alpha', 'hint-correct-a');
    const corrected = insertOutcomeNote(db, 'Outcome compass correction beta', 'hint-correct-b');
    const tierBefore = db.prepare('SELECT tier FROM documents WHERE id = ?').get(corrected).tier;
    recordOutcome(db, { docId: helped, version: 'hint-correct-a', outcome: 'helped', evidence: 'correct-helped' });
    recordOutcome(db, { docId: corrected, version: 'hint-correct-b', outcome: 'corrected', evidence: 'corrected-beta' });

    const hits = relevantNotes('outcome compass correction needs review', { limit: 5, explain: true });

    assert.ok(hits.find(hit => hit.id === corrected).outcome_adjustment < 0);
    assert.ok(hits.findIndex(hit => hit.id === helped) < hits.findIndex(hit => hit.id === corrected));
    assert.strictEqual(db.prepare('SELECT tier FROM documents WHERE id = ?').get(corrected).tier, tierBefore);
  });
});
