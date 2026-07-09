// Point the KB at a throwaway dir BEFORE any module opens the real DB.
// Import this FIRST in any test whose import chain reaches src/paths.js —
// without it, tests write junk into the live ~/.knowledge-base/kb.db.
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.KB_DIR = mkdtempSync(join(tmpdir(), 'kb-test-'));
// Files-first writes (kb_ingest, /ingest, writeNote) target the vault — point
// that at a throwaway dir too or tests write real files into ~/.claude/kb-index.
process.env.OBSIDIAN_VAULT_PATH = mkdtempSync(join(tmpdir(), 'kb-test-vault-'));
