import { readSlackEvidence } from './slack-evidence.mjs';
// Pha Chuẩn bị — code only. Reads the ticket from Helpdesk, identifies the app (so the tools rank its code
// and KB first), gathers earlier cases of the same app from the automatic controller's state and the
// Train-AI lessons, and decides whether the browser tool may be used. Writes <job>/prepare.json that the
// MCP tools server and the prompts read; no credential ever reaches that file.

import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { readEvidence, ROOT, STATE_PATH } from '../../check-ticket/scripts/adapters.mjs';
import { feedbackLessons } from '../../check-ticket/scripts/worker.mjs';
import { customizeHint } from './customize.mjs';
import { settingHint } from './shop-settings.mjs';
import { extractImageLinks } from '../../check-ticket/scripts/bot-command.mjs';
import { fetchStorefrontSettings } from './storefront.mjs';
import { flattenSettings } from './shop-settings.mjs';
import { storefrontAccess, redactStorefrontSecrets } from './storefront-access.mjs';
import { redactConfig } from './config-reader.mjs';

// Helpdesk app name / ticket prefix → apps_doc slug + knowledge-base slug. `names` are the exact appName values seen in
// Andrew's roster (2178 tickets, 14/10/2026); `pattern` is the fallback for a variant spelling. Order matters: first match wins.
export const APPS = [
  { slug: 'joy-subs', kb: 'joy-subscriptions', names: ['JOY Subscription', 'JOY Subscriptions'], prefixes: ['JSUB'], pattern: /joy[\s-]*sub|subscription|recurring|selling[\s-]*plan/i },
  { slug: 'joy', kb: 'joy', names: ['JOY Loyalty'], prefixes: ['JOY'], pattern: /\bjoy\b|loyalty|reward/i },
  { slug: 'wishlist', kb: 'wishlist', names: ['Wishlist'], prefixes: ['WISH'], pattern: /wishlist/i },
  { slug: 'chatty', kb: 'chatty', names: ['Chatty', 'Chatty AI'], prefixes: ['CHAT', 'CHATTY'], pattern: /chatty|helpcenter|help center|faq/i },
  { slug: 'air-reviews', kb: 'air-reviews', names: ['Air Reviews'], prefixes: ['AIR', 'AR'], pattern: /air[\s-]*review|\breview/i },
  { slug: 'aem', kb: 'aem', names: ['Email Marketing', 'aem', 'AEM'], prefixes: ['AEM', 'EM', 'EMA'], pattern: /avada[\s-]*email|\baem\b|email marketing/i },
  { slug: 'shopvid', kb: 'shopvid', names: ['Shopvid'], prefixes: ['SV', 'VID', 'VIDE'], pattern: /shopvid|shoppable video/i },
  { slug: 'booking', kb: 'booking', names: ['LUNA Booking'], prefixes: ['BOOS', 'BOOK', 'APPT'], pattern: /booking|appointment|\bluna\b/i },
  { slug: 'order-limits', kb: 'order-limits', names: ['Avada Order Limit'], prefixes: ['ORDL', 'OL'], pattern: /order[\s-]*limit/i },
  { slug: 'cookie-bar', kb: 'cookie-bar', names: ['Cookie Bar'], prefixes: ['CB'], pattern: /cookie/i },
  { slug: 'pdf-invoice', kb: 'pdf-invoice', names: ['PDF Invoice'], prefixes: ['PDF', 'INV'], pattern: /pdf|invoice/i },
  { slug: 'survey', kb: 'survey', names: ['SEA Survey'], prefixes: ['SUR', 'SV2', 'SRVY'], pattern: /survey|quiz/i },
  { slug: 'accessibility', kb: 'accessibility', names: ['SEA Accessibility'], prefixes: ['ACCS', 'ACC'], pattern: /accessib/i },
  { slug: 'age-verification', kb: 'age-verification', names: ['SUN Age Verification'], prefixes: ['AGE', 'AV', 'SOAV'], pattern: /age[\s-]*verif/i },
  { slug: 'air-edd', kb: 'air-edd', names: ['Air Estimated Delivery Date'], prefixes: ['EDD'], pattern: /\bedd\b|estimated delivery/i },
  { slug: 'order-tracking', kb: 'order-tracking', names: ['SUN Order Tracking'], prefixes: ['SOT', 'OT', 'TRAK'], pattern: /order[\s-]*track/i },
  { slug: 'affily', kb: 'affily', names: ['Avada Affiliate Marketing', 'Affily'], prefixes: ['AFF', 'AFFI'], pattern: /affily|affiliate/i },
  { slug: 'fraud-filter', kb: 'fraud-filter', names: ['SEA Fraud Filter'], prefixes: ['FRAU', 'FF'], pattern: /fraud|ip blocker/i },
  { slug: 'online-course', kb: 'online-course', names: ['SEA Online Course'], prefixes: ['OC', 'COUR'], pattern: /online course|course/i },
  { slug: 'shipping-labels', kb: 'shipping-labels', names: ['Shipping Labels'], prefixes: ['SHIP', 'SL'], pattern: /shipping label|easypost/i },
  { slug: 'backups-restore', kb: 'backups-restore', names: ['Backups & Restore', 'Backups and Restore'], prefixes: ['BAK', 'BR'], pattern: /backup|restore/i },
  { slug: 'withdrawal-forms', kb: 'withdrawal-forms', names: ['Withdrawal Forms', 'withdrawalForms'], prefixes: ['WDFM', 'WF'], pattern: /withdraw/i },
  { slug: 'order-editing', kb: 'order-editing', names: ['Order Editing'], prefixes: ['OE', 'ORDE'], pattern: /order[\s-]*edit/i },
];
// Helpdesk app names that are not a Shopify app of ours (no code, no KB): the scope stays open for these.
export const NON_APP_NAMES = /^(avada ts ai|unknown|)$/i;

