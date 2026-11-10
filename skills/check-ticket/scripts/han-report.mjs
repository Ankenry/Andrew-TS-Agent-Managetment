// One canonical report. Helpdesk is an extractive summary of the whole report, never a second investigation.
export const HAN_REPORT_VERSION = 'han-support-v1';
export const HANDLING_COMMENT_VERSION = 'ts-handling-v1';
export const HELPDESK_COMMENT_VERSION = 'ts-review-v1';
export const HISTORICAL_HAN_COMMENT_VERSION = 'han-support-compact-v1';
export const HELPDESK_OPENING = 'Sau khi TS check thì thấy như sau:';
export const HAN_GREETING = 'Xin chào cạ nhà, đây là Han Support hỗ trợ cạ nhà ticket này nha';
export const HAN_TITLES = ['Phân loại ticket', 'Nội dung khách đang cần', 'Những gì Han đã kiểm tra', 'Hướng xử lý Han đề xuất', 'Những điểm cần lưu ý', 'Han cần hỗ trợ thêm', 'Trạng thái hiện tại'];
export const HAN_COMPACT_IDS = [2, 4, 6];
const categories = ['Customize', 'Bug', 'Feature request', 'Question'];
export const isHanReport = text => { const first = String(text || '').trimStart().split(/\r?\n/)[0]; return first === `**${HAN_GREETING}**` || first === HAN_GREETING; };

export function renderHanReport(report, { compact = false } = {}) {
  if (report?.version !== HAN_REPORT_VERSION || !categories.includes(report.category)
    || report.sections?.length !== 7 || report.sections.some((s, i) => s.id !== i + 1 || typeof s.body !== 'string' || !s.body.trim())) throw new Error('Invalid Han report.');
  return [`**${HAN_GREETING}**`, ...report.sections.filter(s => !compact || HAN_COMPACT_IDS.includes(s.id))
    .map(s => `**${s.id}. ${HAN_TITLES[s.id - 1]}**\n\n${s.body.trim()}`)].join('\n\n');
}

// Only headings outside code fences are structural. CSS/JS and caveats remain byte-for-byte intact.
export function parseHanReport(text, category) {
  const lines = String(text || '').trim().replace(/\r\n/g, '\n').split('\n');
  const greeting = lines.shift();
  if (greeting !== `**${HAN_GREETING}**` && greeting !== HAN_GREETING) throw new Error('Han report thiếu lời chào cố định.');
  const sections = []; let current = null; let fence = null;
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      if (current) current.lines.push(line); else throw new Error('Code nằm ngoài mục report.');
      continue;
    }
    const heading = !fence && /^\*\*([1-7])\. (.+)\*\*$/.exec(line);
    if (heading) {
      const id = Number(heading[1]);
      if (id !== sections.length + 1 || heading[2] !== HAN_TITLES[id - 1]) throw new Error('Han report sai thứ tự/tiêu đề mục.');
      current = { id, lines: [] }; sections.push(current);
    } else if (current) current.lines.push(line);
    else if (line.trim()) throw new Error('Nội dung nằm ngoài mục report.');
  }
  if (fence) throw new Error('Han report có code fence chưa đóng.');
  const report = { version: HAN_REPORT_VERSION, category, sections: sections.map(s => ({ id: s.id, body: s.lines.join('\n').trim() })) };
  renderHanReport(report); // validate all seven non-empty sections
  return report;
}

export function isHanCompactComment(text) {
  if (!isHanReport(text)) return false;
  let fence = null; const ids = [];
  for (const line of String(text).split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) { if (!fence) fence = marker[1]; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null; continue; }
    if (fence) continue;
    const heading = /^\*\*([1-7])\. (.+)\*\*$/.exec(line);
    if (heading) {
      if (heading[2] !== HAN_TITLES[Number(heading[1]) - 1]) return false;
      ids.push(Number(heading[1]));
    }
  }
  return !fence && JSON.stringify(ids) === JSON.stringify(HAN_COMPACT_IDS);
}

// Touch presentation only; code, inline literals, URLs and quotation marks are opaque.
// This same mapping is used to check claims after removing the full-report voice.
export function helpdeskProse(text) {
  return String(text).replace(/^\s*\d+[.)]\s+/gm, '- ')
    .replace(/^\s*(?:⚠️?|ℹ️?)\s*/gm, '')
    .split(/(`+[^\n]*?`+|https?:\/\/[^\s<>]+|“[^”]*”|"[^"\n]*")/g).map((part, i) => i % 2 ? part : part
    .replace(/\bHan\b/g, 'TS')
    .replace(/cạ nhà/gi, 'anh/chị')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')).join('');
}

