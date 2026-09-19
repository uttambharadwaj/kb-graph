import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
  realpathSync, statSync, unlinkSync, writeFileSync,
} from 'fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'path';
import { homedir } from 'os';
import { createHash, randomUUID } from 'crypto';
import matter from 'gray-matter';
import { LOGS_DIR } from './paths.js';

export const SOURCE_KEYS = [
  'memory-global', 'memory-project',
  'gstack-learnings', 'gstack-decisions', 'gstack-reviews', 'gstack-analytics', 'gstack-md',
  'openspec', 'superpowers', 'repo-findings',
];

const SKIP_DIRS = new Set(['node_modules', '.git', '.terraform', '.review-worktrees', '.next', 'dist', 'build', '.venv', 'venv', '__pycache__']);
export const MIGRATION_ID = 'legacy-v1';
export const MIGRATION_ACTION = Object.freeze({
  WRITE: 'write',
  REPLACE: 'replace',
  COLLAPSE: 'collapse',
  CONFLICT: 'conflict',
  SKIP: 'skip',
  DUPLICATE: 'duplicate',
  UNPARSEABLE: 'unparseable',
});
export const MIGRATION_AUDIT_STATUS = Object.freeze({
  STARTED: 'started',
  COMPLETED: 'completed',
  REPORTED: 'reported',
});
export const MIGRATION_SOURCE = Object.freeze({
  JSON_STREAM: 'json-stream',
});
export const MIGRATION_CONFLICT_REASON = Object.freeze({
  ENRICHED_DUPLICATE: 'enriched_duplicate',
  ENRICHED_OWNED_COPY: 'enriched_owned_copy',
});

export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'note';
}

export function hash8(s) {
  return createHash('sha1').update(String(s)).digest('hex').slice(0, 8);
}

export function hash256(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}

export function migrationKeyFor(note) {
  return hash256(`${note.sourceKey}\0${note.key}`);
}

export function dateOf(value, fallbackPath) {
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  if (value instanceof Date && !isNaN(value)) return value.toISOString().slice(0, 10);
  if (fallbackPath) return new Date(statSync(fallbackPath).mtimeMs).toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

// Chunks that never parsed, so the writer can report them rather than let a
// lossless migration lose records quietly.
export const jsonStreamSkips = [];

// One record per line is the common case; ~/.gstack/analytics/eureka.jsonl is
// pretty-printed across lines, so accumulate until a parse succeeds.
export function readJsonStream(path) {
  const out = [];
  let buf = '';
  const skip = () => { jsonStreamSkips.push({ path, text: buf.trim().slice(0, 500) }); buf = ''; };
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    // A record starts at column 0, so an unparsed buffer here is corrupt or
    // truncated: drop it now or its syntax error poisons every later parse.
    if (buf && line.startsWith('{')) skip();
    buf += line + '\n';
    const t = buf.trim();
    if (!t) { buf = ''; continue; }
    try { out.push(JSON.parse(t)); buf = ''; } catch { /* need more lines */ }
  }
  if (buf.trim()) skip();
  return out;
}

export function walkFiles(dir, { skipDirs = SKIP_DIRS, ext = '.md' } = {}) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { if (!skipDirs.has(e.name)) out.push(...walkFiles(full, { skipDirs, ext })); }
    else if (e.isFile() && (!ext || e.name.endsWith(ext))) out.push(full);
  }
  return out;
}

const q = s => JSON.stringify(String(s));
const normalizedProject = project => project ? String(project).trim().toLowerCase() : null;

export function renderNote(n) {
  const fm = [
    '---',
    `title: ${q(n.title)}`,
    `type: ${n.type}`,
    `created: "${n.created}"`,
    `updated: "${n.created}"`,
    `tags: [${n.tags.join(', ')}]`,
    `migration: ${MIGRATION_ID}`,
    `migration_key: ${q(migrationKeyFor(n))}`,
    `migration_body_hash: ${q(hash256(String(n.body).trim()))}`,
  ];
  const project = normalizedProject(n.project);
  if (project) fm.push(`project: ${project}`);
  fm.push(`source: ${q(n.source)}`);
  if (n.summary) fm.push(`summary: ${q(n.summary)}`);
  fm.push(`tier: ${n.tier}`, 'status: active', '---');
  return fm.join('\n') + '\n\n' + String(n.body).trim() + '\n';
}

// A dated filename is the author's own date; mtime is only a fallback.
const fileDate = path => dateOf(basename(path).match(/^(\d{4}-\d{2}-\d{2})/)?.[1], path);

