import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  generateEmbedding,
} from '../src/embeddings/embed.js';

const runtime = {
  node: process.version,
  nodeAbi: process.versions.modules,
  platform: process.platform,
  arch: process.arch,
};

try {
  const [{ default: Database }, { env: transformersEnv }] = await Promise.all([
    import('better-sqlite3'),
    import('@huggingface/transformers'),
  ]);
  const cacheDir = process.env.KB_EMBEDDING_CACHE_DIR?.trim() || transformersEnv.cacheDir;

  const db = new Database(':memory:');
  const sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get().version;
  db.close();

  const probeStartedAt = Date.now();
  const vector = await generateEmbedding(
    'Embedding runtime preflight: one complete cache write precedes parallel test processes.',
  );
  const embeddingProbeMs = Date.now() - probeStartedAt;
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Embedding model returned ${vector.length} dimensions; expected ${EMBEDDING_DIMENSIONS}`);
  }
  if (!vector.every(Number.isFinite)) {
    throw new Error('Embedding model returned a non-finite value');
  }
  if (Math.abs(norm - 1) > 0.01) {
    throw new Error(`Embedding model returned an unnormalized vector (norm ${norm})`);
  }

  console.log(JSON.stringify({
    ...runtime,
    status: 'passed',
    sqlite: sqliteVersion,
    model: EMBEDDING_MODEL,
    dimensions: vector.length,
    norm: Number(norm.toFixed(6)),
    embeddingProbeMs,
    cacheDir,
  }));
} catch (err) {
  console.error(JSON.stringify({
    ...runtime,
    status: 'failed',
    cacheDir: process.env.KB_EMBEDDING_CACHE_DIR?.trim() || null,
    error: err instanceof Error ? err.message : String(err),
  }));
  throw err;
}
