// "@han" commands (13/10/2026, user order: "khi tôi comment @han thì bạn sẽ nhận lệnh theo câu comment của tôi sau đó
// … nếu tôi @han thì bạn sẽ mặc định là check tiếp ticket theo phản hồi ở comment"). Pure helpers, no I/O:
// the controller (service.mjs) finds Andrew's own comments that carry the keyword, this module says what they ask
// for, and the pipeline receives the instruction as DATA that steers the follow-up investigation. Nothing here is
// ever executed as a system command; instructions that would need a write (status change, Done tick, customer
// message, deletion, theme push, setting toggle…) are refused before any work starts.

export const CHECK_ACK = 'Dạ chờ em check xíu nha';

export const DEFAULT_KEYWORD = '@han';
// Jobs without a saved keyword predate the migration. This is display-only, never a trigger alias.
export const jobCommandKeyword = job => job?.command?.keyword || '@bot';
export const DEFAULT_INSTRUCTION = 'check tiếp ticket theo các comment phản hồi mới kể từ lần check trước';
export const DEFAULT_MAX_INSTRUCTION_CHARS = 2000;

const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "@han" at the start or after whitespace/bracket, not glued into a longer token (@hantom, @han123 do not count).
export function commandPattern(keyword = DEFAULT_KEYWORD) {
  return new RegExp(`(^|[\\s(\\[>"'])${escape(keyword)}(?![\\p{L}\\p{N}_.-])`, 'iu');
}

// An empty instruction or one of these short forms means the default follow-up.
const DEFAULT_FORMS = /^(?:check(?:\s+(?:tiếp|lại|lai|tiep))?|tiếp|tiep|follow[\s-]?up|continue)(?:\s+(?:yêu cầu|yeu cau|ticket|đi|nhé|nha|nhá|giúp|giup|anh|em|với|voi|nào|lại))*\s*[.!…]*$/iu;

// Instructions the bot must not act on (read-only workflow). Each entry: what the text asks for → reason shown back.
export const FORBIDDEN = [
  { pattern: /(?:đổi|chuyển|cập nhật|update|change|set|đặt|sửa)\s+(?:lại\s+)?(?:ts\s*)?(?:status|trạng thái|tsstatus)/iu, reason: 'đổi status/trạng thái ticket' },
  { pattern: /(?:tick|mark|đánh dấu|tích|chuyển|set)\b[^.\n]{0,40}\b(?:done|solved|resolved|hoàn thành|xong việc)\b/iu, reason: 'tick Done / đánh dấu solved' },
  { pattern: /\b(?:close|đóng|resolve)\s+(?:ticket|case|vụ này)/iu, reason: 'đóng ticket' },
  { pattern: /(?:nhắn|gửi|reply|trả lời|send|email|mail|phản hồi)\s+(?:cho\s+|to\s+|lại\s+)?(?:khách|merchant|customer|client|shop)/iu, reason: 'nhắn/gửi mail cho khách' },
  { pattern: /\b(?:gửi|send)\s+(?:an?\s+)?(?:e-?mail|mail)\b/iu, reason: 'gửi mail' },
  { pattern: /(?:gửi|send|post|đăng|nhắn)\s+(?:tin\s+)?(?:lên|to|vào|qua)?\s*(?:telegram|slack|tin nhắn|message)/iu, reason: 'gửi tin nhắn Telegram/Slack' },
  { pattern: /(?:xóa|xoá|delete|remove|gỡ)\s+(?:comment|ticket|draft|nháp|file|dữ liệu|data|record|review|bản ghi)/iu, reason: 'xóa dữ liệu' },
  { pattern: /theme\s*push|push\s+(?:lên\s+)?theme|(?:lưu|save|apply|áp dụng|chèn|insert|add|thêm|ghi)\s+(?:đoạn\s+|khối\s+)?(?:css|code|js|script|liquid)[^.\n]{0,40}\b(?:vào|to|into|lên)\s+(?:shop|theme|app|devzone|store)/iu, reason: 'lưu code/CSS vào shop/theme/app' },
  { pattern: /(?:sửa|edit|chỉnh|modify|update)\s+(?:trực tiếp\s+)?(?:theme|file theme|liquid)\s+(?:cho|của|for)\s+(?:khách|merchant|shop)/iu, reason: 'sửa theme của khách' },
  { pattern: /(?:bật|tắt|enable|disable|turn\s+(?:on|off)|toggle|switch\s+(?:on|off)|mở|đóng)\s+(?:giúp\s+|hộ\s+|lại\s+)?(?:setting|option|cấu hình|tính năng|feature|app embed|embed|toggle)/iu, reason: 'bật/tắt setting của shop' },
  { pattern: /(?:mention|tag|nhắc)\s+@?(?!bot\b)[\p{L}][\p{L}\p{N}_.-]{1,}/iu, reason: 'mention người khác trong comment', mailContent: true },
  { pattern: /(?:quick\s*login|đăng nhập|login)\s+(?:vào\s+)?(?:admin|app|shop|store)/iu, reason: 'đăng nhập vào admin/app của khách (chỉ khi Đại tá cho phép trong phiên)' },
];