export function noteFilename(n) {
  return `${n.created}-${slugify(n.title)}-${hash8(n.key)}.md`;
}

const MEMORY_TYPES = {
  feedback:  { folder: 'agents/lessons', type: 'lesson',  tier: 'inferred', extraTags: [] },
  project:   { folder: 'projects',       type: 'project', tier: 'inferred', extraTags: [] },
  reference: { folder: 'sources',        type: 'source',  tier: 'observed', extraTags: [] },
  user:      { folder: 'agents/lessons', type: 'lesson',  tier: 'observed', extraTags: ['user-pref'] },
};

export function memoryTypeMap(type) {
  return MEMORY_TYPES[type] || null;
}

// Encoded cwd ('/'→'-') is ambiguous for hyphenated names; resolve against the
// filesystem, longest existing segment first.
export function projectSlugFromDir(dirName, workspace, root = '/') {
  const tokens = dirName.replace(/^-+/, '').split('-').filter(Boolean);
  let dir = root, i = 0, resolved = true;
  while (i < tokens.length) {
    let found = null;
    for (let j = tokens.length; j > i; j--) {
      const cand = tokens.slice(i, j).join('-');
      if (existsSync(join(dir, cand))) { found = [cand, j]; break; }
    }
    if (!found) { resolved = false; break; }
    dir = join(dir, found[0]); i = found[1];
  }
  if (resolved && resolve(dir) === resolve(workspace)) return null;
  if (!resolved) return tokens.at(-1) || null;
  return basename(dir);
}

function memoryNote(path, { sourceKey, project }) {
  const raw = readFileSync(path, 'utf8');
  const base = { sourceKey, source: `file://${path}`, key: path, created: fileDate(path), project };
  let fm, body;
  try { ({ data: fm, content: body } = matter(raw)); } catch { fm = null; }
  const type = fm && (fm.type || fm.metadata?.type);
  const map = type && memoryTypeMap(type);
  if (!fm || !map) {
    return {
      ...base, folder: 'inbox', type: 'capture', tier: 'inferred',
      title: basename(path, '.md'), summary: null,
      tags: ['migrated', `origin-${sourceKey}`, fm ? 'migrate-unmapped-type' : 'migrate-error'],
      body: raw,
    };
  }
  const folder = map.type === 'project' && project ? `projects/${project}` : map.folder;
  const rawTags = Array.isArray(fm.tags) ? fm.tags.map(String) : typeof fm.tags === 'string' ? fm.tags.split(',') : [];
  const origTags = rawTags.map(t => t.trim()).filter(Boolean).map(t => slugify(t));
  return {
    ...base, folder, type: map.type, tier: map.tier,
    title: fm.name || fm.title || basename(path, '.md'),
    summary: fm.description || null,
    tags: ['migrated', `origin-${sourceKey}`, ...map.extraTags, ...origTags],
    body,
  };
}

export function readMemoryGlobal(claudeDir) {
  const dir = join(claudeDir, 'memory');
  return walkFiles(dir)
    .filter(p => basename(p) !== 'MEMORY.md')
    .map(p => memoryNote(p, { sourceKey: 'memory-global', project: null }));
}

export function readMemoryProjects(claudeDir, workspace) {
  const root = join(claudeDir, 'projects');
  const out = [];
  let dirs = [];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return out; }
  for (const d of dirs.sort()) {
    const memDir = join(root, d, 'memory');
    if (!existsSync(memDir)) continue;
    const project = projectSlugFromDir(d, workspace);
    for (const p of walkFiles(memDir)) {
      if (basename(p) === 'MEMORY.md') continue;
      out.push(memoryNote(p, { sourceKey: 'memory-project', project }));
    }
  }
  return out;
}

const rawBlock = rec => '\n\n```json\n' + JSON.stringify(rec) + '\n```\n';

function gstackProjects(gstackDir) {
  const root = join(gstackDir, 'projects');
  try {
    return readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
  } catch { return []; }
}

function jsonlNotes(gstackDir, filename, build) {
  const out = [];
  for (const project of gstackProjects(gstackDir)) {
    const path = join(gstackDir, 'projects', project, filename);
    if (!existsSync(path)) continue;
    readJsonStream(path).forEach((rec, i) => out.push(build(rec, { project, path, i })));
  }
  return out;
}

