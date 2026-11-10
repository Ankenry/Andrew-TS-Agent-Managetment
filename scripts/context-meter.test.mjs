import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { contextMeter, nativeConfigPreview, readCodexMetrics, renderContextMeter } from './context-meter.mjs';
import { parseOptions } from './codex-context-monitor.mjs';
import { renderTerminalContext } from './context-meter.mjs';

const binding = { sessionId: '11111111-1111-4111-8111-111111111111', workspace: '/project/andrew' };
const now = Date.parse('2026-10-16T00:00:00Z');
const sample = { ...binding, runtime: 'Codex', model: 'fixture-model', usedTokens: 129200,
  windowTokens: 258400, observedAt: new Date(now).toISOString(), status: 'active' };
const meter = (change = {}, options = {}) => contextMeter({ ...sample, ...change }, binding, { now, ...options });
const line = (type, payload, timestamp = sample.observedAt) => JSON.stringify({ type, payload, timestamp });
const metadata = line('session_meta', { id: binding.sessionId, cwd: binding.workspace });
const turn = (model = 'fixture-model') => line('turn_context', { model, cwd: binding.workspace });
const usage = (used = 129201, window = 258400) => line('event_msg', { type: 'token_count', info: {
  last_token_usage: { input_tokens: used - 1, cached_input_tokens: used - 2, total_tokens: used },
  total_token_usage: { total_tokens: 9_000_000 }, model_context_window: window,
} });

test('strictly above half; no trigger at exactly 50 percent', () => {
  assert.equal(meter().percent, 50);
  assert.equal(meter().exceedsHalf, false);
  assert.equal(meter().thresholdTokens, 129201);
  assert.equal(meter({ usedTokens: 129201 }).exceedsHalf, true);
  assert.equal(meter({ windowTokens: 101, usedTokens: 50 }).exceedsHalf, false);
  assert.equal(meter({ windowTokens: 101, usedTokens: 51 }).exceedsHalf, true);
});

test('missing, invalid, stale and future metrics cannot produce a threshold or fake zero', () => {
  for (const change of [{ usedTokens: undefined }, { usedTokens: -1 }, { usedTokens: '2' },
    { windowTokens: 0 }, { observedAt: null }, { observedAt: new Date(now - 300001).toISOString() },
    { observedAt: new Date(now + 1).toISOString() }]) {
    const m = meter(change);
    assert.equal(m.percent, null);
    assert.equal(m.exceedsHalf, false);
    assert.equal(m.thresholdTokens, null);
    assert.match(renderContextMeter(m), / -- /);
    assert.throws(() => nativeConfigPreview(m));
  }
  assert.equal(meter({ usedTokens: 0 }).percent, 0);
});

test('rejects another session or workspace', () => {
  assert.throws(() => meter({ sessionId: 'other' }), /mismatch/);
  assert.throws(() => meter({ workspace: '/project/other' }), /mismatch/);
});

test('uses last request total, never cumulative billing or cached tokens twice', async () => {
  const m = await readCodexMetrics([metadata, turn(), usage()], binding, { now });
  assert.equal(m.usedTokens, 129201);
  assert.equal(m.windowTokens, 258400);
});

test('model changes invalidate the old sample until new usage arrives', async () => {
  const lines = [metadata, turn(), usage(), turn('new-model')];
  assert.equal((await readCodexMetrics(lines, binding, { now })).percent, null);
  const m = await readCodexMetrics([...lines, usage(100000, 475000)], binding, { now });
  assert.equal(m.model, 'new-model');
  assert.equal(m.thresholdTokens, 237501);
});

test('metadata is mandatory and workspace moves are rejected', async () => {
  await assert.rejects(readCodexMetrics([usage()], binding, { now }), /metadata/);
  await assert.rejects(readCodexMetrics([line('session_meta', { id: 'other', cwd: binding.workspace })], binding, { now }), /mismatch/);
  await assert.rejects(readCodexMetrics([metadata, line('turn_context', { cwd: '/other' })], binding, { now }), /moved/);
});

test('ignores conversation and incomplete tail; null token information clears the snapshot', async () => {
  const secret = 'fixture content must never leave the parser';
  const lines = [metadata, turn(), usage(), line('response_item', { text: secret }), '{"type":"event_msg"'];
  assert.equal(JSON.stringify(await readCodexMetrics(lines, binding, { now })).includes(secret), false);
  lines.push(line('event_msg', { type: 'token_count', info: null }));
  assert.equal((await readCodexMetrics(lines, binding, { now })).percent, null);
});

test('active and idle snapshots remain preview-only; no compaction command exists', async () => {
  for (const [event, status] of [['task_started', 'active'], ['task_complete', 'idle']]) {
    const m = await readCodexMetrics([metadata, turn(), usage(), line('event_msg', { type: event })], binding, { now });
    assert.equal(m.status, status);
    assert.equal(m.previewOnly, true);
    assert.match(renderContextMeter(m), /no compaction requested/);
  }
  assert.throws(() => parseOptions(['--compact'], {}), /Unknown/);
  assert.throws(() => parseOptions([], {}), /preview/);
});