const byName = value => { const name = String(value || '').trim().toLowerCase(); if (!name) return null; return APPS.find(item => item.names.some(known => known.toLowerCase() === name)) || APPS.find(item => item.pattern.test(name)) || null; };
const byPrefix = reference => { const prefix = String(reference || '').split('-')[0].toUpperCase(); return prefix ? APPS.find(item => item.prefixes.includes(prefix)) || null : null; };

// Knowledge-base folders the investigator may read for this app, and the common ones every ticket may read.
export const COMMON_KB_ROOTS = ['knowledge-base/skills/investigate/_common', 'knowledge-base/feedback'];
export function kbRootsFor(app, root = ROOT) {
  const kb = typeof app === 'string' ? app : app?.kb;
  if (!kb) return [];
  const slug = typeof app === 'string' ? app : app.slug;
  const mine = [kb, slug].filter(Boolean);
  // joy-subscription-devzone.md starts with "joy-" but belongs to Joy Subscriptions: a longer slug/kb of another app wins.
  const longer = APPS.filter(item => item.kb !== kb).flatMap(item => [item.kb, item.slug]).filter(other => mine.some(prefix => other.startsWith(`${prefix}-`)));
  const roots = [join('knowledge-base/knowledge', kb), join('knowledge-base/skills/investigate', kb)];
  try {
    for (const name of readdirSync(resolve(root, 'knowledge-base/app-guides'))) {
      const stem = name.replace(/\.md$/, '');
      if (!mine.some(prefix => stem === prefix || stem.startsWith(`${prefix}-`) || (prefix.length >= 6 && stem.startsWith(prefix)))) continue; // joy-subs → joy-subscription-devzone.md
      if (longer.some(other => stem === other || stem.startsWith(other))) continue;
      roots.push(join('knowledge-base/app-guides', name));
    }
  } catch { /* no app guides */ }
  return roots.filter(path => existsSync(resolve(root, path)));
}

