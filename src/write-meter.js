// One row per write decision: what the closest existing note was, how close,
// and whether that was close enough to refuse the write.
//
// The refusals were never the problem — a refusal announces itself, in its own
// result, to the caller who has to deal with it. The accepts are the blind
// spot. A note written at a hair under the threshold looks identical to one
// written into empty space, so the only evidence that the threshold sits in
// the wrong place is a human noticing weeks later that two notes say the same
// thing. This table is that evidence, collected at the moment of the decision
// instead of reconstructed afterwards.
import { getDb } from './db.js';
import { resolveAgent, resolveSessionId } from './retrieval.js';

export const WRITE_DECISION_SOURCE = Object.freeze({
  MCP: 'mcp',
  REST: 'rest',
  HARVEST: 'harvest',
  CLI: 'cli',
});
const WRITE_DECISION_SOURCES = new Set(Object.values(WRITE_DECISION_SOURCE));

export function logWriteDecision({
  nearest,
  threshold,
  refused,
  docId = null,
  session = resolveSessionId(),
  agent = resolveAgent(),
  source = null,
}) {
  try {
    if (source !== null && !WRITE_DECISION_SOURCES.has(source)) {
      throw new Error(`unknown write decision source "${source}"`);
    }
    getDb().prepare(
      `INSERT INTO write_decisions
        (nearest_id, nearest_score, threshold, refused, doc_id, session, agent, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      nearest?.document_id ?? null,
      nearest?.score ?? null,
      threshold,
      refused ? 1 : 0,
      docId,
      session,
      agent,
      source,
    );
  } catch (err) {
    console.error(`[KB] write decision log failed (doc_id=${docId}): ${err.message}`);
  }
}
