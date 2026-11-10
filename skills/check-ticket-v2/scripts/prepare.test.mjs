import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserAllowedFor, detectApp, kbRootsFor, APPS } from './prepare.mjs';

test('browser is allowed only for storefront-visible symptoms on a ticket with a store', () => {
  assert.equal(browserAllowedFor({ subject: 'Cookie Bar - Check Meta Pixel', description: 'console error from the cookie bar script on the homepage breaks my Meta pixel', storeDomains: ['a.myshopify.com'] }), true);
  assert.equal(browserAllowedFor({ subject: 'Redeem in cart drawer không hiển thị', description: 'khối redeem không thấy trên cart drawer', storeDomains: ['a.myshopify.com'] }), true);
  assert.equal(browserAllowedFor({ subject: '[Bug] Flow gửi thông báo hết hạn điểm không chạy', description: 'Flow vẫn ON, không có run record', storeDomains: ['a.myshopify.com'] }), false);
  assert.equal(browserAllowedFor({ subject: 'Widget không hiện', description: 'theme Dawn', storeDomains: [] }), false, 'no store → no browser');
  assert.equal(browserAllowedFor({ subject: 'Email sync lỗi', description: 'webhook không chạy', storeDomains: ['a.myshopify.com'] }), false);
});

test('detectApp (14/10/2026): the Helpdesk app name decides, the ticket prefix is the fallback, a disagreement is recorded', () => {
  const conflict = detectApp({ reference: 'JSUB-1', appName: 'JOY Loyalty' });
  assert.equal(conflict.slug, 'joy'); assert.equal(conflict.by, 'appName');
  assert.deepEqual(conflict.appConflict, { appName: 'JOY Loyalty', prefix: 'JSUB', appNameSlug: 'joy', prefixSlug: 'joy-subs', chosen: 'joy' });
  assert.equal(detectApp({ reference: 'JOY-1', appName: 'JOY Loyalty' }).appConflict, null);
  assert.equal(detectApp({ reference: 'ZZ-1', appName: 'JOY Loyalty' }).slug, 'joy');
  const prefixOnly = detectApp({ reference: 'TRAK-1', appName: '' });
  assert.equal(prefixOnly.slug, 'order-tracking'); assert.equal(prefixOnly.by, 'prefix');
  assert.equal(detectApp({ reference: 'ZZ-1', appName: '', subject: 'PDF Invoice - địa chỉ' }).by, 'subject');
  const unknown = detectApp({ reference: 'ZZ-1', appName: 'Unknown App', subject: 'hello' });
  assert.equal(unknown.slug, null); assert.equal(unknown.scope.locked, false, 'unknown app → open scope');
  assert.equal(detectApp({ reference: '', appName: 'Avada TS AI' }).nonApp, true);
});

test('detectApp covers every Helpdesk app name and ticket prefix seen in the roster on 14/10/2026', () => {
  const seen = [['Air Reviews', 'AIR', 'air-reviews'], ['JOY Loyalty', 'JOY', 'joy'], ['Chatty', 'CHAT', 'chatty'], ['JOY Subscription', 'JSUB', 'joy-subs'], ['PDF Invoice', 'PDF', 'pdf-invoice'],
    ['SEA Accessibility', 'ACCS', 'accessibility'], ['Cookie Bar', 'CB', 'cookie-bar'], ['Wishlist', 'WISH', 'wishlist'], ['Shopvid', 'VIDE', 'shopvid'], ['Avada Order Limit', 'ORDL', 'order-limits'],
    ['SUN Order Tracking', 'TRAK', 'order-tracking'], ['SEA Survey', 'SRVY', 'survey'], ['LUNA Booking', 'APPT', 'booking'], ['Email Marketing', 'EMA', 'aem'], ['Air Estimated Delivery Date', 'EDD', 'air-edd'],
    ['Withdrawal Forms', 'WDFM', 'withdrawal-forms'], ['withdrawalForms', '', 'withdrawal-forms'], ['SEA Fraud Filter', 'FRAU', 'fraud-filter'], ['SUN Age Verification', 'SOAV', 'age-verification'], ['SEA Online Course', '', 'online-course'], ['aem', '', 'aem'], ['Avada Affiliate Marketing', 'AFFI', 'affily']];
  for (const [name, prefix, slug] of seen) {
    assert.equal(detectApp({ appName: name, reference: prefix ? `${prefix}-1` : '' }).slug, slug, `appName ${name}`);
    if (prefix) assert.equal(detectApp({ appName: '', reference: `${prefix}-1` }).slug, slug, `prefix ${prefix}`);
  }
  assert.ok(APPS.every(app => Array.isArray(app.names) && app.names.length && app.prefixes.length), 'every app has names and prefixes');
});

test('kbRootsFor keeps the app\'s own guides and leaves another app\'s (joy vs joy-subscriptions)', () => {
  const root = mkdtempSync(join(tmpdir(), 'v2-kb-'));
  mkdirSync(join(root, 'knowledge-base/knowledge/joy'), { recursive: true });
  mkdirSync(join(root, 'knowledge-base/knowledge/joy-subscriptions'), { recursive: true });
  mkdirSync(join(root, 'knowledge-base/app-guides'), { recursive: true });
  for (const name of ['joy.md', 'joy-devzone.md', 'joy-widget-v4-schema.md', 'joy-subs.md', 'joy-subscriptions.md', 'joy-subscription-devzone.md', 'joy-subscriptions-roadmap.md', 'wishlist.md']) writeFileSync(join(root, 'knowledge-base/app-guides', name), '#');
  const joy = kbRootsFor(APPS.find(app => app.slug === 'joy'), root).map(path => path.split('/').pop());
  assert.deepEqual(joy, ['joy', 'joy-devzone.md', 'joy-widget-v4-schema.md', 'joy.md']);
  const subs = kbRootsFor(APPS.find(app => app.slug === 'joy-subs'), root).map(path => path.split('/').pop());
  assert.deepEqual(subs, ['joy-subscriptions', 'joy-subs.md', 'joy-subscription-devzone.md', 'joy-subscriptions-roadmap.md', 'joy-subscriptions.md']);
  const scope = detectApp({ appName: 'JOY Loyalty', reference: 'JOY-1' }, root).scope;
  assert.equal(scope.locked, true); assert.ok(scope.kbRoots.includes('knowledge-base/app-guides/joy-devzone.md')); assert.ok(!scope.kbRoots.some(path => path.includes('joy-sub')));
});

test('browserAllowedFor: a Customize request with a store always switches the browser on (13/10/2026)', () => {
  assert.equal(browserAllowedFor({ subject: '[Customize] Air Reviews - Customize review box ở product page', description: '1/ Xóa reviews và star', storeDomains: ['a.myshopify.com'] }), true);
  assert.equal(browserAllowedFor({ subject: '[Customize] Air Reviews - ẩn số review', description: '', storeDomains: [] }), false, 'no store, no browser');
});