export function readGstackLearnings(gstackDir) {
  return jsonlNotes(gstackDir, 'learnings.jsonl', (rec, { project, path, i }) => ({
    sourceKey: 'gstack-learnings', folder: 'agents/lessons', type: 'lesson',
    tier: Number(rec.confidence) >= 8 ? 'observed' : 'inferred',
    title: rec.key || `learning-${i}`,
    created: dateOf(rec.ts, path),
    tags: ['migrated', 'origin-gstack-learnings', ...(rec.type ? [slugify(rec.type)] : [])],
    project, source: `file://${path}#${i}`, key: `${path}#${i}`, summary: null,
    body: `${rec.insight || ''}\n\nFiles:\n${(rec.files || []).map(f => `- ${f}`).join('\n')}\n\nSkill: ${rec.skill || ''}` + rawBlock(rec),
  }));
}

export function readGstackDecisions(gstackDir) {
  return jsonlNotes(gstackDir, 'decisions.jsonl', (rec, { project, path, i }) => ({
    sourceKey: 'gstack-decisions', folder: 'decisions', type: 'decision', tier: 'observed',
    title: String(rec.decision || `decision-${i}`).slice(0, 80),
    created: dateOf(rec.date, path),
    tags: ['migrated', 'origin-gstack-decisions'],
    project, source: `file://${path}#${i}`, key: `${path}#${i}`, summary: null,
    body: `${rec.decision || ''}\n\nRationale: ${rec.rationale || ''}\n\nScope: ${rec.scope || ''}` + rawBlock(rec),
  }));
}

export function readGstackReviews(gstackDir) {
  const out = [];
  for (const project of gstackProjects(gstackDir)) {
    const dir = join(gstackDir, 'projects', project);
    const files = readdirSync(dir).filter(f => f.endsWith('reviews.jsonl')).sort();
    for (const f of files) {
      const path = join(dir, f);
      const runs = readJsonStream(path);
      if (!runs.length) continue;
      const branch = f.replace(/-?reviews\.jsonl$/, '') || 'unknown';
      const sections = runs.map(r => {
        const head = `## ${r.timestamp || ''} ${r.commit || ''} ${r.status || ''}`.trim();
        const findings = Array.isArray(r.findings) ? r.findings : [];
        if (!findings.length) return `${head} (${r.issues_found ?? 0} issues)`;
        const rows = findings.map(x => `| ${x.severity || ''} | ${x.action || ''} | ${x.fingerprint || ''} |`);
        return `${head}\n\n| severity | action | fingerprint |\n|---|---|---|\n${rows.join('\n')}`;
      });
      out.push({
        sourceKey: 'gstack-reviews', folder: `builds/reviews/${project}`, type: 'build', tier: 'observed',
        title: `Reviews: ${project} / ${branch}`,
        created: dateOf(runs[0].timestamp, path),
        tags: ['migrated', 'origin-gstack-reviews'],
        project, source: `file://${path}`, key: path, summary: `${runs.length} review runs on ${branch}`,
        body: sections.join('\n\n') + '\n\n```json\n' + runs.map(r => JSON.stringify(r)).join('\n') + '\n```\n',
      });
    }
  }
  return out;
}

export function readGstackAnalytics(gstackDir) {
  const out = [];
  const eureka = join(gstackDir, 'analytics', 'eureka.jsonl');
  if (existsSync(eureka)) {
    readJsonStream(eureka).forEach((rec, i) => out.push({
      sourceKey: 'gstack-analytics', folder: 'ideas', type: 'idea', tier: 'inferred',
      title: String(rec.insight || `eureka-${i}`).slice(0, 120),
      created: dateOf(rec.ts, eureka),
      tags: ['migrated', 'origin-gstack-analytics', 'eureka'],
      project: null, source: `file://${eureka}#${i}`, key: `${eureka}#${i}`, summary: null,
      body: `${rec.insight || ''}\n\nBranch: ${rec.branch || ''}\nSkill: ${rec.skill || ''}` + rawBlock(rec),
    }));
  }
  const spec = join(gstackDir, 'analytics', 'spec-review.jsonl');
  if (existsSync(spec)) {
    readJsonStream(spec).forEach((rec, i) => {
      const day = dateOf(rec.ts, spec);
      out.push({
        sourceKey: 'gstack-analytics', folder: 'decisions', type: 'decision', tier: 'observed',
        title: `Spec review: ${rec.skill || 'unknown'} ${day}`,
        created: day,
        tags: ['migrated', 'origin-gstack-analytics', 'spec-review'],
        project: null, source: `file://${spec}#${i}`, key: `${spec}#${i}`, summary: null,
        body: `Iterations: ${rec.iterations ?? ''}\nIssues found: ${rec.issues_found ?? ''}\nIssues fixed: ${rec.issues_fixed ?? ''}\nRemaining: ${rec.remaining ?? ''}\nQuality score: ${rec.quality_score ?? ''}` + rawBlock(rec),
      });
    });
  }
  return out;
}

