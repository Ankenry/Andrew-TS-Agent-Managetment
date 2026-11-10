#!/usr/bin/env node
import { readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const path = join(homedir(), '.bashrc');
const marker = '# Andrew check-ticket terminal viewer';
const existing = await readFile(path, 'utf8');
if (existing.includes(marker)) {
  console.log('Check-ticket terminal hook đã được cài.');
} else {
  const backup = `${path}.before-check-ticket-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const mode = (await stat(path)).mode & 0o777;
  await copyFile(path, backup);
  await writeFile(path, `${existing}\n${marker}\nif [ -r '/home/avada/Andrew Tools CS-TS/Andrew TS Tools/scripts/check-ticket-terminal.bash' ]; then\n    . '/home/avada/Andrew Tools CS-TS/Andrew TS Tools/scripts/check-ticket-terminal.bash'\nfi\n`, { mode });
  console.log(`Đã cài. Bản sao lưu: ${backup}`);
}
