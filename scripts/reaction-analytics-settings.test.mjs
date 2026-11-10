import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReactionSettingsStore } from './reaction-analytics-settings.mjs';

test('reaction sync starts OFF and writes one shared revision atomically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reaction-settings-'));
  const file = join(dir, 'settings.json');
  const store = createReactionSettingsStore(file);
  assert.deepEqual(await store.readReactionSettings(), { enabled:false, revision:0 });
  assert.equal(store.reactionSyncEnabled(), false);
  assert.deepEqual(await store.updateReactionSettings({ enabled:true, expectedRevision:0 }), { enabled:true, revision:1 });
  assert.equal(store.reactionSyncEnabled(), true);
  await assert.rejects(() => store.updateReactionSettings({ enabled:false, expectedRevision:0 }), /REACTION_SETTINGS_CONFLICT/);
  assert.deepEqual(await store.updateReactionSettings({ enabled:false, expectedRevision:1 }), { enabled:false, revision:2 });
  assert.deepEqual(await createReactionSettingsStore(file).readReactionSettings(), { enabled:false, revision:2 });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
