import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectionOf, examplesOf, checkCommentStyle, countSentences, stylePromptSection, loadCommentStyle, DEFAULT_STYLE_CONFIG } from '../../check-ticket/scripts/comment-style.mjs';

const profile = `# Hồ sơ\n\n## 5. Ví dụ nguyên văn tiêu biểu\n\n1. AIR-261008-6rfZxp: "AI đã check đúng, do bị sai biến / <ảnh>"\n2. JSUB-261008-E2tTBm: "@Riley Em manual fix done ạ / <ảnh>"\n3. AIR-1: "TS đã update theme done"\n\n## 6. Quy tắc rút ra cho AI khi viết comment\n\nChắc:\n- Viết ngắn.\n- Tự gọi là "TS".\n\n## 7. Điểm lệch\n\n- Độ dài.`;

test('sectionOf and examplesOf cut the profile without the neighbouring sections', () => {
  assert.equal(sectionOf(profile, '## 6.'), 'Chắc:\n- Viết ngắn.\n- Tự gọi là "TS".');
  assert.equal(sectionOf(profile, '## 9.'), '');
  assert.deepEqual(examplesOf(profile, { max: 2 }), ['"AI đã check đúng, do bị sai biến / <ảnh>"', '"@Riley Em manual fix done ạ / <ảnh>"']);
  assert.equal(examplesOf(profile, { maxChars: 10 })[0], '"AI đã che…');
});

test('loadCommentStyle honours enabled in the config (both states), and degrades to disabled when files are missing', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'comment-style-'));
  mkdirSync(join(root, 'skills/check-ticket'), { recursive: true }); mkdirSync(join(root, 'knowledge-base/feedback'), { recursive: true });
  writeFileSync(join(root, 'knowledge-base/feedback/andrew-comment-style.md'), readFileSync('knowledge-base/feedback/andrew-comment-style.md'));
  const real = JSON.parse(readFileSync('skills/check-ticket/comment-style.json', 'utf8'));
  writeFileSync(join(root, 'skills/check-ticket/comment-style.json'), JSON.stringify({ ...real, enabled: true }));
  const on = await loadCommentStyle({ root });
  assert.equal(on.enabled, true);
  assert.match(on.rules, /TS/);
  assert.ok(on.examples.length >= 3 && on.examples.length <= on.config.maxExamples);
  assert.ok(on.rules.length <= on.config.maxRulesChars);
  assert.match(stylePromptSection(on), /Tự xưng "TS"/);
  writeFileSync(join(root, 'skills/check-ticket/comment-style.json'), JSON.stringify({ ...real, enabled: false }));
  const off = await loadCommentStyle({ root });
  assert.equal(off.enabled, false); assert.equal(off.rules, ''); assert.deepEqual(off.examples, []); assert.equal(stylePromptSection(off), '');
  assert.deepEqual(checkCommentStyle('- bullet\n**bold**', off.config), [], 'disabled config → no style violations');
  // The repository state since 09/10/2026 (Đại tá: "lấy lại rule comment ticket cũ"): disabled unless someone turns it back on.
  const current = await loadCommentStyle();
  assert.equal(current.enabled, real.enabled !== false);
  const missing = await loadCommentStyle({ configPath: 'skills/check-ticket/does-not-exist.json', root: '/nonexistent-root' });
  assert.equal(missing.enabled, false); assert.equal(stylePromptSection(missing), '');
});

