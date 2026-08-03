import { readFileSync, statSync, readdirSync, copyFileSync, existsSync } from 'fs';
import { extname, basename, join } from 'path';
import { parseVaultNote } from './vault/parser.js';
import { FILES_DIR } from './paths.js';
import { insertDocument, listDocuments } from './db.js';
import { normalizeTagString } from './tags.js';

const TYPE_MAP = {
  '.md': 'markdown',
  '.txt': 'text', '.log': 'text',
  '.json': 'text', '.yaml': 'text', '.yml': 'text',
  '.xml': 'text', '.csv': 'text',
  '.js': 'code', '.ts': 'code', '.py': 'code',
  '.go': 'code', '.rs': 'code', '.java': 'code',
  '.sh': 'code', '.c': 'code', '.cpp': 'code',
  '.rb': 'code', '.jsx': 'code', '.tsx': 'code',
  '.html': 'code', '.css': 'code', '.sql': 'code',
  '.pdf': 'pdf',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image',
  '.gif': 'image', '.webp': 'image', '.bmp': 'image', '.svg': 'image',
  '.mp3': 'audio', '.wav': 'audio', '.ogg': 'audio',
  '.flac': 'audio', '.m4a': 'audio', '.aac': 'audio',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video',
  '.avi': 'video', '.mkv': 'video',
};

async function extractPdfContent(filePath, filename) {
  try {
    const pdfParse = (await import('pdf-parse')).default;
    const buffer = readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text;
  } catch (err) {
    return `[pdf file: ${filename}] Could not extract text: ${err.message}`;
  }
}

function extractContent(filePath, type, filename) {
  if (type === 'markdown' || type === 'text' || type === 'code') {
    return readFileSync(filePath, 'utf-8');
  }
  // image, audio, video — metadata only
  const fileSize = statSync(filePath).size;
  return `[${type} file: ${filename}] Size: ${fileSize} bytes`;
}

export function getMarkdownIngestMetadata(content, filename) {
  const parsed = parseVaultNote(content, filename);
  return {
    title: parsed.title,
    content: parsed.body,
    doc_type: parsed.type,
    tags: normalizeTagString(parsed.tags.join(',')),
  };
}

export function normalizeIngestOptions(options = {}) {
  if (typeof options === 'string') return { tags: options };
  if (!options) return {};
  return options;
}

export async function ingestFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  const type = TYPE_MAP[ext];
  if (!type) return null;

  const filename = basename(filePath);
  let title = basename(filePath, ext);
  let docType = type;
  let tags = '';
  const stat = statSync(filePath);

  // Extract content
  let content;
  if (type === 'pdf') {
    content = await extractPdfContent(filePath, filename);
  } else {
    content = extractContent(filePath, type, filename);
    if (type === 'markdown') {
      const metadata = getMarkdownIngestMetadata(content, filename);
      title = metadata.title;
      content = metadata.content;
      docType = metadata.doc_type;
      tags = metadata.tags;
    }
  }

  // Copy file to FILES_DIR with timestamp prefix
  const destName = `${Date.now()}-${filename}`;
  const destPath = join(FILES_DIR, destName);
  copyFileSync(filePath, destPath);

  // Insert into DB
  const doc = insertDocument({
    title,
    content,
    source: filename,
    doc_type: docType,
    tags,
    file_path: destPath,
    file_size: stat.size,
  });

  return { ...doc, ...(await embedIngested(doc.id, content)) };
}

// Ingested documents have no vault file, so the reindex job — which walks the
// vault — will never reach them. Embed here or they stay findable by full-text
// search alone, for good. A model failure must not lose the ingest, so it is
// reported rather than thrown: the caller decides what an unembedded document
// is worth.
async function embedIngested(documentId, content) {
  try {
    const { storeEmbedding } = await import('./embeddings/embed.js');
    return { embedded: await storeEmbedding(documentId, content) };
  } catch (err) {
    return { embedded: 0, embedError: err.message };
  }
}

function collectFiles(dir) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath));
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (TYPE_MAP[ext]) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

export async function ingestDirectory(dirPath) {
  if (!existsSync(dirPath)) {
    throw new Error(`Directory not found: ${dirPath}`);
  }

  const files = collectFiles(dirPath);

  // Filename, not content, and that is the decision rather than an omission:
  // note-writing surfaces route through writeNote and refuse a near-duplicate,
  // but this is somebody else's corpus. Refusing a file for resembling a note
  // already held would silently drop real content mid-import, and losing what
  // was asked for is worse than storing something twice.
  //
  // Superseded docs still own their source file, so they count as ingested.
  const existing = listDocuments({ limit: 100000, includeSuperseded: true });
  const existingSources = new Set(existing.map(d => d.source));

  let ingested = 0;
  let skipped = 0;
  const errors = [];

  for (const filePath of files) {
    const filename = basename(filePath);
    if (existingSources.has(filename)) {
      skipped++;
      continue;
    }
    try {
      const doc = await ingestFile(filePath);
      // An unembedded document is half-ingested, and the count alone would call
      // it a success. Name it here or the run reports "ingested" for a document
      // no semantic query will ever return.
      if (doc?.embedError) errors.push(`${filename}: indexed but not embedded: ${doc.embedError}`);
      existingSources.add(filename); // prevent duplicates within same batch
      ingested++;
    } catch (err) {
      errors.push(`${filename}: ${err.message}`);
    }
  }

  return { ingested, skipped, errors };
}

export function ingestText(title, content, options = {}) {
  const { tags, doc_type, source } = normalizeIngestOptions(options);
  return insertDocument({
    title,
    content,
    source: source || 'manual',
    doc_type: doc_type || 'text',
    tags: normalizeTagString(Array.isArray(tags) ? tags.join(',') : (tags || '')),
    file_size: Buffer.byteLength(content),
  });
}
