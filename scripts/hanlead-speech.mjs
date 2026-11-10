// Read-aloud for the chat bot (extension + TS Management web): turns a Hanlead report or a chat answer into
// spoken Vietnamese text, cuts it into short segments and synthesizes each one with the offline Piper voice
// the user approved. Nothing here calls an AI or an online service; audio is cached under runtime/speech-cache/.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_DIR = process.env.HANLEAD_REPORT_DIR || join(ROOT, 'runtime', 'hanlead-reports');
const CACHE_DIR = process.env.HANLEAD_SPEECH_CACHE_DIR || join(ROOT, 'runtime', 'speech-cache');
const PIPER_HOME = process.env.PIPER_HOME || join(homedir(), '.local', 'share', 'piper');
const PIPER_BIN = join(PIPER_HOME, 'piper', 'piper');
const PIPER_VOICE = process.env.PIPER_VOICE || join(PIPER_HOME, 'voices', 'vi_VN-vais1000-medium.onnx');
// Same settings as scripts/hanlead-report.mjs `say`, the voice the user already heard.
const PIPER_ARGS = ['--sentence_silence', '0.45', '--length_scale', '1.05'];
export const MAX_TEXT = 12_000;
const MAX_SEGMENT = 420;
const MAX_SEGMENTS = 80;
const ID_RE = /^[a-f0-9]{16}$/;

export const piperAvailable = () => existsSync(PIPER_BIN) && existsSync(PIPER_VOICE);

// Names and English words the Vietnamese voice mangles, written the way they should sound.
const SPOKEN = [
  [/\bHachimi\b/gi, 'Ha chi mi'], [/\bHanlead\b/gi, 'Han lít'], [/\bHanlite\b/gi, 'Han lai'], [/\bHancal\b/gi, 'Han can'], [/\bHanbui\b/gi, 'Han bui'],
  [/\bAndrew\b/gi, 'An đờ riu'], [/\bHelpdesk\b/gi, 'Help desk'], [/\bTS Elite 2\b/gi, 'Ti ét Ê lít hai'], [/\bTS Elite\b/gi, 'Ti ét Ê lít'], [/\bElite\b/gi, 'Ê lít'],
  [/\bTS Management\b/gi, 'Ti ét Me nịt mừn'], [/\bAnalytics\b/gi, 'A na lý tích'], [/\bTelegram\b/gi, 'Tê lê gram'], [/\bPlaywright\b/gi, 'Plây rai'], [/\bPiper\b/g, 'Pai pơ'],
  [/\bChrome extension\b/gi, 'tiện ích Chrome'], [/\bextension\b/gi, 'tiện ích'], [/\bchat ?bot\b/gi, 'chát bót'], [/\bweb local\b/gi, 'web nội bộ'],
  [/\bdev[_ ]fixing\b/gi, 'đép đang sửa'], [/\bdevs?\b/gi, 'đép'], [/\bmerchant\b/gi, 'khách'], [/\bcomments?\b/gi, 'bình luận'], [/\bdrafts?\b/gi, 'bản nháp'],
  [/\bstatus\b/gi, 'trạng thái'], [/\bskill\b/gi, 'kỹ năng'], [/\btimer\b/gi, 'bộ hẹn giờ'], [/\breload\b/gi, 'tải lại'], [/\brestart\b/gi, 'khởi động lại'],
  [/\bcheck\b/gi, 'kiểm tra'], [/\btest\b/gi, 'thử'], [/\bfiles?\b/gi, 'tệp'], [/\bservers?\b/gi, 'máy chủ'], [/\bservices?\b/gi, 'dịch vụ'], [/\bsessions?\b/gi, 'phiên'],
  [/\bpreview\b/gi, 'xem trước'], [/\bfeedback\b/gi, 'góp ý'], [/\breactions?\b/gi, 'biểu cảm'], [/\bworkflow\b/gi, 'quy trình'], [/\bdatabase\b/gi, 'cơ sở dữ liệu'],
  [/\bDone\b/g, 'hoàn tất'], [/\bOK\b/gi, 'ô kê'], [/\bURL\b/g, 'đường dẫn'], [/\bAPI\b/g, 'A pi ai'], [/\bAI\b/g, 'ây ai'], [/\bLAN\b/g, 'mạng nội bộ'],
];

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;

