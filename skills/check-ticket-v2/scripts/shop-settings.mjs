// Reading a shop's real app configuration (13/10/2026, user order "sau check ticket thì vào cả app xem có setting đã
// được bật hay chưa"). Pure helpers shared by the tools server (shop_settings tool), prepare, prompts and postcheck:
// where each app exposes its configuration, how to flatten/scrub it, and how to spot a settings-related ticket.
// Two sources, in order: the app's machine DevZone API v1 (X-DevZone-Key + X-Shop-Domain, read-only GET) when the
// app has one and a key is configured; otherwise the configuration object the app embed prints on the storefront
// (window.<APP_GLOBAL>, filled from shop metafields by the theme app embed), read with the headless browser.

import { readFileSync } from 'node:fs';

// Machine DevZone API v1 per app (only apps whose repo has routes/apiV1.js AND a documented base URL; others have no
// readable endpoint from here and the tool says so). `settings` = GET path for the whole configuration.
export const DEVZONE_APIS = {
  // Confirmed via Source API TS_TOOL_API.md and apiV1Controller.getSettingsField, 2026-10-21.
  // /email-notifications creates defaults when absent; /settings uses read-only repository getters.
  'order-tracking': { base: 'https://order-tracking-2667e.firebaseapp.com/api/v1', settings: '/settings', extra: [] },
  'air-reviews': { base: 'https://app.airreviews.io/api/v1', settings: '/settings/all', extra: ['/custom-css'] },
  'air-edd': { base: 'https://air-estimated-delivery-date.firebaseapp.com/api/v1', settings: '/settings', extra: [] },
};

// window global each theme app embed sets on the storefront (from apps_doc/<app>/extensions/*/app-embed|avada-embed|app-data).
export const STOREFRONT_GLOBALS = {
  'air-reviews': ['AIR_REVIEWS'], joy: ['AVADA_JOY'], wishlist: ['AVADA_WISHLIST'], chatty: ['AVADA_FAQ'],
  'cookie-bar': ['AVADA_COOKIES_BAR'], 'order-limits': ['AVADA_ORDER_LIMIT'], 'age-verification': ['AVADA_VERIFICATION'],
  'air-edd': ['AVADA_AIR_EDD', 'AVADA_AIR_EDD_CART'], 'fraud-filter': ['AVADA_FRAUD_FILTER'], survey: ['AVADA_SURVEY'],
  booking: ['SEA_APPOINTMENT'], accessibility: ['SEA_ACCESSIBILITY'], 'online-course': ['AVADA_ONLINE_COURSE'],
  'order-tracking': ['AVADA_ORDER_TRACKING'], 'joy-subs': ['AVADA_SUBSCRIPTION'], shopvid: ['SHOPPABLE_VIDEO'],
};
// Any other global that looks like an Avada app object, when the app is unknown or its global changed.
export const GLOBAL_PATTERN = /^(AVADA_[A-Z_]+|AIR_[A-Z_]+|SEA_[A-Z_]+|SHOPPABLE_VIDEO)$/;

// Env names (in .env_my) that may hold the DevZone API key, most specific first. `DEV_ZONE` is the user's DevZone
// entry (the order of 13/10/2026 names it); the app rejects it with 401 when it is the DevZone UI password rather
// than a `dk_live_…` API key, and the tool then says so and falls back to the storefront.
export const KEY_ENV_NAMES = ['DEVZONE_API_KEY', 'DEV_ZONE_API_KEY', 'DEV_ZONE'];

export function readEnvFile(path, names = KEY_ENV_NAMES) {
  let contents;
  try { contents = readFileSync(path, 'utf8'); } catch { return null; }
  const values = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match || !(names.includes(match[1]) || match[1].startsWith('DEVZONE_API_KEY_'))) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value) values[match[1]] = value;
  }
  // App-specific override: DEVZONE_API_KEY_AIR_REVIEWS.
  return values;
}

export function pickKey(values, app) {
  if (!values) return null;
  const specific = app ? `DEVZONE_API_KEY_${String(app).toUpperCase().replace(/-/g, '_')}` : null;
  if (specific && values[specific]) return values[specific];
  for (const name of KEY_ENV_NAMES) if (values[name]) return values[name];
  return null;
}

