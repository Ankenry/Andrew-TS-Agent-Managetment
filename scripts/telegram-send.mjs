#!/usr/bin/env node
// Minimal Telegram sender shared by small notifications (same bot and chat as the ticket notifier: TELEGRAM_BOT_TOKEN
// and TELEGRAM_CHAT_ID in .env_my). One message, no retry queue; the token never appears in errors or logs.
//   node scripts/telegram-send.mjs "<text>"   (manual test)
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './hachimi-db.mjs';

export function telegramConfig(env = { ...loadEnv(), ...process.env }) {
  return { token: String(env.TELEGRAM_BOT_TOKEN || '').trim(), chatId: String(env.TELEGRAM_CHAT_ID || '').trim() };
}

// Sends one text message; resolves { messageId }. Throws an Error whose message carries no token or URL.
export async function sendTelegramText(text, { token, chatId, fetchImpl = fetch, timeoutMs = 20_000 } = telegramConfig()) {
  if (!token || !chatId) throw new Error('Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID.');
  const body = JSON.stringify({ chat_id: chatId, text: String(text || '').slice(0, 4000), disable_web_page_preview: true });
  let response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) { throw new Error(`Telegram transport failed (${error?.name || error?.code || 'unknown'}).`); }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) throw new Error(`Telegram sendMessage failed: ${result?.description || `HTTP ${response.status}`}.`);
  return { messageId: result.result?.message_id };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = process.argv.slice(2).join(' ').trim();
  if (!text) { console.error('Usage: node scripts/telegram-send.mjs "<text>"'); process.exit(1); }
  try { const sent = await sendTelegramText(text); console.log(JSON.stringify(sent)); }
  catch (error) { console.error(error.message); process.exit(1); }
}
