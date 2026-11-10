import test from 'node:test';
import assert from 'node:assert/strict';
import { readEvidence } from '../../check-ticket/scripts/adapters.mjs';
import { readSlackEvidence, slackRequirement, slackContext, technicalMessages, correctionRules, correctionConflicts, claimsCustomerSaved } from './slack-evidence.mjs';
import { verifyFindings } from './verify.mjs';
import { checkWriterOutput } from './postcheck.mjs';
import { prepare } from './prepare.mjs';

const rootTs = '1792602394.612479', correctionTs = '1792644927.662819', ackTs = '1792651619.539039';
const link = `https://avadaio.slack.com/archives/C083Z2KTZQS/p${rootTs.replace('.', '')}`;
const ticket = { id: 't1', ticketId: 'CB-fixture', subject: 'Cookie question', description: '', appName: 'Cookie Bar', tsStatus: 'dev_fixing', slackLink: link, comments: [], storeDomains: [] };
const correction = 'oct/cct phải là Strictly Required, không phải Analytics; không cần scan lại.';
const old = 'oct/cct là Analytics và cần scan lại.';
const response = messages => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ ok: true, messages, has_more: false }) });
const read = (extra = {}) => readSlackEvidence(ticket, { token: 'fixture', fetchImpl: async () => response([
  { ts: rootTs, text: 'Question', reply_count: 2, latest_reply: ackTs },
  { ts: correctionTs, thread_ts: rootTs, user: 'UDEV', text: correction },
  { ts: ackTs, thread_ts: rootTs, user: 'UCSE', text: 'Đã nhận, cảm ơn.' },
]), ...extra });
const fact = (id, quote, ref, type = 'slack') => ({ id, kind: 'fact', claim: quote, quote, source: { type, ref } });
const findings = () => [fact('CORR', correction, `slack:C083Z2KTZQS:${correctionTs}`), fact('ACK', 'Đã nhận, cảm ơn.', `slack:C083Z2KTZQS:${ackTs}`), fact('OLD', old, 'ticket', 'ticket')];
const verify = (slack, values = findings()) => verifyFindings({ category: 'Question', findings: values, summary: 'fixture' }, { slack, ticketText: old, toolLog: [] });
const output = (body, ids) => ({ body, claims: [{ text: body, finding_ids: ids, inference: false }], customer_letter: null, letter_finding_ids: [] });
const config = { commentMinChars: 1, commentMaxChars: 4000, letterMinScore: 0.9 };

test('B1 correction remains mandatory after ACK; citing correction cannot launder wrong Analytics/rescan claim', async () => {
  const slack = await read();
  assert.deepEqual(technicalMessages(slack).map(m => m.ts), [correctionTs]);
  const verified = verify(slack);
  assert.deepEqual(verified.slackProblems, []);
  for (const ids of [['OLD', 'ACK'], ['CORR'], ['CORR', 'OLD', 'ACK']]) {
    const check = checkWriterOutput(output(old, ids), verified, config);
    assert.equal(check.ok, false, JSON.stringify(ids));
    assert.ok(check.violations.some(v => /correction/.test(v)));
  }
  const good = 'Theo dev, oct/cct phải là Strictly Required, không phải Analytics; không cần scan lại.';
  assert.equal(checkWriterOutput(output(good, ['CORR']), verified, config).ok, true);
});

test('B1 generic correction supports other names/values and ignores unrelated entity', async () => {
  const text = '`cart_cookie` phải là Necessary, không phải Marketing; không cần restart.';
  const slack = await read({ fetchImpl: async () => response([{ ts: rootTs, text: 'Question', reply_count: 1, latest_reply: correctionTs }, { ts: correctionTs, thread_ts: rootTs, text }]) });
  const values = [fact('C', text, `slack:C083Z2KTZQS:${correctionTs}`), fact('G', '`ga_cookie` là Marketing.', 'ticket', 'ticket')];
  const verified = verifyFindings({ category: 'Question', findings: values }, { slack, ticketText: '`ga_cookie` là Marketing.', toolLog: [] });
  assert.equal(checkWriterOutput(output('`cart_cookie` là Marketing và cần restart.', ['C']), verified, config).ok, false);
  const body = '`cart_cookie` phải là Necessary, không phải Marketing; không cần restart. `ga_cookie` là Marketing.';
  assert.equal(checkWriterOutput(output(body, ['C', 'G']), verified, config).ok, true);
});

