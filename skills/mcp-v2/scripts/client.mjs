// Read-only MCP gateway. Connection details must come from the real TS2 installer;
// there is deliberately no guessed endpoint, package, auth header or tool schema.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { storefrontAccess, redactStorefrontSecrets } from '../../check-ticket-v2/scripts/storefront-access.mjs';
import { browserReadiness, browserTool, localBrowserClient } from './local-browser.mjs';
import { createConfigReader, formatConfigReport, supportedConfigApp } from '../../check-ticket-v2/scripts/config-reader.mjs';

export const shopConfigTool = {
  name: 'ts_shop_settings',
  description: 'Read actual app configuration for this ticket/shop through audited backend adapters. The backend may use isolated Quick Login for authentication only, blocking app writes and unaudited GETs. No model browser actions or arbitrary URLs. Returns key/value/source/time, concrete access errors, and missing vs false. Match UI labels using source evidence; no inferred credential type on 401/403.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, source: { type: 'string', enum: ['auto', 'api'] } }, additionalProperties: false },
};
shopConfigTool.inputSchema.properties.path.description = 'Wishlist: settings, notifications.emailHeader.logoUrl, notifications.sender.mode. Use dedicated notifications endpoints for logo/sender; settings.notifications may contain defaults. Machine APIs retain their existing key paths.';

export class McpError extends Error {
  constructor(code, status = 503) { super(code); this.code = code; this.status = status; }
}
export function redact(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  return text.replace(/\b(?:Bearer\s+|sk[-_]|ts2[-_])[A-Za-z0-9._~+\/-]{8,}/gi, '[redacted]');
}
export async function connection(root) {
  let config;
  try { config = JSON.parse(await readFile(resolve(root, 'skills/mcp-v2/connection.json'), 'utf8')); }
  catch (error) { throw new McpError(error.code === 'ENOENT' ? 'MCP_CONNECTION_MISSING' : 'MCP_CONNECTION_INVALID'); }
  let url;
  try { url = new URL(config.url); } catch { throw new McpError('MCP_CONNECTION_INVALID'); }
  if (config.transport !== 'streamable-http' || url.origin !== 'https://ts2.avada.net' || url.username || url.password || url.search || url.hash || !/^[A-Za-z0-9-]+$/.test(config.authHeader || '') || !['', 'Bearer '].includes(config.authPrefix)) throw new McpError('MCP_CONNECTION_INVALID');
  // Only explicitly reviewed read operations can be exposed. Remote annotations alone
  // cannot authorize tools, arbitrary queries, browser scripts or shop writes.
  const reads = config.readTools || {};
  for (const [name, rule] of Object.entries(reads)) {
    if (!/^ts_[a-z0-9_]+$/.test(name) || !rule || !['app', 'catalog', 'ticket', 'knowledge'].includes(rule.scope) || !['document', 'observation'].includes(rule.kind)) throw new McpError('MCP_TOOL_POLICY_INVALID');
    if (/write|delete|update|create|execute|browser|script|shell|save|post|send|install|eval/i.test(name)) throw new McpError('MCP_TOOL_POLICY_INVALID');
    if (rule.scope === 'app' && !/^[A-Za-z][A-Za-z0-9_]*$/.test(rule.appArgument || '')) throw new McpError('MCP_TOOL_POLICY_INVALID');
  }
  if (!reads.ts_list_apps || !reads.ts_app_playbook) throw new McpError('MCP_TOOL_POLICY_MISSING');
  let key = '';
  try { key = parseEnv(await readFile(resolve(root, '.env_my'), 'utf8')).Andrew_TS2_Keys?.trim() || ''; } catch {}
  if (!key) throw new McpError('MCP_KEY_MISSING');
  return { config, key };
}

