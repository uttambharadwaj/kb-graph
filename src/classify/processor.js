import { readFileSync } from 'fs';
import matter from 'gray-matter';
import { classifyNote } from './classifier.js';
import { indexVault, scanVault } from '../vault/indexer.js';
import { replaceNoteIfUnchanged } from '../atomic-note-write.js';

const INTAKE_FOLDERS = ['Clippings', 'inbox'];

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isUnprocessed(filePath, vaultPath) {
  const rel = filePath.replace(vaultPath + '/', '');
  const inIntake = INTAKE_FOLDERS.some(f => rel.startsWith(f + '/') || rel.startsWith(f));
  if (!inIntake) return false;

  try {
    const content = readFileSync(filePath, 'utf-8');
    if (!content.trim()) return false; // skip empty files
    const { data: fm } = matter(content);
    return !fm.classified;
  } catch {
    return false;
  }
}

export async function processNewClippings(vaultPath, {
  dryRun = false,
  classify = classifyNote,
  reindex = indexVault,
  pause = wait,
  signal,
} = {}) {
  signal?.throwIfAborted();
  const allFiles = scanVault(vaultPath);
  const unprocessed = allFiles.filter(f => isUnprocessed(f, vaultPath));

  if (unprocessed.length === 0) {
    return { processed: 0, results: [], message: 'No new clippings to classify' };
  }

  const results = [];
  let processingError;

  try {
    for (const filePath of unprocessed) {
      signal?.throwIfAborted();
      const rel = filePath.replace(vaultPath + '/', '');
      const raw = readFileSync(filePath, 'utf-8');
      const { data: fm, content: body } = matter(raw);
      const title = fm.title || rel.split('/').pop().replace(/\.md$/, '');

      console.log(`Classifying: ${rel}`);
      const classification = await classify(title, body, rel, { signal });

      if (!classification.success) {
        console.log(`  Failed: ${classification.error}`);
        results.push({ path: rel, status: 'error', error: classification.error });
        continue;
      }

      console.log(`  → type=${classification.type}, tags=[${classification.tags?.join(', ')}]`);

      if (dryRun) {
        results.push({ path: rel, status: 'dry-run', classification });
        continue;
      }

      // Update frontmatter in place
      const updatedFm = {
        ...fm,
        title: fm.title || title,
        type: classification.type,
        tags: classification.tags || fm.tags || [],
        project: classification.project || fm.project || null,
        summary: classification.summary || null,
        confidence: classification.confidence || null,
        key_topics: classification.key_topics || [],
        // Proposals only — the indexer's filterAliases decides what the scorer
        // ever sees. Hand-written aliases survive a model that offers none, and
        // the empty list is kept rather than dropped with the nulls below: it is
        // the "asked, nothing to add" marker aliases-backfill keys on, so a
        // classified note is never re-billed.
        aliases: (classification.aliases?.length ? classification.aliases : fm.aliases) || [],
        // Same "asked, nothing to add" marker as aliases, for the same
        // resumability reason. triggers_pinned is never touched here — that
        // key is human-written only, and `...fm` above already carries it
        // through untouched when present.
        triggers: (classification.triggers?.length ? classification.triggers : fm.triggers) || [],
        classified: true,
        classified_at: new Date().toISOString().split('T')[0],
        classified_by: 'claude',
      };

      // Remove null values from frontmatter
      for (const [key, val] of Object.entries(updatedFm)) {
        if (val === null) delete updatedFm[key];
      }

      const updated = matter.stringify(body, updatedFm);
      signal?.throwIfAborted();
      replaceNoteIfUnchanged(filePath, raw, updated);

      results.push({ path: rel, status: 'classified', classification });

      // Brief pause between CLI calls to avoid rate limiting
      await pause(2000);
      signal?.throwIfAborted();
    }
  } catch (err) {
    processingError = err;
  }

  // Re-index vault to pick up changes
  if (!dryRun && results.some(r => r.status === 'classified')) {
    console.log('Re-indexing vault...');
    try {
      await reindex(vaultPath);
    } catch (err) {
      if (processingError?.name === 'AbortError') {
        processingError.cause = err;
        throw processingError;
      }
      if (processingError) {
        throw new AggregateError([processingError, err], 'classification stopped and re-indexing failed');
      }
      throw err;
    }
  }
  signal?.throwIfAborted();
  if (processingError) throw processingError;
  return {
    processed: results.filter(r => r.status === 'classified').length,
    errors: results.filter(r => r.status === 'error').length,
    total: unprocessed.length,
    results,
  };
}
