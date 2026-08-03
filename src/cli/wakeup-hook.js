// SessionStart hook: print a compact KB briefing to stdout so the harness
// injects it as session context. Mechanical replacement for asking agents
// to "run kb_wakeup at session start" — instructions decay, hooks don't.
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getDb, getHealth, liveTierCounts } from '../db.js';
import { isBatchCall } from '../claude-cli.js';
import { SURFACE, logRetrieval, resolveSessionId } from '../retrieval.js';
import { TIER, tierLabel, tiersDiscriminate } from '../tiers.js';
import { unresolvableHookCommands } from './setup-hooks.js';

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
    console.log(lines.join('\n'));
  } catch {
    // Never block session start on KB problems.
  }
  process.exit(0);
}