test('writerPrompt uses Han report rules even when the legacy style is disabled; old fixtures remain verifiable', async () => {
  const { writerPrompt } = await import('./prompts.mjs');
  const { checkWriterOutput } = await import('./postcheck.mjs');
  const prep = { reference: 'JOY-1', ticket: { subject: 's', comments: [] }, app: { slug: 'joy', codeRoot: null, kbRoots: [] }, oldCases: [], lessons: [] };
  const verified = { category: 'Bug', summary: 'tóm tắt', findings: [{ id: 'F1', kind: 'fact', claim: 'Cron chạy 0 0 * * *', quote: '0 0 * * *', source: { ref: 'apps_doc/joy/x.js' }, score: 1, verified: true, inference: false }], stats: { total: 1 } };
  const off = await loadCommentStyle({ configPath: 'skills/check-ticket/does-not-exist.json', root: '/nonexistent-root' });
  const prompt = writerPrompt(prep, verified, { maxChars: 4000, minChars: 150, style: off });
  assert.match(prompt, /\*\*7\. Trạng thái hiện tại\*\*/); assert.match(prompt, /TOÀN BỘ bản đầy đủ cùng ticket\/run/); assert.match(prompt, /Sau khi TS check thì thấy như sau:/); assert.doesNotMatch(prompt, /Helpdesk CHỈ nhận lời chào|phải có cùng finding_ids được trình bày đầy đủ trong 2\/4\/6/); assert.ok(!prompt.includes('phong cách')); assert.ok(!/\d+-\d+ câu/.test(prompt));
  const body = 'Flow vẫn bật nhưng không có run ngày 08/10, TS đã xem cron.\n- Cron publisher chạy `0 0 * * *` theo UTC.\n- Cần dev xem log để biết vì sao job không chạy.\n' + 'Thêm một câu nữa để đủ độ dài tối thiểu của body theo luật cũ. '.repeat(3);
  const check = checkWriterOutput({ body, claims: [{ text: 'Cron publisher chạy `0 0 * * *` theo UTC.', finding_ids: ['F1'], inference: false }], customer_letter: null, letter_finding_ids: [] }, verified, { commentMaxChars: 4000, commentMinChars: 150, letterMinScore: 0.9 }, off);
  assert.ok(!check.violations.some(item => item.startsWith('phong cách')), check.violations.join(' | '));
  assert.equal(check.ok, true, check.violations.join(' | '));
});

test('countSentences ignores links and code', () => {
  assert.equal(countSentences('TS đã update theme done.\nhttps://capture.avada.io/i/abc\nCode\n```css\n.a{}\n```'), 2);
  assert.equal(countSentences(''), 0);
});

test('checkCommentStyle accepts a short colleague-style body', () => {
  const body = 'Ko phải bug ạ, block bị ẩn là do setting Visibility đang bật "Hide block when customer doesn\'t have enough points".\nTS check thấy tài khoản 2.100 điểm với giỏ RM59 ko đủ điều kiện nên block ẩn, lên RM112.80 thì hiện.\nCS báo khách bỏ hai tùy chọn ẩn trong Visibility nếu muốn block luôn hiện.\nĐộ trễ 6 giây TS chưa đo được, cần dev xem thêm.';
  assert.deepEqual(checkCommentStyle(body, DEFAULT_STYLE_CONFIG), []);
});

test('checkCommentStyle flags bullets, bold, headings, length, pronouns, mentions, greeting/closing, missing TS', () => {
  const long = Array.from({ length: 12 }, (_, i) => `Câu số ${i} nói về một ý.`).join(' ');
  const violations = checkCommentStyle(`Chào team,\n# Kết luận\n**Lỗi** do app.\n- bước 1\n- bước 2\n@Riley em đã check rồi ạ.\n${long}\nCảm ơn mọi người.`, DEFAULT_STYLE_CONFIG);
  for (const needle of ['quá dài', 'gạch đầu dòng', 'in đậm', 'heading', 'lời chào', 'cảm ơn', 'xưng hô cá nhân', '@mention']) assert.ok(violations.some(item => item.includes(needle)), `missing ${needle}: ${violations.join(' | ')}`);
  assert.ok(checkCommentStyle('Đã check thấy setting đang tắt. Khách cần bật lại app. Báo khách giúp nhé.', DEFAULT_STYLE_CONFIG).some(item => item.includes('không tự xưng "TS"')));
  assert.ok(checkCommentStyle('Một câu.', DEFAULT_STYLE_CONFIG).some(item => item.includes('quá ngắn')));
  const run = 'TS check thấy ' + 'điều kiện này nối với điều kiện kia bằng dấu chấm phẩy; '.repeat(6) + 'nên block ẩn.';
  assert.ok(checkCommentStyle(`${run}\nKo phải bug.\nBáo khách bật lại setting.`, DEFAULT_STYLE_CONFIG).some(item => item.includes('câu dài hơn')));
  assert.ok(checkCommentStyle(Array.from({ length: 7 }, () => 'TS check thấy một ý dài vừa phải nằm trong giới hạn câu nhưng tổng thể thì vượt quá độ dài body cho phép của phong cách này rồi đó nha, cần cắt bớt cho gọn lại giống cách viết thật trên ticket của người dùng, mỗi ý một câu thôi.').join('\n'), DEFAULT_STYLE_CONFIG).some(item => item.includes('ký tự, phong cách yêu cầu dưới')));
  assert.deepEqual(checkCommentStyle('- bullet', { ...DEFAULT_STYLE_CONFIG, enabled: false }), []);
  assert.deepEqual(checkCommentStyle('- a\n- b\n- c', { ...DEFAULT_STYLE_CONFIG, noBullets: false, sentencesMin: 1 }), []);
});
