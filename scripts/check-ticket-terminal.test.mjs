import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalMonitor, safeText } from './check-ticket-terminal.mjs';

test('prints a confirmed result once, never presents ready/uncertain draft as posted', () => {
  const lines = []; const monitor = new TerminalMonitor(line => lines.push(line));
  const snapshot = status => ({ version: 1, lastScanAt: new Date().toISOString(), jobs: {
    a: { id: 'a', reference: 'TEST-1', status, comment: 'Complete result\n'.repeat(500), commentId: 'comment-a' },
  } });
  monitor.state(snapshot('ready')); monitor.state(snapshot('uncertain'));
  assert(!lines.some(line => line.includes('Complete result')));
  const done = snapshot('done'); monitor.state(done); monitor.state(done);
  assert.equal(lines.filter(line => line.includes('Complete result')).length, 1);
  assert(lines.includes(done.jobs.a.comment));
});

test('startup shows only latest completed report and active jobs, then observes new jobs', () => {
  const lines = []; const monitor = new TerminalMonitor(line => lines.push(line));
  const state = { version: 1, lastScanAt: new Date().toISOString(), jobs: {
    old: { id: 'old', status: 'done', finishedAt: '2026-09-22', comment: 'OLD REPORT' },
    last: { id: 'last', status: 'done', finishedAt: '2026-09-23', comment: 'LATEST REPORT' },
    active: { id: 'active', status: 'running' },
  } };
  monitor.state(state);
  assert(!lines.includes('OLD REPORT')); assert(lines.includes('LATEST REPORT'));
  assert(lines.some(line => line.includes('[active]')));
  monitor.state({ ...state, jobs: { ...state.jobs, incoming: { id: 'incoming', status: 'queued' } } });
  assert(lines.some(line => line.includes('[incoming]')));
});

test('unreachable or disabled service is reported without claiming live operation', () => {
  const lines = []; const monitor = new TerminalMonitor(line => lines.push(line));
  monitor.health(null); monitor.health(null);
  assert.equal(lines.length, 1); assert(lines[0].includes('Không kết nối'));
  monitor.health({ ok: true, ticketReviewWorkflow: { enabled: false, started: false } });
  assert(lines[1].includes('chưa chạy'));
  assert.throws(() => monitor.state({}), /không hợp lệ/);
});

test('ticket text cannot emit terminal commands, preserves report line breaks', () => {
  assert.equal(safeText('\x1b[2Jhello\nworld\x1b]0;evil\x07'), 'hello\nworld');
});
