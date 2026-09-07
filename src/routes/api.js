import { Router } from 'express';
import multer from 'multer';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

import { authMiddleware } from '../auth.js';
import {
  listDocuments,
  searchDocuments,
  getDocument,
  updateDocument,
  deleteDocument,
  getStats,
} from '../db.js';
import { ingestFile, ingestDirectory } from '../ingest.js';
import { indexVault } from '../vault/indexer.js';
import { normalizeTagString } from '../tags.js';
import { SURFACE } from '../retrieval.js';

const router = Router();
const UPLOAD_FILE_LIMIT = 10;
const UPLOAD_FILE_SIZE_LIMIT = 10 * 1024 * 1024;
const UPLOAD_FIELD_SIZE_LIMIT = 16 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: UPLOAD_FILE_SIZE_LIMIT,
    files: UPLOAD_FILE_LIMIT,
    fields: 1,
    fieldSize: UPLOAD_FIELD_SIZE_LIMIT,
    fieldNameSize: 64,
    fieldNestingDepth: 0,
    fieldArrayIndexLimit: 0,
    // Busboy fires partsLimit when the configured count is reached, so the
    // exact contract of 10 files plus one optional tags field needs one spare.
    parts: UPLOAD_FILE_LIMIT + 2,
    headerPairs: 200,
  },
});
const parseDocumentUpload = upload.array('files', UPLOAD_FILE_LIMIT);

function uploadErrorResponse(err) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return { status: 413, error: 'Uploaded file exceeds the 10 MiB per-file limit' };
    }
    if (err.code === 'LIMIT_FILE_COUNT' || (err.code === 'LIMIT_UNEXPECTED_FILE' && err.field === 'files')) {
      return { status: 413, error: `Upload accepts at most ${UPLOAD_FILE_LIMIT} files per request` };
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return { status: 400, error: `Unexpected upload field: ${err.field}` };
    }
    if (err.code === 'LIMIT_FIELD_VALUE') {
      return { status: 413, error: 'Upload field exceeds the 16 KiB limit' };
    }
    if (err.code === 'LIMIT_FIELD_COUNT') {
      return { status: 400, error: 'Upload accepts only the optional tags field' };
    }
    if (err.code === 'LIMIT_FIELD_KEY') {
      return { status: 400, error: 'Upload field name is too long' };
    }
    if (err.code === 'LIMIT_FIELD_NESTING' || err.code === 'LIMIT_FIELD_ARRAY_INDEX') {
      return { status: 400, error: 'Upload accepts only scalar field names' };
    }
    if (err.code === 'LIMIT_PART_COUNT') {
      return { status: 413, error: `Upload accepts at most ${UPLOAD_FILE_LIMIT} files plus tags` };
    }
    return { status: 400, error: 'Invalid multipart upload' };
  }
  return { status: 400, error: 'Malformed multipart upload' };
}

function handleDocumentUpload(req, res, next) {
  parseDocumentUpload(req, res, (err) => {
    if (!err) return next();
    const response = uploadErrorResponse(err);
    return res.status(response.status).json({ error: response.error });
  });
}

// All API routes require auth
router.use('/api/documents', authMiddleware);
router.use('/api/ingest-directory', authMiddleware);
router.use('/api/stats', authMiddleware);

// GET /api/documents — list or search
router.get('/api/documents', (req, res) => {
  try {
    const { q, type, tag, limit, offset } = req.query;
    if (q) {
      const results = searchDocuments(q, limit ? parseInt(limit, 10) : 20, {
        surface: SURFACE.REST_SEARCH,
      });
      return res.json(results);
    }
    const results = listDocuments({
      type: type || undefined,
      tag: tag || undefined,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    return res.json(results);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/:id
router.get('/api/documents/:id', (req, res) => {
  try {
    const doc = getDocument(parseInt(req.params.id, 10), { surface: SURFACE.REST_READ });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    return res.json(doc);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/documents — file upload
router.post('/api/documents', handleDocumentUpload, async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }
    const bodyKeys = Object.keys(req.body || {});
    if (bodyKeys.some(key => key !== 'tags') || (req.body.tags != null && typeof req.body.tags !== 'string')) {
      return res.status(400).json({ error: 'Upload accepts only a scalar tags field' });
    }

    const documents = [];
    const tags = req.body.tags || '';

    for (const file of req.files) {
      // basename() strips path components so a crafted originalname
      // (e.g. "../../etc/cron.d/x") can't escape tmpdir.
      const origName = basename(file.originalname);
      const tempName = `kb-upload-${randomBytes(8).toString('hex')}-${origName}`;
      const tempPath = join(tmpdir(), tempName);

      try {
        writeFileSync(tempPath, file.buffer);
        const ingested = await ingestFile(tempPath, { source: origName });
        if (ingested) {
          // The embed outcome is internal bookkeeping; the response is the row.
          const { embedded: _embedded, embedError: _embedError, ...doc } = ingested;
          // Fix title to use original filename
          const title = origName.replace(/\.[^.]+$/, '');
          updateDocument(doc.id, { title, tags: tags || doc.tags });
          doc.title = title;
          // Echo what updateDocument persisted, not the raw input
          if (tags) doc.tags = normalizeTagString(tags);
          documents.push(doc);
        }
      } finally {
        try { unlinkSync(tempPath); } catch {}
      }
    }

    return res.json({ documents });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/documents/:id
router.put('/api/documents/:id', (req, res) => {
  try {
    const { title, tags } = req.body || {};
    updateDocument(parseInt(req.params.id, 10), { title, tags });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/documents/:id
router.delete('/api/documents/:id', (req, res) => {
  try {
    const filePath = deleteDocument(parseInt(req.params.id, 10));
    if (filePath && existsSync(filePath)) {
      try { unlinkSync(filePath); } catch {}
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/ingest-directory
router.post('/api/ingest-directory', async (req, res) => {
  try {
    const { path: dirPath } = req.body || {};
    if (!dirPath) {
      return res.status(400).json({ error: 'path is required' });
    }
    if (!existsSync(dirPath)) {
      return res.status(400).json({ error: `Path not found: ${dirPath}` });
    }
    const result = await ingestDirectory(dirPath);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/stats
router.get('/api/stats', (req, res) => {
  try {
    return res.json(getStats());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/vault/reindex — triggered by post-sync hook or manually
router.post('/api/vault/reindex', authMiddleware, async (req, res) => {
  try {
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
    if (!vaultPath) {
      return res.status(400).json({ error: 'OBSIDIAN_VAULT_PATH not configured' });
    }
    const result = await indexVault(vaultPath);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/vault/status — check vault index state
router.get('/api/vault/status', authMiddleware, (req, res) => {
  try {
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
    return res.json({
      configured: !!vaultPath,
      vault_path: vaultPath || null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
