// Explicit local connectivity probe; does not call AI or mutate Helpdesk.
import { spawn } from 'node:child_process';
import { WidgetLogTail } from './widget-chat-log.mjs';

const tail = new WidgetLogTail();
await tail.poll(() => {});
const child = spawn(process.execPath, ['scripts/telegram-notifier-native-host.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
const id = `widget-log-test-${Date.now()}`;
const relayTest = process.argv.includes('--relay');
const eventsToSend = [
  ...(relayTest ? [{ id, kind: 'start', text: 'KIỂM THỬ CẦU NỐI TRACE — không phải ticket thật.' }] : []),
  { id, kind: 'phase', text: 'KIỂM THỬ KẾT NỐI LOG: Native Messaging → file log → terminal/chat relay. Không chạy check ticket.' },
  ...(relayTest ? [{ id, kind: 'done', text: 'Phép thử đường truyền đã ghi xong trace. Không gọi AI, không đăng comment Helpdesk. Chỉ xác nhận nhận được trace kiểm thử tại cuộc trò chuyện này.' }] : []),
];
const body = Buffer.from(JSON.stringify({ action: 'widget-chat-log', events: eventsToSend }));
const size = Buffer.alloc(4); size.writeUInt32LE(body.length);
let output = Buffer.alloc(0); let error = '';
child.stdout.on('data', c => { output = Buffer.concat([output, c]); });
child.stderr.on('data', c => { error += c; });
const closed = new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
child.stdin.end(Buffer.concat([size, body]));
const code = await closed;
if (code !== 0 || output.length < 4) throw new Error(error || `Native host returned no frame (exit ${code}).`);
const response = JSON.parse(output.subarray(4, 4 + output.readUInt32LE(0)).toString());
if (!response.ok) throw new Error(response.error);
const events = []; await tail.poll(e => events.push(e));
if (!events.some(e => e.id === id)) throw new Error('Terminal did not read test log.');
console.log(JSON.stringify({ nativeHost: response.ok, terminalReceived: true, id, relayTest }));
