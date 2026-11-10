#!/usr/bin/env node
// Trace storage for the Hachimi tracing web: ingest sessions/events, list/read, purge after retention.
import { query, withTransaction, loadEnv } from './hachimi-db.mjs';
import { normalizeSources } from './hachimi-trace-sources.mjs';

export const DEFAULT_RETENTION_DAYS = 10;
// `warning` is a problem the run survives (a failed attempt that will be retried, a fallback); `error` ends the session.
export const EVENT_KINDS = new Set(['start', 'phase', 'waiting', 'text', 'thinking', 'tool', 'observation', 'note', 'warning', 'result', 'done', 'error', 'cancelled']);
const TERMINAL_KINDS = new Set(['done', 'error', 'cancelled']);
const ID_RE = /^[a-zA-Z0-9_.:-]{1,120}$/;
const SOURCE_RE = /^[a-z0-9_-]{1,32}$/;
const MAX_TEXT = 20_000;
const MAX_BATCH = 200;

export function retentionDays() {
  const raw = Number(process.env.HACHIMI_TRACE_RETENTION_DAYS || loadEnv().HACHIMI_TRACE_RETENTION_DAYS);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_RETENTION_DAYS;
}

const clean = (value, max = 500) => value === undefined || value === null ? null : String(value).slice(0, max);
const isoOrNull = value => { const ms = Date.parse(value); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; };

// Validate an ingest payload: { source, id, ticketReference?, subject?, category?, status?, phase?, trigger?, metadata?, sources?, events: [{kind,text,at?,payload?,actor?,phase?,sources?}] }
// sources: [{ type: docs|skill|kb|elite|ticket|url|artifact|file, label?, path?, url?, locator?, excerpt?, metadata? }] — data the AI consulted at that event.
export function normalizeIngest(body) {
  if (!body || typeof body !== 'object') throw new TypeError('Body must be an object.');
  const source = String(body.source || '').toLowerCase();
  const id = String(body.id || body.externalId || '');
  if (!SOURCE_RE.test(source)) throw new TypeError('Invalid source.');
  if (!ID_RE.test(id)) throw new TypeError('Invalid id.');
  const events = Array.isArray(body.events) ? body.events : body.event ? [body.event] : [];
  if (events.length > MAX_BATCH) throw new TypeError(`At most ${MAX_BATCH} events per request.`);
  const normalized = events.map(event => {
    if (!event || typeof event !== 'object') throw new TypeError('Event must be an object.');
    const kind = String(event.kind || 'text').toLowerCase();
    if (!EVENT_KINDS.has(kind)) throw new TypeError(`Unknown event kind: ${kind}`);
    if (event.text !== undefined && typeof event.text !== 'string') throw new TypeError('Event text must be a string.');
    let payload = null;
    if (event.payload !== undefined && event.payload !== null) {
      payload = JSON.stringify(event.payload);
      if (payload.length > 200_000) throw new TypeError('Event payload too large.');
    }
    return { kind, text: (event.text || '').slice(0, MAX_TEXT), payload, at: isoOrNull(event.at) || new Date().toISOString(), actor: clean(event.actor, 80) || 'api', phase: clean(event.phase, 120), sources: normalizeSources(event.sources) };
    // actor is never null for live ingest: file sync relies on NULL to recognise its own legacy rows.
  });
  const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : null;
  return {
    source, id, events: normalized,
    ticketReference: clean(body.ticketReference, 120), ticketId: clean(body.ticketId, 120), subject: clean(body.subject, 500),
    trigger: clean(body.trigger, 80), status: clean(body.status, 80), phase: clean(body.phase, 120), category: clean(body.category, 80),
    terminal: typeof body.terminal === 'boolean' ? body.terminal : normalized.some(event => TERMINAL_KINDS.has(event.kind)) || null,
    startedAt: isoOrNull(body.startedAt), endedAt: isoOrNull(body.endedAt), metadata,
    sources: normalizeSources(body.sources), // session-level sources (event_seq = -1)
  };
}

// Insert sources for one session. `sources` items carry { eventId, eventSeq, ...source }. Duplicates (same event/type/path/url/locator) are ignored.
export async function insertSources(client, sessionId, sources) {
  const inserted = [];
  for (const source of sources) {
    const { rows: [row] } = await client.query(`
      INSERT INTO trace_sources (session_id, event_id, event_seq, type, label, path, url, locator, excerpt, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::jsonb, '{}'::jsonb))
      ON CONFLICT (session_id, event_seq, type, coalesce(path, ''), coalesce(url, ''), coalesce(locator, '')) DO NOTHING
      RETURNING id::int AS id, event_id::int AS event_id, event_seq, type, label, path, url, locator, excerpt, metadata, created_at`,
      [sessionId, source.eventId ?? null, source.eventSeq ?? -1, source.type, source.label, source.path, source.url, source.locator, source.excerpt, source.metadata ? JSON.stringify(source.metadata) : null]);
    if (row) inserted.push(row);
  }
  return inserted;
}

