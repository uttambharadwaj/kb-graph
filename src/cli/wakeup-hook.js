// SessionStart hook: print a compact KB briefing to stdout so the harness
// injects it as session context. Mechanical replacement for asking agents
// to "run kb_wakeup at session start" — instructions decay, hooks don't.
import { getDb, getHealth } from '../db.js';

export function wakeupHook() {
  try {
    const db = getDb();
    const total = db.prepare('SELECT COUNT(*) as c FROM documents').get().c;
    const facts = db.prepare('SELECT COUNT(*) as c FROM facts WHERE valid_to IS NULL').get().c;
    const byType = db.prepare(
      'SELECT note_type, COUNT(*) as c FROM vault_files WHERE note_type IS NOT NULL GROUP BY note_type ORDER BY c DESC LIMIT 6'
    ).all();
    const recent = db.prepare(
      "SELECT title, note_type, project FROM vault_files WHERE note_type NOT IN ('archive') ORDER BY indexed_at DESC LIMIT 8"
    ).all();

    const health = getHealth();
    const healthLine = health.ok
      ? `health: OK (embeddings ${health.embeddings}, summaries ${health.summaries})`
      : `health: ⚠ ${health.warnings.join(' | ')}`;

    const states = db.prepare(
      "SELECT vf.title, vf.document_id, d.updated_at FROM vault_files vf JOIN documents d ON d.id = vf.document_id WHERE vf.note_type = 'state' ORDER BY d.updated_at DESC LIMIT 8"
    ).all();

    const lines = [
      `KB BRIEFING (knowledge-base MCP; ${total} docs, ${facts} current facts; types: ${byType.map(t => `${t.note_type} ${t.c}`).join(', ')})`,
      healthLine,
      ...(states.length ? [
        'Active workstreams (kb_read for current state):',
        ...states.map(s => `- #${s.document_id} ${s.title} (as of ${s.updated_at?.slice(0, 10)})`),
      ] : []),
      'Recently updated:',
      ...recent.map(r => `- ${r.title}${r.project ? ` [${r.project}]` : ''} (${r.note_type})`),
      'Before non-trivial work: kb_search(query, tags) or kb_context(query). Entity history: kb_fact_query(entity). Capture learnings at session end via /debrief.',
    ];
    console.log(lines.join('\n'));
  } catch {
    // Never block session start on KB problems.
  }
  process.exit(0);
}
