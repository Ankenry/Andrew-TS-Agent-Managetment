#!/usr/bin/env node
// Ingest the full knowledge-base corpus (copied from TS Elite 2, see knowledge-base/SOURCE.md) (knowledge, app-guides, skills, memory, docs, _docs, content/docs
// and the top-level guide files) into documents/document_chunks.
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitMarkdown, appSlugForPath } from './elite2-knowledge-retrieval.mjs';
import { ROOT, query, withTransaction, closePool, vectorLiteral } from './hachimi-db.mjs';
import { embedDocuments, FREE_TIER_REQUESTS_PER_MINUTE, QuotaExhaustedError } from './hachimi-embeddings.mjs';

const DEFAULT_CORPUS_ROOT = resolve(ROOT, 'knowledge-base');
const INSERT_BATCH = 200;
// Collections: Markdown-only folders plus skills, where scripts/config are part of the skill.
export const CORPUS_COLLECTIONS = Object.freeze([
  { name: 'knowledge', dir: 'knowledge' },
  { name: 'app-guides', dir: 'app-guides' },
  { name: 'skills', dir: 'skills', extensions: ['.md', '.json', '.yaml', '.yml', '.py', '.js', '.mjs', '.ts', '.example', '.txt'] },
  { name: 'memory', dir: 'memory' },
  { name: 'docs', dir: 'docs' },
  { name: 'docs', dir: '_docs' },
  { name: 'docs', dir: 'content/docs', extensions: ['.md', '.json'] },
  // Exported from the ts2 database (KB docs authored in the UI, skill library). See knowledge-base/SOURCE.md.
  { name: 'kb-ui', dir: 'ui', extensions: ['.md', '.json'] },
  { name: 'skill-library', dir: 'skill-library', extensions: ['.md', '.json'] },
]);
const ROOT_GUIDE_FILES = Object.freeze(['README.md', 'AGENTS.md', 'CLAUDE.md', 'DEPLOY.md', 'CHANGELOG.md']);
const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git']);

async function textFiles(directory, extensions) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; }
  const files = await Promise.all(entries.map(async entry => {
    if (SKIP_DIRS.has(entry.name)) return [];
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return textFiles(path, extensions);
    return entry.isFile() && extensions.includes(extname(entry.name) || basename(entry.name)) ? [path] : [];
  }));
  return files.flat();
}