test('B1 quoting only the greeting in a technical correction does not satisfy clause coverage', async () => {
  const slack = await read({ fetchImpl: async () => response([{ ts: rootTs, text: 'Question', reply_count: 1, latest_reply: correctionTs }, { ts: correctionTs, thread_ts: rootTs, text: 'Hi there. ' + correction }]) });
  const verified = verify(slack, [fact('GREET', 'Hi there.', `slack:C083Z2KTZQS:${correctionTs}`)]);
  assert.ok(verified.slackProblems.some(v => /mệnh đề đính chính/.test(v)));
});

const actions = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, metadata: { content: 'Recent comment' } }));
function pagedGet(second = { actions: [{ id: 'older', metadata: { content: `Slack thread: ${link}` } }], total: 101, hasMore: false }) {
  const calls = [];
  return { calls, get: async (path, opts) => {
    calls.push(path);
    if (!path.includes('/actions?')) return { ticket: { ...ticket, slackLink: '' } };
    if (path.includes('cursor=older')) return typeof second === 'function' ? second(opts) : second;
    return { actions, total: 101, hasMore: true, nextCursor: 'older' };
  } };
}

test('B2 actual readEvidence pagination discovers page2 link and passes complete evidence into prepare', async () => {
  const mock = pagedGet();
  const evidence = await readEvidence('CB-fixture', mock.get, { allComments: true });
  assert.equal(mock.calls.length, 3); assert.equal(evidence.comments.length, 101);
  assert.equal(evidence.commentEvidence.complete, true); assert.equal(evidence.commentEvidence.pages, 2);
  assert.equal(slackRequirement(evidence).threads[0].url, link);
  let fullRequested = false;
  const prep = await prepare({ reference: 'CB-fixture', url: 'fixture' }, {
    evidence: (ref, get, opts) => { fullRequested = opts.allComments; return readEvidence(ref, mock.get, opts); },
    lessons: async () => [], statePath: '/nonexistent-fixture', preSettings: false,
    slackReader: (t, opts) => readSlackEvidence(t, { ...opts, token: 'fixture', fetchImpl: async () => response([{ ts: rootTs, text: 'Question', reply_count: 0 }]) }),
  });
  assert.equal(fullRequested, true); assert.equal(prep.slack.complete, true);
});

test('B2 page2 failure, timeout, missing cursor and cycles fail closed before Slack discovery', async () => {
  const variants = [
    [() => { throw new Error('HTTP 403'); }, 'http_403'],
    [() => new Promise(() => {}), 'deadline'],
    [{ actions: [], total: 101, hasMore: true }, 'missing_cursor_or_count'],
    [{ actions, total: 101, hasMore: true, nextCursor: 'older' }, 'repeated_cursor'],
  ];
  for (const [second, code] of variants) {
    const mock = pagedGet(second), evidence = await readEvidence('CB-fixture', mock.get, { allComments: true, timeoutMs: 15 });
    assert.equal(evidence.commentEvidence.complete, false); assert.equal(evidence.commentEvidence.error, code);
    const required = slackRequirement(evidence, { instruction: 'check tiếp' });
    assert.equal(required.required, true); assert.match(required.error, /helpdesk_comments_incomplete/);
    const slack = await readSlackEvidence(evidence, { token: 'fixture', fetchImpl: async () => { throw Error('must not call Slack'); } });
    assert.equal(slack.complete, false); assert.equal(slack.status, 'incomplete');
  }
});

test('B2 single-page legacy readers expose incompleteness without changing their comment slice', async () => {
  const mock = pagedGet(), evidence = await readEvidence('CB-fixture', mock.get);
  assert.equal(mock.calls.length, 2); assert.equal(evidence.comments.length, 100);
  assert.equal(evidence.commentEvidence.complete, false); assert.equal(slackRequirement(evidence).required, true);
});

test('B3 title/description/relevant comment alone activate missing-link guard for automatic/manual without followUp', () => {
  for (const fields of [{ subject: 'Kiểm tra phản hồi dev' }, { description: 'Xem phản hồi dev trên Slack giúp tôi' }, { comments: [{ content: 'Đối chiếu phản hồi dev giúp mình' }] }]) {
    const rule = slackRequirement({ ...ticket, slackLink: '', ...fields });
    assert.equal(rule.required, true); assert.equal(rule.error, 'missing_thread_link');
  }
  assert.equal(slackRequirement({ ...ticket, slackLink: '', comments: [{ content: 'Sau khi TS check thì thấy như sau:\nKhông gửi Slack.' }] }).required, false, 'generated report is not a new request');
});