// Markdown/chat text → sentences a Vietnamese voice can read: no markup, tables, code, links, paths or symbols.
export function toSpeech(input) {
  let text = String(input || '').replace(/\r/g, '');
  text = text.replace(/```[\s\S]*?```/g, '\nCó một đoạn mã, không đọc.\n');
  text = text.split('\n').filter(line => !/^\s*\|?\s*:?-{3,}/.test(line)).map(line => {
    if (/^\s*\|.*\|\s*$/.test(line)) return line.replace(/^\s*\||\|\s*$/g, '').split('|').map(cell => cell.trim()).filter(Boolean).join(', ') + '.';
    return line;
  }).join('\n');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/https?:\/\/\S+/g, 'một đường dẫn');
  // Inline code: keep short plain words, replace paths, commands and identifiers.
  text = text.replace(/`([^`]*)`/g, (_, code) => (/[\/\\=<>{}()$]|\.\w{2,5}\b|--|_/.test(code) || code.length > 40) ? 'một mục kỹ thuật' : code);
  text = text.replace(/(?:[\w.-]+\/)+[\w.-]+\.\w{2,5}\b/g, 'một tệp').replace(/\b[\w-]+\.(?:mjs|js|json|md|sql|css|html|sh|py|txt|wav|png)\b/g, 'một tệp');
  // Ticket codes such as AIR-261002-QSGTPD: only the app prefix can be said.
  text = text.replace(/(?:\bticket\s+)?\b([A-Z]{2,10})-\d{6}-[A-Za-z0-9]{4,12}\b/gi, (_, app) => `ticket ${app.toUpperCase()}`);
  text = text.replace(/^\s{0,3}#{1,6}\s*/gm, '').replace(/^\s*>\s?/gm, '').replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2').replace(/~~([^~]+)~~/g, '$1');
  text = text.replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => m === '00' ? `${Number(h)} giờ` : `${Number(h)} giờ ${Number(m)} phút`).replace(/\b(\d{1,2})h(\d{2})?\b/g, (_, h, m) => m && m !== '00' ? `${Number(h)} giờ ${Number(m)} phút` : `${Number(h)} giờ`);
  text = text.replace(/(?:\bngày\s+)?\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/gi, (_, d, m, y) => `ngày ${Number(d)} tháng ${Number(m)} năm ${y}`).replace(/(?:\bngày\s+)?\b(\d{1,2})\/(\d{1,2})\b/gi, (_, d, m) => `ngày ${Number(d)} tháng ${Number(m)}`);
  text = text.replace(/(\d)\s*%/g, '$1 phần trăm').replace(/~\s*(\d)/g, 'khoảng $1').replace(/≤/g, ' không quá ').replace(/≥/g, ' ít nhất ').replace(/→|=>|->/g, ', ').replace(/&/g, ' và ');
  for (const [pattern, spoken] of SPOKEN) text = text.replace(pattern, spoken);
  text = text.replace(EMOJI, ' ').replace(/[`*_#|<>[\]{}\\^~]/g, ' ').replace(/["“”]/g, '').replace(/\s*[—–]\s*/g, ', ').replace(/\s*·\s*/g, ', ').replace(/\(\s*\)/g, ' ');
  // Every line ends as a sentence so the voice pauses between bullets.
  text = text.split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).map(line => /[.!?:;,]$/.test(line) ? line.replace(/[:;,]$/, '.') : `${line}.`).join('\n');
  return text.replace(/ +([.,!?])/g, '$1').replace(/([.,])\1+/g, '$1').trim();
}

// Segments of whole sentences, short enough that the first one starts playing quickly.
export function segmentsOf(speech, max = MAX_SEGMENT) {
  const sentences = String(speech || '').split('\n').flatMap(line => line.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || []).map(part => part.trim()).filter(Boolean);
  const segments = []; let current = '';
  for (let sentence of sentences) {
    while (sentence.length > max) { // one very long sentence: cut at a comma or a space
      const cut = Math.max(sentence.lastIndexOf(',', max), sentence.lastIndexOf(' ', max));
      const head = sentence.slice(0, cut > 40 ? cut : max).trim(); sentence = sentence.slice(head.length).replace(/^[,\s]+/, '');
      if (current) { segments.push(current); current = ''; }
      segments.push(head);
    }
    if (current && current.length + sentence.length + 1 > max) { segments.push(current); current = ''; }
    current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) segments.push(current);
  return segments.slice(0, MAX_SEGMENTS);
}

