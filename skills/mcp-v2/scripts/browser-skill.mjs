// Setup inspection only. Never auto-start bsk, open a browser, pair, install an
// extension or touch the user's existing Chrome profile during readiness checks.
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { browserReadiness } from './local-browser.mjs';
const exec = promisify(execFile);

export async function browserSkillSetup({ env = process.env, home = homedir(), run = exec, root = fileURLToPath(new URL('../../../', import.meta.url)) } = {}) {
  let binary = null;
  for (const dir of [resolve(root, 'runtime/mcp-v2/toolchain/bsk-v0.3.3'), ...String(env.PATH || '').split(delimiter).filter(Boolean), resolve(home, '.local/bin')]) {
    const path = resolve(dir, 'bsk');
    try { await access(path, constants.X_OK); binary = path; break; } catch {}
  }
  let version = null;
  if (binary) { try { const result = await run(binary, ['--version'], { timeout: 5000, maxBuffer: 4096, env: { ...env, BSK_AUTO_START: '0' } }); version = String(result.stdout).trim().slice(0, 100); } catch {} }
  let skillInstalled = false;
  const skillPath = resolve(env.CODEX_HOME || resolve(home, '.codex'), 'skills/browser-skill/SKILL.md');
  try { skillInstalled = (await readFile(skillPath, 'utf8')).includes('browser'); } catch {}
  if (!skillInstalled) { try { skillInstalled = (await readFile(resolve(root, '.agents/skills/browser-skill/SKILL.md'), 'utf8')).includes('browser'); } catch {} }
  if (binary && version) {
    const profile = await browserReadiness(root, { requireSmoke: false });
    const ready = await browserReadiness(root);
    return { cliInstalled: true, cliVersion: version, skillInstalled, connected: profile.available ? true : null,
      isolatedProfileVerified: profile.isolatedProfileVerified, localBrowserEnabled: ready.available,
      reason: ready.available ? null : ready.reason };
  }
  return { cliInstalled: Boolean(binary), cliVersion: version, skillInstalled, connected: null, isolatedProfileVerified: false, localBrowserEnabled: false,
    reason: !binary ? 'BSK_CLI_MISSING' : !version ? 'BSK_VERSION_UNVERIFIED' : !skillInstalled ? 'BSK_SKILL_MISSING' : 'BSK_ISOLATED_PROFILE_NOT_VERIFIED' };
}
