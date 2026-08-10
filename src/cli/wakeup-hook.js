// SessionStart hook: print a compact KB briefing to stdout so the harness
// injects it as session context. Mechanical replacement for asking agents
// to "run kb_wakeup at session start" — instructions decay, hooks don't.
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getDb, getDocument, getHealth, liveTierCounts } from '../db.js';
import { isBatchCall } from '../claude-cli.js';
import { READ_SURFACES, SURFACE, logRetrieval, resolveSessionId } from '../retrieval.js';
import { TIER, tierLabel, tiersDiscriminate } from '../tiers.js';
import { unresolvableHookCommands } from './setup-hooks.js';

// Post-compact context loses everything not in the transcript summary,
// including which workstream was active. Prefer the state note this session
// itself read (a compact can land on a note that isn't the freshest overall);
// fall back to the same "most recent" note the briefing's `states` list
// already surfaces.
//
// Must filter to READ_SURFACES, not any retrieval: this same function runs
// after the states loop below has already logged BRIEFING rows for the
// current session, so an unfiltered query would just match its own push.
function activeStateNote(db, session, states) {
  if (session) {
    const placeholders = READ_SURFACES.map(() => '?').join(', ');
    const hit = db.prepare(`
      SELECT vf.document_id, vf.title
      FROM retrievals r
      JOIN vault_files vf ON vf.document_id = r.doc_id
      JOIN documents d ON d.id = vf.document_id
      WHERE r.session = ? AND r.surface IN (${placeholders}) AND vf.note_type = 'state' AND d.superseded_at IS NULL
      ORDER BY r.created_at DESC
      LIMIT 1
    `).get(session, ...READ_SURFACES);
    if (hit) return hit;
  }
  return states[0] ? { document_id: states[0].document_id, title: states[0].title } : null;
}

// Cap so a large state note can't itself blow the post-compact context budget
// — this is injected on top of a context that just got compacted for size.
const ACTIVE_NOTE_CAP = 6000;

// A hook whose paths have gone stale fails exactly like one with nothing to
// say, so the only place it can surface is a briefing that goes looking. This
// runs inside the briefing and must never be the reason one fails to print.
function staleHookWarnings(home = homedir()) {
  try {
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    return unresolvableHookCommands(settings).flatMap(h => [
      ...(h.missing.length ? [`${h.event} hook cannot run: ${h.missing.join(', ')} missing — re-run 'kb setup' if this is a moved checkout`] : []),
      ...(h.pinned.length ? [`${h.event} hook is pinned to one package version and dies on the next upgrade: ${h.pinned.join(', ')} — re-run 'kb setup'`] : []),
    ]);
  } catch {
    return [];
  }
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

export async function wakeupHook() {
  // Our own model subprocesses are not sessions. Briefing one costs ~480 tokens
  // it cannot use, and logs it as a briefed session the meter then counts.
  if (isBatchCall()) process.exit(0);
  // Parsed separately from the briefing query below: a malformed/absent stdin
  // payload should cost us the session id, not the whole briefing.
  let hookInput = {};
  try {
    hookInput = JSON.parse((await readStdin()) || '{}');
  } catch {
    // fall through with hookInput = {}
  }
  try {
    const db = getDb();
    const total = db.prepare('SELECT COUNT(*) as c FROM documents').get().c;
    const facts = db.prepare('SELECT COUNT(*) as c FROM facts WHERE valid_to IS NULL').get().c;
    const byType = db.prepare(
      'SELECT note_type, COUNT(*) as c FROM vault_files WHERE note_type IS NOT NULL GROUP BY note_type ORDER BY c DESC LIMIT 6'
    ).all();
    // LEFT JOIN so vault files without a linked document still show; the
    // filter drops only notes whose document is superseded (superseded_at is
    // NULL for both live and unlinked rows).
    const recent = db.prepare(
      "SELECT vf.title, vf.note_type, vf.project, d.tier FROM vault_files vf LEFT JOIN documents d ON d.id = vf.document_id WHERE vf.note_type NOT IN ('archive') AND d.superseded_at IS NULL ORDER BY vf.indexed_at DESC LIMIT 8"
    ).all();
    // Same gate as the hint: a standing line reading "inferred 2062" every
    // session, and a mark on every row below it, say nothing while the store
    // holds one tier. Both appear on their own once a note is promoted.
    const tiers = liveTierCounts();
    const showTier = tiersDiscriminate(tiers);

    const health = getHealth({ recordBacklog: true });
    const warnings = [...health.warnings, ...staleHookWarnings()];
    const healthLine = warnings.length === 0
      ? `health: OK (embeddings ${health.embeddings}, summaries ${health.summaries})`
      : `health: ⚠ ${warnings.join(' | ')}`;

    const states = db.prepare(
      "SELECT vf.title, vf.document_id, d.tier, d.updated_at FROM vault_files vf JOIN documents d ON d.id = vf.document_id WHERE vf.note_type = 'state' AND d.superseded_at IS NULL ORDER BY d.updated_at DESC LIMIT 8"
    ).all();
    // Only `states` carries an id into the printed briefing (`#id`) — that's
    // the only part of this hook an agent can act on with kb_read(id), so
    // it's the only part worth logging as a retrieval.
    const session = resolveSessionId(hookInput);
    for (const s of states) logRetrieval({ docId: s.document_id, surface: SURFACE.BRIEFING, session });

    const lines = [
      `KB BRIEFING (knowledge-base MCP; ${total} docs, ${facts} current facts; types: ${byType.map(t => `${t.note_type} ${t.c}`).join(', ')})`,
      healthLine,
      ...(showTier ? [`standing: ${tiers.map(t => `${tierLabel(t.tier)} ${t.count}`).join(', ')} — ⚠ ${TIER.INFERRED} notes are unconfirmed model conclusions; confirm one with kb_promote when a session proves it`] : []),
      ...(states.length ? [
        'Active workstreams (kb_read for current state):',
        ...states.map(s => `- #${s.document_id} ${s.title} (${showTier ? `${tierLabel(s.tier)}, ` : ''}as of ${s.updated_at?.slice(0, 10)})`),
      ] : []),
      'Recently updated:',
      ...recent.map(r => `- ${r.title}${r.project ? ` [${r.project}]` : ''} (${r.note_type}${showTier ? `, ${tierLabel(r.tier)}` : ''})`),
      'Before non-trivial work: kb_search(query, tags) or kb_context(query). Entity history: kb_fact_query(entity). Capture learnings at session end via /debrief.',
    ];

    if (hookInput.source === 'compact') {
      try {
        const active = activeStateNote(db, session, states);
        const doc = active ? getDocument(active.document_id) : null;
        if (doc?.content) {
          const truncated = doc.content.length > ACTIVE_NOTE_CAP;
          const body = truncated ? doc.content.slice(0, ACTIVE_NOTE_CAP) : doc.content;
          // Already logged above if this note is also in `states`; log it here
          // only when it isn't, so the session-scoped pick doesn't double-count.
          if (!states.some(s => s.document_id === active.document_id)) {
            logRetrieval({ docId: active.document_id, surface: SURFACE.BRIEFING, session });
          }
          lines.push(
            `--- Active workstream state (post-compact recovery): ${active.title} (#${active.document_id}) ---`,
            body,
            ...(truncated ? [`[truncated at ${ACTIVE_NOTE_CAP} chars — kb_read(${active.document_id}) for the rest]`] : []),
          );
        }
      } catch {
        // Never let post-compact recovery be the reason the briefing fails.
      }
    }

    console.log(lines.join('\n'));
  } catch {
    // Never block session start on KB problems.
  }
  process.exit(0);
}
