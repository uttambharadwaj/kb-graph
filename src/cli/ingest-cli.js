import { resolve } from 'path';
import { existsSync, statSync } from 'fs';
import { ingestFile, ingestDirectory } from '../ingest.js';

export async function ingest(pathArg) {
  if (!pathArg) {
    console.error('Usage: kb ingest <file-or-directory>');
    process.exit(1);
  }

  const fullPath = resolve(pathArg);
  if (!existsSync(fullPath)) {
    console.error(`Path not found: ${fullPath}`);
    process.exit(1);
  }

  if (statSync(fullPath).isDirectory()) {
    console.log(`Ingesting directory: ${fullPath}`);
    const result = await ingestDirectory(fullPath);
    console.log(`  Ingested: ${result.ingested}`);
    console.log(`  Skipped:  ${result.skipped}`);
    if (result.errors.length) {
      console.log(`  Errors:`);
      result.errors.forEach(e => console.log(`    - ${e}`));
    }
  } else {
    console.log(`Ingesting file: ${fullPath}`);
    const doc = await ingestFile(fullPath);
    if (doc) {
      console.log(`  Ingested: ${doc.title} (${doc.doc_type}, ${doc.file_size} bytes)`);
    } else {
      console.log('  Skipped: unsupported file type');
    }
  }
}