test('CLI binds to current terminal session; rejects cross-session override', () => {
  const env = { CODEX_THREAD_ID: binding.sessionId };
  assert.equal(parseOptions(['--preview'], env).sessionId, binding.sessionId);
  assert.throws(() => parseOptions(['--preview', '--session', '22222222-2222-4222-8222-222222222222'], env), /another bound/);
  assert.throws(() => parseOptions(['--preview', '--rollout'], env), /Missing/);
});

test('bar has 20 cells; config preview does not invent model_context_window', () => {
  const text = renderContextMeter(meter({ usedTokens: 400000 }));
  assert.equal((text.match(/[█░]/g) || []).length, 20);
  const config = nativeConfigPreview(meter());
  assert.match(config, /model_auto_compact_token_limit = 129201/);
  assert.match(config, /context-used/);
  assert.doesNotMatch(config, /^model_context_window\s*=/m);
  assert.match(config, /PREVIEW ONLY/);
});

test('existing Claude renderer with isolated fixtures; Orca hook is never executed', () => {
  const script = readFileSync(new URL('./claude-context-statusline.sh', import.meta.url), 'utf8');
  const filter = script.match(/\| jq -r '([\s\S]*?)' 2>\/dev\/null/)[1];
  const render = (payload) => {
    const result = spawnSync('jq', ['-nr', '--argjson', 'payload', JSON.stringify(payload), `$payload | ${filter}`], {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.replace(/\x1b\[[0-9;]*m/g, '').trim();
  };
  const fixture = (percent) => ({ model: { display_name: 'Claude fixture' }, context_window: { used_percentage: percent, context_window_size: 200000 } });
  for (const percent of [0, 49, 50, 51, 100]) {
    const output = render(fixture(percent));
    assert.match(output, new RegExp(` ${percent}%`));
    assert.equal((output.match(/[█░]/g) || []).length, 20);
  }
  assert.match(render({}), / --$/);
  assert.match(render({ context_window: { context_window_size: 200000, current_usage: {
    input_tokens: 20000, cache_creation_input_tokens: 30000, cache_read_input_tokens: 50000,
  } } }), /50%.*100k\/200k/);
  assert.match(script, /orca\/agent-hooks\/claude-statusline\.sh/);
  const settings = JSON.parse(readFileSync(new URL('../.claude/settings.local.json', import.meta.url), 'utf8'));
  assert.equal(settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '50');
  assert.match(settings.statusLine.command, /claude-context-statusline\.sh/);
});

test('both Codex compaction rollout forms invalidate old usage until a fresh sample', async () => {
  const events = [line('event_msg', { type: 'context_compacted' }),
    line('compacted', { message: 'fixture', replacement_history: [] })];
  for (const event of events) {
    const lines = [metadata, turn(), usage(), event];
    const cleared = await readCodexMetrics(lines, binding, { now });
    assert.equal(cleared.sessionId, binding.sessionId);
    assert.equal(cleared.model, 'fixture-model');
    assert.equal(cleared.percent, null);
    assert.equal(cleared.thresholdTokens, null);
    assert.equal(cleared.exceedsHalf, false);
    assert.match(renderContextMeter(cleared), / -- /);
    assert.throws(() => nativeConfigPreview(cleared), /Fresh/);
    const refreshed = await readCodexMetrics([...lines, usage(40000)], binding, { now });
    assert.equal(refreshed.usedTokens, 40000);
    assert.equal(refreshed.quality, 'fresh');
    assert.equal(refreshed.exceedsHalf, false);
  }
});

test('duplicate compaction notices keep usage unknown; unrelated content is not an event', async () => {
  const compact = line('event_msg', { type: 'context_compacted' });
  const m = await readCodexMetrics([metadata, turn(), usage(), compact, compact], binding, { now });
  assert.equal(m.percent, null);
  const other = line('response_item', { type: 'context_compacted', text: 'unrelated fixture' });
  assert.equal((await readCodexMetrics([metadata, turn(), usage(), other], binding, { now })).usedTokens, 129201);
});

test('ordinary shell requires explicit UUID when CODEX_THREAD_ID is absent', () => {
  assert.throws(() => parseOptions(['--preview'], {}), /CODEX_THREAD_ID or --session/);
  const parsed = parseOptions(['--preview', '--session', binding.sessionId, '--watch'], {});
  assert.equal(parsed.sessionId, binding.sessionId);
  assert.equal(parsed.watch, true);
});

test('terminal bar fits 80 columns and shows unknown data without implying progress', () => {
  const output = renderTerminalContext(meter(), 80);
  assert.ok(output.length <= 80);
  assert.match(output, /50\.0%/);
  assert.match(output, /preview/);
  assert.equal((output.match(/[█░]/g) || []).length, 20);
  const missing = renderTerminalContext(meter({ usedTokens: undefined }), 80);
  assert.match(missing, /-- missing/);
  assert.doesNotMatch(missing, /█/);
  assert.ok(renderTerminalContext(meter(), 50).length <= 50);
});
