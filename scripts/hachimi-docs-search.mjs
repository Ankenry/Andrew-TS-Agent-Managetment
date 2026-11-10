#!/usr/bin/env node
// Hybrid search over document_chunks: full-text (tsvector) + optional pgvector semantic search, merged by RRF.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inferAppSlug, tokenize, MAX_CONTEXT_CHARS } from './elite2-knowledge-retrieval.mjs';
import { query, closePool, vectorLiteral } from './hachimi-db.mjs';
import { embedQuery, embeddingKey } from './hachimi-embeddings.mjs';
import { searchSolarKnowledge } from './solar-release/retrieval.mjs';

const RRF_K = 60;
const CANDIDATES = 30;
const SELECT = `c.id, d.source_path AS "sourcePath", c.app_slug AS "appSlug", d.title, c.heading, c.content`;
const FROM = 'FROM document_chunks c JOIN documents d ON d.id = c.document_id';

// Any-term match ranked by ts_rank_cd, so long questions still hit partially matching chunks.
async function fullTextSearch(text, appSlug, limit) {
  const terms = [...new Set(tokenize(text))];
  if (!terms.length) return [];
  const { rows } = await query(`
    WITH q AS (SELECT to_tsquery('simple', $1) AS tsq)
    SELECT ${SELECT}, ts_rank_cd(c.tsv, q.tsq, 32) AS score
    ${FROM}, q
    WHERE c.tsv @@ q.tsq AND ($2 = '' OR c.app_slug = $2)
      AND d.source_path NOT LIKE 'solar-release/%'
    ORDER BY score DESC, c.id
    LIMIT $3`, [terms.map(term => `'${term.replaceAll("'", "''")}'`).join(' | '), appSlug, limit]);
  return rows;
}

async function semanticSearch(text, appSlug, limit) {
  const { rows: [{ available }] } = await query('SELECT EXISTS (SELECT 1 FROM document_chunks WHERE embedding IS NOT NULL) AS available');
  if (!available || !embeddingKey()) return null;
  const vector = vectorLiteral(await embedQuery(text));
  const { rows } = await query(`
    SELECT ${SELECT}, 1 - (c.embedding <=> $1::vector) AS score
    ${FROM}
    WHERE c.embedding IS NOT NULL AND ($2 = '' OR c.app_slug = $2)
      AND d.source_path NOT LIKE 'solar-release/%'
    ORDER BY c.embedding <=> $1::vector
    LIMIT $3`, [vector, appSlug, limit]);
  return rows;
}

function fuse(lists) {
  const merged = new Map();
  for (const [name, list] of lists) {
    list.forEach((row, rank) => {
      const entry = merged.get(row.id) || { ...row, score: 0, signals: [] };
      entry.score += 1 / (RRF_K + rank + 1);
      entry.signals.push(name);
      merged.set(row.id, entry);
    });
  }
  return [...merged.values()].sort((left, right) => right.score - left.score);
}

async function runAll(text, appSlug, semantic) {
  const [fullText, vector] = await Promise.all([
    fullTextSearch(text, appSlug, CANDIDATES),
    semantic ? semanticSearch(text, appSlug, CANDIDATES) : null,
  ]);
  return fuse([['fulltext', fullText], ['semantic', vector || []]]);
}

async function detectAppSlug(text) {
  const inferred = inferAppSlug(text);
  if (inferred) return inferred;
  const { rows } = await query(`SELECT DISTINCT app_slug FROM documents WHERE app_slug <> ''`);
  const words = new Set(tokenize(text));
  return rows.map(row => row.app_slug).sort((a, b) => b.length - a.length).find(slug => words.has(slug) || tokenize(slug).every(part => words.has(part))) || '';
}

/**
 * Returns the best-matching chunks for a Helpdesk question, mirroring the shape of
 * retrieveElite2Knowledge() so callers can swap between file-based and database retrieval.
 */
export async function searchDocuments(text, { appSlug, limit = 8, semantic = true, maxChars = MAX_CONTEXT_CHARS } = {}) {
  const slug = appSlug ?? await detectAppSlug(text);
  let results = slug ? await runAll(text, slug, semantic) : [];
  if (slug) {
    const releases = await searchSolarKnowledge(text, { appSlug: slug, limit }).catch(error => {
      if (error.code === '42P01') return []; // additive rollout before migration
      throw error;
    });
    let size = 0;
    const chunks = [...releases, ...results].slice(0, limit).filter(chunk => {
      if (size + chunk.content.length > maxChars) return false;
      size += chunk.content.length; return true;
    });
    // A known app never falls back to another app merely because its corpus is small.
    return { appSlug: slug, chunks };
  }
  if (results.length < 3) results = await runAll(text, '', semantic);
  let used = 0;
  const chunks = results.slice(0, limit).filter(chunk => {
    if (used + chunk.content.length > maxChars) return false;
    used += chunk.content.length;
    return true;
  });
  return { appSlug: slug, chunks };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const text = args.filter((arg, index) => !arg.startsWith('--') && !['--app', '--limit'].includes(args[index - 1])).join(' ').trim();
  if (!text) { console.error('Usage: node scripts/hachimi-docs-search.mjs "<question>" [--app <slug>] [--limit 8] [--no-semantic] [--text]'); process.exit(1); }
  try {
    const result = await searchDocuments(text, { appSlug: option('--app'), limit: Number(option('--limit') || 8), semantic: !args.includes('--no-semantic') });
    if (args.includes('--text')) {
      console.log(`app: ${result.appSlug || '(none)'}\n`);
      for (const chunk of result.chunks) console.log(`## ${chunk.sourcePath} › ${chunk.heading} [${chunk.signals.join('+')} ${chunk.score.toFixed(4)}]\n${chunk.content}\n`);
    } else console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Search failed: ${error.message}`);
    process.exitCode = 1;
  } finally { await closePool(); }
}
