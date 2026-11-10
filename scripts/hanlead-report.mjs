#!/usr/bin/env node
// Numbered reports for the user, so a report can be read aloud later by its number ("đọc 112").
// CLI: node scripts/hanlead-report.mjs save [--agent Hanlead] < report.md     -> prints the new report number
//      node scripts/hanlead-report.mjs show <number>                          -> prints the saved report text
//      node scripts/hanlead-report.mjs list [--last 10]                       -> number, time, agent, first line
//      node scripts/hanlead-report.mjs say <number> [< spoken.txt]            -> synthesizes with Piper and plays it; without stdin it replays the cached audio
//      node scripts/hanlead-report.mjs stop                                   -> stops the playback
// Reports live in runtime/hanlead-reports/ (<n>.md, <n>.json, <n>.speech.txt, <n>.wav).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.env.HANLEAD_REPORT_DIR || join(root, 'runtime', 'hanlead-reports');
const piperHome = process.env.PIPER_HOME || join(homedir(), '.local', 'share', 'piper');
const piperBin = join(piperHome, 'piper', 'piper');
const piperVoice = process.env.PIPER_VOICE || join(piperHome, 'voices', 'vi_VN-vais1000-medium.onnx');

function numbers() {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((name) => /^(\d+)\.md$/.exec(name)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
}

function parseNumber(value) {
  if (!/^\d+$/.test(String(value || ''))) throw new Error('Report number is required.');
  const number = Number(value);
  if (!existsSync(join(dir, `${number}.md`))) throw new Error(`Report ${number} does not exist.`);
  return number;
}

function readStdin() {
  if (process.stdin.isTTY) return '';
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function save(args) {
  const text = readStdin().trim();
  if (!text) throw new Error('Report text is required on stdin.');
  mkdirSync(dir, { recursive: true });
  // The exclusive create is the lock: two sessions saving at once never share a number.
  for (let number = (numbers().at(-1) || 0) + 1; ; number += 1) {
    let handle;
    try { handle = openSync(join(dir, `${number}.md`), 'wx'); } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    writeSync(handle, `${text}\n`);
    closeSync(handle);
    writeFileSync(join(dir, `${number}.json`), `${JSON.stringify({ number, at: new Date().toISOString(), agent: option(args, '--agent', 'Hanlead') })}\n`);
    return String(number);
  }
}

function meta(number) {
  try { return JSON.parse(readFileSync(join(dir, `${number}.json`), 'utf8')); } catch { return { number }; }
}

function list(args) {
  const last = Number(option(args, '--last', 10)) || 10;
  return numbers().slice(-last).map((number) => {
    const { at = '', agent = '' } = meta(number);
    const firstLine = readFileSync(join(dir, `${number}.md`), 'utf8').split('\n').find((line) => line.trim()) || '';
    return `${number}\t${at}\t${agent}\t${firstLine.slice(0, 120)}`;
  }).join('\n');
}

function stop() {
  spawnSync('pkill', ['-f', `pw-play ${dir}`]);
}

function say(args) {
  const number = parseNumber(args[0]);
  const speechPath = join(dir, `${number}.speech.txt`);
  const wavPath = join(dir, `${number}.wav`);
  const spoken = readStdin().trim();
  if (spoken) {
    writeFileSync(speechPath, `${spoken}\n`);
    if (!existsSync(piperBin) || !existsSync(piperVoice)) throw new Error(`Piper or its voice is missing under ${piperHome}.`);
    const result = spawnSync(piperBin, ['--model', piperVoice, '--output_file', wavPath, '--sentence_silence', '0.45', '--length_scale', '1.05'], { input: `${spoken}\n`, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Piper failed: ${(result.stderr || '').trim().split('\n').at(-1)}`);
  } else if (!existsSync(wavPath)) {
    throw new Error(`Report ${number} has no audio yet; pass the spoken text on stdin.`);
  }
  stop();
  spawn('pw-play', [wavPath], { detached: true, stdio: 'ignore' }).unref();
  return `playing ${number}`;
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'save') console.log(save(args));
  else if (command === 'show') process.stdout.write(readFileSync(join(dir, `${parseNumber(args[0])}.md`), 'utf8'));
  else if (command === 'list') console.log(list(args));
  else if (command === 'say') console.log(say(args));
  else if (command === 'stop') stop();
  else throw new Error('Usage: hanlead-report.mjs save|show|list|say|stop');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