// Order since 14/10/2026 (user order to classify the app and search only that app): the Helpdesk appName is the field
// CS keeps current, so it decides; the ticket prefix (fixed at creation) is the fallback and a disagreement is recorded as
// `appConflict`; the subject is the last resort. Unknown app → slug null and the search scope stays open (`locked: false`).
export function detectApp({ appName = '', reference = '', subject = '' } = {}, root = ROOT) {
  const nameApp = byName(appName);
  const prefixApp = byPrefix(reference);
  const subjectApp = !nameApp && !prefixApp && subject ? byName(subject) : null;
  const app = nameApp || prefixApp || subjectApp;
  const by = nameApp ? 'appName' : prefixApp ? 'prefix' : subjectApp ? 'subject' : null;
  const appConflict = nameApp && prefixApp && nameApp.slug !== prefixApp.slug ? { appName: String(appName), prefix: String(reference).split('-')[0].toUpperCase(), appNameSlug: nameApp.slug, prefixSlug: prefixApp.slug, chosen: nameApp.slug } : null;
  if (!app) return { slug: null, kb: null, codeRoot: null, kbRoots: [], by: null, appConflict: null, nonApp: NON_APP_NAMES.test(String(appName || '').trim()), scope: { locked: false, kbRoots: [], commonRoots: COMMON_KB_ROOTS.filter(path => existsSync(resolve(root, path))), codeRoot: null } };
  const codeRoot = existsSync(resolve(root, 'apps_doc', app.slug)) ? join('apps_doc', app.slug) : null;
  const kbRoots = kbRootsFor(app, root);
  return { slug: app.slug, kb: app.kb, codeRoot, kbRoots, by, appConflict, nonApp: false, scope: { locked: true, kbRoots, commonRoots: COMMON_KB_ROOTS.filter(path => existsSync(resolve(root, path))), codeRoot } };
}

// Browser use is allowed only when the reported symptom is something a visitor would see on the storefront.
// Anything a visitor's browser would show or log: layout/widget words, but also console errors, scripts and pixels.
const STOREFRONT = /storefront|theme|widget|hiển thị|không hiện|không thấy|show|display|layout|css|cart drawer|popup|block|section|embed|frontend|giao diện|trang chủ|homepage|product page|checkout page|mobile|console|script|pixel|javascript|\bjs\b|website|\bsite\b|\bpage\b|render|tracking|banner|cookie bar/i;
const INTERNAL_ONLY = /webhook|cron|flow|email|mail|sync|import|export|api key|billing|invoice|dashboard|admin|backend|database|report|analytics/i;
export function browserAllowedFor(ticket) {
  const textValue = `${ticket.subject || ''}\n${ticket.description || ''}`;
  const hasStore = Array.isArray(ticket.storeDomains) && ticket.storeDomains.length > 0;
  // A Customize request always concerns what the visitor sees, so the DOM must be readable (13/10/2026).
  if (hasStore && customizeHint(ticket)) return true;
  return hasStore && STOREFRONT.test(textValue) && !(INTERNAL_ONLY.test(ticket.subject || '') && !STOREFRONT.test(ticket.subject || ''));
}

export async function oldCases(reference, app, { statePath = STATE_PATH, limit = 3 } = {}) {
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch { return []; }
  const prefix = String(reference).split('-')[0].toUpperCase();
  const jobs = Object.values(state.jobs || {}).filter(job => job.status === 'done' && job.comment && job.reference !== reference
    && (String(job.reference || '').toUpperCase().startsWith(`${prefix}-`) || (app.slug && APPS.find(item => item.prefixes.includes(String(job.reference || '').split('-')[0].toUpperCase()))?.slug === app.slug)));
  jobs.sort((a, b) => String(b.finishedAt || b.createdAt || '').localeCompare(String(a.finishedAt || a.createdAt || '')));
  return jobs.slice(0, limit).map(job => ({ reference: job.reference, subject: job.subject, category: job.category || null, finishedAt: job.finishedAt || null, comment: String(job.comment).slice(0, 1500) }));
}

