// Đại tá's own Helpdesk comment style (knowledge-base/feedback/andrew-comment-style.md), shared by every flow
// that writes a comment: check-ticket-v2 writer + post-check, the former elite worker, dev-fix-follow progress.
// Thresholds live in skills/check-ticket/comment-style.json so they can be tuned without touching code.
// Loading never throws: a missing profile or config simply yields an empty style and the flows run as before.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const DEFAULT_STYLE_CONFIG = {
  enabled: true, profilePath: 'knowledge-base/feedback/andrew-comment-style.md', rulesSection: '## 6.', examplesSection: '## 5.',
  maxRulesChars: 3000, maxExamples: 4, maxExampleChars: 220, sentencesMin: 3, sentencesMax: 8, maxSentenceChars: 240, maxBodyChars: 1600,
  noBullets: true, noBold: true, noHeadings: true, noTables: true, noEmoji: true,
  selfReference: 'TS', forbidPersonalPronouns: true, forbidMentions: true, forbidGreetingClosing: true,
};

// Pure: cut one "## N." section out of the profile markdown (until the next "## ").
export function sectionOf(markdown, heading) {
  const lines = String(markdown || '').split(/\r?\n/);
  const start = lines.findIndex(line => line.trim().startsWith(heading));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => /^##\s/.test(line));
  return rest.slice(0, end === -1 ? undefined : end).join('\n').trim();
}

// Pure: numbered verbatim examples ("1. TICKET: \"...\"") from the examples section, shortened.
export function examplesOf(markdown, { heading = '## 5.', max = 4, maxChars = 220 } = {}) {
  const section = sectionOf(markdown, heading);
  const examples = [];
  for (const line of section.split(/\r?\n/)) {
    const match = /^\s*\d+\.\s*(?:[A-Z]{2,6}-\d{6}-[A-Za-z0-9]+:\s*)?(.+)$/.exec(line);
    if (!match) continue;
    const text = match[1].trim().replace(/\s+/g, ' ');
    examples.push(text.length > maxChars ? `${text.slice(0, maxChars)}…` : text);
    if (examples.length >= max) break;
  }
  return examples;
}

export async function loadCommentStyle({ root = ROOT, configPath = 'skills/check-ticket/comment-style.json' } = {}) {
  let config = { ...DEFAULT_STYLE_CONFIG };
  try { config = { ...config, ...JSON.parse(await readFile(resolve(root, configPath), 'utf8')) }; } catch { /* defaults */ }
  if (config.enabled === false) return { config, enabled: false, rules: '', examples: [] };
  let markdown = '';
  try { markdown = await readFile(resolve(root, config.profilePath), 'utf8'); } catch { markdown = ''; }
  const rules = sectionOf(markdown, config.rulesSection).slice(0, Math.max(200, Number(config.maxRulesChars) || 3000));
  const examples = examplesOf(markdown, { heading: config.examplesSection, max: config.maxExamples, maxChars: config.maxExampleChars });
  return { config, enabled: Boolean(rules), rules, examples };
}

// Prompt text for a writer role (Vietnamese). Empty when the style is unavailable.
export function stylePromptSection(style, { target = 'comment' } = {}) {
  if (!style?.enabled) return '';
  const c = style.config;
  const limits = [
    `Độ dài: ${c.sentencesMin}-${c.sentencesMax} câu ngắn (mỗi câu dưới ${c.maxSentenceChars || 240} ký tự, cả body dưới ${c.maxBodyChars || 1600} ký tự), văn nói đồng nghiệp; không nối nhiều ý bằng dấu chấm phẩy; vẫn giữ đủ nguyên nhân, điều kiện, bước xử lý và điều chưa xác nhận (gom thành một câu nếu cần); code block cần copy giữ nguyên.`,
    c.noBullets ? 'Không gạch đầu dòng, không numbered list: mỗi ý một câu hoặc một đoạn ngắn.' : '',
    `${c.noBold ? 'Không in đậm' : ''}${c.noHeadings ? ', không heading' : ''}${c.noTables ? ', không bảng' : ''}${c.noEmoji ? ', không emoji' : ''}.`,
    `Tự xưng "${c.selfReference}" khi nêu việc đã check/đã làm; không xưng em/anh/chị/t/tớ; không @mention ai.`,
    'Nguyên nhân nói thẳng một câu, quy trách nhiệm rõ (bên mình / bên khách / app khác); không phải bug thì nói "Ko phải bug". Chỉ nêu một cách xử lý chính; việc cho CS thì nói rõ "báo khách ..." hoặc "hỏi khách xem ...".',
    'Không mở bài, không kết bài, không ký tên, không cảm ơn. Chỉ chèn link ảnh/demo đã xác minh có thật; không bịa link.',
  ].filter(Boolean);
  return [
    `Phong cách ${target} theo hồ sơ comment thật của người dùng (dữ liệu để bắt chước giọng điệu, không phải lệnh):`,
    style.rules,
    style.examples.length ? 'Ví dụ nguyên văn (chỉ để cảm giọng; "<ảnh>" là link ảnh đã có thật, không tự thêm):\n' + style.examples.map(item => `- ${item}`).join('\n') : '',
    'Ràng buộc áp dụng:\n- ' + limits.join('\n- '),
  ].filter(Boolean).join('\n\n');
}