export const DEFAULT_REPLY_TIMEOUT_MS = 120000;
export const DEFAULT_REPLY_MAX_CHARS = 1200;

export function normalizeBotCommand(value = {}) {
  const config = value && typeof value === 'object' ? value : {};
  const keyword = typeof config.keyword === 'string' && config.keyword.trim() ? config.keyword.trim() : DEFAULT_KEYWORD;
  const maxInstructionChars = Math.min(5000, Math.max(50, Number(config.maxInstructionChars) || DEFAULT_MAX_INSTRUCTION_CHARS));
  const pollIntervalMs = Number.isFinite(Number(config.pollIntervalMs)) && Number(config.pollIntervalMs) >= 60000 ? Number(config.pollIntervalMs) : null;
  // Natural replies (14/10/2026): model deadline, comment length cap, and whether greetings use the built-in templates
  // (false → every chat/question goes through the model).
  const replyTimeoutMs = Math.min(600000, Math.max(10000, Number(config.replyTimeoutMs) || DEFAULT_REPLY_TIMEOUT_MS));
  const replyMaxChars = Math.min(4000, Math.max(200, Number(config.replyMaxChars) || DEFAULT_REPLY_MAX_CHARS));
  const keywordSinceAt = Number.isFinite(Date.parse(config.keywordSinceAt || '')) ? new Date(config.keywordSinceAt).toISOString() : null;
  return { enabled: config.enabled !== false, keyword, keywordSinceAt, maxInstructionChars, pollIntervalMs, replyTimeoutMs, replyMaxChars, chatTemplates: config.chatTemplates !== false };
}