// Keys whose values never leave the tool: credentials by key name; personal data (email, phone, name, address) only
// when the value is a filled string, so boolean/number options such as `requiredEmail = true` stay readable.
export const SECRET_KEY = /token|secret|password|passwd|api[_-]?key|accesskey|private|credential|authorization|signature/i;
export const PII_KEY = /email|phone|address|firstname|lastname|first_name|last_name|customer_name|authorName/i;
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LONG_TOKEN_VALUE = /^[A-Za-z0-9_\-]{32,}$/;
export function hideValue(key, value) {
  if (SECRET_KEY.test(key)) return true;
  if (typeof value !== 'string' || !value.trim()) return false;
  return PII_KEY.test(key) || EMAIL_VALUE.test(value.trim()) || (LONG_TOKEN_VALUE.test(value) && !/^https?:/.test(value));
}
export const SKIP_KEY = /^(translations?|translationSettings|locales?|i18n|testimonials|product|collections|collectionsName|customer|shopLogo)$/;

// Flatten an object into `a.b.c = value` lines so the model can quote one setting verbatim.
// Limits keep the output readable: depth, array items, string length, total lines.
export function flattenSettings(value, { path = '', maxLines = 300, maxDepth = 7, maxItems = 6, maxString = 120 } = {}) {
  const lines = [];
  const walk = (node, prefix, depth) => {
    if (lines.length >= maxLines) return;
    if (node === null || node === undefined || typeof node !== 'object') { lines.push(`${prefix || '(root)'} = ${formatScalar(node, maxString)}`); return; }
    if (depth > maxDepth) { lines.push(`${prefix} = ${Array.isArray(node) ? `[${node.length} phần tử]` : '{…}'} (quá sâu)`); return; }
    if (Array.isArray(node)) {
      if (!node.length) { lines.push(`${prefix} = []`); return; }
      if (node.every(item => item === null || typeof item !== 'object')) { lines.push(`${prefix} = [${node.slice(0, maxItems).map(item => formatScalar(item, 40)).join(', ')}${node.length > maxItems ? `, … (${node.length} phần tử)` : ''}]`); return; }
      node.slice(0, maxItems).forEach((item, index) => walk(item, `${prefix}[${index}]`, depth + 1));
      if (node.length > maxItems) lines.push(`${prefix} = … (${node.length} phần tử, hiển thị ${maxItems})`);
      return;
    }
    const keys = Object.keys(node);
    if (!keys.length) { lines.push(`${prefix || '(root)'} = {}`); return; }
    for (const key of keys) {
      if (lines.length >= maxLines) { lines.push(`… (cắt bớt, còn nhiều khóa nữa; dùng path để thu hẹp)`); return; }
      const next = prefix ? `${prefix}.${key}` : key;
      if (hideValue(key, node[key])) { lines.push(`${next} = <ẩn>`); continue; }
      if (!prefix && SKIP_KEY.test(key)) { lines.push(`${next} = (bỏ qua: nội dung dài/không phải cấu hình; dùng path "${key}" nếu cần)`); continue; }
      // Custom CSS / JS fields are read in full (up to 3000 chars): TS needs the whole stored stylesheet to merge with.
      if (/css$|customjs$|customscript$/i.test(key) && typeof node[key] === 'string') { lines.push(`${next} = ${formatScalar(node[key], 3000)}`); continue; }
      walk(node[key], next, depth + 1);
    }
  };
  walk(value, path, 0);
  return lines;
}

function formatScalar(value, maxString) {
  if (typeof value === 'string') return JSON.stringify(value.length > maxString ? `${value.slice(0, maxString)}…` : value);
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}

// Walk `a.b[0].c` into an object.
export function getPath(value, path) {
  if (!path) return value;
  let node = value;
  for (const part of String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (node === null || node === undefined) return undefined;
    node = node[part];
  }
  return node;
}

// Tickets about a setting or a feature being on/off: the investigator must read the shop configuration.
const SETTING_WORDS = /\bsetting|\bsettings|cài đặt|cấu hình|config|option|toggle|checkbox|switch|\benable|\bdisable|\bturn(?:ed)? (?:on|off)|\bbật|\btắt|đã bật|chưa bật|không bật|activate|deactivate|\bon\/off|default|mặc định|hiển thị|không hiện|not show|doesn't show|does not show|not display|not working|không hoạt động|không chạy/i;
export function settingHint(ticket = {}) {
  return SETTING_WORDS.test(`${ticket.subject || ''}\n${ticket.description || ''}`);
}

export const SETTINGS_REF = /^settings:/;
export function hasSettingsFinding(findings = []) {
  if (findings.some(finding => finding.verified === true && finding.shop_config_observation === true)) return true;
  return findings.some(finding => SETTINGS_REF.test(String(finding?.source?.ref || '')));
}