async function sourcesForSession(sessionId, runner = query) {
  const { rows } = await runner('SELECT id::int AS id, event_id::int AS event_id, event_seq, type, label, path, url, locator, excerpt, metadata, created_at FROM trace_sources WHERE session_id = $1 ORDER BY event_seq, id', [sessionId]);
  return rows;
}

function attachSources(events, sources) {
  const bySeq = new Map();
  for (const source of sources) if (source.event_seq >= 0) (bySeq.get(source.event_seq) || bySeq.set(source.event_seq, []).get(source.event_seq)).push(source);
  for (const event of events) event.sources = bySeq.get(event.seq) || [];
  return events;
}

export async function recordTrace(body, { days = retentionDays() } = {}) {
  const trace = normalizeIngest(body);
  const first = trace.events[0];
  const last = trace.events.at(-1);
  const terminalEvent = trace.events.find(event => TERMINAL_KINDS.has(event.kind));
  return withTransaction(async client => {
    const { rows: [session] } = await client.query(`
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
      RETURNING id::int AS id, source, external_id, ticket_reference, expires_at`, [
      trace.source, trace.id, trace.ticketReference, trace.ticketId, trace.subject, trace.trigger,
      trace.status ?? (terminalEvent ? terminalEvent.kind : null), trace.phase ?? last?.phase ?? null, trace.category, trace.terminal,
      trace.startedAt ?? first?.at ?? null, trace.endedAt ?? terminalEvent?.at ?? null, trace.metadata ? JSON.stringify(trace.metadata) : null, days,
    ]);
    const { rows: [{ next }] } = await client.query('SELECT COALESCE(max(seq), -1) + 1 AS next FROM trace_events WHERE session_id = $1', [session.id]);
    const inserted = [];
    for (const [offset, event] of trace.events.entries()) {
      const { rows: [row] } = await client.query(`
        INSERT INTO trace_events (session_id, seq, kind, text, payload, at, actor, phase) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id::int AS id, seq, kind, text, payload, at, actor, phase`,
        [session.id, Number(next) + offset, event.kind, event.text, event.payload, event.at, event.actor, event.phase]);
      row.sources = await insertSources(client, session.id, event.sources.map(source => ({ ...source, eventId: row.id, eventSeq: row.seq })));
      inserted.push(row);
    }
    const sessionSources = await insertSources(client, session.id, trace.sources.map(source => ({ ...source, eventId: null, eventSeq: -1 })));
    return { sessionId: session.id, source: session.source, externalId: session.external_id, ticketReference: session.ticket_reference, expiresAt: session.expires_at, events: inserted, sources: sessionSources };
  });
}