export async function reportNumbers() {
  let names; try { names = await readdir(REPORT_DIR); } catch { return []; }
  return names.map(name => /^(\d+)\.md$/.exec(name)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
}

// { number, text (markdown as saved), speech (spoken text), at, agent } — speech reuses <n>.speech.txt when Hanlead wrote one.
export async function readReport(value) {
  if (!/^\d{1,6}$/.test(String(value ?? ''))) throw new TypeError('Cần số báo cáo.');
  const number = Number(value);
  let text; try { text = await readFile(join(REPORT_DIR, `${number}.md`), 'utf8'); } catch { throw new RangeError(`Không có báo cáo số ${number}.`); }
  let meta = {}; try { meta = JSON.parse(await readFile(join(REPORT_DIR, `${number}.json`), 'utf8')); } catch { /* optional */ }
  let speech = ''; try { speech = (await readFile(join(REPORT_DIR, `${number}.speech.txt`), 'utf8')).trim(); } catch { /* not read aloud before */ }
  if (!speech) speech = `Báo cáo số ${number}.\n${toSpeech(text)}\nHết báo cáo.`;
  return { number, text: text.trim(), speech, at: meta.at || '', agent: meta.agent || 'Hanlead' };
}

// Registers what is about to be read: { id, segments[], voice }. The id is the hash of the spoken text, so the
// same text reuses its audio.
export async function prepareSpeech({ report, text } = {}) {
  let source; let display = ''; let speech; let number = null;
  if (report !== undefined && report !== null && report !== '') { const data = await readReport(report); source = 'report'; number = data.number; display = data.text; speech = data.speech; }
  else {
    const raw = String(text || '').trim();
    if (!raw) throw new TypeError('Không có nội dung để đọc.');
    if (raw.length > MAX_TEXT) throw new TypeError(`Nội dung dài quá ${MAX_TEXT} ký tự.`);
    source = 'text'; speech = toSpeech(raw);
  }
  const segments = segmentsOf(speech);
  if (!segments.length) throw new TypeError('Không có nội dung để đọc.');
  const id = createHash('sha256').update(segments.join('\n')).digest('hex').slice(0, 16);
  const dir = join(CACHE_DIR, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'segments.json'), JSON.stringify({ id, source, number, segments, at: new Date().toISOString() }));
  return { id, source, number, display, segments, voice: piperAvailable() ? 'piper' : 'browser' };
}

let queue = Promise.resolve();
function runPiper(text, output) {
  return new Promise((done, fail) => {
    const child = spawn(PIPER_BIN, ['--model', PIPER_VOICE, '--output_file', output, ...PIPER_ARGS], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { if (stderr.length < 4000) stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', error => { clearTimeout(timer); fail(new Error(`Không chạy được Piper (${error.code || 'spawn'}).`)); });
    child.on('close', code => { clearTimeout(timer); if (code === 0) done(); else fail(new Error(`Piper lỗi: ${stderr.trim().split('\n').at(-1) || `mã ${code}`}`)); });
    child.stdin.on('error', () => {}); child.stdin.end(`${text}\n`);
  });
}

// WAV of one segment (path), synthesized on first use; one Piper process at a time.
export async function segmentAudio(id, index) {
  if (!ID_RE.test(String(id))) throw new TypeError('Mã đọc không hợp lệ.');
  const dir = join(CACHE_DIR, id);
  let data; try { data = JSON.parse(await readFile(join(dir, 'segments.json'), 'utf8')); } catch { throw new RangeError('Không tìm thấy nội dung đọc; gọi lại lệnh đọc.'); }
  const position = Number(index);
  if (!Number.isInteger(position) || position < 0 || position >= data.segments.length) throw new RangeError('Không có đoạn này.');
  const file = join(dir, `${position}.wav`);
  if (existsSync(file)) return file;
  if (!piperAvailable()) throw new Error('Piper hoặc giọng đọc chưa được cài trên máy này.');
  const job = queue.then(async () => {
    if (existsSync(file)) return file;
    const temporary = join(dir, `${position}.${process.pid}.tmp.wav`);
    await runPiper(data.segments[position], temporary);
    if ((await stat(temporary)).size < 1000) throw new Error('Piper tạo file tiếng rỗng.');
    await rename(temporary, file);
    return file;
  });
  queue = job.catch(() => {});
  return job;
}

// Seconds of audio in a PCM WAV file (for checks and tests).
export async function wavSeconds(file) {
  const buffer = await readFile(file);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file.');
  const byteRate = buffer.readUInt32LE(28);
  return byteRate ? (buffer.length - 44) / byteRate : 0;
}
