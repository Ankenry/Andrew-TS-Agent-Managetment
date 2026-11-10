// Minimal mDNS responder: publishes one fixed `<name>.local` A record for this machine so other
// devices on the same network (iPhone, Android, Mac, Windows) can open the TS Management web by a
// stable name even when DHCP changes the LAN IP. No root and no dependency: mDNS uses UDP 5353,
// shared with avahi-daemon through SO_REUSEADDR. It only answers for its own name.
import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";

const GROUP = "224.0.0.251";
const PORT = 5353;
const TYPE_A = 1, TYPE_AAAA = 28, TYPE_NSEC = 47, TYPE_ANY = 255;
const TTL = 120;

export function mdnsInterfaces() {
  const out = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    // Container bridges are not reachable by other devices.
    if (/^(tailscale|docker|br-|veth|virbr|lxc|lxd)/.test(name)) continue;
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) out.push({ name, address: entry.address, netmask: entry.netmask });
    }
  }
  return out;
}
const toInt = (ip) => ip.split(".").reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
function addressFor(sender, interfaces) {
  if (!interfaces.length) return null;
  if (sender && /^\d+\.\d+\.\d+\.\d+$/.test(sender)) {
    const match = interfaces.find((item) => ((toInt(item.address) & toInt(item.netmask)) >>> 0) === ((toInt(sender) & toInt(item.netmask)) >>> 0));
    if (match) return match.address;
  }
  return interfaces[0].address;
}
function encodeName(name) {
  const parts = name.split(".").filter(Boolean).map((label) => Buffer.from(label, "utf8"));
  return Buffer.concat([...parts.flatMap((label) => [Buffer.from([label.length]), label]), Buffer.from([0])]);
}
function readName(buffer, offset, depth = 0) {
  const labels = []; let position = offset; let next = -1;
  while (position < buffer.length) {
    const length = buffer[position];
    if (length === 0) { position += 1; break; }
    if ((length & 0xc0) === 0xc0) {
      if (depth > 8 || position + 1 >= buffer.length) throw new Error("bad pointer");
      if (next === -1) next = position + 2;
      labels.push(readName(buffer, ((length & 0x3f) << 8) | buffer[position + 1], depth + 1).name);
      position = -1; break;
    }
    labels.push(buffer.toString("utf8", position + 1, position + 1 + length));
    position += 1 + length;
  }
  return { name: labels.filter(Boolean).join("."), next: next !== -1 ? next : position };
}
function parseQuestions(buffer) {
  if (buffer.length < 12) return null;
  const flags = buffer.readUInt16BE(2);
  if (flags & 0x8000) return null; // a response, not a query
  const count = buffer.readUInt16BE(4);
  const questions = []; let offset = 12;
  for (let index = 0; index < count && index < 32; index += 1) {
    const { name, next } = readName(buffer, offset);
    if (next + 4 > buffer.length) break;
    questions.push({ name: name.toLowerCase(), type: buffer.readUInt16BE(next), klass: buffer.readUInt16BE(next + 2) });
    offset = next + 4;
  }
  return { id: buffer.readUInt16BE(0), questions };
}
function record(nameBytes, type, klass, ttl, rdata) {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0); head.writeUInt16BE(klass, 2); head.writeUInt32BE(ttl, 4); head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([nameBytes, head, rdata]);
}
export function buildResponse({ name, address, id = 0, question = null, legacy = false, wantsAddress = true }) {
  const nameBytes = encodeName(name);
  const klass = legacy ? 0x0001 : 0x8001; // cache-flush bit for multicast answers
  const ttl = legacy ? 10 : TTL;
  const a = record(nameBytes, TYPE_A, klass, ttl, Buffer.from(address.split(".").map(Number)));
  // NSEC says "this name has an A record only", so clients stop waiting for an AAAA answer.
  const nsec = record(nameBytes, TYPE_NSEC, klass, ttl, Buffer.concat([nameBytes, Buffer.from([0x00, 0x01, 0x40])]));
  const answers = wantsAddress ? [a] : [nsec];
  const additionals = wantsAddress ? [nsec] : [a];
  const questionBytes = question ? Buffer.concat([encodeName(question.name), Buffer.from([question.type >> 8, question.type & 0xff, 0x00, 0x01])]) : Buffer.alloc(0);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0); header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(question ? 1 : 0, 4); header.writeUInt16BE(answers.length, 6); header.writeUInt16BE(0, 8); header.writeUInt16BE(additionals.length, 10);
  return Buffer.concat([header, questionBytes, ...answers, ...additionals]);
}

export function startMdnsResponder({ name, log = console.log, refreshMs = 10_000, label = "ts-web" } = {}) {
  const hostName = String(name || "").trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.local$/.test(hostName)) throw new Error(`Invalid mDNS name "${name}": use one label ending in .local.`);
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  const joined = new Set();
  let lastAddresses = ""; let timer = null; let closed = false;

  const sendMulticast = (address) => {
    try { socket.setMulticastInterface(address); } catch { return; }
    socket.send(buildResponse({ name: hostName, address }), PORT, GROUP, () => {});
  };
  const refresh = () => {
    if (closed) return;
    const interfaces = mdnsInterfaces();
    for (const item of interfaces) {
      if (joined.has(item.address)) continue;
      try { socket.addMembership(GROUP, item.address); joined.add(item.address); } catch { /* interface not ready yet */ }
    }
    for (const address of [...joined]) if (!interfaces.some((item) => item.address === address)) joined.delete(address);
    const signature = interfaces.map((item) => item.address).join(",");
    if (signature !== lastAddresses) {
      lastAddresses = signature;
      if (interfaces.length) log(`[${label}] mDNS: ${hostName} -> ${interfaces.map((item) => `${item.address} (${item.name})`).join(", ")}`);
      else log(`[${label}] mDNS: ${hostName} has no LAN address right now`);
      // Announce twice so caches on other devices pick up the new address quickly.
      for (const delay of [200, 1_400]) setTimeout(() => { if (!closed) mdnsInterfaces().forEach((item) => sendMulticast(item.address)); }, delay);
    }
  };

  socket.on("error", (error) => { log(`[${label}] mDNS responder error: ${error.message}`); });
  socket.on("message", (message, rinfo) => {
    let query; try { query = parseQuestions(message); } catch { return; }
    if (!query) return;
    const relevant = query.questions.filter((question) => question.name === hostName && [TYPE_A, TYPE_AAAA, TYPE_ANY].includes(question.type));
    if (!relevant.length) return;
    const address = addressFor(rinfo.address, mdnsInterfaces());
    if (!address) return;
    const wantsAddress = relevant.some((question) => question.type !== TYPE_AAAA);
    if (rinfo.port !== PORT) {
      // Legacy unicast resolver: answer the sender directly and echo its question.
      socket.send(buildResponse({ name: hostName, address, id: query.id, question: relevant[0], legacy: true, wantsAddress }), rinfo.port, rinfo.address, () => {});
      return;
    }
    try { socket.setMulticastInterface(address); } catch { return; }
    socket.send(buildResponse({ name: hostName, address, wantsAddress }), PORT, GROUP, () => {});
  });
  socket.bind(PORT, () => {
    try { socket.setMulticastTTL(255); socket.setMulticastLoopback(true); } catch {}
    refresh();
    timer = setInterval(refresh, refreshMs);
  });
  return {
    name: hostName,
    stop() { closed = true; if (timer) clearInterval(timer); try { socket.close(); } catch {} },
  };
}
