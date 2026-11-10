import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../chrome-extension/background.js', import.meta.url), 'utf8');
const start = source.indexOf('async function requestTsEliteAiChat(');
const end = source.indexOf('\nasync function requestHachimiSynthesis(', start);

test('summary-only request never enriches a report with new ticket context, even with a ticket ID in its text', async () => {
  let reads = 0;
  const sent = [];
  const context = vm.createContext({
    AI_BASE_URL: 'https://example.test',
    getAiAuthToken: async () => 'test-only-token',
    buildAiTicketContext: async () => { reads++; return 'NEW TICKET DATA'; },
    fetch: async (url, request) => {
      sent.push(JSON.parse(request.body));
      return { ok: true, status: 200, json: async () => ({ jobId: 'test-job' }) };
    },
  });
  vm.runInContext(source.slice(start, end), context);
  const message = 'Summarize report for AIR-260917-YpAND9 without adding new information.';
  await context.requestTsEliteAiChat({ message, chatId: 'summary', summaryOnly: true, ticketContext: 'also excluded' });
  assert.equal(reads, 0);
  assert.equal(sent[0].message, message);
  await context.requestTsEliteAiChat({ message, chatId: 'research' });
  assert.equal(reads, 1);
  assert.match(sent[1].message, /NEW TICKET DATA/);
});