// Small Streamable HTTP client; request size, response size, time and redirects
// are bounded. Error text from the remote service never propagates to logs.
export function httpTransport({ config, key, fetchImpl = fetch, timeoutMs = 8000, signal }) {
  let next = 0; let session = ''; let protocol = '2025-03-26';
  async function rpc(method, params = {}, notification = false) {
    const id = notification ? undefined : ++next;
    const timer = AbortSignal.timeout(timeoutMs);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', [config.authHeader]: config.authPrefix + key };
    if (session) { headers['Mcp-Session-Id'] = session; headers['MCP-Protocol-Version'] = protocol; }
    let response;
    try { response = await fetchImpl(config.url, { method: 'POST', redirect: 'error', headers, signal: signal ? AbortSignal.any([signal, timer]) : timer, body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }) }); }
    catch { throw new McpError(signal?.aborted ? 'MCP_ABORTED' : timer.aborted ? 'MCP_TIMEOUT' : 'MCP_TRANSPORT_FAILED'); }
    if (!response.ok) throw new McpError(`MCP_HTTP_${response.status}`);
    session = response.headers.get('mcp-session-id') || session;
    if (notification) { await response.body?.cancel(); return {}; }
    const reader = response.body?.getReader();
    if (!reader) throw new McpError('MCP_EMPTY_RESPONSE');
    let data = ''; const decoder = new TextDecoder(); let bytes = 0;
    const sse = response.headers.get('content-type')?.includes('text/event-stream');
    const frames = () => sse ? data.split(/\r?\n\r?\n/).slice(0, -1).map(frame => frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')) : [data];
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (value) { bytes += value.byteLength; if (bytes > 1_000_000) throw new McpError('MCP_RESPONSE_TOO_LARGE'); data += decoder.decode(value, { stream: true }); }
        if (done) data += decoder.decode();
        for (const raw of frames()) {
          let message; try { message = JSON.parse(raw); } catch { continue; }
          if (message.id !== id) continue;
          if (message.error) throw new McpError('MCP_RPC_ERROR');
          if (!message.result || typeof message.result !== 'object') throw new McpError('MCP_INVALID_RESPONSE');
          return message.result;
        }
        if (done) throw new McpError('MCP_INVALID_RESPONSE');
      }
    } catch (error) { if (error instanceof McpError) throw error; throw new McpError(signal?.aborted ? 'MCP_ABORTED' : timer.aborted ? 'MCP_TIMEOUT' : 'MCP_TRANSPORT_FAILED'); }
    finally { await reader.cancel().catch(() => {}); }
  }
  return { rpc, async initialize() {
    const info = await rpc('initialize', { protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'andrew-mcp-v2-readonly', version: '1.0.0' } });
    protocol = info.protocolVersion || protocol;
    await rpc('notifications/initialized', {}, true);
  } };
}