function titleFromMd(raw, path) {
  const m = raw.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : basename(path, '.md');
}

export function readGstackMd(gstackDir) {
  const out = [];
  for (const project of gstackProjects(gstackDir)) {
    for (const path of walkFiles(join(gstackDir, 'projects', project))) {
      const raw = readFileSync(path, 'utf8');
      out.push({
        sourceKey: 'gstack-md', folder: `builds/${project}`, type: 'build', tier: 'observed',
        title: titleFromMd(raw, path), created: fileDate(path),
        tags: ['migrated', 'origin-gstack-md'],
        project, source: `file://${path}`, key: path, summary: null, body: raw,
      });
    }
  }
  return out;
}

export function readWorkspace(workspace) {
  const out = [];
  for (const path of walkFiles(workspace)) {
    // Agent worktree copies live under .claude/worktrees/<name>/; strip that
    // segment so every copy derives the same repo and the body-hash dedupe
    // keeps one regardless of walk order.
    const parts = path.replace(/\/\.claude\/worktrees\/[^/]+/, '').split('/');
    const os = parts.indexOf('openspec');
    if (os > 0 && (parts[os + 1] === 'changes' || parts[os + 1] === 'specs')) {
      const repo = parts[os - 1];
      let tail = parts.slice(os + 2);
      const archived = tail[0] === 'archive';
      if (archived) tail = tail.slice(1);
      const change = tail.length > 1 ? tail[0] : 'specs';
      const file = basename(path, '.md');
      const isTasks = file === 'tasks';
      const raw = readFileSync(path, 'utf8');
      out.push({
        sourceKey: 'openspec',
        folder: `decisions/openspec/${repo}/${change}`,
        type: isTasks ? 'session' : 'decision', tier: 'observed',
        title: isTasks ? `${change} tasks` : titleFromMd(raw, path),
        created: fileDate(path),
        tags: ['migrated', 'origin-openspec', ...(archived ? ['archived'] : [])],
        project: repo, source: `file://${path}`, key: path, summary: null, body: raw,
      });
      continue;
    }
    if (path.includes('/docs/superpowers/')) {
      const repo = parts[parts.indexOf('docs') - 1];
      const raw = readFileSync(path, 'utf8');
      out.push({
        sourceKey: 'superpowers', folder: 'research', type: 'research', tier: 'observed',
        title: titleFromMd(raw, path), created: fileDate(path),
        tags: ['migrated', 'origin-superpowers'],
        project: repo, source: `file://${path}`, key: path, summary: null, body: raw,
      });
      continue;
    }
    if (path.includes('/internal-docs/') && /findings|faq/i.test(basename(path))) {
      const repo = parts[parts.indexOf('internal-docs') - 1];
      const raw = readFileSync(path, 'utf8');
      out.push({
        sourceKey: 'repo-findings', folder: 'research', type: 'research', tier: 'observed',
        title: titleFromMd(raw, path), created: fileDate(path),
        tags: ['migrated', 'origin-repo-findings'],
        project: repo, source: `file://${path}`, key: path, summary: null, body: raw,
      });
    }
  }
  // A worktree copy is pruned with its worktree, so let the canonical checkout
  // win the body-hash dedupe. Array#sort is stable, so walk order survives.
  const wt = n => n.source.includes('/.claude/worktrees/') ? 1 : 0;
  out.sort((a, b) => wt(a) - wt(b));
  return out;
}

function emptyCounts() {
  return {
    total: 0,
    written: 0,
    replaced: 0,
    skipped: 0,
    duplicates: 0,
    conflicts: 0,
    unparseable: 0,
  };
}

function noteTags(data) {
  if (Array.isArray(data?.tags)) return data.tags.map(String);
  if (typeof data?.tags === 'string') {
    return data.tags.split(',').map(tag => tag.trim()).filter(Boolean);
  }
  return [];
}

function readVaultNote(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    const { content, data } = matter(raw);
    return { content, data };
  } catch {
    return null;
  }
}

