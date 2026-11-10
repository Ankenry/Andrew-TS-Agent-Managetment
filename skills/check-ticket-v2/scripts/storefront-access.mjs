// Storefront gate credentials are data from the ticket, never model tool arguments.
const LABEL = /^\s*(?:[-*•]\s*)?(?:\*\*)?(?:(?:store(?:front)?|shop)\s*(?:pass(?:word)?|mật khẩu)|(?:pass(?:word)?|mật khẩu)(?:\s+(?:store(?:front)?|shop|cửa hàng))?)(?:\*\*)?\s*[:：=]\s*(.+?)\s*$/i;
const STORE = /^\s*(?:[-*•]\s*)?(?:cửa hàng|store(?:front)?(?:\s+url)?|shop(?:\s+url)?)\s*[:：=]\s*(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})(?:[\s/]|$)/gim;

function passwords(text) {
  const values = [];
  for (const line of String(text || '').replace(/<br\s*\/?\s*>/gi, '\n').split('\n')) {
    const match = line.match(LABEL);
    if (!match) continue;
    const value = match[1].replace(/^([`"'])(.*)\1$/, '$2');
    if (value && value.length <= 128 && !/[<>\r\n]/.test(value) && !/^https?:/i.test(value)
      && (!/\s/.test(value) || /^[`"']/.test(match[1]))) values.push(value);
  }
  return values;
}

export function storefrontAccess(ticket = {}) {
  const comments = [...(ticket.comments || [])].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const texts = [...comments.map(c => c.content), ticket.description || ''];
  const secrets = [...new Set(texts.flatMap(passwords))];
  const hosts = new Set();
  const add = value => {
    try {
      const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port) hosts.add(url.hostname);
    } catch { /* malformed domain is not a credential destination */ }
  };
  for (const domain of ticket.storeDomains || []) add(String(domain));
  for (const text of texts) for (const match of String(text || '').matchAll(STORE)) add(match[1]);
  return { password: secrets[0] || null, secrets, hosts: [...hosts] };
}

export function redactStorefrontSecrets(value, access) {
  if (typeof value === 'string') {
    for (const secret of access?.secrets || []) value = value.split(secret).join('[storefront password hidden]');
    return value;
  }
  if (Array.isArray(value)) return value.map(item => redactStorefrontSecrets(item, access));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStorefrontSecrets(item, access)]));
  return value;
}

export function trustedStorefront(value, access) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && (access?.hosts || []).includes(url.hostname);
  } catch { return false; }
}

export function createStorefrontSession() { return { storageState: null, attempted: new Set() }; }
