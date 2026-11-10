import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEV_PROFILE, statusLabels, resultSchema, RESULT_SCHEMA, normalizeAssessment, decideDraft, decideProgress, formatProgressComment, formatDraftComment,
  latestDraft, lastProgressComment, summaryText, currentSlot,
} from '../skills/dev-fix-follow/scripts/core.mjs';
import { executeRun } from '../skills/dev-fix-follow/scripts/service.mjs';
import { settings, listFollowTickets, statePath, runtimeDir } from '../skills/dev-fix-follow/scripts/adapters.mjs';
import { parseArgs, jsonReport, ticketReference } from '../skills/dev-fix-follow/scripts/cli.mjs';
import { FEATURE_PROFILE } from '../skills/feature-follow/scripts/profile.mjs';

const TZ = 'Asia/Ho_Chi_Minh';
const SLOTS = ['10:00', '14:00', '18:00', '22:00'];
const CONFIG = { slots: SLOTS, timeZone: TZ, commentPolicy: 'on-change-or-daily', concurrency: 2, runTimeoutMs: 60_000, telegramSummary: true };
const at = local => new Date(`${local}:00+07:00`);
const P = FEATURE_PROFILE;

const assessment = (extra = {}) => ({ status: 'acknowledged', progress: 'PM đã nhận yêu cầu và đưa vào backlog.', latestUpdate: 'PM báo sẽ xếp vào sprint sau.', latestMeaningfulAt: '', waitingFor: 'PM',
  customerRequests: [], draftKind: 'none', draftMail: '', confidence: 'high', evidence: '10:00 PM: đưa vào backlog', ...extra });
const message = (ts, text, reactions = []) => ({ ts, at: new Date(Number.parseFloat(ts) * 1000).toISOString(), user: 'U1', text, reactions, assets: [] });

