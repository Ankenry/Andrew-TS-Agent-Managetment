#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';

// Read data, never execute .env_my as a shell script or export its other secrets.
const envPath = fileURLToPath(new URL('../.env_my', import.meta.url));
let key;
try {
  key = parseEnv(readFileSync(envPath, 'utf8')).API_KEY_GEMINI?.trim();
} catch {
  console.error(`Không đọc được file cấu hình: ${envPath}`);
  process.exit(1);
}
if (!key) {
  console.error(`Thiếu API_KEY_GEMINI trong ${envPath}`);
  process.exit(1);
}

const cliPath = join(homedir(), '.local/share/gemini-cli/node_modules/.bin/gemini');
if (!existsSync(cliPath)) {
  console.error('Chưa cài Gemini CLI. Chạy: npm install --prefix "$HOME/.local/share/gemini-cli" @google/gemini-cli');
  process.exit(1);
}

const child = spawn(process.execPath, [cliPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, GEMINI_API_KEY: key },
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', () => {
  console.error('Không khởi động được Gemini CLI.');
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
});