test('B4 exact opaque backend token is redacted recursively from all evidence string fields and model context', async () => {
  for (const token of ['xoxc-fixture-private-value', 'opaque.[secret]+nonstandard']) {
    const message = { ts: rootTs, reply_count: 0, text: token, user: token, blocks: [{ type: 'section', text: { type: 'plain_text', text: token } }, { elements: [{ elements: [{ text: token }] }] }], attachments: [{ title: token, text: token, fallback: token, fields: [{ title: token, value: token }] }], files: [{ name: token, mimetype: token }] };
    const evidence = await read({ token, fetchImpl: async () => response([message]) });
    assert.equal(evidence.complete, true); assert.equal(JSON.stringify(evidence).includes(token), false);
    assert.equal(slackContext(evidence).includes(token), false);
    assert.equal(evidence.threads[0].messages[0].user, '[REDACTED]');
  }
});

test('B4 token-bearing API/transport failures do not enter errors or context; exact value redacts even safe-code collision', async () => {
  const token = 'opaque.[secret]+nonstandard';
  for (const fetchImpl of [async () => { throw Error(token); }, async () => ({ ...response([]), json: async () => ({ ok: false, error: 'debug ' + token }) })]) {
    const evidence = await read({ token, fetchImpl });
    assert.equal(evidence.complete, false); assert.equal(JSON.stringify(evidence).includes(token), false); assert.equal(slackContext(evidence).includes(token), false);
  }
  const collision = await read({ token: 'invalid_auth', fetchImpl: async () => ({ ...response([]), json: async () => ({ ok: false, error: 'invalid_auth' }) }) });
  assert.equal(JSON.stringify(collision).includes('invalid_auth'), false);
});


test('B2 legacy read failures still reject rather than returning a successful empty snapshot', async () => {
  for (const failure of ['HTTP 403', 'network failed']) {
    await assert.rejects(readEvidence('CB-fixture', async path => {
      if (!path.includes('/actions?')) return { ticket };
      throw Error(failure);
    }), /comments read failed/);
  }
});


test('B1 Slack rich-text fragments cannot erase entity scope or replacement from full correction text', async () => {
  const text = '`ga_cookie` là Analytics. Riêng `cart_cookie` phải là Strictly Required, không phải Analytics như phản hồi trước; không cần scan lại.';
  const slack = await read({ fetchImpl: async () => response([
    { ts: rootTs, text: 'Question', reply_count: 1, latest_reply: correctionTs },
    { ts: correctionTs, thread_ts: rootTs, text, blocks: [{ elements: [{ elements: [{ text: ' trong Cookie Bar, không phải Analytics như phản hồi trước' }] }] }] },
  ]) });
  const rule = correctionRules(slack).find(r => r.kind === 'value');
  assert.deepEqual(rule.anchors, ['cartcookie']);
  assert.equal(rule.replacement, 'strictly required');
  const verified = verify(slack, [fact('C', text, `slack:C083Z2KTZQS:${correctionTs}`)]);
  assert.equal(checkWriterOutput(output(text, ['C']), verified, config).ok, true);
  assert.equal(checkWriterOutput(output('`cart_cookie` là Analytics và cần scan lại.', ['C']), verified, config).ok, false);
});


test('B1 explicit removal of obsolete step and denial of Save confirmation are not positive claims', async () => {
  const slack = await read();
  assert.deepEqual(correctionConflicts(slack, 'Đính chính phân loại cookie và bỏ bước scan lại.'), []);
  assert.equal(claimsCustomerSaved('ACK không bổ sung kết quả kỹ thuật hay xác nhận khách đã lưu cấu hình.'), false);
  assert.equal(claimsCustomerSaved('Dev xác nhận khách đã lưu cấu hình.'), true);
  assert.ok(correctionConflicts(slack, 'Cần scan lại.').length);
  assert.deepEqual(correctionConflicts(slack, 'oct/cct là Analytics trong phản hồi lúc 00:09 đã được dev đính chính lúc 11:55.'), []);
  assert.ok(correctionConflicts(slack, 'oct/cct là Analytics theo phản hồi lúc 00:09.').length);
});
