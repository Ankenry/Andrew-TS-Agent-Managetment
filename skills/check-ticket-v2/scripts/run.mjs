#!/usr/bin/env node
// node skills/check-ticket-v2/scripts/run.mjs <ticket URL or ID> --preview [--json] [--no-trace]
// node skills/check-ticket-v2/scripts/run.mjs --rewrite <job dir>   (redo only the write phase of a finished job)
// Preview only: prints the verified findings and the draft comment; never posts, uploads or notifies.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline, rewriteJob, loadSettings } from './pipeline.mjs';

const args = process.argv.slice(2);
const takeValue = flag => { const index = args.indexOf(flag); if (index < 0) return undefined; const [, value] = args.splice(index, 2); return value; };
const rewriteDir = takeValue('--rewrite') ?? null;
// --follow-up "<chỉ thị>" [--since <ISO>]: simulate a "@han" comment command (13/10/2026); the text is data for the pipeline.
const followUpText = takeValue('--follow-up');
const since = takeValue('--since');
const reference = args.find(arg => !arg.startsWith('--'));
const flags = new Set(args.filter(arg => arg.startsWith('--')));
const known = new Set(['--preview', '--json', '--no-trace']);
if ((!reference && !rewriteDir) || [...flags].some(flag => !known.has(flag)) || (process.argv.includes('--follow-up') && followUpText === undefined)) {
  console.error('Usage: node skills/check-ticket-v2/scripts/run.mjs <TICKET_URL_OR_ID> --preview [--json] [--no-trace] [--follow-up "<chỉ thị>"] [--since <ISO>]\n       node skills/check-ticket-v2/scripts/run.mjs --rewrite <job dir>');
  process.exit(1);
}
const followUp = followUpText === undefined ? null : { keyword: '@han', instruction: followUpText.trim() || 'check tiếp ticket theo các comment phản hồi mới kể từ lần check trước', defaultInstruction: !followUpText.trim(), commentId: null, commentAt: new Date().toISOString(), sinceAt: since || null, previousReport: null, preview: true };

async function makeTrace(reference) {
  if (flags.has('--no-trace')) return async () => {};
  const { sendTrace } = await import(resolve(fileURLToPath(new URL('../../../scripts/hachimi-trace-client.mjs', import.meta.url))));
  const now = new Date();
  const id = `v2-${reference}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  return async (kind, text, extra = {}) => {
    try { await sendTrace({ source: 'manual', id, ticketReference: reference, phase: extra.phase, events: [{ kind, text, actor: extra.actor || 'hanbui-v2', phase: extra.phase, payload: extra.payload, sources: extra.sources }] }, { timeoutMs: 2000, fallback: false }); } catch { /* tracing never blocks the review */ }
  };
}

const fmt = ms => `${(ms / 1000).toFixed(1)}s`;
try {
  const settings = await loadSettings();
  const log = phase => console.error(`[check-ticket-v2] ${phase}`);
  const result = rewriteDir
    ? await rewriteJob(resolve(rewriteDir), { settings, log })
    : await runPipeline(reference, { settings, log, trace: await makeTrace(reference.replace(/^https?:\/\/helpdesk\.avada\.net\/(?:t|tickets)\//, '').replace(/\/$/, '')), preview: true, followUp });
  if (flags.has('--json')) { console.log(JSON.stringify(result, null, 2)); }
  else {
    if (result.error) console.error(result.error);
    if (result.comment) console.log(result.comment);
    if (result.customerLetter) console.log('\n--- Thư khách (nháp: fact đã kiểm hoặc xin thông tin theo gap) ---\n' + result.customerLetter);
    if (result.verified) {
      console.log('\n--- Findings đã kiểm ---');
      for (const finding of result.verified.findings) {
        const score = finding.score === null || finding.score === undefined ? '-' : finding.score.toFixed(1);
        console.log(`${finding.id} [${finding.kind}${finding.demoted ? ' ←fact' : ''}] điểm ${score} (${finding.evidence_where || '-'})${finding.inference ? ' · suy luận' : ''}${finding.kind === 'gap' ? ` · blocker ${finding.blocker} ${finding.gap_ok ? 'hợp lệ' : `KHÔNG: ${finding.gap_reason}`}` : ''}\n   ${finding.claim}${finding.source?.ref ? `\n   nguồn: ${finding.source.ref}${finding.source.line ? `:${finding.source.line}` : ''}` : ''}`);
      }
    }
    if (result.postcheck && !result.postcheck.ok) console.log('\n--- Hậu kiểm từ chối ---\n- ' + result.postcheck.violations.join('\n- '));
    if (result.postcheck?.warnings?.length) console.log('\n--- Hậu kiểm cảnh báo (không chặn đăng) ---\n- ' + result.postcheck.warnings.join('\n- '));
    console.log(`\n--- Số đo --- trạng thái ${result.status} · tổng ${fmt(result.totalMs)} · ` + Object.entries(result.timings || {}).map(([name, ms]) => `${name} ${fmt(ms)}`).join(' · '));
    console.log(JSON.stringify(result.counts));
    console.error(`Artifacts: ${result.jobDir}. Không đăng comment, không upload.`);
  }
  if (result.status !== 'ok') process.exit(2);
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
