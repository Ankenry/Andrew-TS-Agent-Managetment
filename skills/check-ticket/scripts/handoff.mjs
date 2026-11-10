import { isHanReport, parseHanReport, renderHelpdeskReport, isHanCompactComment, HANDLING_COMMENT_VERSION, assertHandlingBody } from './han-report.mjs';

export const ANDREW_ID = 'HEYWuzF9rTdG59pE8TNtBKL6W1x1';

export const CATEGORIES = ['Customize', 'Bug', 'Feature request', 'Question'];

export function formatReviewComment(content, category, { commentFormatVersion, prepared = false } = {}) {
  if (!CATEGORIES.includes(category)) throw new Error('Missing or invalid review category.');
  // A persisted payload is immutable during delivery/reconciliation, including legacy whitespace.
  if (prepared) {
    if (typeof content !== 'string' || !content.trim() || content.length > 20000) throw new Error('Invalid prepared review comment.');
    if (commentFormatVersion === HANDLING_COMMENT_VERSION) assertHandlingBody(content);
    return content;
  }
  if (commentFormatVersion === HANDLING_COMMENT_VERSION) { assertHandlingBody(content); return content; }
  if (isHanReport(content)) {
    // A prepared compact comment is immutable across retries/restarts.
    if (isHanCompactComment(content)) {
      if (content.length > 20000) throw new Error('Invalid compact Han report.');
      return content.trim();
    }
    return renderHelpdeskReport(parseHanReport(content, category));
  }
  // Strip only the generated wrapper, leaving the report and code blocks intact.
  let body = content.trim().replace(/(?:^|\n\s*)(?:Chờ Andrew Verify|Nhờ @[^\n]+ check lại và báo khách nhé ạ|Chờ @[^\n]+ review kết quả|@[^\n]+ xem giúp hướng xử lý này ổn chưa nhé\?)\s*$/, '').trimEnd();
  const header = /^Sau khi TS check thì thấy như sau:\r?\nĐây là loại ticket gì\s*:\s*[^\r\n]+(?:\r?\n|$)\s*/;
  while (header.test(body)) body = body.replace(header, '');
  if (!body.trim()) throw new Error('Review body is empty.');
  const final = `Sau khi TS check thì thấy như sau:\nĐây là loại ticket gì : ${category}\n\n${body}`;
  if (final.length > 20000) throw new Error('Final comment exceeds 20000 characters.');
  return final;
}
