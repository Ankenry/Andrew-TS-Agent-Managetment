#!/usr/bin/env node
// CLI helpers for the tracing store: node scripts/hachimi-trace-store-cli.mjs [purge|stats]
import { closePool } from './hachimi-db.mjs';
import { purgeExpired, stats } from './hachimi-trace-store.mjs';
const command = process.argv[2] || 'stats';
try {
  if (command === 'purge') console.log(JSON.stringify(await purgeExpired({ trigger: 'cli' })));
  else if (command === 'stats') console.log(JSON.stringify(await stats(), null, 2));
  else { console.error('Usage: node scripts/hachimi-trace-store-cli.mjs [purge|stats]'); process.exitCode = 1; }
} catch (error) { console.error(`Trace store error: ${error.message}`); process.exitCode = 1; }
finally { await closePool(); }
