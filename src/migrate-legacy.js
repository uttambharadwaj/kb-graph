import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync, appendFileSync, unlinkSync } from 'fs';
import { join, basename, dirname, resolve } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import matter from 'gray-matter';
import { LOGS_DIR } from './paths.js';

export const SOURCE_KEYS = [
  'memory-global', 'memory-project',
  'gstack-learnings', 'gstack-decisions', 'gstack-reviews', 'gstack-analytics', 'gstack-md',
  'openspec', 'superpowers', 'repo-findings',
];

const SKIP_DIRS = new Set(['node_modules', '.git', '.terraform', '.review-worktrees', '.next', 'dist', 'build', '.venv', 'venv', '__pycache__']);

export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'note';
}

export function hash8(s) {
  return createHash('sha1').update(String(s)).digest('hex').slice(0, 8);
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

export function renderNote(n) {
  const fm = [
    '---',
    `title: ${q(n.title)}`,
    `type: ${n.type}`,
    `created: "${n.created}"`,
    `updated: "${n.created}"`,
    `tags: [${n.tags.join(', ')}]`,
  ];
  if (n.project) fm.push(`project: ${String(n.project).trim().toLowerCase()}`);
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

export function writeNotes(notes, { vaultPath, dryRun = false, logPath }) {
  const seen = new Map();  // body hash -> first output path
  const bySource = {};
  const bump = (k, f) => { (bySource[k] ||= { total: 0, written: 0, duplicates: 0 })[f] += 1; };
  if (logPath) mkdirSync(dirname(logPath), { recursive: true });
  const log = entry => { if (logPath) appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); };
  let written = 0, planned = 0, duplicates = 0;
  for (const n of notes) {
    bump(n.sourceKey, 'total');
    const out = join(n.folder, noteFilename(n));
    const bodyHash = hash8(String(n.body).trim());
    if (seen.has(bodyHash)) {
      duplicates += 1; bump(n.sourceKey, 'duplicates');
      log({ source: n.sourceKey, path: n.source, out, action: 'duplicate', duplicate_of: seen.get(bodyHash) });
      continue;
    }
    seen.set(bodyHash, out);
    if (dryRun) {
      planned += 1; log({ source: n.sourceKey, path: n.source, out, action: 'planned' });
      continue;
    }
    const abs = join(vaultPath, out);
    mkdirSync(dirname(abs), { recursive: true });
    // Derivation changes must replace, not orphan: the key is stable but the
    // title and date in the filename are not.
    const suffix = `-${hash8(n.key)}.md`;
    const name = basename(abs);
    for (const f of readdirSync(dirname(abs))) {
      if (f.endsWith(suffix) && f !== name) {
        unlinkSync(join(dirname(abs), f));
        log({ source: n.sourceKey, path: n.source, out: join(n.folder, f), action: 'replaced' });
      }
    }
    writeFileSync(abs, renderNote(n));
    written += 1; bump(n.sourceKey, 'written');
    log({ source: n.sourceKey, path: n.source, out, action: 'written' });
  }
  for (const entry of jsonStreamSkips) {
    log({ source: 'json-stream', path: entry.path, action: dryRun ? 'planned-unparseable' : 'unparseable', text: entry.text });
  }
  jsonStreamSkips.length = 0;
  return { written, planned, duplicates, bySource };
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
  for (const k of keys) counts[k] = result.bySource[k] || { total: 0, written: 0, duplicates: 0 };
  return { counts, notes: notes.map(n => ({ sourceKey: n.sourceKey, folder: n.folder, filename: noteFilename(n), source: n.source })), missing, dryRun };
}