export async function listSessions({ q = '', source = '', status = '', chatId = '', ticket = '', limit = 50, offset = 0 } = {}) {
  const where = ['1=1']; const params = [];
  if (chatId) { params.push(chatId); where.push(`s.metadata->>'chatId' = $${params.length}`); }
  if (ticket) { params.push(ticket); where.push(`(s.ticket_reference = $${params.length} OR s.ticket_id = $${params.length})`); }
  if (q) { params.push(`%${q}%`); where.push(`(s.ticket_reference ILIKE $${params.length} OR s.subject ILIKE $${params.length} OR s.external_id ILIKE $${params.length})`); }
  if (source) { params.push(source); where.push(`s.source = $${params.length}`); }
  if (status === 'active') where.push('s.terminal = false');
  else if (status === 'terminal') where.push('s.terminal = true');
  else if (status) { params.push(status); where.push(`s.status = $${params.length}`); }
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 500), Math.max(Number(offset) || 0, 0));
  const { rows } = await query(`
    SELECT s.id::int AS id, s.source, s.external_id, s.ticket_reference, s.subject, s.trigger, s.status, s.phase, s.category, s.terminal,
           s.started_at, s.ended_at, s.created_at, s.updated_at, s.expires_at,
           (SELECT count(*) FROM trace_events e WHERE e.session_id = s.id)::int AS event_count,
           (SELECT count(*) FROM trace_artifacts a WHERE a.session_id = s.id)::int AS artifact_count,
           (SELECT count(*) FROM trace_sources src WHERE src.session_id = s.id)::int AS source_count,
           (SELECT e.text FROM trace_events e WHERE e.session_id = s.id ORDER BY e.seq DESC LIMIT 1) AS last_text,
           (SELECT e.kind FROM trace_events e WHERE e.session_id = s.id ORDER BY e.seq DESC LIMIT 1) AS last_kind
    FROM trace_sessions s WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(s.started_at, s.created_at) DESC, s.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  const { rows: [{ total }] } = await query(`SELECT count(*)::int AS total FROM trace_sessions s WHERE ${where.join(' AND ')}`, params.slice(0, -2));
  return { sessions: rows.map(row => ({ ...row, last_text: row.last_text?.slice(0, 200) ?? null })), total };
}

export async function lookupSession(source, externalId) {
  const { rows: [row] } = await query('SELECT id::int AS id FROM trace_sessions WHERE source = $1 AND external_id = $2', [source, externalId]);
  return row?.id ?? null;
}

export async function getSession(id) {
  const { rows: [session] } = await query('SELECT s.*, s.id::int AS id FROM trace_sessions s WHERE s.id = $1', [id]);
  if (!session) return null;
  const { rows: events } = await query('SELECT id::int AS id, seq, kind, text, payload, at, actor, phase FROM trace_events WHERE session_id = $1 ORDER BY seq', [id]);
  const { rows: artifacts } = await query('SELECT id::int AS id, run_id, name, length(content)::int AS size, created_at FROM trace_artifacts WHERE session_id = $1 ORDER BY run_id, name', [id]);
  const sources = await sourcesForSession(id);
  return { session, events: attachSources(events, sources), artifacts, sources };
}

export async function getEvents(id, after = -1) {
  const { rows } = await query('SELECT id::int AS id, seq, kind, text, payload, at, actor, phase FROM trace_events WHERE session_id = $1 AND seq > $2 ORDER BY seq', [id, after]);
  const { rows: sources } = await query('SELECT id::int AS id, event_id::int AS event_id, event_seq, type, label, path, url, locator, excerpt, metadata, created_at FROM trace_sources WHERE session_id = $1 AND event_seq > $2 ORDER BY event_seq, id', [id, after]);
  return attachSources(rows, sources);
}

export async function getSessionSources(id) {
  return sourcesForSession(id);
}

// One source plus the session/event it belongs to (for the standalone viewer page).
export async function getSource(sourceId) {
  const { rows: [row] } = await query(`
    SELECT src.id::int AS id, src.event_id::int AS event_id, src.event_seq, src.type, src.label, src.path, src.url, src.locator, src.excerpt, src.metadata, src.created_at,
           s.id::int AS session_id, s.source AS session_source, s.external_id, s.ticket_reference, s.subject, s.category,
           e.kind AS event_kind, e.text AS event_text, e.at AS event_at, e.phase AS event_phase
    FROM trace_sources src JOIN trace_sessions s ON s.id = src.session_id LEFT JOIN trace_events e ON e.id = src.event_id
    WHERE src.id = $1`, [sourceId]);
  if (!row) return null;
  const { session_id, session_source, external_id, ticket_reference, subject, category, event_kind, event_text, event_at, event_phase, ...source } = row;
  return {
    source,
    session: { id: session_id, source: session_source, external_id, ticket_reference, subject, category },
    event: source.event_id ? { id: source.event_id, seq: source.event_seq, kind: event_kind, text: event_text?.slice(0, 500) ?? '', at: event_at, phase: event_phase } : null,
  };
}

// Knowledge chunk behind a `kb` source (hachimi-docs-search result): chunk text plus its parent document path.
export async function getKnowledgeChunk(chunkId) {
  const { rows: [row] } = await query('SELECT c.id::int AS id, c.heading, c.content, c.chunk_index, c.app_slug, d.source_path, d.title FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = $1', [chunkId]);
  return row || null;
}

export async function getArtifact(sessionId, artifactId) {
  const { rows: [row] } = await query('SELECT id::int AS id, run_id, name, content, content_json, source_path, created_at FROM trace_artifacts WHERE session_id = $1 AND id = $2', [sessionId, artifactId]);
  return row || null;
}

export async function deleteSession(id) {
  const { rowCount } = await query('DELETE FROM trace_sessions WHERE id = $1', [id]);
  return rowCount;
}

export async function stats(days = retentionDays()) {
  const { rows: [row] } = await query(`
    SELECT (SELECT count(*) FROM trace_sessions)::int AS sessions,
           (SELECT count(*) FROM trace_sessions WHERE terminal = false)::int AS active_sessions,
           (SELECT count(*) FROM trace_events)::int AS events,
           (SELECT count(*) FROM trace_artifacts)::int AS artifacts,
           (SELECT count(*) FROM trace_sources)::int AS sources,
           (SELECT count(*) FROM trace_sessions WHERE expires_at < now() + interval '1 day')::int AS expiring_soon,
           (SELECT count(*) FROM trace_sessions WHERE expires_at <= now())::int AS expired,
           (SELECT min(expires_at) FROM trace_sessions) AS next_expiry,
           (SELECT row_to_json(r) FROM (SELECT ran_at, deleted_sessions, retention_days, trigger FROM trace_retention_runs ORDER BY ran_at DESC LIMIT 1) r) AS last_purge,
           (SELECT pg_size_pretty(pg_total_relation_size('trace_events') + pg_total_relation_size('trace_sessions') + pg_total_relation_size('trace_artifacts') + pg_total_relation_size('trace_sources'))) AS storage`);
  return { ...row, retention_days: days };
}

export async function purgeExpired({ days = retentionDays(), trigger = 'scheduled' } = {}) {
  return withTransaction(async client => {
    const { rowCount } = await client.query('DELETE FROM trace_sessions WHERE expires_at <= now()');
    await client.query('INSERT INTO trace_retention_runs (retention_days, deleted_sessions, trigger) VALUES ($1, $2, $3)', [days, rowCount, trigger]);
    // Keep the audit table itself small.
    await client.query("DELETE FROM trace_retention_runs WHERE ran_at < now() - interval '60 days'");
    return { deletedSessions: rowCount, retentionDays: days, trigger };
  });
}
