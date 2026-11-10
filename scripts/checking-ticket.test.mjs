import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const sandbox = vm.createContext({});
vm.runInContext(await readFile(new URL('../chrome-extension/checking-ticket.js', import.meta.url), 'utf8'), sandbox);
const Checking = sandbox.CheckingTicket;
const plain = value => JSON.parse(JSON.stringify(value));

const row = (extra = {}) => ({ id:7, source:'automatic', external_id:'jobA', ticket_reference:'TEST-260930-aaaaaa', subject:'Widget lỗi', category:'Bug',
  status:'done', terminal:true, started_at:'2026-09-30T03:00:00.000Z', event_count:3, last_text:'Xong', ...extra });

test('an automatic run continues its History conversation and keeps the internal ticket id', () => {
  const view = plain(Checking.session(row()));
  assert.equal(view.chatId, 'auto-jobA');
  assert.deepEqual(view.selectedTicket, { id:'jobA', ticketId:'TEST-260930-aaaaaa', subject:'Widget lỗi' });
  assert.equal(view.status, 'done');
});

test('a manual run gets its own safe conversation id and no internal ticket id', () => {
  const view = plain(Checking.session(row({ source:'manual', external_id:'manual-TEST.1:2' })));
  assert.match(view.chatId, /^[A-Za-z0-9_-]{1,100}$/);
  assert.deepEqual(view.selectedTicket, { ticketId:'TEST-260930-aaaaaa', subject:'Widget lỗi' });
});

test('status: open runs are running, needs_attention is failed', () => {
  assert.equal(Checking.session(row({ terminal:false, status:null })).status, 'running');
  assert.equal(Checking.session(row({ status:'needs_attention' })).status, 'failed');
  assert.equal(Checking.session(row({ status:'uncertain' })).status, 'uncertain');
});

test('sessions: only check runs, running first, then newest', () => {
  const list = Checking.sessions([
    row({ id:1, started_at:'2026-09-30T01:00:00.000Z' }), row({ id:2, source:'widget' }), row({ id:3, source:'dev-follow' }),
    row({ id:4, started_at:'2026-09-30T02:00:00.000Z' }), row({ id:5, terminal:false, started_at:'2026-09-29T00:00:00.000Z' }),
  ]);
  assert.deepEqual(plain(list.map(item => item.id)), [5, 4, 1]);
});

test('reader: asks the tracing web for each source and returns steps after the cursor', async () => {
  const asked = [];
  const reader = Checking.reader(async path => {
    asked.push(path);
    if (path.startsWith('/api/sessions?')) return { sessions: path.includes('source=automatic') ? [row()] : [] };
    return [{ seq:4, kind:'tool', text:'x'.repeat(7000), phase:'elite', at:'2026-09-30T03:00:01.000Z' }];
  });
  const result = await reader.events('7', '3');
  assert.ok(asked.includes('/api/sessions/7/events?after=3'));
  assert.equal(result.session.id, 7);
  assert.equal(result.events[0].label, 'Công cụ');
  assert.ok(result.events[0].text.length < 6100);
  await assert.rejects(reader.events('7/../x'), /Invalid check session/);
});
