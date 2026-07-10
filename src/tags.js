// Tag helpers. Deliberately does not import db.js (db.js imports this module).

export function splitTags(str) {
  const seen = new Set();
  for (const raw of String(str ?? '').split(',')) {
    const tag = raw.trim().toLowerCase();
    if (tag) seen.add(tag);
  }
  return [...seen];
}

export function normalizeTagString(str) {
  return splitTags(str).join(', ');
}

export function getTagAliasMap(db) {
  const map = new Map();
  for (const row of db.prepare('SELECT alias, canonical FROM tag_aliases').all()) {
    map.set(row.alias.toLowerCase(), row.canonical.toLowerCase());
  }
  return map;
}

export function canonicalTag(tag, aliasMap) {
  const t = String(tag ?? '').trim().toLowerCase();
  return (aliasMap && aliasMap.get(t)) || t;
}
