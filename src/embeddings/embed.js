let pipeline = null;
let pipelinePromise = null; // Mutex: prevents concurrent model loads

async function getEmbedder() {
  if (pipeline) return pipeline;

  // If another call is already loading, wait for it instead of starting a second load
  if (pipelinePromise) return pipelinePromise;

  pipelinePromise = (async () => {
    const { pipeline: createPipeline } = await import('@huggingface/transformers');

    // Race model load against a 60s timeout. Promise.race does not cancel the
    // loser, so the timer must be cleared explicitly — left pending it holds
    // the event loop open and every short-lived process that embeds anything
    // sits there for a minute after its work is done.
    let timeout;
    try {
      pipeline = await Promise.race([
        createPipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Embedding model load timed out after 60s')), 60000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }

    return pipeline;
  })().catch((err) => {
    pipelinePromise = null; // Reset so next call can retry
    throw err;
  });

  return pipelinePromise;
}

/**
 * The text a note is embedded as, wherever it is embedded from.
 *
 * The Related section comes off first: it is auto-appended and cites other
 * notes' titles, so leaving it in makes linked notes look like each other and
 * similarity self-reinforces. Lives beside the only call site that matters —
 * when this and the embedding write were in different modules, whether a note's
 * vector was comparable to its neighbours' depended on which path produced it.
 */
export const embeddableBody = (body) => body.replace(/\n+## Related\n[\s\S]*$/, '').slice(0, 2000);

/**
 * Embed `content` for `documentId` and store it.
 *
 * Every path that creates a document routes through here, because a document
 * without an embedding is reachable by full-text search and by nothing else —
 * semantic search, duplicate detection and related-links all read this table,
 * and none of them can report a document they never saw. `vaultPath` is null
 * for documents that have no vault file.
 *
 * Returns 1 when a vector was written, 0 when the caller passed nothing to
 * embed. Throws on model failure, so a caller that can carry on without the
 * vector has to say so.
 */
export async function storeEmbedding(documentId, content, vaultPath = null) {
  if (!documentId || !content?.trim()) return 0;
  const { getDb } = await import('../db.js');
  const embedding = await generateEmbedding(embeddableBody(content));
  getDb().prepare(`
    INSERT OR REPLACE INTO embeddings (document_id, vault_path, chunk_index, chunk_text, embedding, dimensions)
    VALUES (?, ?, 0, ?, ?, ?)
  `).run(documentId, vaultPath, content.slice(0, 500), embeddingToBuffer(embedding), embedding.length);
  return 1;
}

export async function generateEmbedding(text) {
  const embedder = await getEmbedder();
  const result = await embedder(text, { pooling: 'mean', normalize: true });
  return new Float32Array(result.data);
}

// Convert Float32Array to Buffer for SQLite BLOB storage (3x smaller than JSON)
export function embeddingToBuffer(embedding) {
  return Buffer.from(embedding.buffer);
}

// Convert Buffer back to Float32Array for computation
export function bufferToEmbedding(buffer) {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

export function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}
