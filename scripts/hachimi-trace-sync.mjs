#!/usr/bin/env node
// Sync check-ticket traces (relay state, widget log, automatic jobs + run artifacts) into PostgreSQL.
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, query, withTransaction, closePool } from './hachimi-db.mjs';
import { retentionDays, insertSources, recordTrace, normalizeIngest } from './hachimi-trace-store.mjs';
import { parseSourcesSection, normalizeSource } from './hachimi-trace-sources.mjs';

const CHECK_TICKET = resolve(ROOT, 'runtime/check-ticket');
const RELAY_STATE = resolve(CHECK_TICKET, 'chat-relay-state.json');
const AUTOMATIC_STATE = resolve(CHECK_TICKET, 'state.json');
const WIDGET_LOG = resolve(CHECK_TICKET, 'widget-chat.jsonl');
const JOBS_DIR = resolve(CHECK_TICKET, 'jobs');
const TERMINAL_KINDS = new Set(['done', 'error', 'cancelled']);
const TEXT_ARTIFACTS = new Set(['.json', '.txt', '.css', '.md', '.html', '.log']);
const MAX_ARTIFACT_CHARS = 200_000;

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function upsertSession(client, session) {
  const { rows: [row] } = await client.query(`
    INSERT INTO trace_sessions (source, external_id, ticket_reference, ticket_id, subject, trigger, status, phase, category, terminal, started_at, ended_at, metadata, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, false), $11, $12, COALESCE($13::jsonb, '{}'::jsonb), COALESCE($11::timestamptz, now()) + make_interval(days => $14))
    ON CONFLICT (source, external_id) DO UPDATE SET
      ticket_reference = COALESCE(EXCLUDED.ticket_reference, trace_sessions.ticket_reference),
      ticket_id = COALESCE(EXCLUDED.ticket_id, trace_sessions.ticket_id),
      subject = COALESCE(EXCLUDED.subject, trace_sessions.subject),
      trigger = COALESCE(EXCLUDED.trigger, trace_sessions.trigger),
      status = COALESCE(EXCLUDED.status, trace_sessions.status),
      phase = COALESCE(EXCLUDED.phase, trace_sessions.phase),
      category = COALESCE(EXCLUDED.category, trace_sessions.category),
      terminal = trace_sessions.terminal OR EXCLUDED.terminal,
      started_at = COALESCE(trace_sessions.started_at, EXCLUDED.started_at),
      ended_at = COALESCE(EXCLUDED.ended_at, trace_sessions.ended_at),
      metadata = trace_sessions.metadata || EXCLUDED.metadata,
      updated_at = now()
    RETURNING id`, [
    session.source, session.externalId, session.ticketReference ?? null, session.ticketId ?? null, session.subject ?? null,
    session.trigger ?? null, session.status ?? null, session.phase ?? null, session.category ?? null, session.terminal ?? null,
    session.startedAt ?? null, session.endedAt ?? null, session.metadata ? JSON.stringify(session.metadata) : null, retentionDays(),
  ]);
  return row.id;
}

// File channels (relay state, widget log) append in arrival order. A per-channel cursor in session metadata (`synced.<channel>`)
// records how many file events are already stored, so events appended live by the controller/bridge (seq = max+1) never collide
// with file positions. Legacy sessions (no cursor) count their actor-less rows, which only this sync ever wrote.
export async function insertEvents(client, sessionId, events, channel = 'file') {
  const { rows: [row] } = await client.query(`
    SELECT (s.metadata->'synced'->>$2)::int AS cursor,
           (SELECT count(*)::int FROM trace_events e WHERE e.session_id = s.id AND e.actor IS NULL) AS legacy,
           (SELECT COALESCE(max(seq), -1)::int FROM trace_events e WHERE e.session_id = s.id) AS max
    FROM trace_sessions s WHERE s.id = $1`, [sessionId, channel]);
  if (!row) return 0;
  const cursor = row.cursor ?? row.legacy;
  let seq = row.max + 1; let inserted = 0;
  for (const event of events.slice(cursor)) {
    const { rowCount } = await client.query(`
      INSERT INTO trace_events (session_id, seq, kind, text, payload, at, actor, phase) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (session_id, seq) DO NOTHING`,
      [sessionId, seq++, event.kind || 'text', String(event.text || ''), event.payload ? JSON.stringify(event.payload) : null, event.at || new Date().toISOString(), channel, event.phase || null]);
    inserted += rowCount;
  }
  if (events.length > cursor || row.cursor === null) await setSynced(client, sessionId, channel, events.length);
  return inserted;
}

