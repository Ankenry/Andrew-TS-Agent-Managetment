import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, rename, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

const source = await readFile(new URL("./ticket-notification-to-telegram.mjs", import.meta.url), "utf8");
const notification = (id, type = "ticket_created") => ({
  id, type, metadata: { ticketId: id }, createdAt: "2999-01-01T00:00:00Z",
});

async function harness(t) {
  const root = await mkdtemp(resolve(tmpdir(), "andrew-notifier-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = { notifications: [], sent: [], paths: [], timers: [], telegramFails: false };
  const context = vm.createContext({
    readFile, writeFile, rename, mkdir, dirname, resolve, URLSearchParams, randomUUID, Buffer,
    HttpsAgent: class { constructor(options) { this.options = options; } },
    console: { log() {}, error() {} },
    process: { argv: ["node", "notifier", "--watch", "--resume-session"] },
    setInterval: (fn, delay) => input.timers.push({ fn, delay }),
    fetch: async () => { throw new Error("Unexpected external request"); },
    startTicketReviewAutomation: async (options) => {
      input.workflowOptions=options;
      input.workflowStarts = (input.workflowStarts || 0) + 1;
      return { started: true, health: () => ({ enabled: true, started: true }) };
    },
  });
  const code = source.slice(0, source.lastIndexOf("\nmain().catch("))
    .replace(/^import .*;\n/gm, "")
    .replace(/^const PROJECT_ROOT = .*;$/m, `const PROJECT_ROOT = ${JSON.stringify(root)};`);
  vm.runInContext(code, context);
  context.loadConfig = async () => ({ apiKey: "test" });
  context.helpdeskGet = async (path) => {
    input.paths.push(path);
    assert.ok(path.startsWith("/notifications?"), `Unexpected Helpdesk read: ${path}`);
    return { notifications: input.notifications };
  };
  context.telegramSend = async (_config, text) => {
    if (input.telegramFails) throw new Error("Telegram offline");
    input.sent.push(text);
    return {messageId:input.sent.length};
  };
  return { context, input, root, state: () => context.loadState() };
}

test("new and assigned tickets only forward notifications once", async (t) => {
  const h = await harness(t);
  await h.context.startNotificationSession();
  h.input.notifications = [notification("new"), notification("assigned", "ticket_assigned")];
  await h.context.notifyOnce();
  await h.context.notifyOnce();
  assert.equal(h.input.sent.length, 2);
  assert.equal((await h.state()).notifiedIds.length, 2);
  assert.equal((await h.state()).autoTicketReviews, undefined);
  assert.equal(h.context.helpdeskPost, undefined);
  assert.equal(h.context.processAutomaticTicketReviews, undefined);
});

test("legacy queued, running and failed reviews and notices are not restored", async (t) => {
  const h = await harness(t);
  await h.context.startNotificationSession();
  const before = await h.state();
  await h.context.saveState({ ...before, assignedTicketIds: ["old"], autoTicketReviews: {
    queued: { status: "queued", comment: "old draft" },
    running: { status: "reviewing", pendingNotice: { text: "checking" } },
    failed: { status: "needs_attention" },
  } });
  await h.context.startNotificationSession({ resume: true });
  await h.context.notifyOnce();
  const disk = JSON.parse(await readFile(resolve(h.root, "runtime/telegram-ticket-notifier-state.json"), "utf8"));
  assert.equal(disk.autoTicketReviews, undefined);
  assert.equal(disk.assignedTicketIds, undefined);
  assert.equal(disk.sessionStartedAt, before.sessionStartedAt);
  assert.equal(h.input.sent.length, 0);
});

test("existing notifications remain baseline-only", async (t) => {
  const h = await harness(t);
  h.input.notifications = [{ ...notification("old"), createdAt: "2000-01-01T00:00:00Z" }];
  await h.context.startNotificationSession();
  await h.context.notifyOnce();
  assert.equal(h.input.sent.length, 0);
});

test("Telegram delivery failure retries the notification without creating AI work", async (t) => {
  const h = await harness(t);
  await h.context.startNotificationSession();
  h.input.notifications = [notification("assigned", "ticket_assigned")];
  h.input.telegramFails = true;
  await assert.rejects(h.context.notifyOnce(), /Telegram offline/);
  assert.equal((await h.state()).notifiedIds.length, 0);
  h.input.telegramFails = false;
  await h.context.notifyOnce();
  assert.equal(h.input.sent.length, 1);
  assert.equal((await h.state()).autoTicketReviews, undefined);
});

test("watch starts the separate review service once and preserves notification timers", async (t) => {
  const h = await harness(t);
  h.context.startWidgetAiBridge = async () => {};
  h.context.replyToTelegramMessages = async () => {};
  await h.context.main();
  assert.deepEqual(h.input.timers.map(timer => timer.delay).sort((a,b) => a-b), [5000, 300000]);
  h.input.notifications = [notification("new")];
  for (const timer of h.input.timers) timer.fn();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.input.sent.length, 0);
  const receipt=await h.input.workflowOptions.notify('🔎 Hachimi đang checking ticket TEST');
  assert.equal(receipt.messageId,1);assert.equal(h.input.sent.length,1);
  assert.equal((await h.state()).autoTicketReviews, undefined);
  assert.equal(h.input.workflowStarts, 1);
});

test('Active review service owns ticket lifecycle notices while other notifications still forward',async t=>{
  const h=await harness(t);await h.context.startNotificationSession();await h.context.ensureTicketReviewAutomation();
  h.input.notifications=[notification('a'),notification('b','ticket_assigned'),notification('c','ticket_commented')];
  await h.context.notifyOnce();await h.context.notifyOnce();
  assert.equal(h.input.sent.length,1);assert.match(h.input.sent[0],/\/t\/c/);
  assert.equal((await h.state()).notifiedIds.length,3);
});

test("transport diagnostics retain error codes without leaking credential URLs", async (t) => {
  const h = await harness(t);
  h.context.httpsRequest = () => {
    throw Object.assign(new Error("https://api.telegram.org/botSECRET/getUpdates"), {
      cause: { code: "ECONNRESET", errors: [{ code: "ENETUNREACH" }] },
    });
  };
  await assert.rejects(h.context.telegramFetch("secret-url", {}, "getUpdates"), (error) => {
    assert.match(error.message, /ECONNRESET/);
    assert.match(error.message, /ENETUNREACH/);
    assert.doesNotMatch(error.message, /SECRET|secret-url|https/);
    return true;
  });
});

test("Telegram transport pins IPv4, preserves auth URL, request body and abort signal", async (t) => {
  const h = await harness(t);
  const signal = AbortSignal.timeout(1000);
  let sent;
  h.context.httpsRequest = (url, options, onResponse) => {
    assert.equal(url, "https://api.telegram.org/botTEST/sendMessage");
    assert.equal(options.agent.options.family, 4);
    assert.equal(options.signal, signal);
    assert.equal(options.method, "POST");
    const request = new EventEmitter();
    request.end = (body) => {
      sent = body;
      const response = new EventEmitter();
      response.statusCode = 200;
      onResponse(response);
      response.emit("data", Buffer.from('{"ok":true}'));
      response.emit("end");
    };
    return request;
  };
  const response = await h.context.telegramFetch("https://api.telegram.org/botTEST/sendMessage", { method: "POST", body: '{"text":"hello"}', signal }, "sendMessage");
  assert.equal(sent, '{"text":"hello"}');
  assert.equal(response.ok, true);
  assert.equal((await response.json()).ok, true);
});

test("Telegram polling waits after transport failures and resets after success", async (t) => {
  const h = await harness(t);
  let calls = 0;
  h.context.telegramGetUpdates = async () => { calls++; throw new Error("offline"); };
  await assert.rejects(h.context.replyToTelegramMessages(), /offline/);
  await h.context.replyToTelegramMessages();
  assert.equal(calls, 1);
  vm.runInContext("telegramChatNextAttemptAt = 0", h.context);
  h.context.telegramGetUpdates = async () => { calls++; return []; };
  await h.context.replyToTelegramMessages();
  assert.equal(calls, 2);
  assert.equal(vm.runInContext("telegramChatFailures", h.context), 0);
});

test("Bridge jobs record which local process took them, and failures carry it back", () => {
  const pick = name => source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
  const bridgeConsumer = vm.runInNewContext(`${pick("isExtensionOrigin")}\n${pick("bridgeConsumer")}\nbridgeConsumer`);
  const extensionOrigin = "chrome-extension://" + "a".repeat(32);
  // The TS Management web presents the extension's Origin, so the client itself decides.
  assert.equal(bridgeConsumer({ headers: { "user-agent": "node", origin: extensionOrigin } }), "ts-web");
  assert.equal(bridgeConsumer({ headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36" } }), "extension");
  assert.equal(bridgeConsumer({ headers: { origin: extensionOrigin } }), "extension");
  assert.equal(bridgeConsumer({ headers: {} }), "unknown");
  assert.match(source, /dispatched job \$\{job\.id\} to \$\{job\.consumer\}/);
  assert.match(source, /bridgeJson\(response, 400, \{ error: [^}]*jobId: error\?\.jobId, consumer: error\?\.consumer \}\)/);
  assert.match(source, /bridgeJson\(response, 200, \{ answer, \.\.\.trace \}\)/);
});
