#!/usr/bin/env node
// NEWS: one bulletin file per day under runtime/ts-web/news/<yyyy-mm-dd>.json. buildToday() fetches the sources
// (news-feed.mjs), saves the bulletin at once, then adds the Vietnamese summaries (news-summarize.mjs) and saves again.
// Then it adds the daily sections "10 mẹo dùng AI" / "10 tính năng hay của Claude và Codex" / "10 tool/extension hay dùng với AI" (news-tips.mjs, tool links checked over the network) and saves a third time.
// Old bulletins are never deleted here. CLI: node scripts/news-store.mjs build [--force] [--no-summary] [--no-tips] | show [date] | dates
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, GROUPS, loadSources, fetchAll, buildBulletin } from './news-feed.mjs';
import { summarizeItems } from './news-summarize.mjs';
import { generateTips, readHistory, writeHistory, recordHistory, tipsCount, TIPS_TIMEOUT_MS } from './news-tips.mjs';

export const NEWS_DIR = process.env.TS_WEB_NEWS_DIR || resolve(ROOT, 'runtime/ts-web/news');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIPS_HISTORY_FILE = resolve(NEWS_DIR, 'tips-history.json'); // titles already used by the tips sections
export const BUILD_HOUR = 8; // 08:00 local time
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;

// Local calendar date (the machine's timezone), yyyy-mm-dd.
export function localDate(now = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
export const bulletinPath = date => { if (!DATE_RE.test(date)) throw new TypeError('Ngày phải có dạng yyyy-mm-dd.'); return resolve(NEWS_DIR, `${date}.json`); };

export async function readBulletin(date) {
  try { return JSON.parse(await readFile(bulletinPath(date), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function listDates() {
  let names; try { names = await readdir(NEWS_DIR); } catch { return []; }
  return names.map(name => /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name)?.[1]).filter(Boolean).sort().reverse();
}
export async function latestBulletin() {
  const [date] = await listDates();
  return date ? readBulletin(date) : null;
}
async function save(bulletin) {
  await mkdir(NEWS_DIR, { recursive: true, mode: 0o700 });
  const file = bulletinPath(bulletin.date); const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(bulletin, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}

const allItems = bulletin => GROUPS.flatMap(group => bulletin.groups?.[group] || []);
export const bulletinMeta = bulletin => bulletin ? { date: bulletin.date, builtAt: bulletin.builtAt, summarized: Boolean(bulletin.summarized), total: allItems(bulletin).length, sourcesFailed: (bulletin.sources || []).filter(s => !s.ok).length, tips: bulletin.tips ? tipsCount(bulletin.tips) : null, tipsError: bulletin.tips?.error || '' } : null;

// The two daily sections, one Codex run per bulletin. Failure or timeout keeps the bulletin and records the reason in
// bulletin.tips.error (the view then says "chưa tạo được, thử Làm mới"). Titles used today go to the history file.
async function addTips(bulletin, log) {
  let history = null;
  try {
    history = await readHistory(TIPS_HISTORY_FILE);
    bulletin.tips = await generateTips({ bulletin, history, timeoutMs: TIPS_TIMEOUT_MS });
    if (tipsCount(bulletin.tips)) await writeHistory(TIPS_HISTORY_FILE, recordHistory(history, bulletin.tips, bulletin.date));
  } catch (error) {
    bulletin.tips = { generatedAt: new Date().toISOString(), error: `Chưa tạo được: ${error.message}`, aiTips: [], toolFeatures: [], aiTools: [] };
  }
  await save(bulletin);
  const links = bulletin.tips.links ? ` · link tool ${bulletin.tips.links.ok}/${bulletin.tips.links.checked} ok` : '';
  log(`[news] ${bulletin.date}: mẹo/tính năng/tool ${tipsCount(bulletin.tips)}/30${links}${bulletin.tips.error ? ` (${bulletin.tips.error})` : ''}`);
}

let building = null; let lastFailure = 0; let lastError = '';
export const buildStatus = () => ({ building: Boolean(building), lastError, lastFailureAt: lastFailure ? new Date(lastFailure).toISOString() : null });

// The 08:00 rule: build when it is past BUILD_HOUR and today's bulletin is missing (a failed attempt waits 10 minutes).
export async function shouldBuild(now = new Date()) {
  if (now.getHours() < BUILD_HOUR || building) return false;
  if (Date.now() - lastFailure < RETRY_AFTER_FAILURE_MS) return false;
  return !(await readBulletin(localDate(now)));
}

// Builds today's bulletin (reused when one is already being built). force=true rebuilds even if today's file exists.
export function buildToday({ force = false, summary = true, tips = true, log = () => {}, fetchImpl } = {}) {
  if (building) return building;
  building = (async () => {
    const date = localDate();
    const existing = await readBulletin(date);
    if (existing && !force) return existing;
    const config = await loadSources();
    const previous = existing || await latestBulletin();
    const lastSeenVersion = existing?.lastSeenVersion || previous?.lastSeenVersion || '';
    const started = Date.now();
    const results = await fetchAll(config, { lastSeenVersion, fetchImpl });
    const bulletin = buildBulletin(results, { date, windowHours: config.windowHours, maxItems: config.maxItems, perGroup: config.perGroup, lastSeenVersion });
    if (!bulletin.total && results.every(result => result.error)) throw new Error(`Không lấy được nguồn nào: ${results.map(r => `${r.source.id}: ${r.error}`).join('; ')}`);
    // Keep yesterday's summaries for items that are still in today's bulletin.
    const known = new Map(previous ? allItems(previous).filter(item => item.summary).map(item => [item.id, item.summary]) : []);
    for (const item of allItems(bulletin)) if (known.has(item.id)) item.summary = known.get(item.id);
    bulletin.fetchMs = Date.now() - started;
    await save(bulletin);
    log(`[news] ${date}: ${bulletin.total} tin từ ${bulletin.sources.filter(s => s.ok).length}/${bulletin.sources.length} nguồn trong ${bulletin.fetchMs} ms`);
    if (summary) {
      const pending = allItems(bulletin).filter(item => !item.summary);
      try {
        const summaries = pending.length ? await summarizeItems(pending) : {};
        for (const item of allItems(bulletin)) if (summaries[item.id]) item.summary = summaries[item.id];
        bulletin.summarized = allItems(bulletin).every(item => item.summary);
        bulletin.summaryError = bulletin.summarized ? '' : 'Một số tin chưa có tóm tắt tiếng Việt.';
      } catch (error) { bulletin.summarized = false; bulletin.summaryError = `Chưa tóm tắt được: ${error.message}`; }
      await save(bulletin);
      log(`[news] ${date}: tóm tắt ${bulletin.summarized ? 'xong' : 'chưa đủ'}${bulletin.summaryError ? ` (${bulletin.summaryError})` : ''}`);
    }
    if (tips) await addTips(bulletin, log);
    return bulletin;
  })();
  building.then(() => { lastFailure = 0; lastError = ''; }, error => { lastFailure = Date.now(); lastError = error.message; }).finally(() => { building = null; });
  return building;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = 'build', ...args] = process.argv.slice(2);
  try {
    if (command === 'build') {
      const bulletin = await buildToday({ force: args.includes('--force'), summary: !args.includes('--no-summary'), tips: !args.includes('--no-tips'), log: console.log });
      console.log(JSON.stringify({ ...bulletinMeta(bulletin), fetchMs: bulletin.fetchMs, summaryError: bulletin.summaryError || '', sources: bulletin.sources }, null, 2));
      if (bulletin.tips) for (const key of ['aiTips', 'toolFeatures', 'aiTools']) console.log(`${key}:\n${(bulletin.tips[key] || []).map((item, index) => `  ${index + 1}. ${item.title}${item.kind ? ` [${item.kind}]` : ''}${item.url ? ` ${item.url}` : ''}${item.linkStatus && item.linkStatus !== 'ok' ? ` (${item.linkStatus})` : ''}`).join('\n')}`);
    } else if (command === 'show') process.stdout.write(`${JSON.stringify(await readBulletin(args[0] || localDate()), null, 2)}\n`);
    else if (command === 'dates') console.log((await listDates()).join('\n'));
    else throw new Error('Usage: news-store.mjs build [--force] [--no-summary] [--no-tips] | show [date] | dates');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