async function setSynced(client, sessionId, key, value) {
  await client.query(`UPDATE trace_sessions SET metadata = metadata || jsonb_build_object('synced', COALESCE(metadata->'synced', '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)) WHERE id = $1`,
    [sessionId, key, JSON.stringify(value)]);
}

async function sourceCount(client, sessionId) {
  const { rows: [{ count }] } = await client.query('SELECT count(*)::int AS count FROM trace_sources WHERE session_id = $1', [sessionId]);
  return count;
}

async function sessionEvents(client, sessionId) {
  const { rows } = await client.query('SELECT id::int AS id, seq, kind, phase FROM trace_events WHERE session_id = $1 ORDER BY seq', [sessionId]);
  return rows;
}

const HELPDESK_URL = 'https://helpdesk.avada.net/tickets/';
const SKILL_ROUTES = { Customize: 'check-ticket-customize', Bug: 'check-ticket-bug', 'Feature request': 'check-ticket-feature-request', Question: 'check-ticket-question' };

// Backfill data sources for automatic jobs recorded before live source tracing existed (or whose controller trace never arrived):
// citations from elite.txt, the skill files used, the ticket, and each run artifact — attached to the matching timeline event.
async function backfillAutomaticSources(client, sessionId, job, artifacts, category) {
  if (!artifacts.length || await sourceCount(client, sessionId)) return 0;
  const events = await sessionEvents(client, sessionId);
  const at = predicate => events.find(predicate) || null;
  const anchor = (event, fallback) => { const target = event || fallback; return target ? { eventId: target.id, eventSeq: target.seq } : { eventId: null, eventSeq: -1 }; };
  const start = at(event => event.kind === 'start');
  const last = events.at(-1) || null;
  const phaseEvent = name => at(event => event.kind === 'phase' && event.phase === name);
  const sources = [];
  // Same validation as the HTTP ingest path; keep the timeline anchor alongside the normalized fields.
  const safe = source => { try { return { ...normalizeSource(source), eventId: source.eventId, eventSeq: source.eventSeq }; } catch { return null; } };
  if (job.reference) sources.push({ ...anchor(start), type: 'ticket', label: `Ticket ${job.reference}`, url: HELPDESK_URL + job.reference, excerpt: job.subject || null });
  const elite = artifacts.findLast(artifact => artifact.name === 'elite.txt');
  if (elite) {
    const where = anchor(phaseEvent('elite'), start);
    sources.push({ ...where, type: 'artifact', label: 'elite.txt', path: relative(ROOT, elite.sourcePath) });
    for (const cited of parseSourcesSection(elite.content)) sources.push({ ...where, ...cited });
  }
  const skillWhere = anchor(phaseEvent('classify'), start);
  sources.push({ ...skillWhere, type: 'skill', label: 'check-ticket/SKILL.md', path: 'skills/check-ticket/SKILL.md' });
  if (SKILL_ROUTES[category]) sources.push({ ...skillWhere, type: 'skill', label: `${SKILL_ROUTES[category]}/SKILL.md`, path: `skills/check-ticket/${SKILL_ROUTES[category]}/SKILL.md` });
  for (const artifact of artifacts) {
    if (['elite.txt', 'result-schema.json', 'input.json'].includes(artifact.name)) continue;
    const phase = artifact.name.replace(/-(result|observations|fallback)?\.[a-z]+$/, '').replace(/\.[a-z]+$/, '');
    const target = artifact.name === 'comment.txt' || artifact.name === 'review.json' ? at(event => event.kind === 'result') || last : phaseEvent(phase) || phaseEvent(phase.replace(/^elite$/, 'classify')) || last;
    sources.push({ ...anchor(target, last), type: 'artifact', label: artifact.name, path: relative(ROOT, artifact.sourcePath), locator: artifact.runId.slice(0, 8) });
  }
  const inserted = await insertSources(client, sessionId, sources.map(safe).filter(Boolean));
  return inserted.length;
}