// Strip Helpdesk HTML a comment may carry so the keyword and the instruction are read as the user typed them.
export function plainText(content) {
  return String(content || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// --- Classification (14/10/2026, user feedback "Tôi chỉ @han hi mà sao không trả lời 1 cách tự nhiên mà lại thành check
// ticket vậy"): a comment after the keyword is one of
//   follow_up — asks to check/verify/investigate again (empty or default form, or a check verb) → the v2 follow-up pipeline;
//   chat      — a greeting, thanks, ok, ping or joke → one short natural reply (templates or model), no pipeline;
//   question  — asks something about the ticket that the existing data answers (posted report, comments) → model reply;
//   unsure    — none of the rules matched → the model classifies and answers; it may only pick follow_up when the text
//               clearly asks for a check, otherwise it answers and offers "@han check tiếp".
// Rules first, model only for `unsure`. FORBIDDEN still wins over everything but the default forms.

// Verbs that ask for a (re)check — the whole instruction becomes a follow-up, whatever else it says.
const CHECK_VERBS = /(?:^|[^\p{L}])(?:check|re-?check|kiểm tra|kiem tra|kiểm lại|xem lại|xem lai|xem thử|xem thu|xem giúp|xem giup|xem hộ|xem ho|xem coi|xem xét|xem xet|coi lại|coi lai|rà lại|rà soát|ra soat|soát lại|verify|xác minh|xac minh|đối chiếu|doi chieu|điều tra|dieu tra|investigate|look into|chạy lại|chay lai|thử lại|thu lai|test lại|test lai|kiểm chứng|kiem chung|đọc lại|doc lai|theo dõi tiếp|follow[\s-]?up|tiếp tục check|check tiếp|xử lý tiếp|xu ly tiep)(?![\p{L}])/iu;

// Chat lexicon: the instruction is chat when every token belongs to one of these groups or to the filler list.
// Each group pattern matches at the start of the remaining text (longest phrases first).
const CHAT_GROUPS = [
  { group: 'thanks', pattern: /^(?:thank you very much|thank you|thank u|thanks a lot|many thanks|thanks|thank|thx|tks|ty|cảm ơn|cam on|cám ơn|cám on|camon|thanks you)/iu },
  { group: 'greeting', pattern: /^(?:good (?:morning|afternoon|evening|night)|xin chào|xin chao|chào buổi (?:sáng|chiều|tối)|hế lô|hé lô|hello|helo|hallo|hi+|hey|heya|chào|chao|alo|alô|hola|yo|sup|what's up|whats up|bonjour)/iu },
  { group: 'ok', pattern: /^(?:good job|well done|got it|đúng rồi|dung roi|biết rồi|biet roi|hiểu rồi|hieu roi|rõ rồi|ro roi|noted|okay|okie|oke|okê|ok|good|nice|tốt|tot|được|duoc|đc|rồi|roi|hay|tuyệt|tuyet|great|cool|đỉnh|dinh|perfect|xịn|ổn|on|ngon|chuẩn|chuan|fine|sure|yes|yep|yeah|ừ|ừa|uh|ok la|oklah|👍|👌|🙏|❤️|😂|🤣|😄|😊)/iu },
  { group: 'ping', pattern: /^(?:có đó không|co do khong|còn đó không|con do khong|có đấy không|đâu rồi|dau roi|có nghe không|co nghe khong|có ai không|co ai khong|đang chạy không|còn sống không|con song khong|hoạt động không|ổn không|on khong|có đó ko|còn đó ko|đó không|đó ko|testing|test|ping|alive|hello\?)/iu },
  { group: 'fun', pattern: /^(?:hahaha+|haha|hihi+|hehe+|hoho+|huhu+|lol|lmao|kkk+|kk|=\)\)+|:\)+|:d|xd|\^\^|<3|:\(|=\(\(+|vui quá|vui qua|đùa thôi|dua thoi|just kidding|jk)/iu },
];
// Words that may surround a chat phrase without changing its meaning.
const CHAT_FILLER = /^(?:han|bot|em|bạn|ban|anh|chị|chi|ơi|oi|nhé|nhe|nha|nhá|ạ|a|ha|hả|nào|nao|lắm|lam|nhiều|nhieu|nhìu|quá|qua|rất|rat|you|u|bro|man|there|nhỉ|nhi|đó|do|đấy|day|thế|the|vậy|vay|á|à|ừ|hen|hén|luôn|luon|cả nhà|everyone|team|mọi người|moi nguoi|again|lại|lai|nhen|nè|ne|này|nay|ah|oh|hm+|ơ|ờ|yes|dạ|da|vâng|vang|ok|oke|good|nice|hi|hello|thanks|cảm ơn|chào)(?![\p{L}])/iu;
const EMOTICON = /(?:=\)\)+|:\)+|:D|:\(|=\(\(+|\^\^|<3|:v|:3|xD)/g;
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu;
const PUNCT = /[.!?~,;:…"'“”‘’()\[\]{}\-–—_*#/\\|]+/g;

// → { group } when the whole text is chat, else null. `hadEmoji` lets "@han 👍" count as an ok.
export function classifyChat(after) {
  const raw = String(after || '');
  const hadEmoji = EMOJI.test(raw); EMOJI.lastIndex = 0;
  let text = raw.replace(EMOTICON, ' haha ').replace(EMOJI, ' ').replace(PUNCT, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return hadEmoji ? { group: 'ok' } : null;
  if (text.split(' ').length > 8) return null;
  const groups = new Set(); let guard = 0;
  while (text && guard++ < 20) {
    const hit = CHAT_GROUPS.find(item => item.pattern.test(text));
    if (hit) {
      const phrase = hit.pattern.exec(text)[0];
      // The phrase must end at a word boundary ("hi" in "hide" is not a greeting).
      const rest = text.slice(phrase.length);
      if (rest && /^[\p{L}\p{N}]/u.test(rest)) return null;
      groups.add(hit.group); text = rest.trim(); continue;
    }
    const filler = CHAT_FILLER.exec(text);
    if (!filler) return null;
    text = text.slice(filler[0].length).trim();
  }
  // "ok cảm ơn em" is a thanks, not an ok: the most specific group wins.
  const group = ['thanks', 'greeting', 'ping', 'fun', 'ok'].find(name => groups.has(name)) || null;
  return group ? { group } : null;
}

// Question about the ticket: a question mark or an interrogative word, and no check verb (checked by the caller).
const QUESTION_WORDS = /\?|(?:^|[^\p{L}])(?:sao rồi|sao roi|ra sao|thế nào|the nao|như nào|nhu nao|tới đâu|toi dau|đến đâu|den dau|tại sao|tai sao|vì sao|vi sao|là gì|la gi|là sao|la sao|gì vậy|gi vay|gì thế|gì|kết luận|ket luan|kết quả|ket qua|khi nào|khi nao|bao giờ|bao gio|lúc nào|luc nao|ở đâu|o dau|chỗ nào|cho nao|bao lâu|bao lau|bao nhiêu|bao nhieu|chưa|chua|hay không|hay chưa|hay ko|không|ko|hông|what|why|how|when|where|which|who|status|tình hình|tinh hinh|tiến độ|tien do|cập nhật gì|update gì|nghĩa là|nghia la|ý là|y la|giải thích|giai thich|explain|tóm tắt|tom tat|summary|summarize|nhắc lại|nhac lai|nói lại|noi lai|kể lại|ke lai|cho hỏi|cho hoi|hỏi|hoi|cho biết|cho biet|nói rõ|noi ro|chi tiết hơn|chi tiet hon|tell me|remind me|recap)(?![\p{L}])/iu;

export function classifyInstruction(after) {
  const text = String(after || '').replace(/\s+/g, ' ').trim();
  if (!text || DEFAULT_FORMS.test(text)) return { kind: 'follow_up', defaultInstruction: true, chatGroup: null };
  if (CHECK_VERBS.test(text)) return { kind: 'follow_up', defaultInstruction: false, chatGroup: null };
  const chat = classifyChat(text);
  if (chat) return { kind: 'chat', defaultInstruction: false, chatGroup: chat.group };
  if (QUESTION_WORDS.test(text)) return { kind: 'question', defaultInstruction: false, chatGroup: null };
  return { kind: 'unsure', defaultInstruction: false, chatGroup: null };
}

// → null when the keyword is absent; otherwise { kind: 'follow_up' | 'chat' | 'question' | 'unsure' | 'refused',
//   instruction, defaultInstruction, reasons, truncated, chatGroup }. For chat/question/unsure `instruction` is the text as typed.
// Match the drafting phrase, not an instruction to send. Remove only that span
// before applying forbidden-action rules, so "draft ... and send" stays refused.
const DRAFT_REQUEST = /(?:^|[^\p{L}])(?:(?:viết|viet|soạn|soan|tạo|tao)\s+(?:(?:lại|llại|lai|llai)\s+)?(?:(?:một|mot|bản|ban)\s+)*(?:e-?mail|mail|thư|thu)|(?:draft|compose|write|create|prepare)\s+(?:(?:an?|the|customer|reply)\s+)*(?:e-?mail|mail|reply))(?![\p{L}])(?:\s+(?:cho|for|to|trả lời)\s+(?:khách(?:\s+hàng)?|khach(?:\s+hang)?|merchant|customer|client|shop))?/iu;
const DRAFT_MIXED_WRITE = /(?:\b(?:send|deliver|dispatch|delete|remove|publish|post|close|resolve|enable|disable)\b|(?:^|[^\p{L}])(?:gửi|gui|nhắn|xóa|xoá|xoa|đăng)(?![\p{L}])|\breply\s+to\s+(?:the\s+)?(?:customer|merchant|client)|(?:change|update|set|mark)\s+(?:the\s+)?(?:status|ticket|done|solved|setting))/iu;

// A relative clause about existing image/video evidence is not a request to send.
// Mask only its past-tense verb for the broad mixed-write check. Keep the full
// text for FORBIDDEN and for the worker; additional actions must still be checked.
const PAST_MEDIA_EVIDENCE = /((?:^|[^\p{L}])(?:link\s+(?:ảnh|hình|video)|hình\s+ảnh|ảnh|hình|screenshot|video)\s+(?:mà\s+)?(?:tester|dev|developer|qa|khách(?:\s+hàng)?|merchant|tôi)\s+đã\s+)(?:gửi|đăng)(?![\p{L}])/giu;

// Vietnamese relative clauses may omit "đã": "image dev gửi ở thread Slack".
// Require an existing-media noun, its author, and a bounded source location.
// Future/request words, recipient clauses and new send/post actions stay visible.
const LOCATED_MEDIA_EVIDENCE = /((?:^|[^\p{L}])(?:link\s+(?:ảnh|hình|image|screenshot|video)|hình\s+ảnh|ảnh|hình|image|screenshot|video)\s+(?:mà\s+)?(?:tester|dev|developer|qa|khách(?:\s+hàng)?|merchant|tôi)\s+)(?:gửi|đăng)(?=\s+(?:ở|trong|tại)\s+(?:(?:thread|luồng)\s+)?(?:slack|ticket|comment|bình luận)\s*(?:$|[,.;!?)\]”"]))/giu;

// "Mail không nhắc tới <topic>" describes mail content, not a person to tag.
// Mask only that verb for the mention rule, with mail context and a quoted/topic
// object (never @person). All other guards still inspect the full action text.
const MAIL_CONTENT_REFERENCE = /((?:^|[^\p{L}])(?:e-?mail|mail|thư)\s+(?:(?:không|chưa|cần|phải|nên|có)\s+)?)nhắc(\s+(?:tới|đến)(?![\p{L}])\s+)(?=["“'‘](?!\s*@)|(?:việc|lỗi|vấn đề|nguyên nhân|thông tin|nội dung|chi tiết|currency|video)(?![\p{L}]))/giu;

export function parseBotCommand(content, { keyword = DEFAULT_KEYWORD, maxInstructionChars = DEFAULT_MAX_INSTRUCTION_CHARS } = {}) {
  const textValue = plainText(content);
  const match = commandPattern(keyword).exec(textValue);
  if (!match) return null;
  const after = textValue.slice(match.index + match[0].length).replace(/\s+/g, ' ').trim();
  const classified = classifyInstruction(after);
  const { defaultInstruction } = classified;
  const instruction = defaultInstruction ? DEFAULT_INSTRUCTION : after.slice(0, maxInstructionChars);
  const draftMatch = DRAFT_REQUEST.exec(after);
  const actionText = draftMatch ? after.slice(0, draftMatch.index) + ' ' + after.slice(draftMatch.index + draftMatch[0].length) : after;
  const mentionText = after.replace(MAIL_CONTENT_REFERENCE, '$1đề cập$2');
  const reasons = defaultInstruction ? [] : [...new Set(FORBIDDEN.filter(rule => rule.pattern.test(rule.mailContent ? mentionText : actionText)).map(rule => rule.reason))];
  const mixedActionText = actionText.replace(PAST_MEDIA_EVIDENCE, '$1cung cấp').replace(LOCATED_MEDIA_EVIDENCE, '$1cung cấp');
  if (draftMatch && DRAFT_MIXED_WRITE.test(mixedActionText)) reasons.push('lệnh soạn mail kèm thao tác gửi/ghi khác');
  if (draftMatch && after.length > maxInstructionChars) reasons.push('lệnh soạn mail vượt giới hạn, không cắt mất chỉ thị');
  return { kind: reasons.length ? 'refused' : draftMatch ? 'draft' : classified.kind, instruction, defaultInstruction, reasons, truncated: !defaultInstruction && after.length > maxInstructionChars, chatGroup: classified.chatGroup };
}

export const REPLY_KINDS = ['chat', 'question', 'unsure'];
export const isReplyKind = kind => REPLY_KINDS.includes(kind);

// Comment actions of one ticket → the new commands Andrew wrote, oldest first.
// since: ISO/epoch cursor (comments at or before it are baseline, never replayed); seen: ids already handled.
export function findBotCommands(actions, { authorId, since, seen = new Set(), keyword = DEFAULT_KEYWORD, maxInstructionChars } = {}) {
  const cutoff = typeof since === 'number' ? since : Date.parse(since || '');
  const out = [];
  for (const action of Array.isArray(actions) ? actions : []) {
    if (!action?.id || seen.has(action.id)) continue;
    if (action.type && action.type !== 'commentTicket') continue;
    if (!authorId || action.author?.memberId !== authorId) continue; // only the account that owns this tool commands it
    const createdAt = Date.parse(action.createdAt || '');
    if (!Number.isFinite(createdAt) || (Number.isFinite(cutoff) && createdAt <= cutoff)) continue;
    const content = action.metadata?.content ?? action.content ?? '';
    const parsed = parseBotCommand(content, { keyword, maxInstructionChars });
    if (!parsed) continue;
    out.push({ commentId: action.id, createdAt: new Date(createdAt).toISOString(), content: plainText(content).slice(0, 2000), ...parsed });
  }
  return out.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

// Where the follow-up window starts: the end of the latest finished check of this ticket before the command
// (an automatic review or an earlier @han run), else the ticket creation time, else null (= all comments).
export function followUpWindow({ jobs = {}, ticketId, commentAt, ticketCreatedAt = null } = {}) {
  const limit = Date.parse(commentAt || '') || Infinity;
  let sinceAt = null; let previous = null;
  for (const job of Object.values(jobs || {})) {
    const jobTicket = job?.ticketId || job?.id;
    if (jobTicket !== ticketId || job.status !== 'done' || ['draft', 'reply'].includes(job.mode) || !job.finishedAt) continue;
    const finished = Date.parse(job.finishedAt);
    if (!Number.isFinite(finished) || finished >= limit) continue;
    if (!sinceAt || finished > Date.parse(sinceAt)) { sinceAt = new Date(finished).toISOString(); previous = job; }
  }
  if (!sinceAt && ticketCreatedAt && Number.isFinite(Date.parse(ticketCreatedAt))) sinceAt = new Date(Date.parse(ticketCreatedAt)).toISOString();
  return { sinceAt, previousJobId: previous?.id || null, previousReport: previous?.comment || null, previousCategory: previous?.category || null };
}

// Image links a comment or description may carry (screen captures the user attaches as evidence).
export const IMAGE_LINK = /https?:\/\/(?:capture\.avada\.io|capture\.chattyai\.dev)\/i\/[A-Za-z0-9_-]+|https?:\/\/[^\s<>"')\]]+\.(?:png|jpe?g|gif|webp)(?:\?[^\s<>"')\]]*)?/gi;
export function extractImageLinks(text) {
  return [...new Set((String(text || '').match(IMAGE_LINK) || []).map(link => link.replace(/[.,;:!?]+$/, '')))];
}
