#!/usr/bin/env node
// Publish a Markdown or HTML file to notes.avada.net and print the public URL.
//   node scripts/notes-publish.mjs <file.md|file.html> [--name <slug>] [--ext md|html]
// Token: NOTE_AVADA_TOKEN in .env_my (never printed). The API: POST https://notes.avada.net/api/upload?ext=<ext>&name=<slug>
// with `Authorization: Bearer <token>` and the file content as body; the JSON answer carries `url`.
import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const API = 'https://notes.avada.net/api/upload';

async function token() {
  if (process.env.NOTE_AVADA_TOKEN) return process.env.NOTE_AVADA_TOKEN.trim();
  const text = await readFile(resolve(ROOT, '.env_my'), 'utf8').catch(() => '');
  const line = text.split('\n').find(row => row.startsWith('NOTE_AVADA_TOKEN='));
  const value = line ? line.slice('NOTE_AVADA_TOKEN='.length).trim().replace(/^["']|["']$/g, '') : '';
  if (!value) throw new Error('Thiếu NOTE_AVADA_TOKEN trong .env_my.');
  return value;
}

// Slug without diacritics: letters, digits and dashes only.
export const slugify = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

export async function publish(file, { name = '', ext = '' } = {}) {
  const path = resolve(file);
  const kind = (ext || extname(path).slice(1)).toLowerCase();
  if (!['md', 'html'].includes(kind)) throw new Error('ext phải là md hoặc html.');
  const body = await readFile(path, 'utf8');
  const slug = slugify(name || basename(path, extname(path)));
  if (!slug) throw new Error('Tên (slug) rỗng.');
  const url = `${API}?ext=${kind}&name=${encodeURIComponent(slug)}`;
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': `${kind === 'md' ? 'text/markdown' : 'text/html'}; charset=utf-8` }, body });
  const text = await response.text();
  if (!response.ok) throw new Error(`notes.avada.net trả ${response.status}: ${text.slice(0, 200)}`);
  let data; try { data = JSON.parse(text); } catch { throw new Error(`Phản hồi không phải JSON: ${text.slice(0, 200)}`); }
  const link = data.url || data.data?.url || '';
  if (!link) throw new Error(`Phản hồi không có url: ${text.slice(0, 200)}`);
  return { url: link, slug, ext: kind, bytes: Buffer.byteLength(body) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = key => { const index = args.indexOf(key); return index >= 0 ? args[index + 1] || '' : ''; };
  const file = args.find(arg => !arg.startsWith('--') && arg !== opt('--name') && arg !== opt('--ext'));
  if (!file) { console.error('Usage: node scripts/notes-publish.mjs <file.md|file.html> [--name <slug>] [--ext md|html]'); process.exit(1); }
  try { const result = await publish(file, { name: opt('--name'), ext: opt('--ext') }); console.log(result.url); console.error(`${result.ext} · ${result.slug} · ${result.bytes} bytes`); }
  catch (error) { console.error(error.message); process.exit(1); }
}