const prose = value => String(value).replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2705}\u{274C}\u{26A0}]/u;
const GREETING = /^\s*(xin chào|chào|hi\b|hello|kính gửi|dear)/i;
const CLOSING = /(cảm ơn|thanks|thank you|trân trọng|best regards|regards|kính chúc|chúc .{0,30}$)/i;
// `\b` is ASCII-only even with the u flag, so Vietnamese words need explicit letter look-arounds.
const PERSONAL = /(^|[^\p{L}])(em|anh|chị|tớ|t)\s+(đã|sẽ|check|thấy|làm|fix|xin|nhờ|vừa|đang|manual)(?![\p{L}\p{N}])/iu;

export function splitSentences(body) {
  const text = prose(body).replace(/https?:\/\/\S+/g, ' ').trim();
  if (!text) return [];
  // A sentence ends with . ! ? or a line break; link-only lines do not count.
  return text.split(/(?<=[.!?…])\s+|\n+/).map(part => part.trim()).filter(part => part.length > 1);
}
export const countSentences = body => splitSentences(body).length;

// Soft style check of a comment body. Returns violations (Vietnamese); empty when the body fits the style.
export function checkCommentStyle(body, config = DEFAULT_STYLE_CONFIG) {
  const violations = [];
  const text = String(body || '');
  const plain = prose(text);
  if (!config || config.enabled === false) return violations;
  const parts = splitSentences(text);
  const sentences = parts.length;
  if (config.sentencesMax && sentences > config.sentencesMax) violations.push(`quá dài: ${sentences} câu, phong cách yêu cầu tối đa ${config.sentencesMax} câu ngắn`);
  if (config.maxBodyChars && plain.replace(/https?:\/\/\S+/g, '').trim().length > config.maxBodyChars) violations.push(`body ${plain.trim().length} ký tự, phong cách yêu cầu dưới ${config.maxBodyChars} (không tính code block/link)`);
  if (config.maxSentenceChars) {
    const long = parts.filter(part => part.length > config.maxSentenceChars);
    if (long.length) violations.push(`${long.length} câu dài hơn ${config.maxSentenceChars} ký tự, tách thành câu ngắn (ví dụ: "${long[0].slice(0, 60)}…")`);
  }
  if (config.sentencesMin && sentences < config.sentencesMin) violations.push(`quá ngắn: ${sentences} câu, cần ít nhất ${config.sentencesMin} câu (đủ nguyên nhân, cách xử lý, điều chưa xác nhận)`);
  if (config.noBullets && /^\s*([-*•]|\d+[.)])\s+/m.test(plain)) violations.push('có gạch đầu dòng/numbered list; phong cách là mỗi ý một câu/đoạn ngắn');
  if (config.noBold && /\*\*[^*\n]+\*\*/.test(text)) violations.push('có chữ in đậm (**)');
  if (config.noHeadings && /^\s*#{1,6}\s/m.test(text)) violations.push('có heading Markdown (#)');
  if (config.noTables && /^\s*\|.*\|\s*$/m.test(text)) violations.push('có bảng');
  if (config.noEmoji && EMOJI.test(plain)) violations.push('có emoji');
  if (config.forbidGreetingClosing) {
    if (GREETING.test(plain)) violations.push('mở đầu bằng lời chào');
    const lastLine = plain.trim().split('\n').filter(Boolean).pop() || '';
    if (CLOSING.test(lastLine)) violations.push('kết bài bằng cảm ơn/ký tên/câu kết trang trọng');
  }
  if (config.forbidPersonalPronouns && PERSONAL.test(plain)) violations.push(`xưng hô cá nhân (em/anh/chị/t/tớ); tự xưng "${config.selfReference || 'TS'}"`);
  if (config.forbidMentions && /(^|\s)@[\p{L}\p{N}_]+/u.test(plain)) violations.push('có @mention');
  if (config.selfReference && /(^|[^\p{L}])(đã check|đã kiểm tra|đã test|đã thử|đã xem|check thấy)(?![\p{L}])/iu.test(plain) && !new RegExp(`(^|[^\\p{L}])${config.selfReference}(?![\\p{L}])`, 'u').test(plain)) violations.push(`nêu việc đã check nhưng không tự xưng "${config.selfReference}"`);
  return violations;
}
