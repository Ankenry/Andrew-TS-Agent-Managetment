// One local setting shared by tracing web, TS Management web and extension.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REACTION_SETTINGS_FILE = resolve(ROOT, 'runtime/reaction-analytics-settings.json');
export function createReactionSettingsStore(file = REACTION_SETTINGS_FILE) {
let cache = null, writes = Promise.resolve();
async function readReactionSettings() {
  if (cache) return { ...cache };
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.revision) || value.revision < 0) throw Error('invalid');
    cache = { enabled: value.enabled, revision: value.revision };
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('REACTION_SETTINGS_UNREADABLE');
    cache = { enabled: false, revision: 0 };
  }
  return { ...cache };
}

function reactionSyncEnabled() { return cache?.enabled === true; }

async function updateReactionSettings({ enabled, expectedRevision } = {}) {
  if (typeof enabled !== 'boolean' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('REACTION_SETTINGS_INVALID');
  const work = writes.then(async () => {
    const current = await readReactionSettings();
    if (expectedRevision !== current.revision) throw Object.assign(new Error('REACTION_SETTINGS_CONFLICT'), { current });
    if (current.enabled === enabled) return current;
    const next = { enabled, revision: current.revision + 1 };
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(next) + '\n', { mode: 0o600 });
    await rename(temp, file);
    cache = next;
    return { ...next };
  });
  writes = work.catch(() => {});
  return work;
}
return { readReactionSettings, reactionSyncEnabled, updateReactionSettings };
}

const live = createReactionSettingsStore();
export const readReactionSettings = live.readReactionSettings;
export const reactionSyncEnabled = live.reactionSyncEnabled;
export const updateReactionSettings = live.updateReactionSettings;
