import { searchDocuments } from '../db.js';

export function search(query) {
  if (!query) {
    console.error('Usage: kb search <query>');
    process.exit(1);
  }

  const results = searchDocuments(query, 10);

  if (!results.length) {
    console.log('No results found.');
    return;
  }

  console.log(`Found ${results.length} result(s):\n`);
  results.forEach((r, i) => {
    // Strip HTML tags from snippet for CLI display
    const snippet = (r.snippet || '').replace(/<[^>]*>/g, '');
    console.log(`${i + 1}. [${r.doc_type}] ${r.title}`);
    if (r.tags) console.log(`   Tags: ${r.tags}`);
    if (snippet) console.log(`   ${snippet.substring(0, 200)}`);
    console.log();
  });
}
