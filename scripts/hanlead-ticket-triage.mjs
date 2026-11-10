#!/usr/bin/env node
// Hanlead's read-only triage for a manual "check ticket <URL>" order: reads the
// ticket from Helpdesk and says which agent takes it. A ticket is "dev" when
// its tsStatus is dev_fixing and a Slack thread link is stored on the ticket;
// every other ticket is "normal". Nothing is written anywhere.
//
// Run: node scripts/hanlead-ticket-triage.mjs <ticket URL or reference> [--json]
import { readEvidence } from '../skills/check-ticket/scripts/adapters.mjs';
import { ticketReference } from '../skills/check-ticket/scripts/core.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const target = args.find(a => !a.startsWith('--'));
if (!target) { console.error('Usage: node scripts/hanlead-ticket-triage.mjs <ticket URL or reference> [--json]'); process.exit(2); }

const { reference } = ticketReference(target);
const t = await readEvidence(reference);
const slackLink = String(t.slackLink || '').trim();
const devFixing = t.tsStatus === 'dev_fixing';
const kind = devFixing && slackLink ? 'dev' : 'normal';
const notes = [];
if (devFixing && !slackLink) notes.push('tsStatus là dev_fixing nhưng ticket chưa gắn Slack thread: coi là ticket thường, nêu rõ thiếu link khi giao.');
if (!devFixing && slackLink) notes.push(`Ticket có Slack thread nhưng tsStatus là ${t.tsStatus || '(trống)'}: coi là ticket thường.`);
const out = {
  reference, id: t.id, subject: t.subject, appName: t.appName, ticketStatus: t.ticketStatus, tsStatus: t.tsStatus || '',
  slackLink, kind, assignTo: kind === 'dev' ? ['Hachimi'] : ['Hanlite', 'Hancal'],
  comments: t.comments.length, lastCommentAt: t.comments.at(-1)?.createdAt || '', notes,
};
if (json) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
console.log(`${reference} | ${t.subject}`);
console.log(`app: ${t.appName || '-'} | status: ${t.ticketStatus || '-'} | tsStatus: ${t.tsStatus || '-'} | comments: ${t.comments.length}`);
console.log(`slack: ${slackLink || '(không có)'}`);
console.log(`=> loại: ${kind === 'dev' ? 'ticket báo dev' : 'ticket thường'} -> giao: ${out.assignTo.join(' + ')}`);
for (const n of notes) console.log(`lưu ý: ${n}`);
