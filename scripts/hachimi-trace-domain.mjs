// Friendly local address of the Hachimi tracing web: http://andrewtstracing.localhost:5077.
// Browsers resolve every *.localhost name to this machine, so it needs no hosts entry and no sudo.
// Optional: a custom domain without a port (HACHIMI_TRACE_WEB_DOMAIN, e.g. andrewtstracing.com) installed once with
// scripts/install-hachimi-trace-domain.sh (/etc/hosts + a systemd socket proxy on a loopback address).
// Other devices on the same network (phone, tablet) cannot use a *.localhost name: they open
// http://andrewtstracing.local:5077 (mDNS) or http://<LAN IP>:5077, read-only.
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const TRACE_LOCAL_NAME = 'andrewtstracing.localhost';
export const TRACE_DOMAIN_ADDRESS = '127.0.0.77';
export const TRACE_SERVICE_NAME = 'hachimi-trace-web';
export const TRACE_KEY_COOKIE = 'hachimi_trace_key';
const MDNS_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.local$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function env() {
  try { return parseEnv(readFileSync(new URL('../.env_my', import.meta.url), 'utf8')); } catch { return {}; }
}

// Optional custom domain; empty when none is configured.
export function traceDomain() {
  const value = String(process.env.HACHIMI_TRACE_WEB_DOMAIN || env().HACHIMI_TRACE_WEB_DOMAIN || '').trim().toLowerCase();
  return DOMAIN_RE.test(value) ? value : '';
}

export function traceWebPort() {
  const raw = Number(process.env.HACHIMI_TRACE_WEB_PORT || env().HACHIMI_TRACE_WEB_PORT);
  return Number.isInteger(raw) && raw > 0 ? raw : 5077;
}

const setting = name => String(process.env[name] ?? env()[name] ?? '').trim();
const disabled = value => ['off', 'false', '0', 'no'].includes(value.toLowerCase());

// LAN access (read-only) is on by default; HACHIMI_TRACE_WEB_LAN=off keeps the server on loopback only.
export const traceLanEnabled = () => !disabled(setting('HACHIMI_TRACE_WEB_LAN'));
// Fixed LAN name published over mDNS by the tracing web; HACHIMI_TRACE_WEB_MDNS_NAME=off disables it.
export function traceLanName() {
  const value = setting('HACHIMI_TRACE_WEB_MDNS_NAME').toLowerCase() || 'andrewtstracing.local';
  return traceLanEnabled() && !disabled(value) && MDNS_RE.test(value) ? value : '';
}
// Name published by the TS Management web (same machine), accepted as a Host as well.
function tsWebLanName() {
  const value = setting('TS_WEB_MDNS_NAME').toLowerCase() || 'andrewtsmanagement.local';
  return !disabled(value) && MDNS_RE.test(value) ? value : '';
}
// IPv4 addresses other devices can reach; container bridges are skipped.
export function traceLanAddresses() {
  const out = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (/^(docker|br-|veth|virbr|lxc|lxd)/.test(name)) continue;
    for (const entry of entries || []) if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
  }
  return out;
}
export function isLoopbackAddress(address) {
  const value = String(address || '').replace(/^::ffff:/, '');
  return value === '::1' || /^127(?:\.\d{1,3}){3}$/.test(value);
}
// The TS Management web access key (TS_WEB_PIN) also protects LAN access to the tracing web.
export function traceLanKeyRequired() { return Boolean(setting('TS_WEB_PIN')); }
export function isTraceLanKey(value) {
  const expected = Buffer.from(setting('TS_WEB_PIN')); const given = Buffer.from(String(value || ''));
  return expected.length > 0 && expected.length === given.length && timingSafeEqual(expected, given);
}

export const localTraceUrl = (port = traceWebPort()) => `http://127.0.0.1:${port}`;
// What people open and what every link uses.
export const friendlyTraceUrl = (port = traceWebPort()) => `http://${TRACE_LOCAL_NAME}:${port}`;

const hostName = header => {
  const host = String(header || '').trim().toLowerCase();
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
};

// Host header allowlist (blocks DNS-rebinding pages from reading or deleting traces): loopback names, *.localhost,
// the optional custom domain and, with LAN access, this machine's own LAN addresses and mDNS names.
export function isAllowedHost(header, domain = traceDomain(), { lan = traceLanEnabled(), addresses = lan ? traceLanAddresses() : [], names = lan ? [traceLanName(), tsWebLanName()] : [] } = {}) {
  const name = hostName(header);
  if (!name) return false;
  if (name === '[::1]' || name === 'localhost' || name.endsWith('.localhost')) return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(name)) return true;
  if (lan && (addresses.includes(name) || names.filter(Boolean).includes(name))) return true;
  return Boolean(domain) && (name === domain || name === `www.${domain}`);
}

// True only when the domain resolves to loopback on this machine and the tracing web answers behind it.
export async function traceDomainReady({ domain = traceDomain(), timeoutMs = 1500 } = {}) {
  if (!domain) return false;
  try {
    const { address } = await lookup(domain, { family: 4 });
    if (!address.startsWith('127.')) return false; // never probe a public server
    const response = await fetch(`http://${domain}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json();
    return Boolean(response.ok && body?.ok && body.service === TRACE_SERVICE_NAME);
  } catch { return false; }
}

// URL to show/open for people: the custom domain when one is configured and working, otherwise andrewtstracing.localhost:<port>.
export async function publicTraceUrl(options = {}) {
  const domain = options.domain || traceDomain();
  return await traceDomainReady({ ...options, domain }) ? `http://${domain}` : friendlyTraceUrl();
}

// Link for the device that asked: this machine keeps the friendly local address; another device gets an address it can
// resolve, i.e. the mDNS name when it already reached us by a .local name, otherwise the LAN IP it used.
export async function traceUrlForClient({ remoteAddress, host } = {}, options = {}) {
  if (isLoopbackAddress(remoteAddress) || !traceLanEnabled()) return publicTraceUrl(options);
  const port = traceWebPort(); const name = hostName(host); const addresses = traceLanAddresses();
  if (name.endsWith('.local') && traceLanName()) return `http://${traceLanName()}:${port}`;
  const address = addresses.includes(name) ? name : addresses[0];
  return address ? `http://${address}:${port}` : publicTraceUrl(options);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const domain = traceDomain();
  const ready = await traceDomainReady({ domain });
  const port = traceWebPort();
  console.log(JSON.stringify({ url: ready ? `http://${domain}` : friendlyTraceUrl(), customDomain: domain || null, customDomainReady: ready, loopback: localTraceUrl(),
    lan: { enabled: traceLanEnabled(), readOnly: true, keyRequired: traceLanKeyRequired(), name: traceLanName() ? `http://${traceLanName()}:${port}` : null, addresses: traceLanEnabled() ? traceLanAddresses().map(address => `http://${address}:${port}`) : [] }, root: ROOT }));
}
