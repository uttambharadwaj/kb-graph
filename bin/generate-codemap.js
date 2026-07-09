#!/usr/bin/env node
// Generates a token-efficient codebase map for AI agents
// Run after significant code changes: node bin/generate-codemap.js
// Output: CODEMAP.md in project root — loaded automatically by agents

import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, relative, extname } from 'path';

const PROJECT_ROOT = process.argv[2] || process.cwd();
const IGNORE_DIRS = new Set(['node_modules', '.git', 'data', 'coverage', '.claude', 'dist', 'build', 'config', '__pycache__', 'venv', '.venv']);
const CODE_EXTS = new Set(['.js', '.mjs', '.ts', '.py', '.sh']);

function walk(dir) {
  const results = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(full));
    } else if (CODE_EXTS.has(extname(entry.name))) {
      results.push(full);
    }
  }
  return results;
}

function extractExports(content) {
  const exports = [];
  // ES module exports
  for (const match of content.matchAll(/export\s+(?:async\s+)?(?:function|const|class|let)\s+(\w+)/g)) {
    exports.push(match[1]);
  }
  // Default export
  if (content.match(/export\s+default/)) exports.push('default');
  return exports;
}

function extractPurpose(content, filename) {
  // First comment block or JSDoc
  const commentMatch = content.match(/^\/\*\*([\s\S]*?)\*\//) || content.match(/^\/\/\s*(.+)/m) || content.match(/^#\s*(.+)/m);
  if (commentMatch) return commentMatch[1].replace(/\s*\*\s*/g, ' ').trim().slice(0, 120);
  // Infer from filename
  return null;
}

function getFileSize(path) {
  return statSync(path).size;
}

const files = walk(PROJECT_ROOT);
const sections = {};

for (const file of files) {
  const rel = relative(PROJECT_ROOT, file);
  const dir = rel.includes('/') ? rel.split('/').slice(0, -1).join('/') : '.';
  if (!sections[dir]) sections[dir] = [];

  const content = readFileSync(file, 'utf-8');
  const exports = extractExports(content);
  const purpose = extractPurpose(content, rel);
  const lines = content.split('\n').length;
  const size = getFileSize(file);

  sections[dir].push({
    file: rel,
    lines,
    size,
    exports,
    purpose,
  });
}

// Generate markdown
let md = `# Codebase Map
> Auto-generated. Do NOT edit manually. Regenerate with: \`node bin/generate-codemap.js\`
> Generated: ${new Date().toISOString().split('T')[0]}

## Quick Stats
- **Files:** ${files.length}
- **Total lines:** ${files.reduce((sum, f) => sum + readFileSync(f, 'utf-8').split('\n').length, 0).toLocaleString()}

## Architecture Overview
\`\`\`
src/
  mcp.js          ← MCP server (16 tools: search, write, capture, classify, safety)
  db.js            ← SQLite + FTS5 (documents, vault_files, embeddings tables)
  server.js        ← Express dashboard server
  vault/           ← Obsidian vault indexer + parser
  capture/         ← YouTube, web, X bookmarks, terminal session capture
  classify/        ← AI auto-classification + summarization (uses claude CLI)
  embeddings/      ← Local embeddings (HuggingFace) + hybrid search
  promotion/       ← Knowledge promotion pipeline (prompts + promoter)
  synthesis/       ← Weekly review / cross-source synthesis
  safety/          ← Destructive action review (KB-aware)
  sync/            ← KB ↔ vault bidirectional sync
bin/
  kb.js            ← CLI entry point (start, search, classify, summarize, etc.)
  cron-capture.sh  ← Daily automated capture + classify
  post-sync.sh     ← Post-sync reindex trigger
\`\`\`

`;

// Sort directories
const sortedDirs = Object.keys(sections).sort();

for (const dir of sortedDirs) {
  md += `## ${dir === '.' ? 'Root' : dir}/\n\n`;
  md += '| File | Lines | Exports | Purpose |\n';
  md += '|------|-------|---------|---------|\n';

  for (const f of sections[dir].sort((a, b) => a.file.localeCompare(b.file))) {
    const name = f.file.split('/').pop();
    const exportsStr = f.exports.length > 0 ? f.exports.slice(0, 5).join(', ') + (f.exports.length > 5 ? '...' : '') : '-';
    const purposeStr = f.purpose ? f.purpose.slice(0, 80) : '-';
    md += `| ${name} | ${f.lines} | ${exportsStr} | ${purposeStr} |\n`;
  }
  md += '\n';
}

md += `## Key Data Flows

1. **Intake:** Obsidian clip → sync → vault → \`scanVault()\` → \`parseVaultNote()\` → \`upsertVaultFile()\` → SQLite
2. **Classify:** \`processNewClippings()\` → \`classifyNote()\` (claude CLI) → update frontmatter → reindex
3. **Search:** \`kb_context\` (summaries) → \`kb_search\` (FTS5) → \`kb_search_smart\` (FTS5 + embeddings)
4. **Safety:** Hook intercepts Bash → pattern match → \`reviewDestructiveAction()\` → KB search → block/allow
5. **Capture:** \`captureSession()\` / \`captureFix()\` → write to vault → \`indexVault()\` → searchable

## MCP Tools (${16} total)
| Tool | Purpose |
|------|---------|
| kb_search | FTS5 keyword search |
| kb_context | Token-efficient summary briefing (98% savings) |
| kb_search_smart | Hybrid keyword + semantic search |
| kb_read | Read full document by ID |
| kb_list | List docs by type/tag |
| kb_write | Write new note to vault |
| kb_ingest | Ingest text into KB |
| kb_classify | Auto-classify new clippings |
| kb_capture_youtube | Capture YouTube transcript |
| kb_capture_web | Capture web article |
| kb_capture_session | Record debugging session |
| kb_capture_fix | Record bug fix |
| kb_vault_status | Vault indexing stats |
| kb_promote | Promote source to structured knowledge |
| kb_synthesize | Generate cross-source synthesis |
| kb_safety_check | Review destructive action before executing |
`;

writeFileSync(join(PROJECT_ROOT, 'CODEMAP.md'), md);
console.log(`Generated CODEMAP.md: ${files.length} files mapped`);
