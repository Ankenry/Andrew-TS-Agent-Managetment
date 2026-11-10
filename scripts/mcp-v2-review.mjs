import { snapshotMcpEngine, SettingsError } from './mcp-v2-settings.mjs';

export function reviewRequest(body) {
  if (body?.intent !== 'ticket-review') return null;
  const reference = body.ticket?.ticketId;
  if (typeof reference !== 'string' || !/^[A-Z][A-Z0-9]{1,12}-\d{6}-[A-Za-z0-9]+$/.test(reference)) throw new SettingsError(400, 'MCP_TICKET_REFERENCE_REQUIRED');
  if (body.reviewFollowUp !== undefined && typeof body.reviewFollowUp !== 'boolean') throw new SettingsError(400, 'MCP_FOLLOW_UP_INVALID');
  if (body.expectedEngineRevision !== undefined && (!Number.isSafeInteger(body.expectedEngineRevision) || body.expectedEngineRevision < 0)) throw new SettingsError(400, 'MCP_ENGINE_REVISION_INVALID');
  return { reference, followUp: body.reviewFollowUp === true ? { instruction: String(body.message || '').slice(0, 2000) } : null };
}
export async function maybeMcpReview(body, { snapshot = snapshotMcpEngine, run = runMcpPreview } = {}) {
  const request = reviewRequest(body);
  if (!request) return null;
  const engine = await snapshot();
  if (body.expectedEngineRevision !== undefined && (!engine.enabled || body.expectedEngineRevision !== engine.revision)) throw new SettingsError(409, 'MCP_ENGINE_CHANGED');
  if (!engine.enabled) return null;
  return run(request, engine);
}
async function runMcpPreview(request, engineSnapshot) {
  const { runPipeline, loadSettings } = await import('../skills/check-ticket-v2/scripts/pipeline.mjs');
  const result = await runPipeline(request.reference, { settings: await loadSettings(), preview: true, mode: 'manual', followUp: request.followUp, engineSnapshot, signal: AbortSignal.timeout(600_000) });
  if (result.status !== 'ok' || !result.fullReport) throw new SettingsError(503, 'MCP_REVIEW_INCOMPLETE');
  return { answer: result.fullReport, engine: 'mcp-v2', revision: engineSnapshot.revision, runId: result.runId };
}
