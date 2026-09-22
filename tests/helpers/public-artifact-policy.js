import assert from 'node:assert/strict';

export const PUBLIC_ARTIFACT_DENYLIST = Object.freeze([
  /\/(?:Users|home)\//i,
  /\b(?:tinyfish|mino)\b/i,
  /\bPF-\d+\b/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(?:Bearer\s+|sk-|ghp_|phc_|xox[baprs]-)[A-Za-z0-9._-]{8,}/i,
]);

export function assertPublicArtifactSafe(content) {
  for (const pattern of PUBLIC_ARTIFACT_DENYLIST) {
    assert.doesNotMatch(content, pattern);
  }
}