// Widget answers streamed straight from TS Elite 2 carry their own "Sources" section: attach those citations to the done event once.
async function backfillWidgetSources(client, sessionId, events) {
  if (!events.some(event => TERMINAL_KINDS.has(event.kind))) return 0;
  const { rows: [row] } = await client.query(`SELECT (metadata->'synced'->>'widgetSources') AS done FROM trace_sessions WHERE id = $1`, [sessionId]);
  if (row?.done) return 0;
  await setSynced(client, sessionId, 'widgetSources', true);
  if (await sourceCount(client, sessionId)) return 0; // the bridge already traced this turn's sources
  const cited = parseSourcesSection(events.filter(event => event.kind === 'text').map(event => event.text || '').join(''));
  if (!cited.length) return 0;
  const stored = await sessionEvents(client, sessionId);
  const target = stored.findLast(event => TERMINAL_KINDS.has(event.kind)) || stored.at(-1);
  const inserted = await insertSources(client, sessionId, cited.map(source => ({ ...source, eventId: target?.id ?? null, eventSeq: target?.seq ?? -1 })));
  return inserted.length;
}

function referenceFromText(text) {
  return String(text || '').match(/\b[A-Z]{2,6}-\d{6}-[A-Za-z0-9]{4,}\b/)?.[0] ?? null;
}

function sessionFromEvents(source, id, events, extra = {}) {
  const last = events.at(-1);
  const terminal = Boolean(last && TERMINAL_KINDS.has(last.kind));
  return {
    source, externalId: id, terminal,
    ticketReference: events.map(event => referenceFromText(event.text)).find(Boolean) ?? null,
    startedAt: events[0]?.at ?? null, endedAt: terminal ? last.at : null, status: terminal ? last.kind : null, ...extra,
  };
}

async function syncRelayTraces(stats) {
  const state = await readJson(RELAY_STATE, null);
  for (const trace of Object.values(state?.traces || {})) {
    await withTransaction(async client => {
      const sessionId = await upsertSession(client, sessionFromEvents(trace.source, trace.id, trace.events, { metadata: { relayDispatch: trace.dispatch } }));
      stats.events += await insertEvents(client, sessionId, trace.events, 'relay');
    });
    stats.sessions++;
  }
}

