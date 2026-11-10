// Command line shared by the follow skills. Each skill's run.mjs calls
// main(<its profile>, argv).
//   --preview    (default) read and assess only; prints the planned comments, writes nothing to Helpdesk/Telegram
//   --post       post progress comments and mail drafts now
//   --scheduled  the timer's mode: like --post, for the current slot, once per slot
//   --ticket <TICKET_URL_OR_ID>   one ticket only (no Telegram summary, no slot completion)
//   --force      assess again even when the thread did not change; rerun a completed slot
//   --json       print one JSON object on stdout (for the extension / TS Management web) instead of text
import { executeRun } from './service.mjs';
import { currentSlot, manualSlot, statusLabels } from './core.mjs';
import { settings, createIO, acquireLock } from './adapters.mjs';

const KNOWN = ['--preview', '--post', '--scheduled', '--ticket', '--force', '--json'];

export function ticketReference(value) {
  const url = String(value).match(/helpdesk\.avada\.net\/(?:t|tickets)\/([A-Za-z0-9_-]+)/i);
  const reference = url ? url[1] : String(value).trim();
  if (!/^[A-Za-z0-9_-]{4,80}$/.test(reference)) throw new Error('Ticket không hợp lệ.');
  return reference;
}

export function parseArgs(argv) {
  const args = [...argv];
  const flags = new Set(args.filter(arg => arg.startsWith('--')));
  const ticketIndex = args.indexOf('--ticket');
  const ticket = ticketIndex >= 0 ? String(args[ticketIndex + 1] || '') : '';
  const modes = ['--post', '--scheduled', '--preview'].filter(flag => flags.has(flag));
  const invalid = args.some(arg => arg.startsWith('--') && !KNOWN.includes(arg)) || modes.length > 1 || (ticketIndex >= 0 && !ticket);
  return { invalid, mode: (modes[0] || '--preview').slice(2), ticket, force: flags.has('--force'), json: flags.has('--json') };
}

// The machine-readable shape the UIs parse: the run as returned by executeRun,
// without the internal startedAt/finishedAt noise.
export function jsonReport(run, profile) {
  const labels = statusLabels(profile);
  return {
    skill: profile.name, slot: run.slot, mode: run.mode, skipped: run.skipped, notified: run.notified, notifyError: run.notifyError,
    results: (run.results || []).map(item => ({
      id: item.id, reference: item.reference, subject: item.subject, status: item.status, statusLabel: item.statusLabel || labels[item.status] || item.status,
      assessed: item.assessed === true, draft: item.draft, progress: item.progress, error: item.error,
    })),
  };
}

function printRun(run, profile) {
  const labels = statusLabels(profile);
  if (run.skipped) return console.log(`Khung ${run.slot.label} đã chạy xong trước đó, bỏ qua.`);
  console.log(`Lượt ${run.slot.label} (${run.mode}): ${run.results.length} ticket`);
  for (const item of run.results) {
    console.log(`\n=== ${item.reference} — ${item.error ? 'LỖI' : labels[item.status] || item.status}`);
    if (item.subject) console.log(item.subject);
    if (item.error) { console.log(item.error); continue; }
    console.log(`AI đánh giá lại: ${item.assessed ? 'có' : 'không (thread không đổi)'} · mail nháp: ${item.draft.action}${item.draft.kind !== 'none' ? ` (${item.draft.kind})` : ''} · tiến độ: ${item.progress.action} (${item.progress.reason})`);
    if (run.mode === 'preview') {
      if (item.draft.content) console.log(`\n--- Mail nháp sẽ lưu ---\n${item.draft.content}`);
      if (item.progress.content) console.log(`\n--- Comment tiến độ sẽ đăng ---\n${item.progress.content}`);
    }
  }
  if (run.mode === 'preview') console.error('\nPreview: chưa đăng comment, chưa gửi Telegram, chưa đổi state.');
  else if (run.notifyError) console.error(`Chưa gửi được Telegram: ${run.notifyError}`);
}

export async function main(profile, argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.invalid) {
    console.error(`Usage: node ${profile.skillDir}/scripts/run.mjs [--preview | --post | --scheduled] [--ticket <TICKET_URL_OR_ID>] [--force] [--json]`);
    process.exitCode = 2;
    return;
  }
  let release;
  try {
    const config = await settings(profile);
    if (options.mode === 'scheduled' && !config.enabled) {
      if (options.json) console.log(JSON.stringify({ skill: profile.name, mode: options.mode, skipped: 'disabled', results: [] }));
      else console.log(profile.disabledMessage);
      return;
    }
    const now = new Date();
    const slot = options.mode === 'scheduled' ? currentSlot(now, config.slots, config.timeZone) : manualSlot(now, config.timeZone);
    if (options.mode !== 'preview') release = await acquireLock(undefined, profile);
    const io = createIO(slot, config, { trace: options.mode !== 'preview', profile });
    const run = await executeRun(io, config, { mode: options.mode, only: options.ticket ? ticketReference(options.ticket) : '', force: options.force, now, profile });
    if (options.json) console.log(JSON.stringify(jsonReport(run, profile)));
    else printRun(run, profile);
    if (run.results.some(item => item.error)) process.exitCode = 1;
  } catch (error) {
    if (options.json) console.log(JSON.stringify({ skill: profile.name, mode: options.mode, error: String(error.message || error), results: [] }));
    console.error(error.message);
    process.exitCode = 1;
  } finally { await release?.(); }
}