function renderOwnedUpdate(note, candidate) {
  if (!candidate) return renderNote(note);
  const desired = matter(renderNote(note)).data;
  const data = {
    ...desired,
    ...candidate.data,
    title: desired.title,
    type: desired.type,
    created: desired.created,
    source: desired.source,
    migration: MIGRATION_ID,
    migration_key: desired.migration_key,
    migration_body_hash: desired.migration_body_hash,
    tags: [...new Set([...noteTags(candidate.data), ...noteTags(desired)])],
  };
  if (desired.project) data.project = desired.project;
  else delete data.project;
  return matter.stringify(`${String(note.body).trim()}\n`, data);
}

function importedContentMatches(note, migrationKey, candidate) {
  if (!candidate) return false;
  const tags = noteTags(candidate.data);
  return candidate.data?.migration === MIGRATION_ID
    && candidate.data?.migration_key === migrationKey
    && candidate.data?.migration_body_hash === hash256(String(note.body).trim())
    && candidate.data?.title === note.title
    && candidate.data?.type === note.type
    && String(candidate.data?.created).slice(0, 10) === note.created
    && candidate.data?.source === note.source
    && (candidate.data?.project || null) === normalizedProject(note.project)
    && note.tags.every(tag => tags.includes(tag))
    && String(candidate.content).trim() === String(note.body).trim();
}

function hasBodyEnrichment(note, candidate) {
  if (!candidate) return false;
  const currentHash = hash256(String(candidate.content).trim());
  const importedHash = candidate.data?.migration_body_hash;
  return importedHash
    ? importedHash !== currentHash
    : currentHash !== hash256(String(note.body).trim());
}

function hasEnrichment(note, candidate) {
  if (!candidate) return false;
  const baseline = matter(renderNote(note)).data;
  if (hasBodyEnrichment(note, candidate)) return true;
  const sourceOwned = new Set([
    'title', 'type', 'created', 'updated', 'source', 'migration', 'migration_key',
    'migration_body_hash', 'tags', 'project',
  ]);
  for (const [key, value] of Object.entries(candidate.data || {})) {
    if (sourceOwned.has(key)) continue;
    if (!Object.hasOwn(baseline, key)) return true;
    if (JSON.stringify(value) !== JSON.stringify(baseline[key])) return true;
  }
  return false;
}

function isOwnedBy(note, migrationKey, candidate) {
  if (!candidate) return false;
  if (
    candidate.data?.migration === MIGRATION_ID
    && candidate.data?.migration_key === migrationKey
  ) return true;
  const tags = noteTags(candidate.data);
  return candidate.data?.source === note.source
    && tags.includes('migrated')
    && tags.includes(`origin-${note.sourceKey}`);
}

function addIndexPath(index, key, out) {
  const paths = index.get(key) || new Set();
  paths.add(out);
  index.set(key, paths);
}

function legacySourceKey(sourceKey, source) {
  return `${sourceKey}\0${source}`;
}

function indexVault(vaultPath) {
  const files = new Map();
  const byKey = new Map();
  const byLegacySource = new Map();
  for (const path of walkFiles(vaultPath)) {
    const out = relative(vaultPath, path);
    const candidate = readVaultNote(path);
    files.set(out, candidate);
    if (candidate?.data?.migration === MIGRATION_ID && typeof candidate.data?.migration_key === 'string') {
      addIndexPath(byKey, candidate.data.migration_key, out);
    }
    const tags = noteTags(candidate?.data);
    if (!tags.includes('migrated') || typeof candidate?.data?.source !== 'string') continue;
    for (const tag of tags) {
      if (!tag.startsWith('origin-')) continue;
      const sourceKey = tag.slice('origin-'.length);
      addIndexPath(byLegacySource, legacySourceKey(sourceKey, candidate.data.source), out);
    }
  }
  return { byKey, byLegacySource, files };
}

function disambiguatedOut(out, migrationKey, occupied, owned) {
  const extension = extname(out);
  const stem = out.slice(0, -extension.length);
  let candidate = `${stem}-${migrationKey.slice(0, 12)}${extension}`;
  let counter = 2;
  while (occupied.has(candidate) && !owned.has(candidate)) {
    candidate = `${stem}-${migrationKey.slice(0, 12)}-${counter}${extension}`;
    counter += 1;
  }
  return candidate;
}

