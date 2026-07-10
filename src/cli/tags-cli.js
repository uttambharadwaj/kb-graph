import { getDb } from '../db.js';
import { getTagAliasMap } from '../tags.js';
import { aliasCandidatePair } from '../tunnels.js';

function collectRawTags(db) {
  const counts = new Map(); // raw trimmed token -> count (case preserved)
  for (const row of db.prepare("SELECT tags FROM documents WHERE tags != ''").all()) {
    for (const raw of row.tags.split(',')) {
      const t = raw.trim();
      if (t) counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return counts;
}

export function tagsReport(db = getDb()) {
  const raw = collectRawTags(db);
  const aliases = getTagAliasMap(db);
  const byLc = new Map(); // lc -> { total, variants: Map(raw -> count) }
  for (const [t, c] of raw) {
    const lc = t.toLowerCase();
    const entry = byLc.get(lc) || { total: 0, variants: new Map() };
    entry.total += c;
    entry.variants.set(t, (entry.variants.get(t) || 0) + c);
    byLc.set(lc, entry);
  }
  const top = [...byLc.entries()].sort((x, y) => y[1].total - x[1].total).slice(0, 30)
    .map(([tag, e]) => ({ tag, count: e.total }));
  const caseVariants = [...byLc.entries()].filter(([, e]) => e.variants.size > 1)
    .map(([tag, e]) => ({ tag, variants: [...e.variants.keys()] }));
  const lcTags = [...byLc.keys()].filter(t => !aliases.has(t));
  const candidates = [];
  for (let i = 0; i < lcTags.length; i++) {
    for (let j = i + 1; j < lcTags.length; j++) {
      if (aliasCandidatePair(lcTags[i], lcTags[j])) {
        candidates.push({ a: lcTags[i], count_a: byLc.get(lcTags[i]).total, b: lcTags[j], count_b: byLc.get(lcTags[j]).total });
      }
    }
  }
  return { top, caseVariants, candidates, aliases: [...aliases.entries()].map(([alias, canonical]) => ({ alias, canonical })) };
}

export function runTagsCli(args) {
  const db = getDb();
  if (args[0] === 'alias') {
    const [, alias, canonical] = args;
    if (!alias || !canonical) { console.error('Usage: kb tags alias <alias> <canonical>'); process.exit(1); }
    db.prepare('INSERT INTO tag_aliases (alias, canonical) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET canonical = excluded.canonical')
      .run(alias.toLowerCase().trim(), canonical.toLowerCase().trim());
    console.log(`alias: ${alias.toLowerCase().trim()} -> ${canonical.toLowerCase().trim()}`);
    return;
  }
  if (args[0] === 'aliases') {
    for (const row of db.prepare('SELECT alias, canonical FROM tag_aliases ORDER BY alias').all()) {
      console.log(`${row.alias} -> ${row.canonical}`);
    }
    return;
  }
  const report = tagsReport(db);
  console.log('Top tags:');
  for (const t of report.top) console.log(`  ${String(t.count).padStart(4)}  ${t.tag}`);
  if (report.caseVariants.length) {
    console.log('\nCase variants (folded at query time; new writes are lowercased):');
    for (const v of report.caseVariants) console.log(`  ${v.tag}: ${v.variants.join(', ')}`);
  }
  if (report.candidates.length) {
    console.log('\nAlias candidates (add with: kb tags alias <alias> <canonical>):');
    for (const c of report.candidates) console.log(`  ${c.a} (${c.count_a}) <-> ${c.b} (${c.count_b})`);
  }
  if (report.aliases.length) {
    console.log('\nActive aliases:');
    for (const a of report.aliases) console.log(`  ${a.alias} -> ${a.canonical}`);
  }
}
