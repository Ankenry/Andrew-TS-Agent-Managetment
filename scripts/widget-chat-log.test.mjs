import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, appendFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendWidgetEvents, WidgetLogTail } from './widget-chat-log.mjs';

const loggerSource = await readFile(new URL('../chrome-extension/widget-terminal-log.js', import.meta.url), 'utf8');
const background = await readFile(new URL('../chrome-extension/background.js', import.meta.url), 'utf8');
function harness({ failed = false } = {}) {
  const events = []; const timers = new Map(); let timerId = 0;
  const context = vm.createContext({ crypto: { randomUUID }, console, setTimeout, clearTimeout,
    setInterval(fn) { timers.set(++timerId, fn); return timerId; }, clearInterval(id) { timers.delete(id); },
    chrome: { runtime: { sendNativeMessage(host, payload, callback) {
      assert.equal(host, 'com.avada.andrew_telegram');
      assert.equal(payload.action, 'widget-chat-log');
      events.push(...payload.events); callback({ ok: !failed });
    } } },
  });
  vm.runInContext(loggerSource, context);
  return { context, events, timers, trace: new context.WidgetTerminalTrace('TEST-ONLY') };
}

test('widget trace streams full Unicode response, emits one Done and stops waiting', async () => {
  const { trace, events, timers } = harness();
  trace.phase('Đang kiểm tra');
  const answer = '😀 Nội dung đầy đủ\n'.repeat(1800);
  trace.event({ type: 'text', content: answer });
  trace.event({ type: 'done' });
  trace.finish('cancelled', 'late disconnect');
  await trace.flush();
  assert.equal(events.filter(e => e.kind === 'text').map(e => e.text).join(''), answer);
  assert.equal(events.filter(e => e.kind === 'done').length, 1);
  assert(!events.some(e => e.kind === 'cancelled'));
  assert(events.every(e => e.text.length <= 12000));
  assert.equal(timers.size, 0);
});

test('logger failure leaves caller working; error is terminal and never Done', async () => {
  const { trace, events } = harness({ failed: true });
  trace.event({ type: 'error', message: 'rate limit' });
  await trace.flush();
  assert(events.some(e => e.kind === 'error'));
  assert(!events.some(e => e.kind === 'done'));
});

test('native log whitelists fields, tails append, preserves UTF-8 and follows truncation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'widget-chat-log-'));
  const path = join(dir, 'events.jsonl'); const tail = new WidgetLogTail(path); const events = [];
  await tail.poll(e => events.push(e));
  await appendWidgetEvents([{ id: 'test', kind: 'phase', text: 'Đang kiểm tra', token: 'MUST-NOT-LOG' }], path);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert(!(await readFile(path, 'utf8')).includes('MUST-NOT-LOG'));
  await tail.poll(e => events.push(e)); await tail.poll(e => events.push(e));
  assert.equal(events.length, 1);
  const row = Buffer.from(JSON.stringify({ id: 'test', kind: 'text', text: '😀' }) + '\n');
  const split = row.indexOf(Buffer.from('😀')) + 1;
  await appendFile(path, row.subarray(0, split)); await tail.poll(e => events.push(e));
  assert.equal(events.length, 1);
  await appendFile(path, row.subarray(split)); await tail.poll(e => events.push(e));
  assert.equal(events[1].text, '😀');
  await writeFile(path, ''); await tail.poll(e => events.push(e));
  await appendWidgetEvents([{ id: 'test', kind: 'done', text: 'finished fixture' }], path);
  await tail.poll(e => events.push(e)); assert.equal(events[2].kind, 'done');
  await assert.rejects(appendWidgetEvents([{ id: '../bad', kind: 'text', text: 'bad' }], path));
});

async function runStream(frames, { disconnect = false } = {}) {
  const { context, trace, events } = harness();
  let connect; let onDisconnect;
  let complete;
  const finished = new Promise(resolve => { complete = resolve; });
  const sent = [];
  Object.assign(context, {
    widgetTerminalStreams: new Map([['fixture', { trace }]]), AbortController, TextDecoder,
    AI_BASE_URL: 'https://fixture.invalid', getAiAuthToken: async () => 'test-token',
    fetch: async () => ({ ok: true, body: new ReadableStream({ start(controller) {
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    } }) }),
  });
  context.chrome.runtime.onConnect = { addListener(fn) { connect = fn; } };
  const start = background.indexOf('chrome.runtime.onConnect.addListener((port) => {');
  vm.runInContext(background.slice(start, background.indexOf('\nchrome.action.onClicked', start)), context);
  connect({ name: 'ai-stream:fixture', onDisconnect: { addListener(fn) { onDisconnect = fn; } },
    postMessage(event) {
      sent.push(event);
      if (event.type === 'done' || event.type === 'error') { onDisconnect(); complete(); }
      if (event.type === 'stream_end') complete();
    },
  });
  if (disconnect) { onDisconnect(); complete(); }
  await finished;
  await new Promise(resolve => setImmediate(resolve));
  await trace.flush();
  return { events, sent };
}

test('real stream handler handles CRLF split frames and final unterminated Done', async () => {
  const { events, sent } = await runStream(['data: {"type":"text","content":"Xin chào"}\r', '\n\r\n', 'data: {"type":"done"}']);
  assert.equal(events.filter(e => e.kind === 'text').map(e => e.text).join(''), 'Xin chào');
  assert.equal(events.filter(e => e.kind === 'done').length, 1);
  assert(!events.some(e => e.kind === 'cancelled'));
  assert(sent.some(e => e.type === 'done'));
});

test('missing Done and widget disconnect do not announce success', async () => {
  const incomplete = await runStream(['data: {"type":"text","content":"partial"}\n\n']);
  assert(incomplete.events.some(e => e.kind === 'error'));
  assert(!incomplete.events.some(e => e.kind === 'done'));
  const cancelled = await runStream([], { disconnect: true });
  assert(cancelled.events.some(e => e.kind === 'cancelled'));
  assert(!cancelled.events.some(e => e.kind === 'done'));
});

test('conversation chatId travels with widget trace events and is whitelisted by the native log', async () => {
  const { context, events } = harness();
  const trace = new context.WidgetTerminalTrace('TEST-ONLY', 'conv-123');
  trace.phase('Đang kiểm tra'); trace.finish('done', 'ok');
  await trace.flush();
  assert(events.length >= 2);
  assert(events.every(e => e.chatId === 'conv-123'));
  assert.equal(new context.WidgetTerminalTrace('TEST-ONLY', '../bad').chatId, '');
  const dir = await mkdtemp(join(tmpdir(), 'widget-chat-log-'));
  const path = join(dir, 'events.jsonl');
  await appendWidgetEvents([{ id: 'test', kind: 'phase', text: 'a', chatId: 'conv-123' }, { id: 'test', kind: 'phase', text: 'b', chatId: '../bad' }, { id: 'test', kind: 'phase', text: 'c' }], path);
  const rows = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.chatId), ['conv-123', undefined, undefined]);
});