export function reportProse(text) {
  let fence = null;
  return String(text).split('\n').filter(line => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return false;
    }
    return !fence;
  }).join('\n').replace(/`+[^\n]*?`+/g, '');
}

export function helpdeskBody(report) {
  renderHanReport(report);
  const paragraphs = []; const seen = new Set();
  // Start with the situation, then retain classification rationale, findings, proposal,
  // caveats, requests and actual status. No section is a required home for a caveat.
  for (const id of [2, 1, 3, 4, 5, 6, 7]) {
    let prose = []; let code = []; let fence = null;
    const flush = () => {
      const paragraph = helpdeskProse(prose.join('\n')).trim(); prose = [];
      if (paragraph && !seen.has(paragraph)) { paragraphs.push(paragraph); seen.add(paragraph); }
    };
    for (const line of report.sections[id - 1].body.split('\n')) {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        code.push(line);
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) {
          paragraphs.push(code.join('\n')); code = []; fence = null;
        }
      } else if (marker) { flush(); fence = marker[1]; code.push(line); }
      else if (!line.trim()) flush();
      else prose.push(line);
    }
    if (fence) throw new Error('Han report có code fence chưa đóng.');
    flush();
  }
  return paragraphs.join('\n\n');
}

export function renderHelpdeskReport(report) {
  const body = helpdeskBody(report);
  const prose = reportProse(body);
  // Reject an unsuitable source rather than deleting a sentence that may contain a caveat.
  if (/^\s*(?:#{1,6}\s|\|.*\|\s*$|Sources\s*:|Support by|Best regards|Chờ @?Andrew)/im.test(prose)
    || /(?:Nếu (?:anh\/chị|bạn) cần[^\n]*(?:hỗ trợ|nhắn|liên hệ)|Xin chào cạ nhà|Han Support)/i.test(prose)) {
    throw new Error('Helpdesk summary source contains a heading, table, greeting or footer; revise the full report.');
  }
  const comment = `${HELPDESK_OPENING}\nĐây là loại ticket gì : ${report.category}\n\n${body}`;
  if (comment.length > 20000) throw new Error('Final comment exceeds 20000 characters.');
  return comment;
}

// The semantic mapping is defined only for this validated schema, never for arbitrary array positions.
export function handlingBody(report) {
  renderHanReport(report);
  const id = HAN_TITLES.indexOf('Hướng xử lý Han đề xuất') + 1;
  const body = report.sections.find(section => section.id === id)?.body;
  assertHandlingBody(body);
  return body; // exact stored body, including whitespace and fenced code
}

export function assertHandlingBody(body) {
  if (typeof body !== 'string' || !body.trim()) throw new Error('Handling section is empty.');
  if (body.length > 20000) throw new Error('Handling comment exceeds 20000 characters; do not clip.');
  const prose = reportProse(body);
  if (/^\s*(?:#{1,6}\s|\*\*\d+\.|Sau khi TS check|Đây là loại ticket gì|Xin chào|Chào |Hello|Hi |Sources\s*:|Support by)/im.test(prose)
      || /^\s*\*\*[^*\n]+\*\*\s*$/m.test(prose) || prose.includes(HAN_GREETING)) throw new Error('Handling body contains a wrapper, greeting or heading.');
  let fence = null;
  for (const line of body.split('\n')) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) { if (!fence) fence = m[1]; else if (m[1][0] === fence[0] && m[1].length >= fence.length) fence = null; }
  }
  if (fence) throw new Error('Handling body has an unclosed code fence.');
}

export const HANDLING_WRITER_RULES = [
  `Automatic report ${HANDLING_COMMENT_VERSION}: vẫn viết FULL report bảy mục, không viết bản tóm tắt riêng.`,
  'Helpdesk chỉ nhận nguyên body mục Hướng xử lý Han đề xuất; không thêm heading, greeting, phân loại hoặc hai dòng wrapper.',
  'Mục xử lý phải tự đủ: code hoàn chỉnh nguyên văn, nơi dán, điều kiện merchant đồng ý/quyền triển khai, giới hạn, kết quả đã thử hoặc chưa thử và lý do. Không biến đề xuất thành việc đã làm.',
  'Đặt mọi claim suggestion/gap và mọi điều kiện/giới hạn ảnh hưởng hành động ngay trong mục xử lý; claim tương ứng chép nguyên câu. Nếu caveat đó còn xuất hiện ở mục khác, dùng cùng câu để hậu kiểm đối chiếu, không bỏ caveat để đạt kiểm tra.',
  'Full vẫn giữ evidence và kết luận đầy đủ. Thiếu hướng xử lý hợp lệ thì báo thiếu, không bịa bước để đi qua guard.',
].join('\n');