test('the feature profile differs from dev only in status, labels, prefixes and paths', () => {
  assert.equal(P.tsStatus, 'feature_request');
  assert.equal(P.runtimeDir, 'runtime/feature-follow');
  assert.equal(P.skillDir, 'skills/feature-follow');
  assert.equal(P.unit, 'andrew-feature-follow');
  assert.equal(P.progressPrefix, '[FEATURE FOLLOW |');
  assert.deepEqual(Object.keys(P.draftPrefix), ['done', 'customer_info']);
  assert.match(P.draftPrefix.done, /^\[DRAFT — feature đã release$/);
  assert.match(P.draftPrefix.customer_info, /^\[DRAFT — feature chờ khách xác nhận$/);
  for (const key of Object.keys(DEV_PROFILE)) assert.ok(key in P, `feature profile lacks ${key}`);
  // Statuses the dev profile has must exist here too (shared draft rules rely on done / awaiting_customer).
  for (const status of ['done', 'awaiting_customer', 'awaiting_verification', 'awaiting_merge', 'in_progress', 'blocked', 'no_response', 'unknown']) assert.ok(status in P.aiStatuses, status);
  assert.ok('acknowledged' in P.aiStatuses && 'declined' in P.aiStatuses);
  assert.equal(statusLabels(P).missing_thread, 'Thiếu Slack thread');
  assert.equal(statusLabels(P).done, 'Feature đã release');
  assert.deepEqual(resultSchema(P).properties.status.enum, Object.keys(P.aiStatuses));
  assert.deepEqual(RESULT_SCHEMA.properties.status.enum, Object.keys(DEV_PROFILE.aiStatuses));
  assert.equal(runtimeDir(P).endsWith('/runtime/feature-follow'), true);
  assert.equal(statePath(P).endsWith('/runtime/feature-follow/state.json'), true);
});

test('feature statuses validate under the feature profile only; drafts stay limited to done / awaiting_customer', () => {
  const acknowledged = normalizeAssessment(assessment(), P);
  assert.equal(acknowledged.status, 'acknowledged');
  assert.equal(acknowledged.draftKind, 'none');
  assert.throws(() => normalizeAssessment(assessment(), DEV_PROFILE), /invalid dev-fix-follow assessment/);
  const declined = normalizeAssessment(assessment({ status: 'declined', draftKind: 'done', draftMail: 'Hi' }), P);
  assert.deepEqual([declined.draftKind, declined.draftMail, declined.draftWithheld], ['none', '', '']);
  const released = normalizeAssessment(assessment({ status: 'done', draftKind: 'done', draftMail: 'Hi Anna, the feature is live.' }), P);
  assert.equal(released.draftKind, 'done');
  const guess = normalizeAssessment(assessment({ status: 'done', draftKind: 'done', draftMail: 'Hi', confidence: 'low' }), P);
  assert.equal(guess.draftWithheld, 'low_confidence');
});

test('feature comments carry the feature prefixes and are recognised by them', () => {
  const slot = currentSlot(at('2026-10-12T14:00'), SLOTS, TZ);
  const waiting = normalizeAssessment(assessment({ status: 'awaiting_customer', waitingFor: 'khách', customerRequests: ['Ví dụ đơn hàng cần deeplink'], draftKind: 'customer_info', draftMail: 'Hi' }), P);
  const content = formatProgressComment({ slot, status: waiting.status, assessment: waiting, latestSlackAt: '2026-10-12T03:40:29.131Z', changed: true, draft: { kind: 'customer_info', action: 'post' }, timeZone: TZ, profile: P });
  assert.match(content, /^\[FEATURE FOLLOW \| 14:00 12\/10\/2026\] Chờ khách cung cấp thông tin\n\n/);
  assert.match(content, /Dev\/PM cần khách cung cấp:\n- Ví dụ đơn hàng cần deeplink/);
  assert.match(content, /Slack cập nhật gần nhất lúc 10:40 12\/10\/2026/);
  const missing = formatProgressComment({ slot, status: 'missing_thread', assessment: null, latestSlackAt: '', changed: true, draft: null, timeZone: TZ, profile: P });
  assert.match(missing, /^\[FEATURE FOLLOW \| .*\] Thiếu Slack thread\n\nTicket đang ở Feature request nhưng chưa có link Slack thread/);
  assert.throws(() => formatProgressComment({ slot, status: 'acknowledged', assessment: normalizeAssessment(assessment(), P), latestSlackAt: '', changed: true, draft: null, timeZone: TZ }), /Unknown dev-fix-follow status/);
  const draft = formatDraftComment('done', '2026-10-12T03:40:29.131Z', 'Hi Anna,\n\nThe feature is ready.', P, 'Chatty');
  assert.match(draft, /^\[DRAFT — feature đã release .*\n\nI am Andrew from the Chatty technical support team,/);
  assert.match(draft, /Andrew, Chatty Technical Support Team$/);
  const comments = [
    { content: '[DRAFT — dev báo done | Slack update: x]\n\nold dev draft', createdAt: '2026-10-12T04:00:00.000Z' },
    { content: draft, createdAt: '2026-10-12T05:00:00.000Z' },
    { content: '[DEV FOLLOW | 10:00 12/10/2026] Dev báo done\n\nx', createdAt: '2026-10-12T03:00:00.000Z' },
    { content: content, createdAt: '2026-10-12T07:00:00.000Z' },
  ];
  assert.equal(latestDraft(comments, 'done', P).content, draft);
  assert.equal(latestDraft(comments, 'done').content.startsWith('[DRAFT — dev báo done'), true);
  assert.equal(lastProgressComment(comments, P).content, content);
  assert.equal(lastProgressComment(comments).content.startsWith('[DEV FOLLOW'), true);
  // A dev draft in the ticket never counts as a feature draft.
  const released = normalizeAssessment(assessment({ status: 'done', draftKind: 'done', draftMail: 'Hi' }), P);
  assert.equal(decideDraft({ assessment: released, comments: [comments[0]], latestSlackAt: '2026-10-12T03:40:29.131Z', assessed: true, profile: P }).action, 'post');
  assert.equal(decideDraft({ assessment: released, comments: [comments[1]], latestSlackAt: '2026-10-12T03:40:29.131Z', assessed: true, profile: P }).action, 'exists');
  // The daily rule looks at feature progress comments only.
  const base = { policy: 'on-change-or-daily', slot, timeZone: TZ, key: 'k1', postedKey: 'k1', postedSlot: '2026-10-12T10:00', profile: P };
  assert.equal(decideProgress({ ...base, comments: [comments[2]] }).reason, 'daily');
  assert.equal(decideProgress({ ...base, comments: [{ content: '[FEATURE FOLLOW | 10:00 12/10/2026] x\n\ny', createdAt: '2026-10-12T03:00:00.000Z' }] }).reason, 'unchanged_today');
});

function fakeIO({ tickets, threads, answers }) {
  const calls = { assess: [], post: [], notify: [] };
  let state = { version: 1, tickets: {} };
  const comments = {};
  const io = {
    profile: P, calls, comments,
    loadState: async () => structuredClone(state),
    saveState: async next => { state = structuredClone(next); },
    state: () => state,
    listTickets: async () => tickets.map(ticket => ({ id: ticket.id, ticketId: ticket.ticketId, subject: ticket.subject })),
    evidence: async reference => {
      const ticket = tickets.find(item => item.ticketId === reference || item.id === reference);
      if (!ticket) throw new Error('Helpdesk read failed.');
      return { appName: 'Chatty', ...ticket, comments: [...(comments[ticket.id] || [])] };
    },
    slackThread: async link => { if (!threads[link]) throw new Error('Không kết nối được Slack API.'); return threads[link]; },
    assess: async input => { calls.assess.push(input.evidence.ticketId); return answers[input.evidence.ticketId]; },
    post: async (id, content) => { calls.post.push({ id, content }); (comments[id] ||= []).push({ content, createdAt: new Date().toISOString(), author: 'Andrew' }); },
    notify: async run => { calls.notify.push(run); },
  };
  return io;
}
const ticket = (id, ticketId, extra = {}) => ({ id, ticketId, subject: `Subject ${ticketId}`, description: '', tsStatus: 'feature_request', slackLink: `https://x.slack.com/archives/C1/p179000000000${id.length}00`, ...extra });
const thread = (...messages) => ({ link: 'l', rootTs: messages[0].ts, latestAt: messages.at(-1).at, users: {}, messages });

test('run under the feature profile posts feature comments, keeps state in its own shape and summarises as feature request', async () => {
  const released = ticket('a', 'CHAT-1');
  const queued = ticket('bb', 'SEO-2');
  const noThread = ticket('ccc', 'AIR-3', { slackLink: '' });
  const io = fakeIO({
    tickets: [released, queued, noThread],
    threads: { [released.slackLink]: thread(message('1791500000.000100', 'feature đã lên production, store đã bật')), [queued.slackLink]: thread(message('1791500100.000100', 'đưa vào backlog Q4')) },
    answers: {
      'CHAT-1': assessment({ status: 'done', progress: 'Feature đã release và bật cho store.', waitingFor: '', draftKind: 'done', draftMail: 'Hi Anna, the feature is now live on your store.' }),
      'SEO-2': assessment(),
    },
  });
  const preview = await executeRun(io, CONFIG, { mode: 'preview', now: at('2026-10-12T14:05') });
  assert.equal(io.calls.post.length, 0);
  assert.deepEqual(io.state().tickets, {});
  assert.match(preview.results[0].draft.content, /^\[DRAFT — feature đã release/);
  assert.match(preview.results[0].progress.content, /^\[FEATURE FOLLOW \| 14:05 12\/10\/2026\] Feature đã release/);
  assert.equal(preview.results[0].statusLabel, 'Feature đã release');
  assert.equal(preview.results[1].statusLabel, 'Dev/PM đã nhận yêu cầu');
  assert.match(preview.results[2].progress.content, /Thiếu Slack thread\n\nTicket đang ở Feature request/);

  const run = await executeRun(io, CONFIG, { mode: 'scheduled', now: at('2026-10-12T14:00') });
  assert.deepEqual(io.calls.post.map(call => call.content.slice(0, 16)), ['[DRAFT — feature', '[FEATURE FOLLOW ', '[FEATURE FOLLOW ', '[FEATURE FOLLOW ']);
  assert.equal(run.results.every(item => !item.error), true);
  const entry = io.state().tickets.a;
  assert.deepEqual(Object.keys(entry).sort(), ['assessedAt', 'assessedKey', 'assessment', 'draftPending', 'lastSeenAt', 'latestSlackAt', 'postedAt', 'postedKey', 'postedSlot', 'reference'].sort());
  assert.equal(io.state().lastCompletedSlot, '2026-10-12T14:00');
  assert.deepEqual(Object.keys(io.state().lastRun).sort(), ['failed', 'finishedAt', 'mode', 'slot', 'tickets']);
  const summary = summaryText(run, P);
  assert.match(summary, /^✨ Hachimi đã cập nhật tiến độ feature request \(14:00 12\/10\/2026\)/);
  assert.match(summary, /CHAT-1 — Feature đã release · đã lưu mail nháp/);
  assert.match(summary, /SEO-2 — Dev\/PM đã nhận yêu cầu/);
  assert.equal(io.calls.notify.length, 1);

  const report = jsonReport(run, P);
  assert.equal(report.skill, 'feature-follow');
  assert.deepEqual(Object.keys(report.results[0]).sort(), ['assessed', 'draft', 'error', 'id', 'progress', 'reference', 'status', 'statusLabel', 'subject'].sort());
  assert.equal(report.results[0].statusLabel, 'Feature đã release');
  assert.equal(JSON.parse(JSON.stringify(report)).results[0].error, undefined);
});

test('cli flags, ticket references and the feature workflow file', async () => {
  assert.deepEqual(parseArgs(['--preview', '--ticket', 'https://helpdesk.avada.net/t/AIR-261001-24v44K', '--json']), { invalid: false, mode: 'preview', ticket: 'https://helpdesk.avada.net/t/AIR-261001-24v44K', force: false, json: true });
  assert.equal(parseArgs([]).mode, 'preview');
  assert.equal(parseArgs(['--post', '--scheduled']).invalid, true);
  assert.equal(parseArgs(['--ticket']).invalid, true);
  assert.equal(parseArgs(['--bogus']).invalid, true);
  assert.equal(ticketReference('https://helpdesk.avada.net/t/AIR-261001-24v44K'), 'AIR-261001-24v44K');
  assert.throws(() => ticketReference('x'));
  const config = await settings(P);
  assert.equal(config.enabled, false, 'feature-follow ships disabled until the user orders it on');
  assert.deepEqual(config.slots, SLOTS);
  assert.equal(config.commentPolicy, 'on-change-or-daily');
  assert.match(readFileSync(new URL('../skills/feature-follow/SKILL.md', import.meta.url), 'utf8'), /Carry the evidence image/);
});

test('listing asks Helpdesk for the profile status, keeps Andrew\'s open tickets only', async () => {
  const andrew = 'HEYWuzF9rTdG59pE8TNtBKL6W1x1';
  const paths = [];
  const tickets = await listFollowTickets(P, async path => {
    paths.push(path);
    return { hasMore: false, tickets: [
      { id: '1', ticketId: 'CHAT-1', subject: 'a', memberIds: [andrew], ticketStatus: 'open' },
      { id: '2', ticketId: 'CHAT-2', subject: 'b', memberIds: ['other'], ticketStatus: 'open' },
      { id: '3', ticketId: 'CHAT-3', subject: 'c', members: [{ memberId: andrew }], ticketStatus: 'closed' },
      { id: '4', ticketId: 'CHAT-4', subject: 'd', members: [{ memberId: andrew }] },
    ] };
  });
  assert.match(paths[0], /tsStatus=feature_request/);
  assert.deepEqual(tickets.map(ticket => ticket.ticketId), ['CHAT-1', 'CHAT-4']);
});