// Follow-up after a "@han" comment (13/10/2026): the comments written since the last check (oldest first, the command
// comment itself left out), the image links they carry, the instruction and the report posted last time — all DATA for
// the investigator, never evidence. sinceAt null = every comment is "new".
const TS_REPORT_OPENING = /^\s*(?:Sau khi TS check thì thấy như sau:|\*\*Xin chào cạ nhà, đây là Han Support hỗ trợ cạ nhà ticket này nha\*\*)/;
export function followUpContext(ticket, followUp) {
  if (!followUp) return null;
  const sinceMs = Date.parse(followUp.sinceAt || '');
  const all = Array.isArray(ticket.comments) ? ticket.comments : [];
  const newComments = all
    .filter(comment => comment && comment.id !== followUp.commentId && !(followUp.acknowledgementIds || []).includes(comment.id) && (!Number.isFinite(sinceMs) || Date.parse(comment.createdAt || '') > sinceMs))
    .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')))
    // A report the controller/an agent posted under Andrew's account is marked so the prompt does not read it as Andrew's own words.
    .map(comment => ({ id: comment.id, author: comment.author || '', authorId: comment.authorId || '', createdAt: comment.createdAt || '', content: String(comment.content || '').slice(0, 4000), tsReport: TS_REPORT_OPENING.test(String(comment.content || '')) }));
  const commandComment = followUp.commentId ? all.find(comment => comment.id === followUp.commentId) || null : null;
  const newText = [...newComments.map(comment => comment.content), commandComment?.content || '', followUp.instruction || ''].join('\n');
  return {
    instruction: String(followUp.instruction || '').slice(0, 2000), defaultInstruction: followUp.defaultInstruction !== false, keyword: followUp.keyword || '@han',
    commentId: followUp.commentId || null, commentAt: followUp.commentAt || null, sinceAt: Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : null,
    previousReport: followUp.previousReport ? String(followUp.previousReport).slice(0, 4000) : null, previousCategory: followUp.previousCategory || null, previousFinishedAt: followUp.previousFinishedAt || null,
    newComments, commandComment: commandComment ? { id: commandComment.id, author: commandComment.author || '', createdAt: commandComment.createdAt || '', content: String(commandComment.content || '').slice(0, 2000) } : null,
    imageLinks: extractImageLinks([newText, ticket.description || ''].join('\n')), newText,
  };
}

export async function prepare(target, { slackReader = readSlackEvidence, signal = null, evidence = readEvidence, lessons = feedbackLessons, statePath = STATE_PATH, root = ROOT, followUp = null, preSettings = true, fetchSettings = fetchStorefrontSettings } = {}) {
  const started = Date.now();
  const ticket = await evidence(target.reference, undefined, { allComments: true, signal });
  const slack = await slackReader(ticket, { root, followUp, signal });
  const access = storefrontAccess(ticket);
  const app = detectApp({ appName: ticket.appName, reference: target.reference, subject: ticket.subject }, root);
  const [cases, learned] = await Promise.all([oldCases(target.reference, app, { statePath }), lessons(target.reference)]);
  const storeUrls = (ticket.storeDomains || []).map(domain => `https://${String(domain).replace(/^https?:\/\//, '').replace(/\/$/, '')}/`);
  const follow = followUpContext(ticket, followUp);
  // In a follow-up the new comments and the instruction count for the hints too (a CSS request may arrive as a comment).
  const hintTicket = follow ? { ...ticket, description: [ticket.description || '', follow.newText].join('\n') } : ticket;
  const settingLooking = settingHint(hintTicket);
  // Pre-read of the shop configuration (14/10/2026): one storefront load here instead of 3–5 inside the investigation;
  // the tools server answers later shop_settings calls on the same page from this cache. Failure → skipped, noted.
  let settingsPre = null;
  if (preSettings && settingLooking && app.slug && storeUrls[0]) {
    const read = await fetchSettings(storeUrls[0], app.slug, { timeoutMs: 25000, access });
    settingsPre = read.error ? { url: storeUrls[0], error: read.error } : { ...read, lines: read.found.flatMap(item => (item.value ? flattenSettings(item.value, { path: item.name, maxLines: read.found.length > 1 ? 40 : 60 }) : [`window.${item.name}: ${item.error || 'rỗng'}`])).slice(0, 60) };
  }
  if (settingsPre?.found) {
    for (const item of settingsPre.found) item.value = redactConfig(item.value);
    settingsPre.lines = settingsPre.found.flatMap(item => item.value ? flattenSettings(item.value, { path: item.name, maxLines: 60 }) : [`window.${item.name}: ${item.error || 'rỗng'}`]).slice(0, 60);
  }
  return redactStorefrontSecrets({
    reference: target.reference, url: target.url, preparedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
    storefrontAccess: { hasPassword: Boolean(access.password), hosts: access.hosts },
    ticket, slack, app, scope: app.scope, browserAllowed: browserAllowedFor(hintTicket), customizeHint: customizeHint(hintTicket), settingHint: settingLooking, storeUrls, settingsPre,
    oldCases: cases, lessons: (learned || []).slice(0, 12), followUp: follow,
    imageLinks: follow ? follow.imageLinks : extractImageLinks([ticket.description || '', ...(ticket.comments || []).map(comment => comment.content)].join('\n')),
    ticketText: [ticket.subject, ticket.description, ...(ticket.comments || []).map(comment => comment.content)].join('\n'),
  }, access);
}
