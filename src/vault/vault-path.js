// A vault-relative path is an identity key shared by every process that opens
// the database — a Windows indexer and a WSL/Linux one can share a vault and a
// DB. `path.relative` spells it with the indexing platform's separator, and a
// POSIX process joins a stored `\` as a literal filename character (#190), so
// the stored form is always `/`. `\` is safe to read as a separator on every
// platform: Windows and Obsidian both forbid it inside a file or folder name.
export function normalizeVaultPath(vaultPath) {
  return vaultPath.replaceAll('\\', '/');
}