export async function createClient(root, { transport, signal, loadConnection = connection, ticketId = null, timeoutMs = 30000, browserOptions = {}, discoverBrowser = true } = {}) {
  const { config, key } = await loadConnection(root);
  const wire = transport || httpTransport({ config, key, signal, timeoutMs });
  await wire.initialize();
  const definitions = []; const cursors = new Set(); let cursor;
  do {
    const page = await wire.rpc('tools/list', cursor ? { cursor } : {});
    if (!Array.isArray(page.tools)) throw new McpError('MCP_TOOL_LIST_INVALID');
    definitions.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor && (cursors.has(cursor) || cursors.size >= 20)) throw new McpError('MCP_TOOL_LIST_INCOMPLETE');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  const tools = definitions.filter(tool => Object.hasOwn(config.readTools, tool.name) && tool.annotations?.destructiveHint !== true);
  for (const name of Object.keys(config.readTools)) if (!tools.some(tool => tool.name === name)) throw new McpError('MCP_REQUIRED_TOOL_MISSING');
  const browser = discoverBrowser ? await browserReadiness(root, browserOptions) : { available: false, reason: 'BSK_DISCOVERY_SKIPPED' };
  if (browser.available) tools.push(browserTool);
  if (ticketId && tools.some(tool => tool.name === 'ts_get_ticket'))
  tools.push(shopConfigTool);
  const configReader = createConfigReader({ root });
  const schemas = new Map(); const paths = new Map(); let access = { secrets: [] };
  let local = null; let authorizedApp = null;
  const client = {
    browser,
    async close() { if (local) await (await local).close(); },
    tools: tools.map(tool => ({ name: tool.name, description: redact(tool.description || '', [key]), inputSchema: JSON.parse(redact(JSON.stringify(tool.inputSchema || {}), [key])) })),
    async call(name, args = {}, app = null) {
      if (name === 'ts_shop_settings') {
        if (!ticketId || !app) throw new McpError('MCP_TICKET_MISMATCH');
        if (!args || typeof args !== 'object' || Array.isArray(args) || !validArguments(args, shopConfigTool.inputSchema)
            || Object.keys(args).some(k => !Object.hasOwn(shopConfigTool.inputSchema.properties, k))) throw new McpError('MCP_ARGUMENTS_INVALID');
        const ticket = await client.call('ts_get_ticket');
        if (ticket.data?.app !== app || ticket.data?.ticket?.ticketId !== ticketId) throw new McpError('MCP_APP_MISMATCH');
        if (!supportedConfigApp(app)) throw new McpError('MCP_CONFIG_ADAPTER_UNAVAILABLE');
        const shops = (ticket.data.ticket.storeDomains || []).filter(s => /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s));
        if (new Set(shops).size !== 1) throw new McpError('MCP_CONFIG_SHOP_AMBIGUOUS');
        const data = await configReader.read({ app, shop: shops[0], ticketId, allowedShops: shops, path: args.path, source: args.source, signal });
        const ref = `mcp-v2:${app}/${randomUUID()}`, at = new Date().toISOString();
        return { ref, app, at, kind: 'observation', tool: name, args, data,
          output: `[nguồn: ${ref}]\n[đọc lúc: ${at}]\n${formatConfigReport(data)}` };
      }
      if (name === 'ts_local_browser') {
        if (!browser.available) throw new McpError('MCP_TOOL_FORBIDDEN');
        if (!ticketId || !app) throw new McpError('MCP_TICKET_MISMATCH');
        if (!validArguments(args, browserTool.inputSchema) || Object.keys(args).some(key => !Object.hasOwn(browserTool.inputSchema.properties, key))) throw new McpError('MCP_BROWSER_ARGUMENT_FORBIDDEN');
        if (!authorizedApp) authorizedApp = (await client.call('ts_get_ticket')).data?.app;
        if (authorizedApp !== app) throw new McpError('MCP_APP_MISMATCH');
        local ||= localBrowserClient(root, { wire, definitions, ticketId, ...browserOptions });
        let evidence;
        try { evidence = await (await local).call(args); } catch (error) {
          const safe = new McpError(/^MCP_|^BSK_/.test(error.message) ? error.message : 'MCP_LOCAL_BROWSER_FAILED');
          if (['STORE_BOUNDARY', 'BSK_COMMAND_FAILED', 'ADAPTER_REJECTED'].includes(error.reason)) safe.reason = error.reason;
          throw safe;
        }
        const ref = `mcp-v2:${app}/${randomUUID()}`, at = new Date().toISOString();
        const data = redactStorefrontSecrets(evidence.data, access);
        return { ref, app, at, kind: 'observation', tool: name, args, data,
          output: `[nguồn: ${ref}]\n[đọc lúc: ${at}]\n${JSON.stringify(data)}${evidence.trial ? `\nCSS verification: ${JSON.stringify(evidence.trial)}` : ''}`,
          images: evidence.content.filter(item => item.type === 'image'), trial: evidence.trial };
      }
      const rule = Object.hasOwn(config.readTools, name) ? config.readTools[name] : null; const definition = tools.find(tool => tool.name === name);
      if (!rule || !definition) throw new McpError('MCP_TOOL_FORBIDDEN');
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new McpError('MCP_ARGUMENTS_INVALID');
      const input = { ...args };
      if (rule.scope === 'ticket') {
        if (!ticketId || (input.ticket_id !== undefined && input.ticket_id !== ticketId)) throw new McpError('MCP_TICKET_MISMATCH');
        input.ticket_id = ticketId;
      }
      if (rule.scope === 'app') {
        if (!app) throw new McpError('MCP_APP_UNRESOLVED');
        if (input[rule.appArgument] !== undefined && input[rule.appArgument] !== app) throw new McpError('MCP_APP_MISMATCH');
        input[rule.appArgument] = app;
      }
      // Refuse undeclared arguments. Conditional API actions must be explicitly
      // fixed by the reviewed connection policy, never accepted from ticket data.
      for (const [field, value] of Object.entries(rule.fixedArguments || {})) {
        if (input[field] !== undefined && input[field] !== value) throw new McpError('MCP_ARGUMENT_FORBIDDEN');
        input[field] = value;
      }
      const schema = definition.inputSchema || {};
      let validationSchema = schema;
      if (name === 'ts_app_read') {
        if (!schemas.has(app)) await client.call('ts_read_tools', {}, app);
        const nested = schemas.get(app)?.find(item => item.name === input.tool);
        if (!nested || !readToolAllowed(nested, input.arguments)) throw new McpError('MCP_READ_TOOL_FORBIDDEN');
        input.arguments = { ...input.arguments };
        if (nested.parameters?.properties?.app) {
          if (input.arguments.app !== undefined && input.arguments.app !== app) throw new McpError('MCP_APP_MISMATCH');
          input.arguments.app = app;
        }
        validationSchema = { ...schema, properties: { ...schema.properties, arguments: nested.parameters } };
      }
      if (rule.scope === 'knowledge') {
        if (!app) throw new McpError('MCP_APP_UNRESOLVED');
        if (!paths.has(app)) await client.call('ts_knowledge_list', {}, app);
        if (!paths.get(app)?.has(input.path)) throw new McpError('MCP_DOCUMENT_FORBIDDEN');
      }
      if (Object.keys(input).some(field => !Object.hasOwn(schema.properties || {}, field)) || !validArguments(input, validationSchema)) throw new McpError('MCP_ARGUMENTS_INVALID');
      let result;
      try { result = await wire.rpc('tools/call', { name, arguments: input }); }
      catch (error) { throw error instanceof McpError ? error : new McpError('MCP_CALL_FAILED'); }
      if (result.isError) throw new McpError('MCP_TOOL_ERROR');
      const clean = JSON.parse(redact(JSON.stringify(result), [key]));
      const body = clean.structuredContent !== undefined ? JSON.stringify(clean.structuredContent) : (clean.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
      if (!body || body.length > 100_000) throw new McpError('MCP_TOOL_OUTPUT_INVALID');
      let data = decodeMcpData(clean);
      if (name === 'ts_get_ticket' && data?.ticket) access = storefrontAccess({ ...data.ticket, comments: (data.comments || []).map(item => ({ ...item, content: item.metadata?.content || item.content || '' })) });
      data = redactStorefrontSecrets(data, access);
      if (name === 'ts_get_ticket') authorizedApp = data?.app;
      if (name === 'ts_read_tools') {
        if (!Array.isArray(data)) throw new McpError('MCP_READ_SCHEMA_INVALID');
        data = data.map(reviewedReadSchema).filter(Boolean);
        schemas.set(app, data);
      }
      if (name === 'ts_knowledge_list') paths.set(app, listedPaths(data));
      const ref = `mcp-v2:${app || 'catalog'}/${randomUUID()}`;
      const at = new Date().toISOString();
      return { ref, kind: name === 'ts_app_read' && input.tool === 'GitLabResearch' ? 'document' : rule.kind, app, tool: name, args: JSON.parse(redact(JSON.stringify(input), [key])), at, output: `[nguồn: ${ref}]\n[đọc lúc: ${at}]\n${typeof data === 'string' ? data : JSON.stringify(data)}`, data };
    },
  };
  return client;
}