function planNotes(notes, vaultPath) {
  const { byKey, byLegacySource, files } = indexVault(vaultPath);
  const occupied = new Set(files.keys());
  const seenBodies = new Map();
  const operations = [];

  for (const note of notes) {
    const migrationKey = migrationKeyFor(note);
    const bodyHash = hash256(String(note.body).trim());
    const desired = join(note.folder, noteFilename(note));
    const legacyKey = legacySourceKey(note.sourceKey, note.source);
    const owned = new Set([
      ...(byKey.get(migrationKey) || []),
      ...(byLegacySource.get(legacyKey) || []),
    ]);
    if (seenBodies.has(bodyHash)) {
      const survivor = seenBodies.get(bodyHash);
      const remove = [...owned].filter(path => path !== survivor.out).sort();
      const enriched = remove.some(path => hasEnrichment(note, files.get(path)));
      let action;
      if (enriched) {
        action = {
          action: MIGRATION_ACTION.CONFLICT,
          source: note.sourceKey,
          path: note.source,
          out: survivor.out,
          retained: remove,
          reason: MIGRATION_CONFLICT_REASON.ENRICHED_DUPLICATE,
        };
      } else if (remove.length) {
        action = {
          action: MIGRATION_ACTION.COLLAPSE,
          source: note.sourceKey,
          path: note.source,
          out: survivor.out,
          remove,
          duplicate_of: survivor.out,
        };
      } else {
        action = {
          action: MIGRATION_ACTION.DUPLICATE,
          source: note.sourceKey,
          path: note.source,
          out: desired,
          duplicate_of: survivor.out,
        };
      }
      operations.push({
        action,
        migrationKey,
        note,
        survivor,
      });
      if (!enriched) {
        for (const old of remove) {
          occupied.delete(old);
          files.delete(old);
          byKey.get(migrationKey)?.delete(old);
          byLegacySource.get(legacyKey)?.delete(old);
        }
      }
      continue;
    }

    let out = desired;
    if (occupied.has(out) && !owned.has(out)) {
      out = disambiguatedOut(out, migrationKey, occupied, owned);
    }
    const remove = [...owned].filter(path => path !== out).sort();
    const enrichedRemove = remove.filter(path => hasEnrichment(note, files.get(path)));
    if (enrichedRemove.length) {
      operations.push({
        action: {
          action: MIGRATION_ACTION.CONFLICT,
          source: note.sourceKey,
          path: note.source,
          out,
          retained: enrichedRemove,
          reason: MIGRATION_CONFLICT_REASON.ENRICHED_OWNED_COPY,
        },
        migrationKey,
        note,
      });
      continue;
    }
    const prior = owned.has(out) ? files.get(out) : files.get([...owned][0]);
    if (owned.has(out) && hasBodyEnrichment(note, prior)) {
      operations.push({
        action: {
          action: MIGRATION_ACTION.CONFLICT,
          source: note.sourceKey,
          path: note.source,
          out,
          retained: [out],
          reason: MIGRATION_CONFLICT_REASON.ENRICHED_OWNED_COPY,
        },
        migrationKey,
        note,
      });
      continue;
    }
    const rendered = renderOwnedUpdate(note, prior);
    const needsWrite = !owned.has(out) || !importedContentMatches(note, migrationKey, files.get(out));
    let action;
    if (!needsWrite && remove.length === 0) {
      action = { action: MIGRATION_ACTION.SKIP, source: note.sourceKey, path: note.source, out };
    } else if (owned.size > 0) {
      action = {
        action: MIGRATION_ACTION.REPLACE,
        source: note.sourceKey,
        path: note.source,
        out,
        remove,
        write: needsWrite,
      };
    } else {
      action = { action: MIGRATION_ACTION.WRITE, source: note.sourceKey, path: note.source, out };
    }
    operations.push({ action, bodyHash, migrationKey, note, rendered });
    seenBodies.set(bodyHash, { bodyHash, migrationKey, note, out });
    for (const old of remove) {
      occupied.delete(old);
      files.delete(old);
      byKey.get(migrationKey)?.delete(old);
      byLegacySource.get(legacyKey)?.delete(old);
    }
    occupied.add(out);
    const parsed = matter(rendered);
    files.set(out, { content: parsed.content, data: parsed.data });
    addIndexPath(byKey, migrationKey, out);
  }

  for (const entry of jsonStreamSkips) {
    operations.push({
      action: {
        action: MIGRATION_ACTION.UNPARSEABLE,
        source: MIGRATION_SOURCE.JSON_STREAM,
        path: entry.path,
        text: entry.text,
      },
    });
  }
  jsonStreamSkips.length = 0;
  return operations;
}

function writeExclusive(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { flag: 'wx' });
}

