#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE } from './check-ticket-chat-relay.mjs';

export async function readTrace({ source, id, after = 0, waitSeconds = 25, path = STATE }) {
  if (!['widget', 'automatic'].includes(source) || !/^[a-zA-Z0-9_-]{1,100}$/.test(id || '') || !Number.isInteger(after) || after < 0) throw new Error('Invalid trace request');
  const end = Date.now() + Math.min(30, Math.max(0, waitSeconds)) * 1000;
  do {
    const state = JSON.parse(await readFile(path, 'utf8'));
    const trace = state.traces?.[`${source}:${id}`];
    if (!trace) throw new Error('Trace not found; do not start a new review.');
    const events = trace.events.slice(after);
    if (events.length || trace.terminal || Date.now() >= end) return {
      source, id, events, nextCursor: trace.events.length, terminal: trace.terminal, timedOut: !events.length && !trace.terminal,
      relayLastPollAt: state.lastPollAt,
    };
    await new Promise(done => setTimeout(done, 1000));
  } while (true);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2], process.argv[3 + i * 2]]));
  console.log(JSON.stringify(await readTrace({ source: args['--source'], id: args['--id'], after: Number(args['--after'] || 0), waitSeconds: Number(args['--wait'] || 25) }), null, 2));
}
