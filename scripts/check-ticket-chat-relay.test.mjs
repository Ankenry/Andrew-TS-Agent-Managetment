import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatTraceRelay, tracePrompt } from './check-ticket-chat-relay.mjs';
import { readTrace } from './read-check-ticket-trace.mjs';

const baseline = '2026-09-23T07:40:00.000Z';
const at = '2026-09-23T07:41:00.000Z';
async function fixture(enqueue) {
  const dir = await mkdtemp(join(tmpdir(), 'chat-relay-')); const receipts = [];
  const config = { enabled: true, threadId: '11111111-1111-1111-1111-111111111111', activatedAt: baseline };
  const options = { config, statePath: join(dir, 'relay.json'), widgetPath: join(dir, 'widget.jsonl'), automaticPath: join(dir, 'auto.json'),
    now: () => at, enqueue: enqueue || (async (_, trace) => { receipts.push(`${trace.source}:${trace.id}`); return 'receipt'; }) };
  await writeFile(options.automaticPath, JSON.stringify({ jobs: {} }));
  return { options, receipts, relay: new ChatTraceRelay(options),
    widget: async events => appendFile(options.widgetPath, events.map(event => JSON.stringify({ at, ...event })).join('\n') + '\n') };
}

test('no history replay, one queue per new widget run across restarts, full result kept', async () => {
  const f = await fixture();
  await f.widget([{ id: 'old', kind: 'start', at: '2026-09-22', text: 'old' }, { id: 'new', kind: 'start', text: 'ticket' }, { id: 'new', kind: 'phase', text: 'reading' }]);
  await f.relay.tick(); await f.relay.tick();
  assert.deepEqual(f.receipts, ['widget:new']);
  const result = 'Nội dung\n'.repeat(5000);
  await f.widget([{ id: 'new', kind: 'text', text: result }, { id: 'new', kind: 'done', text: 'Widget xong' }]);
  const restarted = new ChatTraceRelay(f.options); await restarted.tick();
  assert.deepEqual(f.receipts, ['widget:new']);
  const read = await readTrace({ source: 'widget', id: 'new', after: 2, waitSeconds: 0, path: f.options.statePath });
  assert.equal(read.terminal, true); assert.equal(read.events[0].text, result);
  const next = await readTrace({ source: 'widget', id: 'new', after: read.nextCursor, waitSeconds: 0, path: f.options.statePath });
  assert.equal(next.events.length, 0);
});

test('partial UTF-8 event survives relay restart without dropping the start', async () => {
  const f = await fixture();
  const bytes = Buffer.from(JSON.stringify({ at, id: 'split', kind: 'start', text: '😀' }) + '\n');
  const split = bytes.indexOf(Buffer.from('😀')) + 1;
  await writeFile(f.options.widgetPath, bytes.subarray(0, split)); await f.relay.tick();
  assert.equal(f.receipts.length, 0);
  await appendFile(f.options.widgetPath, bytes.subarray(split));
  await new ChatTraceRelay(f.options).tick();
  assert.deepEqual(f.receipts, ['widget:split']);
});

test('unknown queue outcome and interrupted enqueue are not blindly retried', async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; throw new Error('timeout'); });
  await f.widget([{ id: 'failed', kind: 'start', text: 'ticket' }]);
  await f.relay.tick(); await new ChatTraceRelay(f.options).tick();
  assert.equal(calls, 1); assert.equal(f.relay.state.traces['widget:failed'].dispatch.status, 'uncertain');
  f.relay.state.traces['widget:failed'].dispatch.status = 'sending'; await f.relay.save();
  const restarted = new ChatTraceRelay(f.options); await restarted.tick();
  assert.equal(calls, 1); assert.equal(restarted.state.traces['widget:failed'].dispatch.status, 'uncertain');
});

test('automatic jobs are observed without modifying state or posting and do not replay old jobs', async () => {
  const f = await fixture();
  const automatic = { jobs: { old: { id: 'old', createdAt: '2026-09-22', status: 'done' }, fresh: { id: 'fresh', createdAt: at, reference: 'TEST-1', status: 'running', phase: 'elite' } } };
  await writeFile(f.options.automaticPath, JSON.stringify(automatic)); await f.relay.tick();
  assert.deepEqual(f.receipts, ['automatic:fresh']);
  automatic.jobs.fresh = { ...automatic.jobs.fresh, status: 'done', comment: 'FINAL REPORT', commentId: 'comment', telegram: { completed: { status: 'sent' } } };
  const before = JSON.stringify(automatic); await writeFile(f.options.automaticPath, before); await f.relay.tick();
  assert.equal(await readFile(f.options.automaticPath, 'utf8'), before);
  const read = await readTrace({ source: 'automatic', id: 'fresh', waitSeconds: 0, path: f.options.statePath });
  assert.equal(read.terminal, true); assert(read.events.some(event => event.text === 'FINAL REPORT'));
  assert.equal(f.receipts.length, 1);
});

test('trace prompt carries only validated identity and disallows running another review', () => {
  assert.throws(() => tracePrompt('widget', 'bad;exec'));
  const prompt = tracePrompt('widget', 'good');
  assert(prompt.includes('KHÔNG phải yêu cầu chạy check ticket lần nữa'));
  assert(prompt.includes('--after 0 --wait 25'));
});