function replaceOwned(path, content) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeExclusive(tmp, content);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function assertVaultPath(vaultPath, path) {
  const root = realpathSync(vaultPath);
  let ancestor = existsSync(path) ? path : dirname(path);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const real = realpathSync(ancestor);
  if (real !== root && !real.startsWith(`${root}${sep}`)) {
    throw new Error(`refusing to follow a path outside the vault: ${path}`);
  }
}

function appendAudit(logPath, action, status) {
  if (!logPath) return;
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify({
    ts: new Date().toISOString(),
    status,
    ...action,
  })}\n`);
}

function removeOwned(action, note, migrationKey, vaultPath) {
  for (const out of action.remove) {
    const old = join(vaultPath, out);
    assertVaultPath(vaultPath, old);
    if (!isOwnedBy(note, migrationKey, readVaultNote(old))) {
      throw new Error(`refusing to remove unowned vault note: ${out}`);
    }
    unlinkSync(old);
  }
}

function assertRetainedOutput({ bodyHash, migrationKey, note, out }, vaultPath) {
  const path = join(vaultPath, out);
  assertVaultPath(vaultPath, path);
  const candidate = readVaultNote(path);
  if (!isOwnedBy(note, migrationKey, candidate)) {
    throw new Error(`refusing cleanup because the retained vault note is unowned: ${out}`);
  }
  if (bodyHash && hash256(String(candidate.content).trim()) !== bodyHash) {
    throw new Error(`refusing cleanup because the retained vault note changed: ${out}`);
  }
}

function executeOperations(operations, {
  logPath,
  replace = replaceOwned,
  vaultPath,
  write = writeExclusive,
}) {
  for (const operation of operations) {
    const { action, bodyHash, migrationKey, note, rendered, survivor } = operation;
    const mutates = action.action === MIGRATION_ACTION.WRITE
      || action.action === MIGRATION_ACTION.REPLACE
      || action.action === MIGRATION_ACTION.COLLAPSE;
    if (!mutates) continue;
    appendAudit(logPath, action, MIGRATION_AUDIT_STATUS.STARTED);
    const abs = join(vaultPath, action.out);
    if (action.action === MIGRATION_ACTION.WRITE) {
      assertVaultPath(vaultPath, abs);
      write(abs, rendered);
      appendAudit(logPath, action, MIGRATION_AUDIT_STATUS.COMPLETED);
      continue;
    }

    if (action.action === MIGRATION_ACTION.REPLACE && action.write) {
      assertVaultPath(vaultPath, abs);
      if (existsSync(abs)) {
        if (!isOwnedBy(note, migrationKey, readVaultNote(abs))) {
          throw new Error(`refusing to replace unowned vault note: ${action.out}`);
        }
        replace(abs, rendered);
      } else {
        write(abs, rendered);
      }
    }
    if (action.action === MIGRATION_ACTION.REPLACE && !action.write) {
      assertRetainedOutput({ bodyHash, migrationKey, note, out: action.out }, vaultPath);
    }
    if (action.action === MIGRATION_ACTION.COLLAPSE) {
      assertRetainedOutput(survivor, vaultPath);
    }
    removeOwned(action, note, migrationKey, vaultPath);
    appendAudit(logPath, action, MIGRATION_AUDIT_STATUS.COMPLETED);
  }
}

function reportUnparseable(logPath, actions) {
  if (!logPath) return;
  const logged = new Set();
  if (existsSync(logPath)) {
    for (const line of readFileSync(logPath, 'utf8').split('\n').filter(Boolean)) {
      try {
        const { ts: _ts, status: _status, ...entry } = JSON.parse(line);
        if (entry.action === MIGRATION_ACTION.UNPARSEABLE) logged.add(JSON.stringify(entry));
      } catch { /* a malformed audit row must not block migration */ }
    }
  }
  for (const action of actions.filter(entry => entry.action === MIGRATION_ACTION.UNPARSEABLE)) {
    if (logged.has(JSON.stringify(action))) continue;
    appendAudit(logPath, action, MIGRATION_AUDIT_STATUS.REPORTED);
    logged.add(JSON.stringify(action));
  }
}

export function writeNotes(notes, {
  beforeExecute,
  dryRun = false,
  logPath,
  replace,
  vaultPath,
  write,
}) {
  if (!dryRun) mkdirSync(vaultPath, { recursive: true });
  const operations = planNotes(notes, vaultPath);
  const actions = operations.map(operation => operation.action);
  const bySource = {};
  for (const note of notes) {
    (bySource[note.sourceKey] ||= emptyCounts()).total += 1;
  }
  for (const action of actions) {
    const counts = action.source === MIGRATION_SOURCE.JSON_STREAM
      ? (bySource[MIGRATION_SOURCE.JSON_STREAM] ||= emptyCounts())
      : (bySource[action.source] ||= emptyCounts());
    if (action.action === MIGRATION_ACTION.WRITE) counts.written += 1;
    else if (action.action === MIGRATION_ACTION.REPLACE) counts.replaced += 1;
    else if (action.action === MIGRATION_ACTION.SKIP) counts.skipped += 1;
    else if (action.action === MIGRATION_ACTION.DUPLICATE || action.action === MIGRATION_ACTION.COLLAPSE) {
      counts.duplicates += 1;
    }
    else if (action.action === MIGRATION_ACTION.CONFLICT) counts.conflicts += 1;
    else if (action.action === MIGRATION_ACTION.UNPARSEABLE) {
      counts.total += 1;
      counts.unparseable += 1;
    }
  }

  if (!dryRun) {
    beforeExecute?.(actions);
    reportUnparseable(logPath, actions);
    executeOperations(operations, { logPath, replace, vaultPath, write });
  }
  const count = action => actions.filter(entry => entry.action === action).length;
  return {
    actions,
    bySource,
    written: count(MIGRATION_ACTION.WRITE),
    replaced: count(MIGRATION_ACTION.REPLACE),
    skipped: count(MIGRATION_ACTION.SKIP),
    duplicates: count(MIGRATION_ACTION.DUPLICATE) + count(MIGRATION_ACTION.COLLAPSE),
    conflicts: count(MIGRATION_ACTION.CONFLICT),
    unparseable: count(MIGRATION_ACTION.UNPARSEABLE),
  };
}

export async function runMigrateLegacy({
  claudeDir = join(homedir(), '.claude'),
  gstackDir = join(homedir(), '.gstack'),
  workspace = process.env.KB_MIGRATE_WORKSPACE || join(homedir(), 'workspace'),
  vaultPath = process.env.OBSIDIAN_VAULT_PATH,
  dryRun = false,
  only = null,
  logPath = join(LOGS_DIR, 'migrate-legacy.jsonl'),
} = {}) {
  if (!vaultPath) throw new Error('vaultPath required (OBSIDIAN_VAULT_PATH)');
  for (const k of only || []) if (!SOURCE_KEYS.includes(k)) throw new Error(`unknown source "${k}"; known: ${SOURCE_KEYS.join(', ')}`);
  jsonStreamSkips.length = 0;
  const keys = only ? SOURCE_KEYS.filter(k => only.includes(k)) : SOURCE_KEYS;
  const missing = [];
  for (const [label, dir] of [['claudeDir', claudeDir], ['gstackDir', gstackDir], ['workspace', workspace]]) {
    if (!existsSync(dir)) missing.push(`${label}: ${dir}`);
  }
  const readers = {
    'memory-global':    () => readMemoryGlobal(claudeDir),
    'memory-project':   () => readMemoryProjects(claudeDir, workspace),
    'gstack-learnings': () => readGstackLearnings(gstackDir),
    'gstack-decisions': () => readGstackDecisions(gstackDir),
    'gstack-reviews':   () => readGstackReviews(gstackDir),
    'gstack-analytics': () => readGstackAnalytics(gstackDir),
    'gstack-md':        () => readGstackMd(gstackDir),
  };
  let notes = [];
  for (const k of keys) if (readers[k]) notes.push(...readers[k]());
  const wsKeys = ['openspec', 'superpowers', 'repo-findings'].filter(k => keys.includes(k));
  if (wsKeys.length) notes.push(...readWorkspace(workspace).filter(n => wsKeys.includes(n.sourceKey)));
  const result = writeNotes(notes, { vaultPath, dryRun, logPath });
  const counts = {};
  for (const k of keys) counts[k] = result.bySource[k] || emptyCounts();
  if (result.bySource[MIGRATION_SOURCE.JSON_STREAM]) {
    counts[MIGRATION_SOURCE.JSON_STREAM] = result.bySource[MIGRATION_SOURCE.JSON_STREAM];
  }
  return {
    actions: result.actions,
    counts,
    notes: notes.map(n => ({ sourceKey: n.sourceKey, folder: n.folder, filename: noteFilename(n), source: n.source })),
    missing,
    dryRun,
  };
}
