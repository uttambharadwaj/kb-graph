// Cross-domain tunnels: tag co-occurrence + entity co-mentions.
// Brute-force full scans by design — same scaling ceiling (<~2000 notes)
// as semanticSearch in src/embeddings/search.js.
import { splitTags, canonicalTag, getTagAliasMap } from './tags.js';

function loadDocs(db, aliasMap) {
  return db.prepare('SELECT id, title, content, tags, created_at FROM documents').all()
    .map(d => ({ ...d, tagSet: new Set(splitTags(d.tags).map(t => canonicalTag(t, aliasMap))) }))
    .filter(d => d.tagSet.size > 0);
}

function round2(x) { return Math.round(x * 100) / 100; }
function scoreOf(lift, cooccur) { return round2(lift * Math.log2(1 + cooccur)); }

export function tagNeighbors(db, tag, { limit = 15, minCount = 2 } = {}) {
  const aliasMap = getTagAliasMap(db);
  const target = canonicalTag(tag, aliasMap);
  const docs = loadDocs(db, aliasMap);
  const N = docs.length;
  const totals = new Map();
  const co = new Map();
  let nA = 0;
  for (const d of docs) {
    for (const t of d.tagSet) totals.set(t, (totals.get(t) || 0) + 1);
    if (!d.tagSet.has(target)) continue;
    nA++;
    for (const t of d.tagSet) if (t !== target) co.set(t, (co.get(t) || 0) + 1);
  }
  const out = [];
  for (const [t, c] of co) {
    if (c < minCount) continue;
    const lift = round2((c * N) / (nA * totals.get(t)));
    out.push({ tag: t, cooccur: c, lift, score: scoreOf(lift, c) });
  }
  return out.sort((x, y) => y.score - x.score || y.cooccur - x.cooccur).slice(0, limit);
}

const RE_ESC = /[.*+?^${}()|[\]\\]/g;

function entityCandidates(db, excluded) {
  const rows = db.prepare(`
    SELECT e.id, e.name, COUNT(*) AS n FROM entities e
    JOIN facts f ON f.subject = e.id OR f.object = e.id
    GROUP BY e.id HAVING n >= 2
  `).all();
  const out = [];
  for (const r of rows) {
    const nameLc = r.name.trim().toLowerCase();
    if (nameLc.length < 3 || /^\d+$/.test(nameLc) || excluded.has(nameLc)) continue;
    const re = new RegExp(`(^|[^a-z0-9_-])${nameLc.replace(RE_ESC, '\\$&')}($|[^a-z0-9_-])`);
    out.push({ id: r.id, name: r.name, nameLc, re });
  }
  return out;
}

function countMentions(docs, entities) {
  const counts = new Map();
  for (const d of docs) {
    const text = `${d.title}\n${d.content || ''}`.toLowerCase();
    for (const e of entities) {
      if (!text.includes(e.nameLc)) continue;
      if (e.re.test(text)) counts.set(e.id, (counts.get(e.id) || 0) + 1);
    }
  }
  return counts;
}

export function tunnel(db, from, to, { limit = 10 } = {}) {
  const aliasMap = getTagAliasMap(db);
  const a = canonicalTag(from, aliasMap);
  const b = canonicalTag(to, aliasMap);
  const docs = loadDocs(db, aliasMap);
  const inA = docs.filter(d => d.tagSet.has(a));
  const inB = docs.filter(d => d.tagSet.has(b));
  const bridges = inA.filter(d => d.tagSet.has(b))
    .sort((x, y) => String(y.created_at || '').localeCompare(String(x.created_at || '')));

  const entities = entityCandidates(db, new Set([a, b]));
  const mA = countMentions(inA, entities);
  const mB = countMentions(inB, entities);
  const bridgeEntities = [];
  for (const e of entities) {
    const from_n = mA.get(e.id) || 0;
    const to_n = mB.get(e.id) || 0;
    if (from_n > 0 && to_n > 0) {
      bridgeEntities.push({ name: e.name, mentions_from: from_n, mentions_to: to_n, strength: Math.min(from_n, to_n) });
    }
  }
  bridgeEntities.sort((x, y) => y.strength - x.strength);

  return {
    from: a,
    to: b,
    stats: { docs_from: inA.length, docs_to: inB.length, overlap: bridges.length },
    bridge_docs: bridges.slice(0, limit).map(({ id, title, tags, created_at }) => ({ id, title, tags, created_at })),
    bridge_entities: bridgeEntities.slice(0, limit),
  };
}

export function aliasCandidatePair(a, b) {
  return a + 's' === b || b + 's' === a || a.startsWith(b + '-') || b.startsWith(a + '-');
}

export function strongestTunnels(db, { limit = 10, minCount = 3 } = {}) {
  const aliasMap = getTagAliasMap(db);
  const docs = loadDocs(db, aliasMap);
  const N = docs.length;
  const totals = new Map();
  const pairs = new Map();
  for (const d of docs) {
    const tags = [...d.tagSet].sort();
    for (const t of tags) totals.set(t, (totals.get(t) || 0) + 1);
    for (let i = 0; i < tags.length; i++) {
      for (let j = i + 1; j < tags.length; j++) {
        const key = `${tags[i]}|${tags[j]}`;
        pairs.set(key, (pairs.get(key) || 0) + 1);
      }
    }
  }
  const out = [];
  for (const [key, c] of pairs) {
    if (c < minCount) continue;
    const [a, b] = key.split('|');
    if (aliasCandidatePair(a, b)) continue;
    const lift = round2((c * N) / (totals.get(a) * totals.get(b)));
    out.push({ from: a, to: b, cooccur: c, lift, score: scoreOf(lift, c) });
  }
  return out.sort((x, y) => y.score - x.score || y.cooccur - x.cooccur).slice(0, limit);
}