export function hanWriterRules(version) {
  if (version !== HANDLING_COMMENT_VERSION) return HAN_WRITER_RULES;
  return HAN_WRITER_RULES.split('\n').filter(line => !line.startsWith('Helpdesk dùng định dạng cũ:') && !line.startsWith('Controller tóm tắt trích xuất')).join('\n').replace('mỗi ý chỉ một lần', 'không lặp evidence; được nhắc lại nguyên câu điều kiện hành động ở mục xử lý để kiểm coverage') + '\n' + HANDLING_WRITER_RULES;
}

export function reportArtifacts(report, { commentFormatVersion = HELPDESK_COMMENT_VERSION } = {}) {
  if (![HELPDESK_COMMENT_VERSION, HISTORICAL_HAN_COMMENT_VERSION, HANDLING_COMMENT_VERSION].includes(commentFormatVersion)) throw new Error('Unknown comment format version.');
  return { report, reportVersion: HAN_REPORT_VERSION, commentFormatVersion, fullReport: renderHanReport(report),
    comment: commentFormatVersion === HANDLING_COMMENT_VERSION ? handlingBody(report) : commentFormatVersion === HISTORICAL_HAN_COMMENT_VERSION ? renderHanReport(report, { compact: true }) : renderHelpdeskReport(report) };
}

export const HAN_WRITER_RULES = [
  `body là report đầy đủ, mở đầu đúng **${HAN_GREETING}**.`,
  'Sau lời chào là đúng 7 tiêu đề in đậm, theo thứ tự; mỗi block cách nhau một dòng trống:',
  ...HAN_TITLES.map((title, i) => `**${i + 1}. ${title}**`),
  'Mục 1: một câu giải thích phân loại. Mục 2: 1–2 câu ngắn về yêu cầu khách. Mục 3: tóm tắt việc đã kiểm.',
  'Mục 4: hướng xử lý ngắn gọn theo bước. Giữ nguyên code hoàn chỉnh, vị trí dán, evidence và kết quả thử/giới hạn ngay cạnh code.',
  'Mục 5: lưu ý ngắn. Mục 6: việc TS/khách cần hỗ trợ; không bịa yêu cầu mới. Mục 7: 1–2 câu trạng thái thật, điều chưa làm/demo. Không thêm câu mời phản hồi/footer.',
  `Helpdesk dùng định dạng cũ: ${HELPDESK_OPENING} rồi dòng Đây là loại ticket gì : <category>. Controller thêm hai dòng này; writer không tự chèn wrapper vào body mục.`,
  'Controller tóm tắt trích xuất từ TOÀN BỘ bản đầy đủ cùng ticket/run: bắt đầu với tình hình ở mục 2, giữ nội dung mọi mục, bỏ lời chào/heading, gộp đoạn trùng, đổi giọng Han thành TS và bước đánh số thành bullet. Không bắt buộc trích 2/4/6, không chuyển caveat giữa các mục, không gọi AI viết báo cáo Helpdesk độc lập.',
  'Viết từng mục tự nhiên, ngắn gọn, mỗi ý chỉ một lần; tránh lặp nhãn rồi lặp nội dung, đoạn dẫn chung chung, bảng hành động, heading phụ, emoji cảnh báo, Sources/footer/chữ ký/mention. Mục 2 mở bằng một câu tình hình. Mọi đoạn phải tự đủ ngữ cảnh khi bỏ tiêu đề. Không rút ngắn bằng cách bỏ code, điều kiện, evidence hoặc caveat. Lời chào và bảy tiêu đề chỉ hiển thị ở full report Han auto.',
  'Giữ phân loại, sự chắc chắn, nhãn UI, code và bằng chứng; không khẳng định đã làm hoặc demo sẵn khi chưa có evidence. Không nhắc nguồn phân tích Elite, không dùng tên agent khác/Đại tá.',
].join('\n');
