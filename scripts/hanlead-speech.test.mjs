// node --test scripts/hanlead-speech.test.mjs — spoken-text cleaning, segmenting, report lookup and the "đọc" command parser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const reports = mkdtempSync(join(tmpdir(), 'hanlead-reports-'));
const cache = mkdtempSync(join(tmpdir(), 'speech-cache-'));
process.env.HANLEAD_REPORT_DIR = reports;
process.env.HANLEAD_SPEECH_CACHE_DIR = cache;
writeFileSync(join(reports, '7.md'), 'Báo cáo Đại tá, **Hachimi** đã check ticket `AIR-261002-QSGTPD`.\n\n- Lịch chạy: 10h, 14:30.\n- File `scripts/run.mjs` đã sửa.\n');
writeFileSync(join(reports, '7.json'), JSON.stringify({ number: 7, at: '2026-10-04T10:00:00.000Z', agent: 'Hanlead' }));
writeFileSync(join(reports, '8.md'), 'Nội dung gốc.\n');
writeFileSync(join(reports, '8.speech.txt'), 'Báo cáo số tám.\nVăn nói đã viết sẵn.\n');

const { toSpeech, segmentsOf, readReport, prepareSpeech, segmentAudio, reportNumbers, piperAvailable, wavSeconds, MAX_TEXT } = await import('./hanlead-speech.mjs');
await import('../chrome-extension/speech-player.js');
const { parseCommand } = globalThis.SpeechPlayer;

test('markdown, code, links, tables and symbols are turned into plain spoken sentences', () => {
  const speech = toSpeech('## Kết quả\n\n- **Hachimi** đã check `dev_fixing` lúc 14:30, đạt 80%.\n- Xem [tài liệu](https://example.com/a) và `scripts/run.mjs`.\n\n| Cột | Giá trị |\n|---|---|\n| A | 1 |\n\n```js\nconst x = 1;\n```\n👍 Xong → báo Hanlead');
  assert.doesNotMatch(speech, /[*`#|\[\]]|https?:|→|👍/u);
  assert.match(speech, /Ha chi mi đã kiểm tra/);
  assert.match(speech, /14 giờ 30 phút/);
  assert.match(speech, /80 phần trăm/);
  assert.match(speech, /Xem tài liệu và một (tệp|mục kỹ thuật)\./);
  assert.match(speech, /Cột, Giá trị\./);
  assert.match(speech, /Có một đoạn mã, không đọc\./);
  assert.match(speech, /Han lít\.$/);
  for (const line of speech.split('\n')) assert.match(line, /[.!?]$/, `line ends as a sentence: ${line}`);
});

test('ticket codes, hours and dates are spoken forms', () => {
  assert.equal(toSpeech('Ticket AIR-261002-QSGTPD chạy lúc 10h và 18:00 ngày 03/10/2026'), 'ticket AIR chạy lúc 10 giờ và 18 giờ ngày 3 tháng 10 năm 2026.');
  assert.equal(toSpeech('Hạn 5/10, mã JOY-260922-S8jDqE'), 'Hạn ngày 5 tháng 10, mã ticket JOY.');
});

test('segments keep whole sentences and stay under the limit', () => {
  const speech = Array.from({ length: 30 }, (_, i) => `Đây là câu số ${i + 1} của một báo cáo khá dài để thử cắt đoạn.`).join('\n');
  const segments = segmentsOf(speech, 200);
  assert.ok(segments.length > 3);
  for (const segment of segments) { assert.ok(segment.length <= 200, `segment length ${segment.length}`); assert.match(segment, /\.$/); }
  assert.equal(segments.join(' '), speech.replace(/\n/g, ' '));
  const long = segmentsOf(`${'từ '.repeat(300)}.`, 200);
  assert.ok(long.every(segment => segment.length <= 200));
});

test('a report is read from its saved spoken text when there is one, else from the cleaned markdown', async () => {
  assert.deepEqual(await reportNumbers(), [7, 8]);
  const cleaned = await readReport(7);
  assert.match(cleaned.speech, /^Báo cáo số 7\./);
  assert.match(cleaned.speech, /Ha chi mi đã kiểm tra ticket AIR\./);
  assert.match(cleaned.speech, /Hết báo cáo\.$/);
  assert.equal((await readReport('8')).speech, 'Báo cáo số tám.\nVăn nói đã viết sẵn.');
  await assert.rejects(readReport(99), RangeError);
  await assert.rejects(readReport('../7'), TypeError);
});

test('prepareSpeech returns stable ids, the report text to display, and rejects empty or oversized text', async () => {
  const first = await prepareSpeech({ report: 8 });
  const again = await prepareSpeech({ report: '8' });
  assert.equal(first.id, again.id);
  assert.match(first.id, /^[a-f0-9]{16}$/);
  assert.equal(first.source, 'report'); assert.equal(first.number, 8); assert.equal(first.display, 'Nội dung gốc.');
  const text = await prepareSpeech({ text: '**Xin chào** Đại tá' });
  assert.equal(text.source, 'text'); assert.deepEqual(text.segments, ['Xin chào Đại tá.']);
  await assert.rejects(prepareSpeech({ text: '   ' }), TypeError);
  await assert.rejects(prepareSpeech({ text: 'a'.repeat(MAX_TEXT + 1) }), TypeError);
  await assert.rejects(segmentAudio('../../etc', 0), TypeError);
  await assert.rejects(segmentAudio(first.id, 99), RangeError);
  await assert.rejects(segmentAudio('0123456789abcdef', 0), RangeError);
});

test('Piper synthesizes a segment to a WAV of plausible length (skipped when Piper is not installed)', { skip: !piperAvailable() }, async () => {
  const prepared = await prepareSpeech({ text: 'Báo cáo Đại tá, tính năng đọc thành tiếng đã sẵn sàng.' });
  const file = await segmentAudio(prepared.id, 0);
  const seconds = await wavSeconds(file);
  assert.ok(seconds > 1.5 && seconds < 15, `audio length ${seconds}s`);
  assert.equal(await segmentAudio(prepared.id, 0), file, 'cached on the second call');
});

test('only the read/stop commands are taken from the chat input', () => {
  assert.deepEqual(parseCommand('đọc'), { type: 'last' });
  assert.deepEqual(parseCommand(' Đọc 49. '), { type: 'report', number: 49 });
  assert.deepEqual(parseCommand('đọc báo cáo số 112'), { type: 'report', number: 112 });
  assert.deepEqual(parseCommand('doc 5'), { type: 'report', number: 5 });
  assert.deepEqual(parseCommand('dừng'), { type: 'stop' });
  assert.deepEqual(parseCommand('Dừng đọc!'), { type: 'stop' });
  assert.equal(parseCommand('đọc ticket AIR-261002-QSGTPD giúp tôi'), null);
  assert.equal(parseCommand('Check ticket 49'), null);
  assert.equal(parseCommand('đọc 49 và tóm tắt'), null);
});
