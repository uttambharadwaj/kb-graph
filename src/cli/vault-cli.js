import { indexVault } from '../vault/indexer.js';
import { setMeta } from '../db.js';

export async function vaultReindex() {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) {
    console.error('Error: OBSIDIAN_VAULT_PATH not set');
    process.exit(1);
  }
  const withEmbeddings = !process.argv.includes('--no-embeddings');
  console.log(`Indexing vault at ${vaultPath}...${withEmbeddings ? ' (with embeddings)' : ''}`);
  const result = await indexVault(vaultPath, { embeddings: withEmbeddings });
  setMeta('last_reindex', `${result.indexed} indexed, ${result.skipped} unchanged, ${result.errors.length} errors`);
  console.log(`Done: ${result.indexed} indexed, ${result.skipped} unchanged, ${result.deleted} removed${result.embedded ? `, ${result.embedded} embedded` : ''}`);
  if (result.errors.length > 0) {
    console.log(`Errors: ${result.errors.length}`);
    result.errors.forEach(e => console.log(`  ${e}`));
  }
}
