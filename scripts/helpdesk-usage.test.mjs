import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usageRoute, summarizeHelpdeskUsage, runHelpdeskFlow, currentHelpdeskFlow } from './helpdesk-usage.mjs';

test('usage routes omit ticket IDs and query strings', () => {
  assert.equal(usageRoute('https://helpdesk.avada.net/api/external/tickets/secret-123/actions?cursor=private'), '/tickets/:id/actions');
  assert.equal(usageRoute('/tickets/secret-123/comments'), '/tickets/:id/comments');
  assert.equal(usageRoute('/notifications/secret-123'), '[other]');
});

test('flow context stays with concurrent asynchronous work', async () => {
  const values = await Promise.all([
    runHelpdeskFlow('analytics-full', async () => { await Promise.resolve(); return currentHelpdeskFlow(); }),
    runHelpdeskFlow('analytics-recent', async () => { await Promise.resolve(); return currentHelpdeskFlow(); }),
  ]);
  assert.deepEqual(values, ['analytics-full','analytics-recent']);
  assert.equal(currentHelpdeskFlow(), '');
});

test('usage summary groups by process, flow, route and hour without old events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helpdesk-usage-'));
  const file = join(dir, 'sample.jsonl');
  await writeFile(file, [
    { at:'2026-10-28T07:00:00.000Z', process:'trace', flow:'analytics-full', route:'/tickets/:id/actions' },
    { at:'2026-10-28T07:02:00.000Z', process:'trace', flow:'analytics-full', route:'/tickets/:id/actions' },
    { at:'2026-10-28T07:03:00.000Z', process:'web', flow:'date-follow', route:'/tickets/:id/actions' },
    { at:'2026-10-27T07:00:00.000Z', process:'old', flow:'old', route:'/tickets' },
  ].map(x=>JSON.stringify(x)).join('\n')+'\n');
  const result = await summarizeHelpdeskUsage({ since: Date.parse('2026-10-28T00:00:00Z'), file });
  assert.equal(result.total, 3);
  assert.deepEqual(result.processes, [{name:'trace',count:2},{name:'web',count:1}]);
  assert.deepEqual(result.instances, [{name:'trace · unknown',count:2},{name:'web · unknown',count:1}]);
  assert.deepEqual(result.flows, [{name:'trace · analytics-full',count:2},{name:'web · date-follow',count:1}]);
  assert.deepEqual(result.hours, [{name:'2026-10-28T07:00Z',count:3}]);
});
