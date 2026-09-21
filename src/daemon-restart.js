import { randomUUID } from 'node:crypto';
import {
  linkSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const DEFAULT_RESTART_GRACE_TIMEOUT_MS = 45_000;
export const DEFAULT_RESTART_MARKER_MAX_AGE_MS = 60_000;
export const DEFAULT_RESTART_MARKER_REFRESH_MS = 15_000;

export function restartMarkerPath(socketPath) {
  return `${socketPath}.restart.json`;
}

const GENERATION_SUFFIX = '.generation.json';
const GENERATION_PATTERN = /^[a-zA-Z0-9-]+$/;

export function restartGenerationPath(socketPath, generation) {
  return `${restartMarkerPath(socketPath)}.${generation}${GENERATION_SUFFIX}`;
}

function parseRecentRestartMarker(raw, now, maxAgeMs) {
  let marker;
  try {
    marker = JSON.parse(raw);
  } catch {
    return null;
  }

  const ageMs = now - marker?.startedAt;
  if (!Number.isFinite(marker?.startedAt)) return null;
  if (!Number.isInteger(marker.pid) || marker.pid <= 0) return null;
  if (
    marker.generation !== undefined
    && (typeof marker.generation !== 'string' || marker.generation.length === 0)
  ) return null;
  if (ageMs < 0 || ageMs > maxAgeMs) return null;
  return marker;
}

function writePrivateFile(path, temporaryPath, raw, { replace }) {
  writeFileSync(temporaryPath, raw, { mode: 0o600, flag: 'wx' });
  if (replace) renameSync(temporaryPath, path);
  else {
    linkSync(temporaryPath, path);
    try { rmSync(temporaryPath); } catch {}
  }
}

/**
 * Records an intentional resident-daemon replacement before the old process
 * starts draining. The synchronous, atomic write keeps the signal path small
 * while ensuring newly starting shims never observe a partial marker.
 */
export function markDaemonRestart(
  socketPath,
  {
    now = Date.now(),
    pid = process.pid,
    generation = randomUUID(),
  } = {},
) {
  if (!Number.isFinite(now) || !Number.isInteger(pid) || pid <= 0) return false;
  if (typeof generation !== 'string' || !GENERATION_PATTERN.test(generation)) return false;

  const markerPath = restartMarkerPath(socketPath);
  const generationPath = restartGenerationPath(socketPath, generation);
  const generationTemporaryPath = `${generationPath}.${pid}.tmp`;
  const legacyTemporaryPath = `${markerPath}.${pid}.${generation}.tmp`;
  const raw = `${JSON.stringify({ startedAt: now, pid, generation })}\n`;
  try {
    writePrivateFile(generationPath, generationTemporaryPath, raw, { replace: false });
  } catch {
    try { rmSync(generationTemporaryPath, { force: true }); } catch {}
    return false;
  }
  try {
    writePrivateFile(markerPath, legacyTemporaryPath, raw, { replace: true });
  } catch {
    try { rmSync(legacyTemporaryPath, { force: true }); } catch {}
  }
  return true;
}

function markerPaths(socketPath) {
  const legacyPath = restartMarkerPath(socketPath);
  const legacyName = basename(legacyPath);
  const generationPrefix = `${legacyName}.`;
  try {
    return readdirSync(dirname(legacyPath))
      .filter(name => name === legacyName
        || (name.startsWith(generationPrefix) && name.endsWith(GENERATION_SUFFIX)))
      .map(name => join(dirname(legacyPath), name));
  } catch {
    return [];
  }
}

function readMarkerEntry(path, legacyPath, now, maxAgeMs) {
  try {
    if (!lstatSync(path).isFile()) return null;
    const raw = readFileSync(path, 'utf8');
    const marker = parseRecentRestartMarker(raw, now, maxAgeMs);
    if (path !== legacyPath) {
      const generation = path.slice(
        `${legacyPath}.`.length,
        -GENERATION_SUFFIX.length,
      );
      if (marker?.generation !== generation) return { path, raw, marker: null, legacy: false };
    }
    return { path, raw, marker, legacy: path === legacyPath };
  } catch {
    return null;
  }
}

/**
 * Captures the exact marker generations present before replacement startup.
 * Immutable generation files are canonical; the fixed path remains a mirror
 * for old shims during rollout.
 */
export function snapshotDaemonRestart(
  socketPath,
  { now = Date.now(), maxAgeMs = DEFAULT_RESTART_MARKER_MAX_AGE_MS } = {},
) {
  const legacyPath = restartMarkerPath(socketPath);
  const entries = markerPaths(socketPath)
    .map(path => readMarkerEntry(path, legacyPath, now, maxAgeMs))
    .filter(Boolean);
  if (entries.length === 0) return null;
  const marker = entries
    .map(entry => entry.marker)
    .filter(Boolean)
    .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
  return { entries, marker };
}

function restoreClaim(claimPath, markerPath) {
  try {
    linkSync(claimPath, markerPath);
  } catch (err) {
    if (err.code !== 'EEXIST') return false;
  }
  try {
    rmSync(claimPath);
    return false;
  } catch {
    return false;
  }
}

function consumeLegacyMarker(entry) {
  const claimPath = `${entry.path}.${process.pid}.${randomUUID()}.consume`;
  try {
    renameSync(entry.path, claimPath);
    if (readFileSync(claimPath, 'utf8') !== entry.raw) {
      return restoreClaim(claimPath, entry.path);
    }
    rmSync(claimPath);
    return true;
  } catch {
    try { return restoreClaim(claimPath, entry.path); } catch { return false; }
  }
}

/**
 * Removes only generations captured before startup. Canonical generation
 * files are immutable, so a concurrent writer always has a distinct path.
 */
export function consumeDaemonRestart(snapshot) {
  if (!snapshot) return false;
  let consumed = true;
  for (const entry of snapshot.entries) {
    if (entry.legacy) {
      consumed = consumeLegacyMarker(entry) && consumed;
      continue;
    }
    try {
      rmSync(entry.path);
    } catch {
      consumed = false;
    }
  }
  return consumed;
}

/**
 * Returns a recent local replacement marker. Old or malformed markers are
 * ignored, so an ordinary outage retains the normal short fallback deadline.
 * Shims are readers only; successful replacement startup owns cleanup.
 */
export function readRecentDaemonRestart(socketPath, options) {
  return snapshotDaemonRestart(socketPath, options)?.marker ?? null;
}