async function syncWidgetLog(stats) {
  let raw;
  try { raw = await readFile(WIDGET_LOG, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const grouped = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { stats.skippedLines++; continue; }
    if (!event.id) continue;
    (grouped.get(event.id) || grouped.set(event.id, []).get(event.id)).push(event);
  }
  for (const [id, events] of grouped) {
    await withTransaction(async client => {
      const chatId = events.find(event => typeof event.chatId === 'string')?.chatId;
      const sessionId = await upsertSession(client, sessionFromEvents('widget', id, events, chatId ? { metadata: { chatId } } : {}));
      stats.events += await insertEvents(client, sessionId, events, 'widget');
      stats.sources += await backfillWidgetSources(client, sessionId, events);
    });
    stats.sessions++;
  }
}

async function runArtifacts(jobDir) {
  const artifacts = [];
  let runs;
  try { runs = await readdir(jobDir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return artifacts; throw error; }
  for (const run of runs.filter(entry => entry.isDirectory())) {
    const runDir = resolve(jobDir, run.name);
    for (const entry of await readdir(runDir, { withFileTypes: true })) {
      if (!entry.isFile() || !TEXT_ARTIFACTS.has(extname(entry.name))) continue;
      const path = resolve(runDir, entry.name);
      if ((await stat(path)).size > MAX_ARTIFACT_CHARS * 4) continue;
      const content = (await readFile(path, 'utf8')).slice(0, MAX_ARTIFACT_CHARS);
      let contentJson = null;
      if (extname(entry.name) === '.json') { try { contentJson = JSON.parse(content); } catch { /* keep as text */ } }
      artifacts.push({ runId: run.name, name: entry.name, content, contentJson, sourcePath: resolve(ROOT, path) });
    }
  }
  return artifacts;
}

// The controller appends every event it emits to jobs/<job>/trace.jsonl. Lines marked delivered:false never reached the
// tracing web (it was stopped or too slow): store them now, once, through the same validation as a live ingest.
export async function undeliveredTrace(path) {
  let raw;
  try { raw = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const events = [];
  // A line still being written has no newline yet: leave it for the next pass.
  for (const line of raw.slice(0, raw.lastIndexOf('\n') + 1).split('\n')) {
    if (!line.trim()) continue;
    let event; try { event = JSON.parse(line); } catch { event = null; }
    if (event?.delivered === false) events.push(event);
  }
  return events;
}

export async function syncUndeliveredTrace(job, stats) {
  const events = await undeliveredTrace(resolve(JOBS_DIR, job.id, 'trace.jsonl'));
  if (!events.length) return;
  const { rows: [row] } = await query(`SELECT id, COALESCE((metadata->'synced'->>'undelivered')::int, 0) AS cursor FROM trace_sessions WHERE source = 'automatic' AND external_id = $1`, [job.id]);
  if (!row || events.length <= row.cursor) return;
  const valid = [];
  for (const { delivered, runId, ...event } of events.slice(row.cursor)) {
    try { normalizeIngest({ source: 'automatic', id: job.id, events: [event] }); valid.push(event); } catch { stats.skippedLines++; }
  }
  for (let start = 0; start < valid.length; start += 200) {
    // terminal/status/phase stay owned by the job state above; these are timeline events only.
    const result = await recordTrace({ source: 'automatic', id: job.id, terminal: false, status: job.status ?? undefined, phase: job.phase ?? undefined, events: valid.slice(start, start + 200) });
    stats.events += result.events.length;
    stats.sources += result.events.reduce((total, event) => total + event.sources.length, 0);
  }
  await withTransaction(client => setSynced(client, row.id, 'undelivered', events.length));
}

async function syncAutomaticJobs(stats) {
  const state = await readJson(AUTOMATIC_STATE, null);
  const jobs = Object.values(state?.jobs || {});
  for (const job of jobs) {
    const artifacts = await runArtifacts(resolve(JOBS_DIR, job.id));
    const classify = artifacts.findLast(artifact => artifact.name === 'classify-result.json')?.contentJson;
    const { telegram, ...metadata } = job;
    const terminal = ['done', 'failed', 'error', 'cancelled', 'needs_attention', 'uncertain'].includes(job.status);
    await withTransaction(async client => {
      const { rows: [prior] } = await client.query(`SELECT s.terminal, (SELECT count(*)::int FROM trace_events e WHERE e.session_id = s.id) AS events,
        (SELECT count(*)::int FROM trace_events e WHERE e.session_id = s.id AND e.kind IN ('done', 'error', 'cancelled', 'result')) AS outcomes
        FROM trace_sessions s WHERE s.source = 'automatic' AND s.external_id = $1`, [job.id]);
      const sessionId = await upsertSession(client, {
        source: 'automatic', externalId: job.id, ticketReference: job.reference ?? null, ticketId: job.id, subject: job.subject ?? null,
        trigger: job.trigger ?? null, status: job.status ?? null, phase: job.phase ?? null, category: classify?.category ?? null,
        terminal: ['done', 'failed', 'error', 'cancelled'].includes(job.status), startedAt: job.createdAt ?? null,
        metadata: { job: metadata, telegram: telegram && Object.fromEntries(Object.entries(telegram).map(([key, value]) => [key, value?.status])) },
      });
      for (const artifact of artifacts) {
        const { rowCount } = await client.query(`
          INSERT INTO trace_artifacts (session_id, run_id, name, content, content_json, source_path) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (session_id, run_id, name) DO UPDATE SET content = EXCLUDED.content, content_json = EXCLUDED.content_json
            WHERE trace_artifacts.content IS DISTINCT FROM EXCLUDED.content`,
          [sessionId, artifact.runId, artifact.name, artifact.content, artifact.contentJson === null ? null : JSON.stringify(artifact.contentJson), artifact.sourcePath]);
        stats.artifacts += rowCount;
      }
      // Backfill a readable timeline from the job state: a start marker once, and the outcome once the job becomes terminal.
      const pending = [];
      if (!prior || prior.events === 0) pending.push({ kind: 'start', at: job.createdAt, text: `Automatic check-ticket • ${job.reference || job.id}${job.subject ? ` • ${job.subject}` : ''}`, phase: 'queued', actor: 'controller' });
      if (terminal && !(prior?.outcomes > 0)) {
        const at = job.finishedAt || job.failedAt || new Date().toISOString();
        if (job.status === 'done') {
          if (job.comment) pending.push({ kind: 'result', at, text: job.comment, phase: 'comment', actor: 'controller' });
          pending.push({ kind: 'done', at, text: `Helpdesk comment đã được xác nhận: ${job.commentId || 'không có ID'}; Telegram completed: ${telegram?.completed?.status || 'chưa có'}`, phase: job.phase || 'comment', actor: 'controller' });
        } else {
          const stopped = job.status === 'cancelled' ? '' : ` • dừng ở pha ${job.phase || 'không rõ'} sau ${job.attempts || 0} lần thử (${job.status})`;
          pending.push({ kind: job.status === 'cancelled' ? 'cancelled' : 'error', at, text: `${job.lastError || job.status}${stopped}`, phase: job.phase || null, actor: 'controller' });
        }
      }
      if (pending.length) {
        const { rows: [{ next }] } = await client.query('SELECT COALESCE(max(seq), -1) + 1 AS next FROM trace_events WHERE session_id = $1', [sessionId]);
        for (const [offset, event] of pending.entries()) {
          const { rowCount } = await client.query('INSERT INTO trace_events (session_id, seq, kind, text, at, phase, actor) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (session_id, seq) DO NOTHING',
            [sessionId, Number(next) + offset, event.kind, event.text, event.at, event.phase, event.actor]);
          stats.events += rowCount;
        }
        if (terminal) await client.query('UPDATE trace_sessions SET terminal = true, ended_at = COALESCE(ended_at, $2), updated_at = now() WHERE id = $1', [sessionId, job.finishedAt || null]);
      }
      stats.sources += await backfillAutomaticSources(client, sessionId, job, artifacts, classify?.category ?? null);
    });
    await syncUndeliveredTrace(job, stats);
    stats.jobs++;
  }
}

export async function syncTraces() {
  const stats = { sessions: 0, events: 0, jobs: 0, artifacts: 0, sources: 0, skippedLines: 0 };
  await syncRelayTraces(stats);
  await syncWidgetLog(stats);
  await syncAutomaticJobs(stats);
  return stats;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await syncTraces()));
    const { rows: [totals] } = await query('SELECT (SELECT count(*) FROM trace_sessions)::int AS sessions, (SELECT count(*) FROM trace_events)::int AS events, (SELECT count(*) FROM trace_artifacts)::int AS artifacts');
    console.log(JSON.stringify({ totals }));
  } catch (error) {
    console.error(`Trace sync failed: ${error.message}`);
    process.exitCode = 1;
  } finally { await closePool(); }
}
