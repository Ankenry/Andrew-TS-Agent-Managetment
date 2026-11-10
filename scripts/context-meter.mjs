// Pure context snapshots. No RPC, process control, persisted state or compaction.
import { resolve } from 'node:path';

const count = (value) => Number.isSafeInteger(value) && value >= 0;
export const DEFAULT_MAX_AGE_MS = 300_000;

export function contextMeter(sample, binding, { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  if (!binding?.sessionId || !binding?.workspace) throw new Error('Session and workspace binding required');
  if (sample.sessionId !== binding.sessionId || !sample.workspace
    || resolve(sample.workspace) !== resolve(binding.workspace)) throw new Error('Session/workspace mismatch');
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error('Invalid clock/freshness limit');
  const result = {
    runtime: sample.runtime, sessionId: binding.sessionId, workspace: resolve(binding.workspace),
    model: sample.model || null, observedAt: sample.observedAt || null,
    status: sample.status || 'unknown', quality: 'missing',
    usedTokens: null, windowTokens: null, percent: null, exceedsHalf: false,
    thresholdTokens: null, previewOnly: true,
  };
  if (!count(sample.usedTokens) || !count(sample.windowTokens) || sample.windowTokens === 0) return result;
  const at = Date.parse(sample.observedAt);
  if (!Number.isFinite(at)) return result;
  result.quality = now < at ? 'future' : now - at > maxAgeMs ? 'stale' : 'fresh';
  if (result.quality !== 'fresh') return result;
  result.usedTokens = sample.usedTokens;
  result.windowTokens = sample.windowTokens;
  result.percent = sample.usedTokens * 100 / sample.windowTokens;
  result.exceedsHalf = sample.usedTokens > sample.windowTokens / 2;
  result.thresholdTokens = Math.floor(sample.windowTokens / 2) + 1;
  return result;
}

export function renderContextMeter(meter) {
  const prefix = `${meter.runtime} ${meter.sessionId} | context `;
  if (meter.percent === null) return `${prefix}${'░'.repeat(20)} -- (${meter.quality}; preview)`;
  const filled = Math.floor(Math.min(100, Math.max(0, meter.percent)) / 5);
  const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
  // Values describe the last token sample, not an estimate of unsampled tool output.
  const warning = meter.exceedsHalf ? '; >50%, no compaction requested' : '';
  return `${prefix}${bar} ${meter.percent.toFixed(1)}% (${meter.usedTokens}/${meter.windowTokens}; last sample; preview${warning})`;
}

export function nativeConfigPreview(meter) {
  if (meter.runtime !== 'Codex' || meter.quality !== 'fresh' || !meter.model) {
    throw new Error('Fresh Codex sample with model required for config preview');
  }
  return [
    '# PREVIEW ONLY: not written, loaded or enabled.',
    `# Model: ${meter.model}; observed effective context: ${meter.windowTokens} tokens.`,
    '# Recalculate after a model/window change. This numeric footer is not a graphical bar.',
    `model_auto_compact_token_limit = ${meter.thresholdTokens}`,
    'model_auto_compact_token_limit_scope = "total"',
    '',
    '[tui]',
    'status_line = ["model-with-reasoning", "context-used", "context-window-size"]',
    '',
  ].join('\n');
}

// Compact one-line terminal display; full binding remains available via --json.
// Do not use TUI escape sequences in redirected output or JSON mode.
export function renderTerminalContext(meter, columns = 80) {
  const label = `${meter.runtime} ${meter.sessionId.slice(0, 8)}`;
  const suffix = meter.percent === null ? `-- ${meter.quality}` : `${meter.percent.toFixed(1)}%`;
  const cells = Math.max(5, Math.min(20, Math.floor(columns) - label.length - suffix.length - 14));
  const filled = meter.percent === null ? 0 : Math.floor(Math.min(100, Math.max(0, meter.percent)) * cells / 100);
  return `${label} ${'█'.repeat(filled)}${'░'.repeat(cells - filled)} ${suffix} | preview`;
}

// Accepts an iterable of rollout lines so tests can supply fixtures without disk writes.
// Only metadata and token-count fields are retained. Conversation/tool/reasoning text
// is never returned, logged, persisted or used to calculate usage.
// Codex 0.162.1 serializes ContextCompactedEvent as event_msg/context_compacted
// and persisted CompactedItemWire as a top-level compacted rollout item. These
// are rollout names; contextCompaction is the separate app-server item name.
function isCompactionRecord(line) {
  if (!/"type"\s*:\s*"(?:compacted|context_compacted)"/.test(line)) return false;
  try {
    const record = JSON.parse(line);
    return record.type === 'compacted'
      || (record.type === 'event_msg' && record.payload?.type === 'context_compacted');
  } catch { return false; }
}

export async function readCodexMetrics(lines, binding, options) {
  let verified = false;
  let model = null;
  let status = 'unknown';
  let sample = null;
  for await (const line of lines) {
    if (verified && isCompactionRecord(line)) {
      // Neither an ACK nor the compacted history provides a fresh usage sample.
      // Retain the session/model binding and wait for the next token_count.
      sample = null;
      continue;
    }
    if (!/"type"\s*:\s*"(?:session_meta|turn_context|event_msg)"/.test(line)) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; } // Ignore an incomplete final append.
    const payload = record.payload || {};
    if (record.type === 'session_meta') {
      if (payload.id !== binding.sessionId || !payload.cwd
        || resolve(payload.cwd) !== resolve(binding.workspace)) throw new Error('Session/workspace mismatch');
      verified = true;
    }
    if (!verified) continue;
    if (record.type === 'turn_context') {
      if (payload.cwd && resolve(payload.cwd) !== resolve(binding.workspace)) throw new Error('Session moved to another workspace');
      if (typeof payload.model === 'string' && payload.model !== model) {
        model = payload.model;
        sample = null; // A prior model's usage/window must not survive a switch.
      }
    }
    if (record.type !== 'event_msg') continue;
    if (payload.type === 'task_started') status = 'active';
    if (payload.type === 'task_complete' || payload.type === 'task_aborted') status = 'idle';
    if (payload.type !== 'token_count') continue;
    sample = {
      usedTokens: payload.info?.last_token_usage?.total_tokens,
      windowTokens: payload.info?.model_context_window,
      observedAt: record.timestamp,
    };
  }
  if (!verified) throw new Error('Missing verified session metadata');
  return contextMeter({ ...sample, runtime: 'Codex', sessionId: binding.sessionId,
    workspace: binding.workspace, model, status }, binding, options);
}