export async function corpusFiles(root) {
  const found = [];
  for (const collection of CORPUS_COLLECTIONS) {
    const paths = await textFiles(resolve(root, collection.dir), collection.extensions || ['.md']);
    found.push(...paths.map(path => ({ path, collection: collection.name })));
  }
  for (const name of ROOT_GUIDE_FILES) {
    const path = resolve(root, name);
    if (await stat(path).then(info => info.isFile(), () => false)) found.push({ path, collection: 'guides' });
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

// knowledge/<app>/..., app-guides/<app>*.md, skills/investigate/<app>/..., ui/<app>/... and skill-library/<app>/... map to an app slug.
export function collectionAppSlug(sourcePath, path, root) {
  const known = appSlugForPath(path, root);
  if (known) return known;
  const match = sourcePath.match(/^(?:skills\/investigate|ui|skill-library)\/([^/_][^/]*)\//);
  return match ? match[1] : '';
}

function splitContent(content, path) {
  if (extname(path) === '.md') return splitMarkdown(content);
  // Non-Markdown skill files: single heading, size-limited chunks.
  return splitMarkdown(`# ${basename(path)}\n\n${content}`);
}

function titleOf(markdown, path) {
  return markdown.match(/^#\s+(.+)$/m)?.[1].trim() || basename(path, '.md');
}

async function upsertDocument(client, { sourcePath, appSlug, title, hash, chunks, metadata }) {
  const { rows: [doc] } = await client.query(`
    INSERT INTO documents (source_path, app_slug, title, content_hash, chunk_count, metadata, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
    ON CONFLICT (source_path) DO UPDATE
      SET app_slug = EXCLUDED.app_slug, title = EXCLUDED.title, content_hash = EXCLUDED.content_hash,
          chunk_count = EXCLUDED.chunk_count, metadata = EXCLUDED.metadata, updated_at = now()
    RETURNING id`, [sourcePath, appSlug, title, hash, chunks.length, JSON.stringify(metadata)]);
  await client.query('DELETE FROM document_chunks WHERE document_id = $1', [doc.id]);
  for (let start = 0; start < chunks.length; start += INSERT_BATCH) {
    const slice = chunks.slice(start, start + INSERT_BATCH);
    const values = [];
    const params = [];
    slice.forEach((chunk, offset) => {
      const base = params.length;
      params.push(doc.id, start + offset, appSlug, chunk.heading, chunk.content);
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
    });
    await client.query(`INSERT INTO document_chunks (document_id, chunk_index, app_slug, heading, content) VALUES ${values.join(',')}`, params);
  }
}

export async function ingestDocuments({ corpusRoot = DEFAULT_CORPUS_ROOT, prune = true, log = () => {} } = {}) {
  const root = resolve(corpusRoot);
  const files = await corpusFiles(root);
  const { rows: existing } = await query('SELECT source_path, content_hash FROM documents');
  const known = new Map(existing.map(row => [row.source_path, row.content_hash]));
  const seen = new Set();
  // External versioned releases have a separate owner; corpus prune must never remove them.
  for (const sourcePath of known.keys()) if (sourcePath.startsWith('solar-release/')) seen.add(sourcePath);
  const stats = { files: files.length, unchanged: 0, updated: 0, chunks: 0, pruned: 0, byCollection: {} };

  for (const { path, collection } of files) {
    const sourcePath = relative(root, path).replaceAll('\\', '/');
    seen.add(sourcePath);
    stats.byCollection[collection] = (stats.byCollection[collection] || 0) + 1;
    const content = await readFile(path, 'utf8');
    const hash = createHash('sha256').update(content).digest('hex');
    if (known.get(sourcePath) === hash) { stats.unchanged++; continue; }
    const chunks = splitContent(content, path).filter(chunk => chunk.content.trim());
    const metadata = { collection, extension: extname(path) || basename(path), sourceRoot: 'knowledge-base' };
    await withTransaction(client => upsertDocument(client, {
      sourcePath, appSlug: collectionAppSlug(sourcePath, path, root), title: titleOf(content, path), hash, chunks, metadata,
    }));
    stats.updated++;
    stats.chunks += chunks.length;
    log(`updated ${sourcePath} (${chunks.length} chunks)`);
  }
  if (prune) {
    const stale = [...known.keys()].filter(sourcePath => !seen.has(sourcePath));
    if (stale.length) {
      await query('DELETE FROM documents WHERE source_path = ANY($1)', [stale]);
      stats.pruned = stale.length;
    }
  }
  return stats;
}

// Paced to the free-tier per-minute quota; resumable because only NULL embeddings are processed.
export async function embedMissingChunks({ batchSize = 50, requestsPerMinute = FREE_TIER_REQUESTS_PER_MINUTE, log = () => {} } = {}) {
  let embedded = 0;
  const { rows: [{ remaining }] } = await query('SELECT count(*)::int AS remaining FROM document_chunks WHERE embedding IS NULL');
  let left = remaining;
  while (left > 0) {
    const startedAt = Date.now();
    const { rows } = await query('SELECT id, heading, content FROM document_chunks WHERE embedding IS NULL ORDER BY id LIMIT $1', [batchSize]);
    if (!rows.length) break;
    let vectors;
    try { vectors = await embedDocuments(rows.map(row => `${row.heading}\n${row.content}`)); }
    catch (error) {
      if (!(error instanceof QuotaExhaustedError)) throw error;
      log(`stopped: ${error.message}; ${left} chunks still without embedding (re-run --embed later)`);
      return { embedded, remaining: left, stopped: error.message };
    }
    await withTransaction(async client => {
      for (const [index, row] of rows.entries()) {
        await client.query('UPDATE document_chunks SET embedding = $1::vector WHERE id = $2', [vectorLiteral(vectors[index]), row.id]);
      }
    });
    embedded += rows.length;
    left -= rows.length;
    log(`embedded ${embedded} chunks, ${left} remaining`);
    const minimumMs = (rows.length / requestsPerMinute) * 60_000;
    const wait = minimumMs - (Date.now() - startedAt);
    if (left > 0 && wait > 0) await new Promise(done => setTimeout(done, wait));
  }
  return { embedded, remaining: 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const verbose = args.includes('--verbose');
  const log = verbose ? console.error : () => {};
  try {
    const stats = await ingestDocuments({ corpusRoot: option('--root') || DEFAULT_CORPUS_ROOT, prune: !args.includes('--no-prune'), log });
    console.log(JSON.stringify(stats));
    if (args.includes('--embed')) console.log(JSON.stringify(await embedMissingChunks({ log: console.error })));
  } catch (error) {
    console.error(`Ingest failed: ${error.message}`);
    process.exitCode = 1;
  } finally { await closePool(); }
}