// The live service serializes some read-tool arrays twice. Decode data only;
// never evaluate returned text or treat it as an instruction.
export function decodeMcpData(result) {
  let value = result.structuredContent ?? (result.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  for (let i = 0; i < 5 && typeof value === 'string'; i++) { try { value = JSON.parse(value); } catch { break; } }
  return value;
}
function listedPaths(value, found = new Set()) {
  if (!value || typeof value !== 'object') return found;
  if (typeof value.path === 'string') found.add(value.path);
  for (const child of Object.values(value)) if (child && typeof child === 'object') listedPaths(child, found);
  return found;
}
function readToolAllowed(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const common = new Set(['StorefrontHealth', 'StorefrontSource', 'SlackSearch', 'SlackThread', 'CrispChat', 'TrelloCard', 'JamDebug', 'ShopLookup', 'ResolveShopifyDomain', 'ShopStorefrontOverview', 'ShopTickets']);
  if (common.has(tool.name)) return true;
  if (tool.name === 'GitLabResearch') return ['search', 'multi_search', 'grep', 'screens', 'plans', 'read', 'tree', 'blame', 'history', 'mrs', 'branches'].includes(args.action);
  if (tool.name === 'AvadaTicket') return ['get', 'by-date', 'by-status', 'by-chat', 'actions'].includes(args.action);
  // App-specific actions need the live enum AND a read-only action form.
  // Unknown endpoints, unrestricted CRM paths and free-form actions stay closed.
  const actions = tool.parameters?.properties?.action?.enum;
  return Array.isArray(actions) && actions.includes(args.action) && /^(?:get[-_]|list[-_]|read[-_]|search[-_]|troubleshoot$)/.test(args.action);
}
function reviewedReadSchema(tool) {
  if (readToolAllowed(tool, {})) return tool;
  const actions = tool.name === 'GitLabResearch' ? ['search', 'multi_search', 'grep', 'screens', 'plans', 'read', 'tree', 'blame', 'history', 'mrs', 'branches']
    : tool.name === 'AvadaTicket' ? ['get', 'by-date', 'by-status', 'by-chat', 'actions']
      : (tool.parameters?.properties?.action?.enum || []).filter(action => readToolAllowed(tool, { action }));
  if (!actions.length) return null;
  return { ...tool, parameters: { ...tool.parameters, properties: { ...tool.parameters.properties, action: { ...tool.parameters.properties.action, enum: actions } } } };
}

function validArguments(value, schema = {}, depth = 0) {
  if (depth > 12) return false;
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) return false;
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) return false;
  if (schema.anyOf) return schema.anyOf.some(part => validArguments(value, part, depth + 1));
  if (schema.oneOf) return schema.oneOf.filter(part => validArguments(value, part, depth + 1)).length === 1;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if ((schema.required || []).some(field => !Object.hasOwn(value, field))) return false;
    return Object.entries(value).every(([field, item]) => Object.hasOwn(schema.properties || {}, field)
      ? validArguments(item, schema.properties[field], depth + 1)
      : schema.additionalProperties === true);
  }
  if (schema.type === 'array') return Array.isArray(value) && value.length <= Math.min(schema.maxItems ?? 100, 100) && value.every(item => validArguments(item, schema.items, depth + 1));
  if (schema.type === 'integer') return Number.isSafeInteger(value) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length > Math.min(schema.maxLength ?? 12000, 12000) || value.length < (schema.minLength ?? 0)) return false;
    if (schema.pattern) { try { if (!new RegExp(schema.pattern).test(value)) return false; } catch { return false; } }
    return true;
  }
  if (schema.type === 'null') return value === null;
  // Unknown schemas require an adapter based on the real service contract.
  return false;
}

// Match the actual catalog using stable id/slug/name/aliases. No default app and
// no enumeration copied from the old engine: new apps can be discovered remotely.
export function matchApp(catalog, candidates) {
  const rows = Array.isArray(catalog) ? catalog : catalog?.apps;
  if (!Array.isArray(rows)) throw new McpError('MCP_APP_CATALOG_INVALID');
  const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const candidate of candidates.filter(Boolean)) {
    const matches = rows.filter(row => [row.slug, row.id, row.name, ...(Array.isArray(row.aliases) ? row.aliases : [])].some(value => normalize(value) === normalize(candidate)));
    if (matches.length > 1) throw new McpError('MCP_APP_AMBIGUOUS');
    if (matches.length === 1) { if (matches[0].disabled || matches[0].internal) throw new McpError('MCP_APP_UNAVAILABLE'); const slug = matches[0].slug || matches[0].id; if (typeof slug !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(slug)) throw new McpError('MCP_APP_CATALOG_INVALID'); return slug; }
  }
  throw new McpError('MCP_APP_UNSUPPORTED');
}
