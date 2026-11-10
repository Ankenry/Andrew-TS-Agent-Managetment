#!/usr/bin/env node
// Shared PostgreSQL access for the Hachimi database (db/docker-compose.yml).
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import pg from 'pg';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCHEMA = resolve(ROOT, 'db/schema.sql');
const DEFAULT_URL = 'postgres://hachimi:hachimi@127.0.0.1:5434/hachimi';

// Read data only; never execute .env_my as a shell script.
export function loadEnv() {
  try { return parseEnv(readFileSync(resolve(ROOT, '.env_my'), 'utf8')); } catch { return {}; }
}
export function databaseUrl() {
  return process.env.HACHIMI_DATABASE_URL || loadEnv().HACHIMI_DATABASE_URL || DEFAULT_URL;
}

let pool;
export function getPool() {
  pool ??= new pg.Pool({ connectionString: databaseUrl(), max: 4, connectionTimeoutMillis: 5000 });
  return pool;
}
export const query = (text, params) => getPool().query(text, params);
export async function withTransaction(work) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
export async function closePool() { await pool?.end(); pool = undefined; }
export const vectorLiteral = values => `[${values.map(v => Number(v).toPrecision(8)).join(',')}]`;

export async function migrate() { await query(await readFile(SCHEMA, 'utf8')); }
export async function status() {
  const { rows } = await query(`
    SELECT (SELECT count(*) FROM trace_sessions)::int AS sessions,
           (SELECT count(*) FROM trace_events)::int AS events,
           (SELECT count(*) FROM trace_artifacts)::int AS artifacts,
           (SELECT count(*) FROM documents)::int AS documents,
           (SELECT count(*) FROM document_chunks)::int AS chunks,
           (SELECT count(*) FROM document_chunks WHERE embedding IS NOT NULL)::int AS embedded_chunks,
           (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS pgvector,
           version() AS postgres`);
  return rows[0];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || 'status';
  try {
    if (command === 'migrate') { await migrate(); console.log('Schema applied:', SCHEMA); }
    else if (command === 'status') console.log(JSON.stringify(await status(), null, 2));
    else { console.error('Usage: node scripts/hachimi-db.mjs [migrate|status]'); process.exitCode = 1; }
  } catch (error) {
    console.error(`Database error (${databaseUrl().replace(/:\/\/.*@/, '://***@')}): ${error.message}`);
    process.exitCode = 1;
  } finally { await closePool(); }
}
