(() => {
  const ROOT_ID = "andrew-ticket-widget-root";
  const existing = document.getElementById(ROOT_ID);
  if (existing) { existing.dispatchEvent(new Event("andrew-toggle-widget")); return; }

  const HELP_DESK_URL = "https://helpdesk.avada.net";
  // Chrome extensions cannot execute local shell commands. Keep the exact
  // detached-screen command here so the user can copy it after a reboot.
  const TELEGRAM_BOT_START_COMMAND = "cd \"/home/avada/Andrew Tools CS-TS/Andrew TS Tools\" && screen -dmS andrew_ticket_notifier bash -lc 'exec node scripts/ticket-notification-to-telegram.mjs --watch >> runtime/telegram-ticket-notifier.log 2>&1'";
  const CODEX_BRIDGE_START_COMMAND = "cd \"/home/avada/Andrew Tools CS-TS/Andrew TS Tools\" && screen -dmS andrew_codex_ticket_bridge bash -lc 'exec node scripts/codex-ticket-bridge.mjs >> runtime/codex-ticket-bridge.log 2>&1'";
  // The external Members API does not return the Helpdesk-only `group` field.
  // Ticket Management uses this same app-to-team allocation as Helpdesk.
  const TS_TEAM_BY_APP = Object.freeze({
    "Air Reviews": "TS2", "LUNA Booking": "TS2", "AOV Bundle": "TS1", "AOV Bundle Upsell": "TS1", "AOV Cart Drawer": "TS1", "AOV Post Purchase": "TS1", "Chatty": "TS2", "AOV Free Gift": "TS1", "AOV Checkout Upsell": "TS1", "AOV Countdown Timer": "TS1", "Boost Sales": "TS1", "Cookie Bar": "TS2", "Email Marketing": "TS2", "Form": "TS2", "SEA Fraud Filter": "TS2", "JOY Loyalty": "TS2", "JOY Subscription": "TS2", "Shopvid": "TS2", "ShopVid Shoppable Video Reels": "TS2", "Avada Order Limit": "TS2", "Order Limits": "TS2", "PDF Invoice": "TS2", "POS Fee Surcharge": "TS2", "SEO On Blog": "TS1", "SEO On AEO": "TS1", "SEO On AI Product Copy": "TS1", "SEO On: AI Product Description": "TS1", "SEA Accessibility": "TS2", "Accessibility": "TS2", "SEO Suite": "TS1", "SEA Survey": "TS2", "Survey": "TS2", "SUN Age Verification": "TS2", "Avada Speed Optimization": "TS1", "Image Optimizer": "TS1", "Blocko Section": "TS1", "Wishlist": "TS2", "POS Staff management": "TS2", "LUNA Whatsapp": "TS2", "MARS COD Form": "TS2", "UpMagic AI": "TS2", "Avada Affiliate Marketing": "TS2", "Air Estimated Delivery Date": "TS2", "SUN Order Tracking": "TS2", "AOV.ai Pre-Order": "TS1", "LUNA Shipping Protection": "TS2", "Avada Backups & Restore": "TS2", "Avada Shipping Labels": "TS2", "Order Editing": "TS2", "SEA Online Course": "TS2", "Withdrawal Forms": "TS2"
  });
  const LOCAL_READ_NOTIFICATION_IDS_KEY = "widgetReadNotificationIds";
  const NOTIFICATION_BASELINE_KEY = "widgetNotificationBaselineCreated";
  const CHAT_HISTORY_STORAGE_KEY = "ticketAiConversationHistory";
  // Local Hachimi tracing web (scripts/hachimi-trace-web.mjs). Chrome resolves every *.localhost name to this machine,
  // so the friendly name needs no setup. Keep in sync with TRACE_LOCAL_NAME / HACHIMI_TRACE_WEB_PORT.
  const TRACE_WEB_URL = "http://andrewtstracing.localhost:5077";
  // Local TS Management web (scripts/ts-management-web.mjs); keep in sync with TS_WEB_PORT.
  // andrewtsmanagement.com is a local name: /etc/hosts maps it to 127.0.0.1 on this machine.
  const TS_WEB_URL = "http://andrewtsmanagement.com:5088";
  const conversationTicketRef = (conversation) => conversation?.selectedTicket?.ticketId || conversation?.selectedTicket?.id || "";
  const conversationTraceUrl = (conversation) => {
    const ticket = conversationTicketRef(conversation);
    return `${TRACE_WEB_URL}/#chat/${encodeURIComponent(conversation.chatId)}${ticket ? `?ticket=${encodeURIComponent(ticket)}` : ""}`;
  };
  // Every trace of one ticket (automatic review, widget chats, manual checks).
  const ticketTraceUrl = (ticketRef) => `${TRACE_WEB_URL}/#ticket/${encodeURIComponent(ticketRef)}`;
  // Automatic reviews saved into the history (automatic-history.js) open their own trace inside the ticket view.
  const AutomaticHistory = globalThis.AutomaticReviewHistory;
  const historyTraceUrl = (conversation) => {
    const ticketRef = conversationTicketRef(conversation);
    if (!ticketRef) return conversationTraceUrl(conversation);
    const jobId = AutomaticHistory.isAutomatic(conversation) ? conversation.automatic?.jobId : "";
    return `${ticketTraceUrl(ticketRef)}${jobId ? `?open=automatic:${encodeURIComponent(jobId)}` : ""}`;
  };
  const MAX_REMEMBERED_NOTIFICATION_IDS = 2_000;
  const MAX_SAVED_MESSAGES_PER_CONVERSATION = 100;
  const HELPDESK_WEBHOOK_EVENTS_URL = "http://127.0.0.1:39543/events";
  // Webhooks are the realtime path. This only heals a missed event after a
  // bridge, tunnel, or Chrome disconnect; it is not the normal sync loop.
  const RECONCILIATION_INTERVAL_MS = 30 * 60_000;
  const GROUPS = [
    { key: "pending", label: "Pending", action: { label: "Move to doing", nextStatus: "doing" } },
    { key: "doing", label: "Doing", action: { label: "Wait customer", nextStatus: "waiting_customer" }, bulkAction: { label: "Move all → wait", nextStatus: "waiting_customer" } },
    // Keep shared tickets visible: Andrew being one of several assignees still
    // means it belongs in his queue. Show the details needed to review it.
    { key: "waiting_customer", label: "Wait customer", action: { label: "Move to done", nextStatus: "done" }, bulkAction: { label: "Move all → done", nextStatus: "done" }, keepAndrewOnly: true, showDetails: true },
    { key: "dev_fixing", label: "Dev fix", slackOnly: true },
    // Feature Request tickets (Helpdesk tsStatus feature_request), followed by the feature-follow skill via the TS web (12/10/2026).
    { key: "feature_request", label: "Feature", slackOnly: true, feature: true },
  ];
  const createChatId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const state = {
    screen: "home", groups: {}, notifications: [], generalNotifications: [], devDoneNotifications: [], dateFollowNotifications: [], slaSkillNotifications: [], scanSchedules: [], devFollowDue: {}, featureFollow: null, featureFollowError: "", notificationSection: "general", chatSection: "chat", checking: { tab: "cmt", sessions: [], loaded: false, error: "", open: null }, followDevDetail: null, followDevLoading: false, followDevMail: "", showUnreadOnly: false, ticketRequest: null, notificationRequest: null, selectedTicket: null, chatId: createChatId(), aiConnected: false, chatHistoryOpen: false, savedConversations: [], selectedDoingTicketIds: new Set(), selectedWaitingCustomerTicketIds: new Set(),
    widgetDisplay: "panel", widgetOpen: true,
    ticketManagement: { team: "TS2", tickets: [], members: [], loading: false, error: "" },
    chatMessages: [],
  };

  const host = document.createElement("aside");
  host.id = ROOT_ID;
  host.setAttribute("aria-label", "TS Management ticket assistant");
  host.style.cssText = "position:fixed;z-index:2147483647;width:420px;max-width:calc(100vw - 32px);";
  const shadow = host.attachShadow({ mode: "open" });
  document.documentElement.append(host);

  const style = document.createElement("style");
  style.textContent = `
    :host { all:initial; } *,*::before,*::after { box-sizing:border-box; } button,input,select,textarea { font:inherit; }
    .panel { display:flex;height:min(680px,calc(100vh - 32px));max-height:calc(100vh - 32px);flex-direction:column;overflow:hidden;border:1px solid #e7e5eb;border-radius:20px;color:#1f1f29;background:#fbfbfc;box-shadow:0 18px 50px rgba(15,23,42,.32);font-family:Inter,ui-sans-serif,system-ui,sans-serif; }
    .widget-launcher { position:relative;display:none;width:64px;height:64px;place-items:center;border:0;border-radius:50%;cursor:pointer;padding:0;background:#000;box-shadow:0 12px 28px rgba(15,23,42,.28);transition:transform .16s ease,box-shadow .16s ease; }.widget-launcher:hover { transform:translateY(-2px);box-shadow:0 16px 34px rgba(15,23,42,.34); }.widget-launcher:focus-visible { outline:3px solid #a78bfa;outline-offset:3px; }.widget-launcher img { width:52px;height:52px;border-radius:50%; }.widget-launcher .online-dot { position:absolute;right:2px;bottom:2px;width:15px;height:15px;border:2px solid #fff;border-radius:50%;background:#22c55e; }:host([data-display="bubble"][data-open="false"]) .widget-launcher { display:grid; }:host([data-display="bubble"][data-open="false"]) .panel { display:none; }
    .head { display:flex;min-height:96px;align-items:flex-start;justify-content:space-between;padding:17px 17px 15px;color:#fff;background:linear-gradient(112deg,#604893 0%,#765ab8 48%,#9578e4 100%); }.head.chat-head { min-height:68px;align-items:center;padding:12px 14px; }.eyebrow { margin:0 0 3px;font-size:9px;font-weight:800;letter-spacing:.1em;opacity:.8; } h2 { margin:0;font-size:20px;line-height:1.2; }.subtitle { margin:4px 0 0;color:#f0ebff;font-size:11px; }.brand { display:flex;align-items:center;gap:10px; }.brand-logo { width:40px;height:40px;flex:0 0 40px;border:2px solid rgba(255,255,255,.45);border-radius:50%;object-fit:cover;background:#fff; }.head-button { display:grid;width:30px;height:30px;place-items:center;border:0;border-radius:9px;cursor:pointer;color:#fff;background:rgba(255,255,255,.15);font-size:19px;line-height:1; }.back { display:flex;align-items:center;gap:9px;border:0;cursor:pointer;color:#fff;background:transparent;font-size:14px;font-weight:700; }.back span { font-size:26px;font-weight:400; }
    .screen { min-height:0;flex:1;overflow-y:auto;scrollbar-width:none;-ms-overflow-style:none; }.screen::-webkit-scrollbar,.chat-messages::-webkit-scrollbar { display:none; }
    .home-summary { display:flex;align-items:center;justify-content:space-between;padding:15px 16px 0; }.count-pill { padding:5px 10px;border-radius:999px;color:#604893;background:#eee7ff;font-size:12px;font-weight:750; }.refresh { border:0;border-radius:8px;cursor:pointer;padding:7px 11px;color:#604893;background:#f0ebff;font-size:12px;font-weight:700; }.refresh:disabled { cursor:wait;opacity:.65; }.status { min-height:18px;margin:10px 16px 0;color:#667085;font-size:12px;line-height:1.4; }.status.error { padding:8px;border:1px solid #fecaca;border-radius:8px;color:#b42318;background:#fff1f1; }
    .categories { display:grid;gap:8px;padding:12px 11px 18px; }.category { overflow:hidden;border:1px solid #e7e5eb;border-radius:12px;background:#fff; }.category-header { display:flex;min-height:45px;align-items:center;gap:6px;padding:7px 8px 7px 11px; }.toggle { display:flex;min-width:0;flex:1;align-items:center;gap:7px;border:0;cursor:pointer;padding:3px 0;color:#25334c;background:transparent;text-align:left; }.arrow { color:#64748b;font-size:12px;transition:transform .15s; }.category.expanded .arrow { transform:rotate(90deg); }.name { font-size:13px;font-weight:800; }.count { display:grid;min-width:20px;height:20px;place-items:center;padding:0 5px;border-radius:999px;color:#604893;background:#eee7ff;font-size:10px;font-weight:800; }.group-actions { display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px; }.all,.keep-andrew { border:0;border-radius:6px;cursor:pointer;padding:6px 7px;color:#604893;background:#eee7ff;font-size:10px;font-weight:800; }.keep-andrew { color:#fff;background:#765ab8; }.items { display:none;border-top:1px solid #edf0f5; }.category.expanded .items { display:block; }.empty { margin:0;padding:12px;color:#7a8699;font-size:11px; }.ticket { display:flex;align-items:flex-start;gap:6px;padding:9px 10px;border-bottom:1px solid #f0f2f6; }.ticket:last-child { border:0; }.link { min-width:0;flex:1;color:inherit;text-decoration:none; }.link:hover .subject { color:#765ab8; }.id { display:block;color:#765ab8;font-size:9px;font-weight:800;letter-spacing:.02em; }.subject { display:block;overflow:hidden;margin-top:2px;color:#334155;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:650; }.ticket-members { display:block;margin-top:4px;color:#667085;font-size:9px;line-height:1.35; }.ticket-description { display:block;margin-top:3px;color:#475467;font-size:10px;line-height:1.4;white-space:pre-wrap; }.ticket-actions { display:flex;flex-direction:column;align-items:flex-end;gap:6px;padding-left:8px; }.dev-reminder-warning { margin:0;color:#b45309;font-size:10px;font-weight:800;line-height:1.3;text-align:right; }.ticket.feature-ticket { flex-wrap:wrap; }.feature-progress { display:grid;gap:5px;flex:1 1 100%;width:100%;margin-top:4px;padding:7px 8px;border:1px solid #ebe7f5;border-radius:8px;background:#faf8ff; }.feature-head { display:flex;flex-wrap:wrap;align-items:center;gap:5px; }.feature-pill { display:inline-block;border-radius:999px;padding:2px 7px;color:#fff;background:#667085;font-size:9px;font-weight:800;line-height:1.3; }.feature-pill.status-in_progress,.feature-pill.status-acknowledged { background:#765ab8; }.feature-pill.status-done,.feature-pill.status-awaiting_verification { background:#15803d; }.feature-pill.status-awaiting_merge { background:#0369a1; }.feature-pill.status-no_response,.feature-pill.status-blocked,.feature-pill.status-missing_thread { background:#b45309; }.feature-pill.status-declined { background:#be123c; }.feature-meta,.feature-meta-line,.feature-note,.feature-scan-note { margin:0;color:#667085;font-size:10px;line-height:1.35; }.feature-note.error { color:#b42318; }.feature-text { margin:0;color:#334155;font-size:11px;line-height:1.4;overflow-wrap:anywhere;white-space:normal; }.feature-previews { display:flex;flex-wrap:wrap;gap:4px; }.feature-preview { max-height:220px;overflow:auto;margin:0;padding:7px 8px;border:1px solid #ebe7f5;border-radius:6px;background:#fff;color:#334155;font-size:10px;line-height:1.4;white-space:pre-wrap;overflow-wrap:anywhere; }.feature-actions { align-items:center; }.move,.ask-ai { border:0;border-radius:6px;cursor:pointer;padding:5px 6px;color:#604893;background:#f0ebff;font-size:9px;font-weight:800;white-space:nowrap; }.ask-ai { color:#fff;background:#765ab8; }.dev-remind { color:#fff;background:#dc2626; }.notification-tabs { display:flex;border-bottom:1px solid #e7e5eb;padding:0 12px; }.notification-tab { flex:1;border:0;border-bottom:2px solid transparent;cursor:pointer;padding:12px 6px 10px;color:#8991a0;background:transparent;font-size:11px;font-weight:800; }.notification-tab.active { border-bottom-color:#ec4899;color:#fff; }.notification-list { display:grid;gap:8px;padding:12px 11px 18px; }.notification { display:block;border:1px solid #e7e5eb;border-radius:12px;padding:11px;color:#25334c;background:#fff;text-decoration:none; }.notification-link { display:block;color:inherit;text-decoration:none; }.notification:hover { border-color:#c8b8ee;background:#faf8ff; }.notification.unread { border-left:3px solid #765ab8;padding-left:9px; }.notification-top { display:flex;align-items:center;justify-content:space-between;gap:8px; }.notification-title { overflow:hidden;color:#334155;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:800; }.notification-badge { flex:0 0 auto;border-radius:999px;padding:2px 6px;color:#fff;background:#765ab8;font-size:9px;font-weight:800; }.notification-message { display:-webkit-box;overflow:hidden;margin-top:5px;color:#667085;-webkit-box-orient:vertical;-webkit-line-clamp:2;font-size:11px;line-height:1.4; }.notification-time { display:block;margin-top:7px;color:#98a2b3;font-size:10px; }.notification-card-actions { display:flex;justify-content:flex-end;margin-top:9px; }
    .nav { display:flex;min-height:64px;flex:0 0 64px;border-top:1px solid #e8e6ea;background:#fff; }.nav-button { position:relative;display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:3px;border:0;cursor:pointer;color:#737373;background:transparent;font-size:11px; }.nav-icon { font-size:21px;line-height:1; }.nav-button.active { color:#765ab8;font-weight:800; }.nav-button.active::before { position:absolute;top:0;width:42px;border-top:2px solid #765ab8;content:""; }
    .chat-screen { display:flex;flex-direction:column;overflow:hidden; }.chat-context { display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border-bottom:1px solid #e9e5f4;color:#604893;background:#f5f1ff;font-size:11px; }.chat-context span { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }.clear-context { border:0;cursor:pointer;padding:2px 5px;color:#604893;background:transparent;font-size:13px; }.chat-messages { display:flex;min-height:0;flex:1;flex-direction:column;gap:9px;overflow-y:auto;padding:14px 12px;scrollbar-width:none;-ms-overflow-style:none; }.bubble { max-width:84%;padding:10px 12px;border-radius:15px;color:#2e2a38;background:#f0eef2;font-size:12px;line-height:1.45;white-space:pre-wrap; }.bubble.user { align-self:flex-end;color:#fff;background:#604893;border-bottom-right-radius:4px; }.bubble.assistant { align-self:flex-start;border-bottom-left-radius:4px; }.bubble.assistant.ai-response { width:100%;max-width:100%;border:1px solid #303030;border-radius:4px;padding:12px 13px;color:#f5f5f5;background:#171717;font-size:12px;line-height:1.48;white-space:normal; }.ai-response-copy { margin:0 0 9px;color:#e8e8e8; }.ai-response-copy:last-child { margin-bottom:0; }.ai-response-section { margin:11px 0 5px;color:#fff;font-size:12px;font-weight:800; }.ai-response-section:first-child { margin-top:0; }.ai-response-list { margin:3px 0 10px;padding-left:17px;color:#ededed; }.ai-response-list:last-child { margin-bottom:0; }.ai-response-list li { margin:3px 0;padding-left:1px; }.ai-response strong { color:#fff;font-weight:800; }.ai-response code { border-radius:3px;padding:1px 3px;color:#f6c979;background:#272727;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.94em; }.bubble.thinking { color:#765ab8;font-style:italic; }.chat-form { display:flex;align-items:flex-end;gap:8px;padding:10px 12px;border-top:1px solid #e8e6ea;background:#fff; }.chat-input { min-height:40px;max-height:96px;flex:1;resize:none;border:1px solid #d7d1e1;border-radius:11px;padding:10px;outline:none;color:#2e2a38;background:#fbfbfc;font-size:12px; }.chat-input:focus { border-color:#765ab8;box-shadow:0 0 0 3px #eee7ff; }.send { display:grid;width:40px;height:40px;place-items:center;border:0;border-radius:10px;cursor:pointer;color:#fff;background:#765ab8;font-size:16px; }.send:disabled { cursor:wait;opacity:.55; }.chat-header-actions { display:flex;align-items:center;gap:5px; }.chat-header-button { border:0;border-radius:7px;cursor:pointer;padding:6px 7px;color:#fff;background:rgba(255,255,255,.16);font-size:10px;font-weight:800; }.chat-history-list { display:grid;grid-template-columns:minmax(0,1fr);gap:8px;overflow-x:hidden;overflow-y:auto;padding:12px; }.chat-history-title { margin:0 0 2px;color:#2e2a38;font-size:14px;font-weight:800; }.chat-history-copy { margin:0 0 8px;color:#667085;font-size:11px; }.chat-history-item { min-width:0;max-width:100%;overflow:hidden;border:1px solid #e7e5eb;border-radius:11px;cursor:pointer;padding:10px;color:#2e2a38;background:#fff;text-align:left; }.chat-history-item:hover { border-color:#bfa9e8;background:#faf8ff; }.chat-history-item strong,.chat-history-item span { display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }.chat-history-item strong { font-size:12px; }.chat-history-item span { margin-top:4px;color:#667085;font-size:10px; }.chat-history-row { display:flex;min-width:0;max-width:100%;align-items:stretch;gap:6px; }.chat-history-row .chat-history-item { min-width:0;flex:1; }.chat-history-ticket { margin-top:4px;color:#604893;font-size:10px;font-weight:700; }.chat-history-item .chat-history-auto { display:inline-block;max-width:100%;margin-top:5px;border-radius:9px;padding:2px 7px;color:#075d70;background:#e6f8fc;font-size:10px;font-weight:800; }.chat-history-item .chat-history-auto.running { color:#8a5a00;background:#fff4d6; }.chat-history-item .chat-history-auto.failed,.chat-history-item .chat-history-auto.uncertain { color:#a12828;background:#fde8e8; }.chat-history-trace { display:flex;flex:0 0 auto;align-items:center;justify-content:center;border:1px solid #d7d1e1;border-radius:11px;cursor:pointer;padding:5px 10px;color:#604893;background:#f5f1ff;font-size:10px;font-weight:800;white-space:nowrap; }.chat-history-trace.ticket { color:#075d70;background:#e6f8fc;border-color:#bfe9f2; }.chat-history-trace.ticket:hover { background:#d2f1f8;border-color:#7fd3e6; }.chat-history-trace:hover { border-color:#bfa9e8;background:#ece4ff; }.ticket.doing-ticket { display:block; }.doing-ticket .link { display:block; }.doing-ticket .ticket-actions { display:flex;flex-direction:row;align-items:center;justify-content:flex-start;gap:8px;margin-top:10px;padding-left:0; }.doing-ticket .ticket-actions button { flex:0 0 auto; }.ticket-tooltip.conversation { max-height:min(460px,calc(100vh - 24px)); }.ticket-tooltip { position:fixed;z-index:2147483647;width:min(330px,calc(100vw - 24px));max-height:260px;overflow:auto;pointer-events:none;border:1px solid #bfa9e8;border-radius:10px;padding:10px;color:#fff;background:#2a1c40;box-shadow:0 12px 32px rgba(0,0,0,.35);font-size:11px;line-height:1.45;white-space:pre-wrap; }
    .settings { padding:16px; }.settings h3 { margin:0;color:#2e2a38;font-size:16px; }.settings-copy { margin:6px 0 16px;color:#667085;font-size:12px;line-height:1.45; }.setting-card { margin:0 0 12px;padding:12px;border:1px solid #e7e5eb;border-radius:12px;background:#fff; }.setting-card h4 { margin:0 0 5px;color:#2e2a38;font-size:13px; }.setting-card p { margin:0 0 10px;color:#667085;font-size:11px;line-height:1.4; }.setting-switch { display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px; }.setting-switch label { margin:0;cursor:pointer; }.setting-switch input { position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap; }.switch-track { position:relative;display:block;width:42px;height:24px;flex:0 0 42px;border-radius:999px;cursor:pointer;background:#c9c4d1;transition:background .16s ease; }.switch-track::after { position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;content:"";background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.28);transition:transform .16s ease; }.setting-switch input:checked + .switch-track { background:#765ab8; }.setting-switch input:checked + .switch-track::after { transform:translateX(18px); }.setting-switch input:focus-visible + .switch-track { outline:3px solid #c8b8ee;outline-offset:3px; }.setting-switch input:disabled + .switch-track { cursor:wait;opacity:.6; }label { display:block;margin:11px 0 5px;color:#4a4454;font-size:11px;font-weight:750; }input,select { width:100%;border:1px solid #d7d1e1;border-radius:8px;padding:9px;outline:none;color:#2e2a38;background:#fff;font-size:12px; }input:focus,select:focus { border-color:#765ab8;box-shadow:0 0 0 3px #eee7ff; }.terminal-command { width:100%;min-height:78px;resize:vertical;border:0;border-radius:14px;padding:12px;color:#f5f5f5;background:#242424;box-shadow:inset 0 0 0 1px #303030;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;line-height:1.5; }.terminal-command::selection { color:#fff;background:#765ab8; }.primary,.secondary { border:0;border-radius:8px;cursor:pointer;padding:9px 11px;color:#fff;background:#765ab8;font-size:12px;font-weight:750; }.secondary { color:#604893;background:#f0ebff; }.settings-save { margin-top:18px; }.settings-status { min-height:16px;margin:8px 0 0;color:#667085;font-size:11px; }.setting-card .settings-status { margin:3px 0 0; }.settings-status.ok { color:#166534; }.settings-status.error { color:#b42318; }
    :host([data-theme="dark"]) .panel { color:#f5f2ff;background:#11121a;border-color:#3a3a4a;box-shadow:0 18px 50px rgba(0,0,0,.6); }:host([data-theme="dark"]) .head { background:linear-gradient(112deg,#3a215d 0%,#61399a 52%,#8659ca 100%); }:host([data-theme="dark"]) .screen,:host([data-theme="dark"]) .settings { background:#11121a; }:host([data-theme="dark"]) .nav,:host([data-theme="dark"]) .chat-form,:host([data-theme="dark"]) .category,:host([data-theme="dark"]) .notification,:host([data-theme="dark"]) .setting-card { border-color:#363646;background:#1a1b25; }:host([data-theme="dark"]) .notification:hover { border-color:#765ab8;background:#211a30; }:host([data-theme="dark"]) .nav-button { color:#a5a2b2; }:host([data-theme="dark"]) .nav-button.active { color:#b88cff; }:host([data-theme="dark"]) .nav-button.active::before { border-color:#b88cff; }:host([data-theme="dark"]) .category-header { background:#1e1f2a; }:host([data-theme="dark"]) .toggle,:host([data-theme="dark"]) .name,:host([data-theme="dark"]) .subject,:host([data-theme="dark"]) .notification-title,:host([data-theme="dark"]) .settings h3,:host([data-theme="dark"]) .setting-card h4,:host([data-theme="dark"]) label { color:#f2efff; }:host([data-theme="dark"]) .ticket,:host([data-theme="dark"]) .items,:host([data-theme="dark"]) .chat-form { border-color:#313240; }:host([data-theme="dark"]) .status,:host([data-theme="dark"]) .settings-copy,:host([data-theme="dark"]) .setting-card p,:host([data-theme="dark"]) .settings-status,:host([data-theme="dark"]) .empty,:host([data-theme="dark"]) .no-link,:host([data-theme="dark"]) .notification-message,:host([data-theme="dark"]) .notification-time { color:#aaa7b9; }:host([data-theme="dark"]) .count-pill,:host([data-theme="dark"]) .count,:host([data-theme="dark"]) .all,:host([data-theme="dark"]) .move,:host([data-theme="dark"]) .refresh { color:#d3b7ff;background:#2e2443; }:host([data-theme="dark"]) .keep-andrew,:host([data-theme="dark"]) .ask-ai,:host([data-theme="dark"]) .send,:host([data-theme="dark"]) .primary { background:#8154c3;color:#fff; }:host([data-theme="dark"]) input,:host([data-theme="dark"]) select,:host([data-theme="dark"]) .chat-input { border-color:#494857;color:#f2efff;background:#252632; }:host([data-theme="dark"]) .bubble.assistant { color:#f2efff;background:#292a36; }:host([data-theme="dark"]) .chat-context { border-color:#493262;color:#dfc8ff;background:#251b34; }:host([data-theme="dark"]) .secondary { color:#d3b7ff;background:#2e2443; }
    .notification { position:relative;border-color:#00a3c1;color:#fff;background:#00b7da; }.notification.unread { border-left-color:#ef4444;color:#fff;background:#1f2944; }.notification:hover { border-color:#fff;background:#049cbd; }.notification.unread:hover { border-color:#ef4444;background:#2b3859; }.notification-title,.notification-message,.notification-time { color:#fff; }.notification-message,.notification-time { opacity:.84; }.notification-dot { position:absolute;top:13px;right:13px;display:block;width:9px;height:9px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.2); }.notification-actions { display:flex;justify-content:flex-end;gap:7px;padding:10px 16px 0; }.notification-actions button { border:0;border-radius:8px;cursor:pointer;padding:7px 9px;color:#075d70;background:#c9f5ff;font-size:11px;font-weight:800; }.notification-actions button.active { color:#fff;background:#1f2944; }.notification-actions button:disabled { cursor:wait;opacity:.55; }:host([data-theme="dark"]) .notification.notification { border-color:#00a3c1;color:#fff;background:#00b7da; }:host([data-theme="dark"]) .notification.notification.unread { border-left-color:#ef4444;color:#fff;background:#1f2944; }:host([data-theme="dark"]) .notification.notification:hover { border-color:#fff;background:#049cbd; }:host([data-theme="dark"]) .notification.notification.unread:hover { border-color:#ef4444;background:#2b3859; }:host([data-theme="dark"]) .notification.notification .notification-title,:host([data-theme="dark"]) .notification.notification .notification-message,:host([data-theme="dark"]) .notification.notification .notification-time { color:#fff; }:host([data-theme="dark"]) .chat-history-title,:host([data-theme="dark"]) .chat-history-item { color:#f2efff; }:host([data-theme="dark"]) .chat-history-copy,:host([data-theme="dark"]) .chat-history-item span { color:#aaa7b9; }:host([data-theme="dark"]) .chat-history-item { border-color:#363646;background:#1a1b25; }:host([data-theme="dark"]) .chat-history-item:hover { border-color:#765ab8;background:#211a30; }:host([data-theme="dark"]) .chat-history-trace { border-color:#363646;color:#cdbfff;background:#211a30; }:host([data-theme="dark"]) .chat-history-ticket { color:#cdbfff; }:host([data-theme="dark"]) .chat-history-item .chat-history-auto { color:#9fe3f2;background:#12262c; }:host([data-theme="dark"]) .chat-history-item .chat-history-auto.running { color:#ffd98a;background:#33290f; }:host([data-theme="dark"]) .chat-history-item .chat-history-auto.failed,:host([data-theme="dark"]) .chat-history-item .chat-history-auto.uncertain { color:#ffb4b4;background:#3a1717; }:host([data-theme="dark"]) .chat-history-trace.ticket { border-color:#1f4a55;color:#9fe3f2;background:#12262c; }:host([data-theme="dark"]) .chat-history-trace.ticket:hover { border-color:#2f7d8f;background:#173540; }:host([data-theme="dark"]) .chat-history-trace:hover { border-color:#765ab8;background:#2b2240; }
  `;
  const panel = document.createElement("section");
  panel.className = "panel";
  const launcher = document.createElement("button");
  launcher.className = "widget-launcher";
  launcher.type = "button";
  launcher.title = "Open TS Management";
  launcher.setAttribute("aria-label", "Open TS Management");
  const launcherLogo = document.createElement("img");
  launcherLogo.src = chrome.runtime.getURL("icons/bigmouse2-rounded-128.png");
  launcherLogo.alt = "";
  const launcherDot = document.createElement("span");
  launcherDot.className = "online-dot";
  launcher.append(launcherLogo, launcherDot);
  const header = document.createElement("header");
  const screen = document.createElement("main");
  const navigation = document.createElement("nav");
  navigation.className = "nav";
  panel.append(header, screen, navigation);
  const closeChatMenuOnOutsidePointer = (event) => {
    if (!host.isConnected) { document.removeEventListener("pointerdown", closeChatMenuOnOutsidePointer, true); return; }
    const menu = shadow.querySelector(".chat-overflow-menu");
    const more = shadow.querySelector(".chat-more");
    if (!menu || menu.hidden) return;
    const path = event.composedPath();
    if (!path.includes(menu) && !path.includes(more)) menu.hidden = true;
  };
  document.addEventListener("pointerdown", closeChatMenuOnOutsidePointer, true);
  const notificationStyle = document.createElement("style");
  notificationStyle.textContent = `
    /* Notification palette: slate neutrals plus one subdued teal accent. */
    .notification { border-color:#dbe2ea;color:#1f2937;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,.04); }
    .notification:hover { border-color:#94a3b8;background:#fff; }.notification.unread { border-left:3px solid #0f766e;padding-left:9px;color:#1f2937;background:#f8fafc; }.notification.unread:hover { border-color:#0f766e;background:#f1f5f9; }
    .notification-title { overflow:visible;color:#172033;white-space:normal;text-overflow:clip;font-size:13px;font-weight:800;line-height:1.35; }.notification-message { display:block;overflow:visible;margin-top:6px;color:#475569;-webkit-line-clamp:unset;font-size:11px;line-height:1.5; }.notification-time { color:#64748b;font-size:10px; }.notification-dot { background:#0f766e;box-shadow:0 0 0 3px rgba(15,118,110,.13); }
    .notification-tab.active { border-bottom-color:#0f766e;color:#0f766e;background:transparent; }.scan-schedule-tags { display:flex;flex-wrap:wrap;gap:7px;padding:10px 16px 0; }.scan-schedule-tag { border:1px solid #cbd5e1;border-radius:999px;padding:5px 8px;color:#475569;background:#f8fafc;font-size:10px;font-weight:800;line-height:1.25; }.scan-schedule-tag.active { border-color:#99d6cc;color:#0f5f59;background:#f0fdfa; }
    .notification-link-button { width:100%;border:0;cursor:pointer;padding:0;color:inherit;background:transparent;text-align:left;font:inherit; }.notification-link-button:focus-visible { outline:3px solid rgba(15,118,110,.3);outline-offset:3px; }
    .sla-skill-card { overflow:hidden;border-left:3px solid #0f766e;padding:0;background:#fff; }.sla-skill-card.unread { border-left:3px solid #0f766e;padding-left:0;background:#fff; }.sla-skill-trigger { display:block;width:100%;border:0;cursor:pointer;padding:14px 14px 12px;color:inherit;background:transparent;text-align:left;font:inherit; }.sla-skill-trigger:hover { background:#f8fafc; }.sla-skill-heading { display:flex;align-items:flex-start;gap:10px; }.sla-skill-icon { display:grid;width:28px;height:28px;flex:0 0 28px;place-items:center;border-radius:8px;color:#0f5f59;background:#e6f5f1;font-size:9px;font-weight:900;letter-spacing:.06em; }.sla-skill-title-wrap { min-width:0;flex:1; }.sla-skill-title { color:#172033;font-size:14px;font-weight:800;line-height:1.35; }.sla-skill-source { display:block;margin-top:3px;color:#64748b;font-size:10px;font-weight:650;line-height:1.4; }.sla-skill-summary { margin:11px 0 0;color:#334155;font-size:12px;line-height:1.55; }.sla-skill-footer { display:flex;align-items:center;justify-content:space-between;gap:9px;margin-top:11px;color:#64748b;font-size:10px; }.sla-skill-expand { color:#0f766e;font-weight:800; }.sla-skill-detail { display:grid;gap:10px;margin:0;border-top:1px solid #e2e8f0;padding:12px 14px 14px;color:#334155;background:#fcfdfd; }.sla-skill-rules { display:grid;gap:9px; }.sla-skill-rule { display:grid;grid-template-columns:24px minmax(0,1fr);gap:9px;border:1px solid #e2e8f0;border-radius:9px;padding:10px;background:#fff; }.sla-skill-rule-number { display:grid;width:24px;height:24px;place-items:center;border-radius:50%;color:#0f5f59;background:#e6f5f1;font-size:11px;font-weight:900; }.sla-skill-rule-title { color:#1e293b;font-size:11px;font-weight:800;line-height:1.45; }.sla-skill-rule-copy { margin:4px 0 0;color:#475569;font-size:11px;line-height:1.5; }.sla-skill-evidence { margin-top:8px;border-left:2px solid #94a3b8;border-radius:0 6px 6px 0;padding:7px 8px;color:#475569;background:#f1f5f9;font-size:10px;font-style:italic;line-height:1.5; }.sla-skill-evidence strong { color:#334155;font-style:normal; }.sla-skill-empty { margin:0;color:#64748b;font-size:11px;line-height:1.5; }
    .sla-skill-card,.sla-skill-card.unread { padding:0;background:#fff; }
    /* Keep the former hover surface permanently; the SLA card has no hover-state change. */
    .sla-skill-card,.sla-skill-card.unread,.sla-skill-card:hover { border-color:#0f766e;background:#f8fafc; }.sla-skill-trigger { background:#f8fafc; }
    :host([data-theme="dark"]) .notification { border-color:#3b4654;color:#e5e7eb;background:#1b222c;box-shadow:none; }:host([data-theme="dark"]) .notification:hover,:host([data-theme="dark"]) .notification.unread,:host([data-theme="dark"]) .notification.unread:hover { border-color:#2a9d8f;background:#202a35; }:host([data-theme="dark"]) .notification-title,:host([data-theme="dark"]) .sla-skill-title { color:#f1f5f9; }:host([data-theme="dark"]) .notification-message,:host([data-theme="dark"]) .sla-skill-summary,:host([data-theme="dark"]) .sla-skill-rule-copy { color:#cbd5e1; }:host([data-theme="dark"]) .notification-time,:host([data-theme="dark"]) .sla-skill-source,:host([data-theme="dark"]) .sla-skill-footer { color:#94a3b8; }:host([data-theme="dark"]) .sla-skill-card,:host([data-theme="dark"]) .sla-skill-card.unread { border-color:#2a9d8f;background:#1b222c; }:host([data-theme="dark"]) .sla-skill-trigger:hover { background:#202a35; }:host([data-theme="dark"]) .sla-skill-icon,:host([data-theme="dark"]) .sla-skill-rule-number { color:#99e0d6;background:#153d3a; }:host([data-theme="dark"]) .sla-skill-detail { border-color:#3b4654;color:#cbd5e1;background:#182029; }:host([data-theme="dark"]) .sla-skill-rule { border-color:#3b4654;background:#202a35; }:host([data-theme="dark"]) .sla-skill-rule-title { color:#f1f5f9; }:host([data-theme="dark"]) .sla-skill-evidence { border-color:#64748b;color:#cbd5e1;background:#273341; }:host([data-theme="dark"]) .sla-skill-evidence strong { color:#e2e8f0; }:host([data-theme="dark"]) .scan-schedule-tag { border-color:#475569;color:#cbd5e1;background:#202a35; }:host([data-theme="dark"]) .scan-schedule-tag.active { border-color:#2a9d8f;color:#b7f1e8;background:#153d3a; }
    :host([data-theme="dark"]) .sla-skill-card,:host([data-theme="dark"]) .sla-skill-card.unread { background:#1b222c; }
    :host([data-theme="dark"]) .sla-skill-card,:host([data-theme="dark"]) .sla-skill-card.unread,:host([data-theme="dark"]) .sla-skill-card:hover { border-color:#2a9d8f;background:#202a35; }:host([data-theme="dark"]) .sla-skill-trigger { background:#202a35; }
    .chat-tabs { display:flex;border-bottom:1px solid #e7e5eb;background:#fff; }.chat-tab { flex:1;border:0;border-bottom:2px solid transparent;cursor:pointer;padding:12px 6px 10px;color:#8991a0;background:transparent;font-size:11px;font-weight:800; }.chat-tab.active { border-bottom-color:#765ab8;color:#fff;background:#765ab8; }.follow-dev-panel { display:grid;gap:9px;padding:13px;color:#344054;font-size:11px;line-height:1.4; }.follow-dev-panel h3 { margin:0;color:#2e2a38;font-size:14px; }.follow-dev-controls { display:flex;gap:7px; }.follow-dev-controls button { border:0;border-radius:7px;cursor:pointer;padding:7px 9px;color:#fff;background:#765ab8;font-size:11px;font-weight:800; }.follow-dev-controls button:disabled { cursor:wait;opacity:.55; }.follow-dev-row { display:grid;grid-template-columns:108px minmax(0,1fr);gap:7px;border-bottom:1px solid #edf0f5;padding-bottom:7px; }.follow-dev-row strong { color:#475467; }.follow-dev-row span { min-width:0;white-space:pre-wrap; }.follow-dev-row a { color:#765ab8;font-weight:800;text-decoration:none; }.follow-dev-description { display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:3; }.follow-dev-mail { margin:2px 0 0;white-space:pre-wrap;border:1px solid #ded6ed;border-radius:8px;padding:9px;color:#344054;background:#faf8ff;font:11px/1.45 Inter,ui-sans-serif,system-ui,sans-serif; }
  `;
  shadow.append(style, notificationStyle, launcher, panel);
  const darkFollowStyle = document.createElement("style");
  darkFollowStyle.textContent = `
    .chat-header-actions { position:relative; }.chat-more { width:30px;padding:2px 0;font-size:20px;line-height:1; }.chat-overflow-menu { position:absolute;z-index:2;top:36px;right:34px;display:grid;min-width:145px;overflow:hidden;border:1px solid #ded6ed;border-radius:9px;background:#fff;box-shadow:0 10px 24px rgba(15,23,42,.22); }.chat-overflow-menu button { border:0;cursor:pointer;padding:9px 11px;color:#4a4454;background:transparent;text-align:left;font-size:11px;font-weight:750; }.chat-overflow-menu button:hover { background:#f3effb; }
    :host([data-theme="dark"]) .chat-tabs { border-color:#292a37;background:#11111a; }.chat-tab { color:#8f91a5;background:#11111a; }.chat-tab.active { border-color:#7c5cff;color:#fff;background:#7c5cff; }.chat-overflow-menu { border-color:#343545;background:#1a1a24;box-shadow:0 12px 26px rgba(0,0,0,.48); }.chat-overflow-menu button { color:#d8d9e5;background:#1a1a24; }.chat-overflow-menu button:hover { background:#272536; }
    :host([data-theme="dark"]) .follow-dev-panel { gap:12px;padding:14px;background:#0f0f16;color:#d8d9e5; }.follow-dev-controls { gap:8px; }.follow-dev-controls button { border:1px solid #7c5cff;border-radius:999px;padding:7px 12px;color:#cfc7ff;background:transparent;font-size:11px; }.follow-dev-controls button.active { color:#fff;background:#7c5cff; }.follow-dev-controls button:disabled { border-color:#4b4b59;color:#77798a;background:transparent; }.follow-dev-card { display:grid;gap:10px;border:1px solid #262735;border-radius:10px;padding:12px;background:#1a1a24; }.follow-dev-card h3 { margin:0;color:#fff;font-size:12px;font-weight:800; }.follow-dev-row { grid-template-columns:105px minmax(0,1fr);gap:10px;border:0;padding:0; }.follow-dev-row strong { color:#9b9daf;font-size:10px;font-weight:700; }.follow-dev-row span { color:#f0f0f5;font-size:11px;font-weight:650;line-height:1.45; }.follow-dev-row a { color:#a997ff; }.follow-dev-description { color:#dcdee8!important;font-weight:500!important; }.status-done,.status-pending { width:max-content;border-radius:999px;padding:2px 8px!important;font-size:10px!important;font-weight:800!important; }.status-done { color:#86efac!important;background:#14532d; }.status-pending { color:#fdba74!important;background:#7c2d12; }.follow-dev-mail { border-color:#343545;color:#eff0f6;background:#15151e; }
    :host([data-theme="dark"]) .nav { border-color:#292a37;background:#11111a; }.nav-button { color:#8f91a5;font-size:10px; }.nav-icon { width:20px;height:20px;font-size:18px;line-height:20px; }.nav-button.active { color:#a997ff; }.nav-button.active::before { border-color:#7c5cff; }
  `;
  shadow.append(darkFollowStyle);
  const darkStatusStyle = document.createElement("style");
  darkStatusStyle.textContent = ':host([data-theme="dark"]) .status-blocked { width:max-content;border-radius:999px;padding:2px 8px!important;color:#fca5a5!important;background:#7f1d1d;font-size:10px!important;font-weight:800!important; } .chat-overflow-menu[hidden] { display:none!important; } .follow-dev-screen { overflow:hidden; } .follow-dev-screen .follow-dev-panel { min-height:0;flex:1;overflow-y:auto;scrollbar-width:thin; }';
  shadow.append(darkStatusStyle);
  // Keep chat tokens in the shadow root so the host page cannot change them.
  const chatDesignStyle = document.createElement("style");
  chatDesignStyle.textContent = `
    :host { --chat-accent:#7c3aed;--chat-accent-text:#6d28d9;--chat-text:#282335;--chat-muted:#746b85;--chat-surface:#f1edf8;--chat-line:rgba(124,58,237,.16);--chat-soft:rgba(124,58,237,.09); }
    :host([data-theme="dark"]) { --chat-accent-text:#c4a6ff;--chat-text:#f1edf9;--chat-muted:#a29ab5;--chat-surface:#1e1e2a;--chat-line:rgba(167,139,250,.16);--chat-soft:rgba(124,58,237,.17); }
    :host([data-theme="dark"]) .panel { background:radial-gradient(ellipse at 90% 0%,#21152f 0%,transparent 60%),linear-gradient(155deg,#14131e,#0a0a0f);border-color:var(--chat-line); }
    .head,:host([data-theme="dark"]) .head { position:relative;z-index:2;flex-shrink:0;background:linear-gradient(115deg,rgba(76,29,149,.96),rgba(124,58,237,.88),rgba(139,92,246,.84));box-shadow:0 8px 28px rgba(76,29,149,.2),inset 0 -1px rgba(255,255,255,.12);backdrop-filter:blur(16px); }
    .screen.chat-screen,:host([data-theme="dark"]) .screen.chat-screen { background:radial-gradient(ellipse at 100% 0%,var(--chat-soft),transparent 65%); }
    .chat-tabs,:host([data-theme="dark"]) .chat-tabs { position:relative;display:flex;flex-shrink:0;gap:4px;margin:14px 16px 4px;padding:4px;border:1px solid var(--chat-line);border-radius:14px;background:var(--chat-soft); }
    .chat-tabs::after { position:absolute;bottom:3px;left:4px;width:calc((100% - 12px)/2);height:2px;border-radius:999px;background:var(--chat-accent);content:"";transform:translateX(0);transition:transform .25s ease; }
    .chat-tabs[data-active="follow"]::after { transform:translateX(calc(100% + 4px)); }
    .chat-tab { position:relative;border:0;border-radius:10px;padding:10px 6px;color:var(--chat-muted);background:transparent;transition:color .2s,background .2s; }
    .chat-tab:hover { color:var(--chat-accent-text);background:var(--chat-soft); }
    .chat-tab.active { color:var(--chat-accent-text);background:var(--chat-soft); }
    .chat-messages { gap:20px;padding:20px 16px;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--chat-line) transparent; }
    .chat-messages::-webkit-scrollbar { display:block;width:4px; }.chat-messages::-webkit-scrollbar-thumb { border-radius:4px;background:var(--chat-line); }
    .chat-message { display:flex;align-items:flex-start;gap:8px;max-width:94%;flex-shrink:0;align-self:flex-start; }
    .chat-message.is-new { animation:chat-arrive .24s ease-out both; }
    .chat-message.user { align-self:flex-end;flex-direction:row-reverse; }
    .message-avatar { display:grid;width:28px;height:28px;flex:0 0 28px;place-items:center;margin-top:3px;border:1px solid var(--chat-line);border-radius:10px;color:var(--chat-accent-text);background:var(--chat-soft); }
    .chat-message.user .message-avatar { color:#e9ddff;background:linear-gradient(135deg,#7c3aed,#5b21b6); }
    .message-body { min-width:0;display:flex;flex-direction:column;gap:6px; }
    .chat-message .bubble,.chat-message .bubble.assistant.ai-response,:host([data-theme="dark"]) .chat-message .bubble.assistant { width:auto;max-width:100%;border:1px solid var(--chat-line);border-radius:16px;padding:12px 14px;color:var(--chat-text);background:var(--chat-surface);font-size:12px;line-height:1.65;overflow-wrap:anywhere;box-shadow:0 4px 14px rgba(0,0,0,.05); }
    .chat-message .bubble.user { color:#fff;border-color:rgba(255,255,255,.1);background:linear-gradient(135deg,#7c3aed,#6530bd); }
    .chat-message .ai-response-copy,.chat-message .ai-response-list,.chat-message .ai-response-section,.chat-message .ai-response strong { color:inherit; }
    .chat-message .ai-response code { color:var(--chat-accent-text);background:var(--chat-soft);box-decoration-break:clone; }
    .message-time { padding:0 3px;color:var(--chat-muted);font-size:9px;line-height:1.4; }.chat-message.user .message-time { align-self:flex-end; }
    .typing-dots { display:flex;align-items:center;gap:5px;min-height:20px;padding:0 3px; }.typing-dots i { width:5px;height:5px;border-radius:50%;background:var(--chat-accent-text);animation:chat-dot 1.2s ease-in-out infinite; }.typing-dots i:nth-child(2) { animation-delay:.15s; }.typing-dots i:nth-child(3) { animation-delay:.3s; }
    .chat-empty { display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;padding:18px 4px;text-align:center;color:var(--chat-text); }
    .chat-empty-art { position:relative;display:grid;width:76px;height:76px;flex-shrink:0;place-items:center;margin:0 0 20px;border:1px solid rgba(167,139,250,.3);border-radius:25px;color:#e9ddff;background:linear-gradient(145deg,#7c3aed,#432177);box-shadow:0 0 55px rgba(124,58,237,.2),inset 0 1px rgba(255,255,255,.2);transform:rotate(-6deg); }
    .chat-empty-art svg { width:34px;height:34px;transform:rotate(6deg); }
    .chat-empty h3 { margin:0 0 8px;font-size:21px;font-weight:750;letter-spacing:-.5px; }
    .chat-empty p { max-width:260px;margin:0;color:var(--chat-muted);font-size:12px;line-height:1.7; }
    .chat-suggestions { display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:24px; }
    .chat-suggestion { display:flex;align-items:center;gap:7px;border:1px solid var(--chat-line);border-radius:999px;padding:9px 12px;color:var(--chat-accent-text);background:var(--chat-soft);cursor:pointer;font-size:11px;transition:background .2s,transform .2s,border-color .2s; }
    .chat-suggestion:hover { border-color:var(--chat-accent);background:var(--chat-line);transform:translateY(-2px); }
    .chat-form,:host([data-theme="dark"]) .chat-form { flex-shrink:0;gap:0;margin:0 14px 14px;padding:5px;border:1px solid var(--chat-line);border-radius:24px;background:var(--chat-surface);box-shadow:0 4px 20px rgba(0,0,0,.08);transition:border-color .2s,box-shadow .2s; }
    .chat-form:focus-within,:host([data-theme="dark"]) .chat-form:focus-within { border-color:rgba(124,58,237,.65);box-shadow:0 0 0 3px var(--chat-soft),0 4px 20px rgba(0,0,0,.08); }
    .chat-form .chat-input,:host([data-theme="dark"]) .chat-form .chat-input { min-width:0;min-height:38px;max-height:112px;border:0;border-radius:20px;padding:9px 12px;color:var(--chat-text);background:transparent;line-height:20px;box-shadow:none; }
    .chat-input::placeholder { color:var(--chat-muted); }
    .chat-form .send,:host([data-theme="dark"]) .chat-form .send { width:38px;height:38px;flex:0 0 38px;border-radius:50%;color:#fff;background:var(--chat-accent);box-shadow:0 3px 10px rgba(124,58,237,.22);transition:transform .18s,background .18s,box-shadow .18s; }
    .send:hover:not(:disabled) { transform:scale(1.06);box-shadow:0 4px 16px rgba(124,58,237,.4); }.send:active:not(:disabled) { transform:scale(.94); }
    .nav,:host([data-theme="dark"]) .nav { min-height:70px;flex-basis:70px;border-color:var(--chat-line);background:var(--chat-surface); }
    .nav-button,:host([data-theme="dark"]) .nav-button { min-width:0;gap:4px;color:var(--chat-muted);transition:color .2s,background .2s; }
    .nav-icon { display:grid;width:48px;height:28px;place-items:center;border-radius:999px;transition:background .2s,transform .2s; }
    .nav-button.active,:host([data-theme="dark"]) .nav-button.active { color:var(--chat-accent-text); }.nav-button.active .nav-icon { background:var(--chat-soft); }.nav-button:hover .nav-icon { background:var(--chat-soft);transform:translateY(-1px); }.nav-button.active::before { display:none; }
    .chat-icon { width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round; }
    .chat-context { flex-shrink:0;margin-top:8px; }
    
/* Checking segmented tabs: keep these rules identical in web and shadow-root widget. */
.han-checking-tabs { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:0; flex-shrink:0; width:100%; min-width:0; margin:12px 0; padding:5px 5px 0; border:1px solid #533474; border-radius:20px; background:#2e1c49; box-sizing:border-box; }
.han-checking-tabs button { position:relative; min-width:0; min-height:48px; margin:0; padding:10px 8px 13px; border:0; border-radius:14px 14px 0 0; background:transparent; color:#d8c9ef; font:inherit; font-size:14px; font-weight:700; line-height:1.4; text-align:center; cursor:pointer; box-shadow:none; }
.han-checking-tabs button:hover { background:#392253; }
.han-checking-tabs button[aria-selected="true"] { background:#432565; color:#f0e5ff; }
.han-checking-tabs button[aria-selected="true"]::after { content:""; position:absolute; left:0; right:0; bottom:0; height:3px; border-radius:3px; background:#b46cff; }
.han-checking-tabs button:focus-visible { outline:2px solid #ead4ff; outline-offset:-5px; }
.han-auto-panel { flex:1; min-height:0; overflow:auto; color:var(--chat-text); padding:4px 2px 20px; }
.han-auto-list { display:grid; gap:10px; }
.han-auto-ticket { display:grid; gap:8px; width:100%; text-align:left; padding:14px; border:1px solid var(--chat-line); border-radius:12px; background:var(--chat-surface); color:var(--chat-text); cursor:pointer; overflow-wrap:anywhere; }
.han-auto-ticket span { font-size:12px; color:var(--chat-muted); }
.han-auto-bar { display:flex; gap:10px; margin-bottom:14px; }
.han-auto-report { max-width:900px; margin:auto; font-size:14px; line-height:1.65; overflow-wrap:anywhere; }
.han-auto-report h2 { font-size:17px; } .han-auto-report h3 { font-size:15px; margin:24px 0 8px; }
.han-auto-report p { margin:8px 0; } .han-auto-report pre { overflow:auto; white-space:pre; padding:12px; border:1px solid var(--chat-line); border-radius:8px; background:var(--chat-soft); }
.han-auto-report code { font-family:monospace; } .han-auto-report ol, .han-auto-report ul { padding-left:24px; }

.checking-list { min-height:0;flex:1;grid-auto-rows:max-content;align-content:start;padding-top:14px; }
    .checking-item .checking-meta { display:flex;align-items:center;gap:8px;margin-top:7px;font-size:10px; }
    .chat-history-item .checking-pill,.checking-pill { display:inline-block;flex:0 0 auto;margin:0;border-radius:9px;padding:2px 8px;color:#15803d;background:rgba(34,197,94,.16);font-size:10px;font-weight:800;white-space:nowrap; }
    .chat-history-item .checking-pill.running,.checking-pill.running { color:#b45309;background:rgba(245,158,11,.18); }
    .chat-history-item .checking-pill.failed,.chat-history-item .checking-pill.uncertain,.chat-history-item .checking-pill.cancelled,.checking-pill.failed,.checking-pill.uncertain,.checking-pill.cancelled { color:#dc2626;background:rgba(239,68,68,.14); }
    :host([data-theme="dark"]) .checking-pill { color:#86efac; }:host([data-theme="dark"]) .checking-pill.running { color:#ffd98a; }
    :host([data-theme="dark"]) .checking-pill.failed,:host([data-theme="dark"]) .checking-pill.uncertain,:host([data-theme="dark"]) .checking-pill.cancelled { color:#ffb4b4; }
    .chat-context.checking-bar,:host([data-theme="dark"]) .chat-context.checking-bar { flex-wrap:wrap;justify-content:flex-start;gap:6px;border-color:var(--chat-line);color:var(--chat-accent-text);background:var(--chat-soft); }
    .checking-bar .checking-title { order:2;min-width:0;flex:1 1 100%;font-weight:700; }.checking-bar .checking-pill-slot { display:flex;flex:0 0 auto;margin-right:auto;overflow:visible; }
    .checking-back,.checking-link { flex:0 0 auto;border:1px solid var(--chat-line);border-radius:999px;cursor:pointer;padding:4px 9px;color:var(--chat-accent-text);background:transparent;font-size:11px;font-weight:800; }.checking-link:disabled { cursor:default;opacity:.5; }
    .checking-steps { display:grid;flex-shrink:0;gap:10px;border:1px solid var(--chat-line);border-radius:14px;padding:12px;background:var(--chat-surface); }
    .checking-steps h4 { margin:0;color:var(--chat-text);font-size:12px; }.checking-steps-status { margin:0;color:var(--chat-muted);font-size:11px; }.checking-steps-status.error { color:#dc2626; }
    .checking-step { display:grid;grid-template-columns:10px minmax(0,1fr);gap:9px; }.checking-step-dot { width:8px;height:8px;margin-top:5px;border-radius:50%;background:var(--chat-muted); }
    .checking-step.kind-start .checking-step-dot,.checking-step.kind-phase .checking-step-dot,.checking-step.kind-tool .checking-step-dot { background:var(--chat-accent); }
    .checking-step.kind-result .checking-step-dot,.checking-step.kind-done .checking-step-dot { background:#22c55e; }
    .checking-step.kind-warning .checking-step-dot,.checking-step.kind-waiting .checking-step-dot { background:#f59e0b; }
    .checking-step.kind-error .checking-step-dot,.checking-step.kind-cancelled .checking-step-dot { background:#ef4444; }
    .checking-step-head { display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;color:var(--chat-text);font-size:11px; }.checking-step-phase { border-radius:6px;padding:0 6px;color:var(--chat-accent-text);background:var(--chat-soft);font-size:10px; }.checking-step-head time { margin-left:auto;color:var(--chat-muted);font-size:10px; }
    .checking-step-text { margin:3px 0 0;color:var(--chat-text);font-size:12px;line-height:1.55;overflow-wrap:anywhere;white-space:pre-wrap; }.checking-step-text.clamped { max-height:7.75em;overflow:hidden; }
    .checking-step-more { margin-top:2px;border:0;cursor:pointer;padding:0;color:var(--chat-accent-text);background:transparent;font-size:11px;font-weight:800; }
    .checking-report,.checking-report.ai-response { margin-top:5px;border:1px solid var(--chat-line);border-radius:12px;padding:10px 12px;color:var(--chat-text);background:var(--chat-soft);font-size:12px;line-height:1.6;overflow-wrap:anywhere; }
    .checking-report .ai-response-copy,.checking-report .ai-response-list,.checking-report .ai-response-section,.checking-report strong { color:inherit; }
    .checking-chat-hint { flex-shrink:0;margin:0;color:var(--chat-muted);font-size:11px;text-align:center; }
    .chat-tab:focus-visible,.nav-button:focus-visible,.chat-suggestion:focus-visible,.send:focus-visible { outline:2px solid var(--chat-accent-text);outline-offset:2px; }
    @keyframes chat-arrive { from { opacity:0;transform:translateY(8px); } to { opacity:1;transform:translateY(0); } }
    @keyframes chat-dot { 0%,60%,100% { transform:translateY(0);opacity:.45; } 30% { transform:translateY(-4px);opacity:1; } }
    @media (prefers-reduced-motion:reduce) { .chat-message.is-new,.typing-dots i { animation:none; }.chat-tabs::after,.chat-tab,.nav-button,.nav-icon,.chat-suggestion,.send,.chat-form { transition:none; } }
    @media (max-height:600px) { .chat-empty { padding:4px; }.chat-empty-art { width:48px;height:48px;margin-bottom:12px;border-radius:16px; }.chat-suggestions { margin-top:12px; } }
  `;
  shadow.append(chatDesignStyle);
  const ticketManagementStyle = document.createElement("style");
  ticketManagementStyle.textContent = `
    .ticket-management { display:grid;gap:12px;padding:12px;overflow-y:auto; }
    .management-toolbar { display:flex;align-items:center;justify-content:space-between;gap:8px; }
    .management-toolbar label { margin:0;color:#4a4454;font-size:11px;font-weight:800; }
    .management-toolbar select { width:108px;padding:7px; }
    .management-summary { margin:0;color:#667085;font-size:11px; }
    .management-card { border:1px solid #e7e5eb;border-radius:12px;padding:11px;background:#fff; }
    .management-card h3 { margin:0 0 8px;color:#2e2a38;font-size:13px; }
    .management-member { display:flex;align-items:center;gap:7px;padding:3px 0;color:#344054;font-size:11px; }
    .management-dot { width:8px;height:8px;flex:0 0 8px;border-radius:50%;background:#765ab8; }
    .management-member-count { margin-left:auto;color:#667085; }
    .management-ticket { display:block;border:1px solid #e7e5eb;border-radius:10px;padding:9px;color:#2e2a38;background:#fff;text-decoration:none; }
    .management-ticket + .management-ticket { margin-top:8px; }
    .management-ticket:hover { border-color:#bfa9e8;background:#faf8ff; }
    .management-ticket-title { display:block;color:#2e2a38;font-size:12px;font-weight:800;line-height:1.35; }
    .management-ticket-meta { display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;color:#667085;font-size:10px;line-height:1.35; }
    .management-ticket-member { color:#fff; }
    .management-badge { border-radius:999px;padding:2px 6px;color:#604893;background:#eee7ff;font-size:9px;font-weight:800; }
    :host([data-theme="dark"]) .management-card,:host([data-theme="dark"]) .management-ticket { border-color:#363646;background:#1a1b25; }
    :host([data-theme="dark"]) .management-card h3,:host([data-theme="dark"]) .management-ticket-title { color:#f2efff; }
    :host([data-theme="dark"]) .management-summary,:host([data-theme="dark"]) .management-member,:host([data-theme="dark"]) .management-member-count { color:#aaa7b9; }
    :host([data-theme="dark"]) .management-ticket:hover { border-color:#765ab8;background:#211a30; }
    :host([data-theme="dark"]) .management-toolbar label { color:#f2efff; }
  `;
  shadow.append(ticketManagementStyle);
  // Analytics section (chrome-extension/analytics-view.js): styles travel with the shared view.
  const analyticsStyle = document.createElement("style");
  analyticsStyle.textContent = `${globalThis.AnalyticsView?.css || ""}${globalThis.SpeechPlayer?.css || ""}${globalThis.NewsView?.css || ""}`;
  shadow.append(analyticsStyle);
  const bulkActionStyle = document.createElement("style");
  bulkActionStyle.textContent = `
    .refresh.web-link { color:#fff;background:#765ab8; } :host([data-theme="dark"]) .refresh.web-link { color:#fff;background:#8154c3; }
    .all,.keep-andrew { transition:transform .15s ease,background .15s ease,box-shadow .15s ease; }
    .doing-selection,.waiting-selection { display:flex;align-items:center;gap:4px;color:#604893;font-size:10px;font-weight:800;white-space:nowrap; }
    .doing-selection input,.waiting-selection input,.doing-ticket-select,.waiting-ticket-select { width:15px;height:15px;margin:0;padding:0;border:0;background:transparent;accent-color:#765ab8;cursor:pointer; }
    .doing-selection-count,.waiting-selection-count { color:#604893; }
    .ticket.doing-ticket,.ticket.waiting-ticket { display:grid;grid-template-columns:18px minmax(0,1fr); }
    .doing-ticket .doing-ticket-select,.waiting-ticket .waiting-ticket-select { grid-column:1;grid-row:1 / span 2;align-self:center;margin:0; }
    .doing-ticket .link,.waiting-ticket .link { grid-column:2;grid-row:1; }
    .doing-ticket .ticket-actions,.waiting-ticket .ticket-actions { grid-column:2;grid-row:2; }
    :host([data-theme="dark"]) .doing-selection,:host([data-theme="dark"]) .doing-selection-count,:host([data-theme="dark"]) .waiting-selection,:host([data-theme="dark"]) .waiting-selection-count { color:#d3b7ff; }
    .all:hover:not(:disabled) { transform:translateY(-1px);color:#4c347d;background:#ddd0ff;box-shadow:0 4px 10px rgba(96,72,147,.22); }
    .keep-andrew:hover:not(:disabled) { transform:translateY(-1px);background:#604893;box-shadow:0 4px 10px rgba(96,72,147,.34); }
    .all:active:not(:disabled),.keep-andrew:active:not(:disabled) { transform:translateY(0);box-shadow:none; }
    .all:focus-visible,.keep-andrew:focus-visible { outline:3px solid #bfa9e8;outline-offset:2px; }
    .all:disabled,.keep-andrew:disabled { cursor:wait;opacity:.6; }
  `;
  shadow.append(bulkActionStyle);
  const ticketTooltip = document.createElement("div");
  ticketTooltip.className = "ticket-tooltip";
  ticketTooltip.hidden = true;
  shadow.append(ticketTooltip);

  function request(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!response?.ok) reject(Object.assign(new Error(response?.error || "Extension request failed."), { status: response?.status }));
        else resolve(response);
      });
    });
  }
  function ticketUrl(ticket) { return `${HELP_DESK_URL}/t/${encodeURIComponent(ticket.ticketId || ticket.id)}`; }
  function ticketMemberSummary(ticket) {
    const members = Array.isArray(ticket.members) ? ticket.members : [];
    const memberIds = Array.isArray(ticket.memberIds) ? ticket.memberIds : [];
    const count = members.length || memberIds.length;
    const names = members.map((member) => member?.displayName || member?.name || member?.email || member?.memberId || member?.id).filter(Boolean);
    const label = `${count} member${count === 1 ? "" : "s"}`;
    return names.length ? `${label}: ${names.join(", ")}` : label;
  }
  function applyPosition(position) {
    host.style.top = ""; host.style.right = ""; host.style.bottom = "16px"; host.style.left = position === "bottom-left" ? "16px" : "";
    if (position !== "bottom-left") host.style.right = "16px";
  }
  function setWidgetOpen(isOpen) {
    state.widgetOpen = Boolean(isOpen);
    host.dataset.open = state.widgetOpen ? "true" : "false";
    const showPanel = state.widgetDisplay !== "bubble" || state.widgetOpen;
    host.style.width = showPanel ? "420px" : "64px";
    host.style.maxWidth = showPanel ? "calc(100vw - 32px)" : "64px";
  }
  function applyWidgetDisplay(display, keepOpen = false) {
    state.widgetDisplay = display === "bubble" ? "bubble" : "panel";
    host.dataset.display = state.widgetDisplay;
    setWidgetOpen(state.widgetDisplay !== "bubble" || (keepOpen && state.widgetOpen));
  }
  function closeWidget() {
    if (state.widgetDisplay === "bubble") setWidgetOpen(false);
    else host.remove();
  }
  function applyTheme(theme) { host.dataset.theme = theme === "dark" ? "dark" : "light"; }
  launcher.addEventListener("click", () => setWidgetOpen(true));
  host.addEventListener("andrew-toggle-widget", () => {
    if (state.widgetDisplay === "bubble") setWidgetOpen(!state.widgetOpen);
    else host.remove();
  });
  function renderHeader() {
    header.replaceChildren();
    if (state.screen === "chat") {
      header.className = "head chat-head";
      const back = document.createElement("button");
      back.className = "back"; back.type = "button"; back.innerHTML = `<span>‹</span> ${state.chatHistoryOpen ? "Back to chat" : "Back to tickets"}`;
      back.addEventListener("click", () => state.chatHistoryOpen ? closeChatHistory() : showScreen("home"));
      const actions = document.createElement("div"); actions.className = "chat-header-actions";
      const more = document.createElement("button"); more.className = "chat-header-button chat-more"; more.type = "button"; more.textContent = "⋯"; more.setAttribute("aria-label", "More chat actions");
      const menu = document.createElement("div"); menu.className = "chat-overflow-menu"; menu.hidden = true;
      const clear = document.createElement("button"); clear.type = "button"; clear.textContent = "Clear conversations";
      clear.addEventListener("click", () => { menu.hidden = true; state.chatSection = "chat"; void startNewConversation(); });
      const history = document.createElement("button"); history.type = "button"; history.textContent = "History";
      history.addEventListener("click", () => { menu.hidden = true; state.chatSection = "chat"; void openChatHistory(); });
      const tracing = document.createElement("button"); tracing.type = "button"; tracing.textContent = "Tracing";
      tracing.addEventListener("click", () => { menu.hidden = true; window.open(TRACE_WEB_URL, "_blank", "noopener,noreferrer"); });
      menu.append(clear, history, tracing); more.addEventListener("click", () => { menu.hidden = !menu.hidden; });
      const close = document.createElement("button");
      close.className = "head-button"; close.type = "button"; close.textContent = "×"; close.addEventListener("click", closeWidget);
      actions.append(more, menu, close); header.append(back, actions); return;
    }
    header.className = "head";
    const heading = document.createElement("div");
    const logoUrl = chrome.runtime.getURL("icons/bigmouse2-rounded-128.png");
    heading.innerHTML = state.screen === "settings"
      ? '<h2>Settings</h2><p class="subtitle">Ticket widget preferences</p>'
      : state.screen === "checking"
        ? (state.checking.tab === "auto" ? '<h2>Checking ticket</h2><p class="subtitle">Ticket tự động · Đúng/Sai và góp ý</p>' : '<h2>Checking ticket</h2><p class="subtitle">Quá trình Hachimi check ticket · hỏi thêm Hachimi</p>')
      : state.screen === "analytics"
        ? '<h2>Analytics</h2><p class="subtitle">Đánh giá trực tiếp · reaction lịch sử</p>'
      : state.screen === "news"
        ? '<h2>NEWS</h2><p class="subtitle">Công nghệ · Model AI mới · Claude · cập nhật 08:00 hằng ngày</p>'
      : state.screen === "notifications"
        ? '<h2>Notifications</h2><p class="subtitle">Latest updates for Andrew</p>'
        : state.screen === "ticket-management"
          ? '<h2>Ticket Management</h2><p class="subtitle">Open pending and doing tickets by TS team</p>'
        : `<div class="brand"><img class="brand-logo" src="${logoUrl}" alt="TS Management logo"><div><h2>TS Management</h2><p class="subtitle">Pending · Doing · Wait customer · Dev fix · Feature</p><p class="subtitle">---edit by Andrew---</p></div></div>`;
    const actions = document.createElement("div"); actions.className = "chat-header-actions";
    // Ticket page: the NEWS button sits left of the close button; the NEWS page closes back to the tickets.
    if (state.screen === "home" && globalThis.NewsView) { const news = globalThis.NewsView.button(() => showScreen("news")); newsButton = news; actions.append(news.element); void refreshNewsBadge(); }
    const close = document.createElement("button");
    close.className = "head-button"; close.type = "button"; close.textContent = "×";
    close.setAttribute("aria-label", state.screen === "news" ? "Đóng NEWS, về Tickets" : "Close widget");
    close.addEventListener("click", () => { if (state.screen === "news") showScreen("home"); else closeWidget(); });
    actions.append(close);
    header.append(heading, actions);
  }
  function renderNavigation() {
    navigation.hidden = false;
    if (navigation.childElementCount) {
      navigation.querySelectorAll("button").forEach((button) => {
        const active = button.dataset.screen === state.screen || (state.screen === "news" && button.dataset.screen === "home");
        button.classList.toggle("active", active);
        if (active) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      });
      return;
    }
    [["home", "Tickets"], ["chat", "Chat bot"], ["checking", "Checking"], ["analytics", "Analytics"], ["notifications", "Notifications"], ["settings", "Settings"]].forEach(([name, label]) => {
      const button = document.createElement("button");
      button.className = `nav-button${state.screen === name ? " active" : ""}`; button.type = "button";
      button.dataset.screen = name;
      if (state.screen === name) button.setAttribute("aria-current", "page");
      button.innerHTML = `<span class="nav-icon">${chatIcon(name)}</span><span>${label}</span>`;
      button.addEventListener("click", () => {
        if (name === "chat") state.chatHistoryOpen = false;
        else void saveActiveConversation();
        showScreen(name);
      }); navigation.append(button);
    });
  }
  function showScreen(name, ticket = null) {
    if (name !== "checking" && stopHanAuto) { stopHanAuto(); stopHanAuto = null; }
    mcpV2SettingsCard?.dispose();
    reactionSettingsCard?.dispose();
    state.screen = name; if (ticket) state.selectedTicket = ticket;
    renderHeader(); renderNavigation();
    if (name === "home") renderHome();
    if (name === "chat") renderChat();
    if (name === "checking") renderChecking();
    if (name === "analytics") renderAnalytics();
    if (name === "news") renderNews();
    if (name === "notifications") { renderNotifications(); loadNotifications(); }
    if (name === "ticket-management") { renderTicketManagement(); loadTicketManagement(); }
    if (name === "settings") renderSettings();
  }
  async function startTicketCheck(ticket) {
    const id = ticket?.ticketId || ticket?.id || "this ticket";
    // A Check starts a focused conversation instead of mixing the ticket's
    // result into an earlier, unrelated chat.
    await saveActiveConversation();
    state.selectedTicket = ticket;
    state.chatId = createChatId();
    state.chatMessages = [];
    state.chatHistoryOpen = false;
    showScreen("chat", ticket);
    const messages = screen.querySelector(".chat-messages");
    const send = screen.querySelector(".send");
    if (messages && send) void sendChat(`Check ticket ${id}`, messages, send);
  }
  function ticketHoverText(ticket) {
    const members = Array.isArray(ticket?.members)
      ? ticket.members.map((member) => member?.displayName || member?.name || member?.email || member?.memberId).filter(Boolean).join(", ")
      : "";
    return [
      `Title: ${ticket?.subject || "No subject"}`,
      `App: ${ticket?.appName || ticket?.app || "Unknown"}`,
      `Description: ${ticket?.description || ticket?.content || "No description"}`,
      `Members: ${members || "No members"}`,
    ].join("\n");
  }
  function positionTicketTooltip(event) {
    const padding = 12;
    const gap = 14;
    const width = Math.min(330, window.innerWidth - padding * 2);
    const widget = host.getBoundingClientRect();
    const leftSpace = widget.left - gap - padding;
    const rightSpace = window.innerWidth - widget.right - gap - padding;
    // Keep the details outside the widget so they do not cover the ticket or
    // its controls. Prefer the left side (the usual bottom-right placement).
    const left = leftSpace >= width || leftSpace >= rightSpace
      ? Math.max(padding, widget.left - gap - width)
      : Math.min(window.innerWidth - width - padding, widget.right + gap);
    // Use the rendered height when the tooltip is already visible so long content stays inside the viewport.
    const height = ticketTooltip.hidden ? 0 : ticketTooltip.offsetHeight;
    const top = Math.max(padding, Math.min(event.clientY + 14, window.innerHeight - Math.max(180, height + padding)));
    ticketTooltip.style.left = `${left}px`;
    ticketTooltip.style.top = `${top}px`;
  }
  function showTicketTooltip(event, ticket) {
    ticketTooltip.textContent = ticketHoverText(ticket);
    positionTicketTooltip(event);
    ticketTooltip.hidden = false;
  }
  function hideTicketTooltip() { ticketTooltip.hidden = true; ticketTooltip.classList.remove("conversation"); }
  function notificationHoverText(notification) {
    return [
      `Title: ${notification?.metadata?.ticketSubject || notification?.title || "Helpdesk notification"}`,
      `Message: ${notification?.message || notification?.body || notification?.title || "No message"}`,
      notification?.metadata?.detail ? `Báo cáo follow dev:\n${notification.metadata.detail}` : "",
      `Time: ${notificationTime(notification?.createdAt) || "Unknown"}`,
    ].filter(Boolean).join("\n\n");
  }
  function showNotificationTooltip(event, notification) {
    ticketTooltip.textContent = notificationHoverText(notification);
    positionTicketTooltip(event);
    ticketTooltip.hidden = false;
  }
  function createTicket(ticket, group, onDoingSelectionChange = null) {
    const row = document.createElement("div"); row.className = `ticket${group.key === "doing" ? " doing-ticket" : group.key === "waiting_customer" ? " waiting-ticket" : group.feature ? " feature-ticket" : ""}`;
    if (group.key === "doing") {
      row.addEventListener("pointerenter", (event) => showTicketTooltip(event, ticket));
      row.addEventListener("pointermove", positionTicketTooltip);
      row.addEventListener("pointerleave", hideTicketTooltip);
      const ticketId = String(ticket.ticketId || ticket.id);
      const checkbox = document.createElement("input"); checkbox.className = "doing-ticket-select"; checkbox.type = "checkbox"; checkbox.checked = state.selectedDoingTicketIds.has(ticketId);
      checkbox.setAttribute("aria-label", `Chọn ticket ${ticketId}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.selectedDoingTicketIds.add(ticketId);
        else state.selectedDoingTicketIds.delete(ticketId);
        onDoingSelectionChange?.();
      });
      row.append(checkbox);
    }
    if (group.key === "waiting_customer") {
      const ticketId = String(ticket.ticketId || ticket.id);
      const checkbox = document.createElement("input"); checkbox.className = "waiting-ticket-select"; checkbox.type = "checkbox"; checkbox.checked = state.selectedWaitingCustomerTicketIds.has(ticketId);
      checkbox.setAttribute("aria-label", `Chọn ticket ${ticketId}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.selectedWaitingCustomerTicketIds.add(ticketId);
        else state.selectedWaitingCustomerTicketIds.delete(ticketId);
        onDoingSelectionChange?.();
      });
      row.append(checkbox);
    }
    const ticketReference = String(ticket.ticketId || ticket.id);
    const feature = group.feature ? featureSummaryFor(ticket) : null;
    const devReminder = group.key === "dev_fixing" ? state.devFollowDue[ticketReference] : feature?.reminderDue ? feature : null;
    const destination = group.slackOnly ? ticket.slackLink : ticketUrl(ticket);
    if (destination) {
      const link = document.createElement("a"); link.className = "link"; link.href = destination; link.target = "_blank"; link.rel = "noreferrer";
      const id = document.createElement("span"); id.className = "id"; id.textContent = ticket.ticketId || ticket.id;
      const subject = document.createElement("span"); subject.className = "subject"; subject.textContent = ticket.subject || "No subject";
      link.append(id, subject);
      if (group.showDetails) {
        const members = document.createElement("span"); members.className = "ticket-members"; members.textContent = ticketMemberSummary(ticket);
        const description = document.createElement("span"); description.className = "ticket-description"; description.textContent = ticket.description || "No description";
        link.append(members, description);
      }
      row.append(link);
    } else { const missing = document.createElement("span"); missing.className = "subject"; missing.textContent = `${ticket.ticketId || ticket.id}: no Slack link`; row.append(missing); }
    const actions = document.createElement("div"); actions.className = "ticket-actions";
    if (group.key === "doing") {
      const check = document.createElement("button"); check.className = "ask-ai"; check.type = "button"; check.textContent = "Check";
      check.title = "Check this Doing ticket with AI";
      check.addEventListener("click", () => { void startTicketCheck(ticket); }); actions.append(check);
    }
    if (group.key === "waiting_customer") {
      const moveToDoing = document.createElement("button"); moveToDoing.className = "move"; moveToDoing.type = "button"; moveToDoing.textContent = "Move to doing";
      moveToDoing.addEventListener("click", async () => {
        moveToDoing.disabled = true;
        try { await request({ type: "move-ticket", ticket, nextStatus: "doing" }); await loadTickets(); }
        catch (error) { setHomeStatus(error.message, true); } finally { moveToDoing.disabled = false; }
      }); actions.append(moveToDoing);
    }
    if (group.action && group.key !== "doing" && group.key !== "waiting_customer") {
      const move = document.createElement("button"); move.className = "move"; move.type = "button"; move.textContent = group.action.label;
      move.addEventListener("click", async () => {
        move.disabled = true;
        try { await request({ type: "move-ticket", ticket, nextStatus: group.action.nextStatus }); await loadTickets(); }
        catch (error) { setHomeStatus(error.message, true); } finally { move.disabled = false; }
      }); actions.append(move);
    }
    if (group.key === "dev_fixing" || group.feature) {
      const follow = document.createElement("button"); follow.className = "ask-ai"; follow.type = "button"; follow.textContent = "Follow dev";
      follow.addEventListener("click", () => { void openFollowDev(ticket); }); actions.append(follow);
    }
    if (group.feature) {
      const scan = document.createElement("button"); scan.className = "move feature-scan"; scan.type = "button"; scan.textContent = "Quét"; scan.title = "Quét preview bằng feature-follow (không đăng gì)";
      scan.addEventListener("click", async () => { scan.disabled = true; try { await runFeatureScan(ticketReference); } catch (error) { setHomeStatus(error.message, true); } finally { scan.disabled = false; } });
      actions.append(scan);
    }
    if (devReminder) {
      const warning = document.createElement("p"); warning.className = "dev-reminder-warning"; warning.textContent = group.feature ? `⚠ Cần nhắc dev follow up (${feature.silentHours} giờ không có update)` : "⚠ Cần nhắc dev follow up";
      const openThread = document.createElement("button"); openThread.className = "move"; openThread.type = "button"; openThread.textContent = "Mở Slack";
      openThread.addEventListener("click", () => { if (ticket.slackLink) window.open(ticket.slackLink, "_blank", "noopener,noreferrer"); });
      const remind = document.createElement("button"); remind.className = "move dev-remind"; remind.type = "button"; remind.textContent = "Nhắc dev";
      remind.addEventListener("click", async () => {
        remind.disabled = true; openThread.disabled = true;
        try {
          await request({ type: "send-dev-reminder", ticket });
          setHomeStatus(`Đã nhắc dev cho ticket ${ticketReference}.`);
          if (group.feature) await loadFeatureFollow(); else await followDevFixTickets();
        } catch (error) { setHomeStatus(error.message, true); }
        finally { remind.disabled = false; openThread.disabled = false; }
      });
      actions.append(warning, openThread, remind);
    }
    row.append(actions);
    if (group.feature) row.append(featureProgressBlock(feature));
    return row;
  }
  // --- Feature section: progress from skills/feature-follow, read through the TS Management web (5088) -----------
  function featureSummaryFor(ticket) {
    const payload = state.featureFollow; if (!payload || !ticket) return null;
    return payload.tickets?.[String(ticket.id || "")] || payload.byReference?.[String(ticket.ticketId || "")] || null;
  }
  const featureTime = (value) => { const date = new Date(value || ""); return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }); };
  const featureNode = (tag, className, text = "") => { const node = document.createElement(tag); node.className = className; if (text) node.textContent = text; return node; };
  function featureProgressBlock(feature) {
    const block = featureNode("div", "feature-progress");
    if (!feature) {
      const note = state.featureFollow ? (state.featureFollow.skillInstalled ? "Chưa quét: chưa có đánh giá từ feature-follow cho ticket này." : "Chưa cài skill feature-follow; chưa có tiến độ.") : state.featureFollowError ? `Không đọc được tiến độ: ${state.featureFollowError}` : "Đang đọc tiến độ…";
      block.append(featureNode("p", "feature-note", note)); return block;
    }
    const head = featureNode("div", "feature-head");
    head.append(featureNode("span", `feature-pill status-${feature.status || "unknown"}`, feature.statusLabel || "Chưa quét"));
    if (feature.waitingFor) head.append(featureNode("span", "feature-meta", `chờ: ${feature.waitingFor}`));
    if (feature.draftKind && feature.draftKind !== "none") head.append(featureNode("span", "feature-meta", `mail nháp: ${feature.draftKind}`));
    block.append(head);
    if (feature.progressShort) block.append(featureNode("p", "feature-text", feature.progressShort));
    const when = [];
    if (feature.assessedAt) when.push(`${feature.source === "scan" ? "quét tay" : "AI đánh giá"} ${featureTime(feature.assessedAt)}`);
    if (feature.latestSlackAt) when.push(`Slack cập nhật ${featureTime(feature.latestSlackAt)}`);
    if (feature.postedAt) when.push(`comment tiến độ ${featureTime(feature.postedAt)}`);
    if (when.length) block.append(featureNode("p", "feature-meta-line", when.join(" · ")));
    if (feature.scanError) block.append(featureNode("p", "feature-note error", `Lượt quét lỗi: ${feature.scanError}`));
    const previews = [["Xem comment", feature.scanComment], ["Xem nháp", feature.scanDraft || feature.draftMail]].filter(([, content]) => content);
    if (previews.length) {
      const bar = featureNode("div", "feature-previews");
      for (const [label, content] of previews) {
        const pre = featureNode("pre", "feature-preview", content); pre.hidden = true;
        const button = featureNode("button", "move", label); button.type = "button"; button.setAttribute("aria-expanded", "false");
        button.addEventListener("click", () => { pre.hidden = !pre.hidden; button.setAttribute("aria-expanded", String(!pre.hidden)); });
        bar.append(button); block.append(bar, pre);
      }
    }
    return block;
  }
  let featurePollTimer = null;
  function scheduleFeaturePoll() { if (state.featureFollow?.running && !featurePollTimer && host.isConnected) featurePollTimer = setTimeout(() => { featurePollTimer = null; void loadFeatureFollow(); }, 4_000); }
  async function loadFeatureFollow() {
    try { const { data } = await request({ type: "feature-follow" }); state.featureFollow = data; state.featureFollowError = ""; }
    catch (error) { state.featureFollowError = error.message; }
    if (state.screen === "home") renderHome();
    scheduleFeaturePoll();
  }
  async function runFeatureScan(reference = "") {
    const { data } = await request({ type: "feature-scan", ticket: reference });
    state.featureFollow = data; state.featureFollowError = "";
    setHomeStatus(reference ? `Đang quét ticket ${reference} (preview, không đăng)…` : "Đang quét các ticket Feature (preview, không đăng)…");
    if (state.screen === "home") renderHome();
    scheduleFeaturePoll();
  }
  function createCategory(group, tickets) {
    const category = document.createElement("section"); category.className = "category";
    const categoryHeader = document.createElement("div"); categoryHeader.className = "category-header";
    const toggle = document.createElement("button"); toggle.className = "toggle"; toggle.type = "button";
    const arrow = document.createElement("span"); arrow.className = "arrow"; arrow.textContent = "›";
    const name = document.createElement("span"); name.className = "name"; name.textContent = group.label;
    const count = document.createElement("span"); count.className = "count"; count.textContent = String(tickets.length);
    toggle.append(arrow, name, count); toggle.addEventListener("click", () => category.classList.toggle("expanded")); categoryHeader.append(toggle);
    if ((group.bulkAction || group.keepAndrewOnly) && tickets.length) {
      const groupActions = document.createElement("div"); groupActions.className = "group-actions";
      if (group.key === "waiting_customer" && group.bulkAction) {
        const ticketIds = new Set(tickets.map((ticket) => String(ticket.ticketId || ticket.id)));
        state.selectedWaitingCustomerTicketIds.forEach((id) => { if (!ticketIds.has(id)) state.selectedWaitingCustomerTicketIds.delete(id); });
        const selection = document.createElement("label"); selection.className = "waiting-selection";
        const selectAll = document.createElement("input"); selectAll.type = "checkbox"; selectAll.setAttribute("aria-label", "Chọn tất cả ticket Wait customer");
        const selectedCount = document.createElement("span"); selectedCount.className = "waiting-selection-count";
        const selectAllCopy = document.createElement("span"); selectAllCopy.textContent = "Select all";
        selection.append(selectAll, selectedCount, selectAllCopy);
        const moveSelected = document.createElement("button"); moveSelected.className = "all"; moveSelected.type = "button";
        const keepAndrew = document.createElement("button"); keepAndrew.className = "keep-andrew"; keepAndrew.type = "button"; keepAndrew.textContent = "Keep Andrew";
        const selectedTickets = () => tickets.filter((ticket) => state.selectedWaitingCustomerTicketIds.has(String(ticket.ticketId || ticket.id)));
        const syncWaitingSelection = () => {
          const selected = selectedTickets();
          const isAllSelected = selected.length === tickets.length;
          selectAll.checked = isAllSelected;
          selectAll.indeterminate = selected.length > 0 && !isAllSelected;
          selectedCount.textContent = selected.length ? `${selected.length} selected` : "";
          moveSelected.disabled = selected.length === 0;
          keepAndrew.disabled = selected.length === 0;
          moveSelected.textContent = isAllSelected ? group.bulkAction.label : selected.length > 1 ? `Move ${selected.length} to done` : "Move to done";
          keepAndrew.textContent = isAllSelected ? "Keep Andrew" : selected.length > 1 ? `Keep Andrew (${selected.length})` : "Keep Andrew";
        };
        const setWaitingInputsDisabled = (disabled) => {
          selectAll.disabled = disabled;
          category.querySelectorAll(".waiting-ticket-select").forEach((checkbox) => { checkbox.disabled = disabled; });
        };
        selectAll.addEventListener("change", () => {
          tickets.forEach((ticket) => {
            const ticketId = String(ticket.ticketId || ticket.id);
            if (selectAll.checked) state.selectedWaitingCustomerTicketIds.add(ticketId);
            else state.selectedWaitingCustomerTicketIds.delete(ticketId);
          });
          syncWaitingSelection();
          category.querySelectorAll(".waiting-ticket-select").forEach((checkbox) => { checkbox.checked = selectAll.checked; });
        });
        moveSelected.addEventListener("click", async () => {
          const selected = selectedTickets(); if (!selected.length) return;
          const isAll = selected.length === tickets.length;
          const label = isAll ? group.bulkAction.label : selected.length > 1 ? `Move ${selected.length} to done` : "Move to done";
          const detail = isAll ? `Tất cả ticket ${group.label} sẽ được chuyển sang trạng thái done.` : `${selected.length} ticket đã chọn sẽ được chuyển sang trạng thái done.`;
          if (!confirmBulkAction(label, detail)) return;
          moveSelected.disabled = true; keepAndrew.disabled = true; setWaitingInputsDisabled(true);
          try {
            let moved = 0; let failed = 0;
            if (isAll) {
              const result = await request({ type: "move-all-status", status: group.key, nextStatus: group.bulkAction.nextStatus });
              moved = result.moved; failed = result.failed?.length || 0;
            } else {
              for (const ticket of selected) {
                try { await request({ type: "move-ticket", ticket, nextStatus: group.bulkAction.nextStatus }); moved += 1; }
                catch (_) { failed += 1; }
              }
            }
            const message = `Đã chuyển ${moved} ticket(s) sang done.${failed ? ` ${failed} ticket(s) thất bại.` : ""}`;
            setHomeStatus(message, Boolean(failed)); showBulkActionResult(message);
            state.selectedWaitingCustomerTicketIds.clear(); await loadTickets();
          } catch (error) { setHomeStatus(error.message, true); }
          finally { setWaitingInputsDisabled(false); syncWaitingSelection(); }
        });
        keepAndrew.addEventListener("click", async () => {
          const selected = selectedTickets(); if (!selected.length) return;
          const isAll = selected.length === tickets.length;
          const detail = isAll ? `Andrew sẽ là người được assign duy nhất trên tất cả ticket ${group.label}.` : `Andrew sẽ là người được assign duy nhất trên ${selected.length} ticket đã chọn.`;
          if (!confirmBulkAction("Keep Andrew", detail)) return;
          moveSelected.disabled = true; keepAndrew.disabled = true; setWaitingInputsDisabled(true);
          try {
            let updated = 0; let unchanged = 0; let failed = 0;
            if (isAll) {
              const result = await request({ type: "keep-andrew-only", status: group.key });
              updated = result.updated; unchanged = result.unchanged; failed = result.failed?.length || 0;
            } else {
              for (const ticket of selected) {
                try {
                  const result = await request({ type: "keep-andrew-only-ticket", ticket });
                  if (result.changed) updated += 1; else unchanged += 1;
                } catch (_) { failed += 1; }
              }
            }
            const message = `Đã giữ Andrew là người duy nhất trên ${updated} ticket(s). ${unchanged} ticket(s) không cần thay đổi.${failed ? ` ${failed} ticket(s) thất bại.` : ""}`;
            setHomeStatus(message, Boolean(failed)); showBulkActionResult(message);
            state.selectedWaitingCustomerTicketIds.clear(); await loadTickets();
          } catch (error) { setHomeStatus(error.message, true); }
          finally { setWaitingInputsDisabled(false); syncWaitingSelection(); }
        });
        syncWaitingSelection();
        groupActions.append(selection, moveSelected, keepAndrew);
        category.addEventListener("andrew-waiting-selection-changed", syncWaitingSelection);
      } else if (group.key === "doing" && group.bulkAction) {
        const ticketIds = new Set(tickets.map((ticket) => String(ticket.ticketId || ticket.id)));
        state.selectedDoingTicketIds.forEach((id) => { if (!ticketIds.has(id)) state.selectedDoingTicketIds.delete(id); });
        const selection = document.createElement("label"); selection.className = "doing-selection";
        const selectAll = document.createElement("input"); selectAll.type = "checkbox"; selectAll.setAttribute("aria-label", "Chọn tất cả ticket Doing");
        const selectedCount = document.createElement("span"); selectedCount.className = "doing-selection-count";
        const selectAllCopy = document.createElement("span"); selectAllCopy.textContent = "Select all";
        selection.append(selectAll, selectedCount, selectAllCopy);
        const moveSelected = document.createElement("button");
        moveSelected.className = "all"; moveSelected.type = "button";
        const syncDoingSelection = () => {
          const selectedTickets = tickets.filter((ticket) => state.selectedDoingTicketIds.has(String(ticket.ticketId || ticket.id)));
          const isAllSelected = selectedTickets.length === tickets.length;
          selectAll.checked = isAllSelected;
          selectAll.indeterminate = selectedTickets.length > 0 && !isAllSelected;
          selectedCount.textContent = selectedTickets.length ? `${selectedTickets.length} selected` : "";
          moveSelected.disabled = selectedTickets.length === 0;
          moveSelected.textContent = isAllSelected ? group.bulkAction.label : selectedTickets.length > 1 ? `Move ${selectedTickets.length} to wait` : "Move to wait";
        };
        selectAll.addEventListener("change", () => {
          tickets.forEach((ticket) => {
            const ticketId = String(ticket.ticketId || ticket.id);
            if (selectAll.checked) state.selectedDoingTicketIds.add(ticketId);
            else state.selectedDoingTicketIds.delete(ticketId);
          });
          syncDoingSelection();
          category.querySelectorAll(".doing-ticket-select").forEach((checkbox) => { checkbox.checked = selectAll.checked; });
        });
        moveSelected.addEventListener("click", async () => {
          const selectedTickets = tickets.filter((ticket) => state.selectedDoingTicketIds.has(String(ticket.ticketId || ticket.id)));
          if (!selectedTickets.length) return;
          const isAll = selectedTickets.length === tickets.length;
          const label = isAll ? group.bulkAction.label : selectedTickets.length > 1 ? `Move ${selectedTickets.length} to wait` : "Move to wait";
          const detail = isAll
            ? `Tất cả ticket ${group.label} sẽ được chuyển sang trạng thái ${group.bulkAction.nextStatus}.`
            : `${selectedTickets.length} ticket đã chọn sẽ được chuyển sang trạng thái ${group.bulkAction.nextStatus}.`;
          if (!confirmBulkAction(label, detail)) return;
          moveSelected.disabled = true; selectAll.disabled = true;
          category.querySelectorAll(".doing-ticket-select").forEach((checkbox) => { checkbox.disabled = true; });
          try {
            if (isAll) {
              const result = await request({ type: "move-all-status", status: group.key, nextStatus: group.bulkAction.nextStatus });
              const message = `Đã chuyển ${result.moved} ticket(s) sang ${group.bulkAction.nextStatus}.${result.failed?.length ? ` ${result.failed.length} ticket(s) thất bại.` : ""}`;
              setHomeStatus(message, Boolean(result.failed?.length));
              showBulkActionResult(message);
            } else {
              let moved = 0;
              let failed = 0;
              for (const ticket of selectedTickets) {
                try {
                  await request({ type: "move-ticket", ticket, nextStatus: group.bulkAction.nextStatus });
                  moved += 1;
                } catch (_) {
                  failed += 1;
                }
              }
              const message = `Đã chuyển ${moved} ticket(s) sang ${group.bulkAction.nextStatus}.${failed ? ` ${failed} ticket(s) thất bại.` : ""}`;
              setHomeStatus(message, Boolean(failed));
              showBulkActionResult(message);
            }
            state.selectedDoingTicketIds.clear();
            await loadTickets();
          } catch (error) { setHomeStatus(error.message, true); }
          finally {
            selectAll.disabled = false;
            category.querySelectorAll(".doing-ticket-select").forEach((checkbox) => { checkbox.disabled = false; });
            syncDoingSelection();
          }
        });
        syncDoingSelection();
        groupActions.append(selection, moveSelected);
        category.addEventListener("andrew-doing-selection-changed", syncDoingSelection);
      } else if (group.bulkAction) {
        const all = document.createElement("button"); all.className = "all"; all.type = "button"; all.textContent = group.bulkAction.label;
        all.addEventListener("click", async () => {
          if (!confirmBulkAction(group.bulkAction.label, `Tất cả ticket ${group.label} sẽ được chuyển sang trạng thái ${group.bulkAction.nextStatus}.`)) return;
          all.disabled = true;
          try {
            const result = await request({ type: "move-all-status", status: group.key, nextStatus: group.bulkAction.nextStatus });
            const message = `Đã chuyển ${result.moved} ticket(s) sang ${group.bulkAction.nextStatus}.${result.failed?.length ? ` ${result.failed.length} ticket(s) thất bại.` : ""}`;
            setHomeStatus(message, Boolean(result.failed?.length));
            showBulkActionResult(message);
            await loadTickets();
          }
        catch (error) { setHomeStatus(error.message, true); } finally { all.disabled = false; }
        }); groupActions.append(all);
      }
      if (group.keepAndrewOnly && group.key !== "waiting_customer") {
        const keepAndrew = document.createElement("button"); keepAndrew.className = "keep-andrew"; keepAndrew.type = "button"; keepAndrew.textContent = "Keep Andrew";
        keepAndrew.addEventListener("click", async () => {
          if (!confirmBulkAction("Keep Andrew", `Andrew sẽ là người được assign duy nhất trên tất cả ticket ${group.label}.`)) return;
          keepAndrew.disabled = true;
          try {
            const result = await request({ type: "keep-andrew-only", status: group.key });
            const failure = result.failed?.length ? ` ${result.failed.length} failed.` : "";
            const message = `Đã giữ Andrew là người duy nhất trên ${result.updated} ticket(s). ${result.unchanged} ticket(s) không cần thay đổi.${failure}`;
            setHomeStatus(message, Boolean(result.failed?.length));
            showBulkActionResult(message);
            await loadTickets();
          } catch (error) { setHomeStatus(error.message, true); } finally { keepAndrew.disabled = false; }
        }); groupActions.append(keepAndrew);
      }
      categoryHeader.append(groupActions);
    }
    if (group.feature) {
      const groupActions = document.createElement("div"); groupActions.className = "group-actions feature-actions";
      const follow = state.featureFollow;
      const note = featureNode("span", "feature-scan-note", follow?.running ? `Đang quét${follow.runningTicket ? ` ${follow.runningTicket}` : ""}…` : follow?.scanAt ? `Quét tay ${featureTime(follow.scanAt)}` : follow?.stateAt ? `Timer ${featureTime(follow.stateAt)}` : "Chưa quét");
      const scan = featureNode("button", "all feature-scan-all", follow?.running ? "Đang quét…" : "Quét"); scan.type = "button"; scan.disabled = Boolean(follow?.running) || !tickets.length;
      scan.addEventListener("click", async () => { scan.disabled = true; try { await runFeatureScan(); } catch (error) { setHomeStatus(error.message, true); scan.disabled = false; } });
      groupActions.append(note, scan); categoryHeader.append(groupActions);
    }
    const items = document.createElement("div"); items.className = "items";
    if (!tickets.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = `No ${group.label.toLowerCase()} tickets.`; items.append(empty); }
    else tickets.forEach((ticket) => items.append(createTicket(
      ticket,
      group,
      group.key === "doing"
        ? () => category.dispatchEvent(new Event("andrew-doing-selection-changed"))
        : group.key === "waiting_customer"
          ? () => category.dispatchEvent(new Event("andrew-waiting-selection-changed"))
          : null,
    )));
    category.append(categoryHeader, items); return category;
  }
  function setHomeStatus(message = "", isError = false) {
    const status = screen.querySelector(".status"); if (!status) return; status.textContent = message; status.classList.toggle("error", isError);
  }
  function confirmBulkAction(label, detail) {
    return window.confirm(`Bạn đã chọn “${label}”.\n\n${detail}\n\nTiếp tục thực hiện?`);
  }
  function showBulkActionResult(message) {
    window.alert(message);
  }
  function renderHome() {
    screen.className = "screen"; screen.replaceChildren();
    const summary = document.createElement("div"); summary.className = "home-summary";
    const total = GROUPS.reduce((sum, group) => sum + (state.groups[group.key] || []).length, 0);
    const count = document.createElement("span"); count.className = "count-pill"; count.textContent = `${total} ticket${total === 1 ? "" : "s"}`;
    const controls = document.createElement("div"); controls.className = "group-actions";
    const webLink = document.createElement("button"); webLink.className = "refresh web-link"; webLink.type = "button"; webLink.textContent = "Web local";
    webLink.title = `Mở TS Management web (${TS_WEB_URL})`;
    webLink.addEventListener("click", () => window.open(TS_WEB_URL, "_blank", "noopener,noreferrer"));
    const management = document.createElement("button"); management.className = "refresh"; management.type = "button"; management.textContent = "Ticket Management";
    management.addEventListener("click", () => showScreen("ticket-management"));
    const refresh = document.createElement("button"); refresh.className = "refresh"; refresh.dataset.action = "refresh-tickets"; refresh.type = "button"; refresh.textContent = "Refresh"; refresh.addEventListener("click", loadTickets);
    controls.append(webLink, management, refresh); summary.append(count, controls);
    const status = document.createElement("p"); status.className = "status";
    const categories = document.createElement("div"); categories.className = "categories";
    GROUPS.forEach((group) => categories.append(createCategory(group, state.groups[group.key] || [])));
    screen.append(summary, status, categories);
  }
  function managementTicketMembers(ticket) {
    return (ticket?.members || [])
      .map((member) => member?.displayName || member?.name || member?.email || member?.memberId)
      .filter(Boolean)
      .join(", ") || "No member";
  }
  function managementCreatedAt(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Unknown date" : date.toLocaleString();
  }
  function renderTicketManagement() {
    screen.className = "screen ticket-management"; screen.replaceChildren();
    const { team, tickets, members, loading, error } = state.ticketManagement;
    const toolbar = document.createElement("div"); toolbar.className = "management-toolbar";
    const label = document.createElement("label"); label.htmlFor = "ticket-management-team"; label.textContent = "TS team";
    const select = document.createElement("select"); select.id = "ticket-management-team";
    select.innerHTML = '<option value="TS1">TS1</option><option value="TS2">TS2</option>';
    select.value = team;
    select.addEventListener("change", () => { state.ticketManagement.team = select.value; loadTicketManagement(); });
    toolbar.append(label, select);
    const summary = document.createElement("p"); summary.className = "management-summary";
    summary.textContent = loading ? "Loading ticket management…" : error ? error : `${tickets.length} open ticket${tickets.length === 1 ? "" : "s"} in ${team}`;
    const memberCard = document.createElement("section"); memberCard.className = "management-card";
    const memberHeading = document.createElement("h3"); memberHeading.textContent = "Tickets by member"; memberCard.append(memberHeading);
    if (!loading && !members.length) {
      const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "No assigned TS tickets."; memberCard.append(empty);
    } else {
      const totalAssignments = members.reduce((total, member) => total + member.count, 0);
      members.forEach((member, index) => {
        const row = document.createElement("div"); row.className = "management-member";
        const dot = document.createElement("span"); dot.className = "management-dot"; dot.style.background = ["#2563eb", "#10b981", "#f59e0b", "#ef4444", "#3b82f6", "#ec4899", "#06b6d4"][index % 7];
        const name = document.createElement("span"); name.textContent = member.name;
        const count = document.createElement("span"); count.className = "management-member-count";
        count.textContent = `${member.count} (${totalAssignments ? ((member.count / totalAssignments) * 100).toFixed(1) : "0.0"}%)`;
        row.append(dot, name, count); memberCard.append(row);
      });
    }
    const ticketCard = document.createElement("section"); ticketCard.className = "management-card";
    const ticketHeading = document.createElement("h3"); ticketHeading.textContent = "Open tickets"; ticketCard.append(ticketHeading);
    if (!loading && !tickets.length) {
      const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "No pending or doing tickets for this team."; ticketCard.append(empty);
    } else {
      tickets.forEach((ticket) => {
        const item = document.createElement("a"); item.className = "management-ticket"; item.href = ticketUrl(ticket); item.target = "_blank"; item.rel = "noreferrer";
        const title = document.createElement("span"); title.className = "management-ticket-title"; title.textContent = ticket.subject || "No subject";
        const meta = document.createElement("span"); meta.className = "management-ticket-meta";
        const status = document.createElement("span"); status.className = "management-badge"; status.textContent = ticket.tsStatus || "pending";
        const member = document.createElement("span"); member.className = "management-ticket-member"; member.textContent = `Member: ${managementTicketMembers(ticket)}`;
        const created = document.createElement("span"); created.textContent = `Created: ${managementCreatedAt(ticket.createdAt)}`;
        const level = document.createElement("span"); level.textContent = `Level: ${ticket.level ?? "—"}`;
        meta.append(status, member, created, level); item.append(title, meta); ticketCard.append(item);
      });
    }
    screen.append(toolbar, summary, memberCard, ticketCard);
  }
  async function loadTicketManagement() {
    if (state.ticketManagement.loading) return;
    state.ticketManagement.loading = true; state.ticketManagement.error = "";
    if (state.screen === "ticket-management") renderTicketManagement();
    try {
      // The page is already signed in to Helpdesk. Reading the management
      // data here gives us the member `group` field, absent from the public
      // external Members API, so the TS rule is applied exactly.
      const data = await loadTicketManagementDirect(state.ticketManagement.team);
      state.ticketManagement.tickets = data.tickets || [];
      state.ticketManagement.members = data.members || [];
    } catch (error) {
      state.ticketManagement.error = `Could not load ticket management: ${error.message}`;
    } finally {
      state.ticketManagement.loading = false;
      if (state.screen === "ticket-management") renderTicketManagement();
    }
  }
  async function helpdeskManagementRequest(path, apiKey) {
    let response;
    try { response = await fetch(`https://helpdesk.avada.net/api/external${path}`, {
      headers: { "X-API-Key": apiKey },
    }); }
    finally { void chrome.runtime.sendMessage({ type: "helpdesk-usage", flow: "helpdeskManagementRequest", path, status: response?.status || 0 }).catch(() => {}); }
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.success) throw new Error(body?.error?.message || `Helpdesk returned HTTP ${response.status}.`);
    return body.data;
  }
  async function listManagementTickets(status, apiKey) {
    const tickets = [];
    let cursor = null;
    for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({ tsStatus: status, limit: "100" });
      if (cursor) params.set("cursor", cursor);
      const data = await helpdeskManagementRequest(`/tickets/admin?${params}`, apiKey);
      tickets.push(...(data?.tickets || []));
      // Some live API responses omit `hasMore` while providing a nextCursor.
      // Continue from that cursor, unless the API explicitly says there is no
      // further page.
      if (data?.hasMore === false || !data?.nextCursor) break;
      cursor = data.nextCursor;
    }
    return tickets;
  }
  function managementMemberId(member) { return String(member?.memberId || member?.id || member?.authUid || ""); }
  function firebaseTokenFromValue(value) {
    if (!value || typeof value !== "object") return "";
    const token = value?.stsTokenManager?.accessToken || value?.accessToken || value?.value?.stsTokenManager?.accessToken;
    return typeof token === "string" && token.startsWith("eyJ") ? token : "";
  }
  async function getHelpdeskFirebaseToken() {
    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key?.startsWith("firebase:authUser:")) continue;
        const token = firebaseTokenFromValue(JSON.parse(localStorage.getItem(key) || "null"));
        if (token) return token;
      }
    } catch (_) { /* Firebase may use IndexedDB persistence instead. */ }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (token = "") => { if (!settled) { settled = true; resolve(token); } };
      try {
        const open = indexedDB.open("firebaseLocalStorageDb");
        open.onerror = () => finish();
        open.onsuccess = () => {
          const database = open.result;
          if (!database.objectStoreNames.contains("firebaseLocalStorage")) { database.close(); finish(); return; }
          const read = database.transaction("firebaseLocalStorage", "readonly").objectStore("firebaseLocalStorage").getAll();
          read.onerror = () => { database.close(); finish(); };
          read.onsuccess = () => {
            const token = (read.result || []).map(firebaseTokenFromValue).find(Boolean) || "";
            database.close(); finish(token);
          };
        };
      } catch (_) { finish(); }
    });
  }
  async function getHelpdeskMembersWithGroups() {
    const token = await getHelpdeskFirebaseToken();
    if (!token) throw new Error("Sign in to Helpdesk, then reload this page so TS member data can be read.");
    const response = await fetch(`${HELP_DESK_URL}/api/members`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error?.message || "Could not read Helpdesk member groups.");
    const members = body?.success ? body.data?.members : body?.members;
    if (!Array.isArray(members)) throw new Error("Helpdesk did not return member data.");
    return members;
  }
  async function loadTicketManagementDirect(team) {
    const { apiKey } = await chrome.storage.local.get({ apiKey: "" });
    if (!apiKey) throw new Error("Add your Helpdesk API key in Settings first.");
    const [pending, doing, memberData, internalMembers] = await Promise.all([
      listManagementTickets("pending", apiKey),
      listManagementTickets("doing", apiKey),
      helpdeskManagementRequest("/members?limit=100", apiKey),
      getHelpdeskMembersWithGroups(),
    ]);
    const directory = new Map((memberData?.members || []).map((member) => [managementMemberId(member), member]));
    const groupDirectory = new Map(internalMembers.map((member) => [managementMemberId(member), member]));
    const selectedTeam = team === "TS1" || team === "TS2" ? team : "";
    const tickets = [...pending, ...doing].filter((ticket) => (ticket.members || []).some((assignment) => {
      const member = groupDirectory.get(managementMemberId(assignment));
      return member?.group?.startsWith("TS") && (!selectedTeam || member.group === selectedTeam);
    }));
    const counts = new Map();
    tickets.forEach((ticket) => (ticket.members || []).forEach((assignment) => {
      const groupMember = groupDirectory.get(managementMemberId(assignment));
      if (!groupMember?.group?.startsWith("TS") || (selectedTeam && groupMember.group !== selectedTeam)) return;
      const member = directory.get(managementMemberId(assignment)) || groupMember || assignment;
      const id = managementMemberId(member) || String(member?.displayName || "Unknown");
      const item = counts.get(id) || { id, name: member.displayName || member.email || "Unknown", count: 0 };
      item.count += 1; counts.set(id, item);
    }));
    return {
      tickets: tickets.sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || ""))),
      members: [...counts.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
    };
  }
  function notificationUrl(notification) {
    const link = String(notification?.link || "").trim();
    if (link) return new URL(link, HELP_DESK_URL).href;
    const ticketId = notification?.metadata?.ticketId;
    return ticketId ? `${HELP_DESK_URL}/t/${encodeURIComponent(ticketId)}` : HELP_DESK_URL;
  }
  function notificationTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
  }
  function nextScanLabel(schedule) {
    const next = new Date(schedule?.scheduledAt || "");
    if (Number.isNaN(next.getTime())) return `${schedule?.label || "Quét tự động"} · đang xác định lịch`;
    const time = next.toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
    return `${schedule.label} · lần scan kế tiếp ${time}`;
  }
  function renderScanScheduleTags() {
    const scheduleKeyBySection = {
      dev_done: "dev_follow",
      date_follow: "date_follow",
      sla_skill: "sla_skill",
    };
    const scheduleKey = scheduleKeyBySection[state.notificationSection];
    if (!scheduleKey) return document.createDocumentFragment();
    const schedule = state.scanSchedules.find((item) => item.key === scheduleKey);
    if (!schedule) return document.createDocumentFragment();
    const tags = document.createElement("div"); tags.className = "scan-schedule-tags";
    const tag = document.createElement("span");
    tag.className = "scan-schedule-tag active";
    tag.textContent = nextScanLabel(schedule);
    tags.append(tag);
    return tags;
  }
  function notificationId(notification) { return String(notification?.id || ""); }
  async function applyLocalNotificationState(notifications) {
    const { [LOCAL_READ_NOTIFICATION_IDS_KEY]: storedIds = [], [NOTIFICATION_BASELINE_KEY]: initialized = false } = await chrome.storage.local.get({
      [LOCAL_READ_NOTIFICATION_IDS_KEY]: [], [NOTIFICATION_BASELINE_KEY]: false,
    });
    const readIds = new Set(Array.isArray(storedIds) ? storedIds : []);
    if (!initialized) {
      notifications.map(notificationId).filter(Boolean).forEach((id) => readIds.add(id));
      await chrome.storage.local.set({
        [NOTIFICATION_BASELINE_KEY]: true,
        [LOCAL_READ_NOTIFICATION_IDS_KEY]: [...readIds].slice(-MAX_REMEMBERED_NOTIFICATION_IDS),
      });
    }
    return notifications.map((notification) => ({ ...notification, read: readIds.has(notificationId(notification)) }));
  }
  async function rememberReadNotificationIds(ids) {
    const { [LOCAL_READ_NOTIFICATION_IDS_KEY]: storedIds = [] } = await chrome.storage.local.get({ [LOCAL_READ_NOTIFICATION_IDS_KEY]: [] });
    const next = new Set(Array.isArray(storedIds) ? storedIds : []);
    ids.filter(Boolean).forEach((id) => next.add(id));
    await chrome.storage.local.set({ [LOCAL_READ_NOTIFICATION_IDS_KEY]: [...next].slice(-MAX_REMEMBERED_NOTIFICATION_IDS) });
  }
  function parseSlaSkillDetail(detail) {
    const blocks = String(detail || "").split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
    const source = blocks.find((block) => /^Nguồn\s*:/i.test(block))?.replace(/^Nguồn\s*:\s*/i, "") || "Avada Bot · Quét SLA";
    const summaryBlock = blocks.find((block) => /^Tóm tắt/i.test(block));
    const summary = summaryBlock ? summaryBlock.replace(/^Tóm tắt[^:]*:\s*/i, "") : "Bản tin SLA mới cần được rà soát.";
    const rules = blocks.filter((block) => /^\d+\.\s+/.test(block)).map((block) => {
      const [heading = "", ...lines] = block.split("\n");
      const title = heading.replace(/^\d+\.\s*/, "").trim();
      const ruleLine = lines.find((line) => /^Quy tắc\s*:/i.test(line)) || "";
      const evidenceLine = lines.find((line) => /^Bằng chứng SLA\s*:/i.test(line)) || "";
      return {
        title,
        rule: ruleLine.replace(/^Quy tắc\s*:\s*/i, "").trim(),
        evidence: evidenceLine.replace(/^Bằng chứng SLA\s*:\s*/i, "").trim(),
      };
    }).filter((rule) => rule.title || rule.rule || rule.evidence);
    return { source, summary, rules };
  }
  function createSlaSkillNotification(notification) {
    const content = parseSlaSkillDetail(notification?.metadata?.detail);
    const item = document.createElement("article"); item.className = `notification sla-skill-card${notification?.read ? "" : " unread"}`;
    const trigger = document.createElement("button"); trigger.type = "button"; trigger.className = "sla-skill-trigger";
    trigger.setAttribute("aria-expanded", "false");
    const heading = document.createElement("div"); heading.className = "sla-skill-heading";
    const icon = document.createElement("span"); icon.className = "sla-skill-icon"; icon.textContent = "SLA";
    const titleWrap = document.createElement("div"); titleWrap.className = "sla-skill-title-wrap";
    const title = document.createElement("div"); title.className = "sla-skill-title"; title.textContent = notification?.title || "Skill SLA";
    const source = document.createElement("span"); source.className = "sla-skill-source"; source.textContent = content.source;
    titleWrap.append(title, source); heading.append(icon, titleWrap);
    if (!notification?.read) { const dot = document.createElement("span"); dot.className = "notification-dot"; dot.title = "Chưa đọc"; heading.append(dot); }
    const time = notificationTime(notification?.createdAt);
    const summary = document.createElement("p"); summary.className = "sla-skill-summary"; summary.textContent = content.summary;
    const footer = document.createElement("div"); footer.className = "sla-skill-footer";
    const timestamp = document.createElement("time"); timestamp.textContent = time;
    const expand = document.createElement("span"); expand.className = "sla-skill-expand"; expand.textContent = `Xem ${content.rules.length || ""} quy tắc`;
    footer.append(timestamp, expand); trigger.append(heading, summary, footer);
    const detail = document.createElement("div"); detail.className = "sla-skill-detail"; detail.hidden = true;
    if (!content.rules.length) {
      const empty = document.createElement("p"); empty.className = "sla-skill-empty"; empty.textContent = "Chưa trích được quy tắc chi tiết từ bản tin SLA này."; detail.append(empty);
    } else {
      const list = document.createElement("div"); list.className = "sla-skill-rules";
      content.rules.forEach((rule, index) => {
        const ruleCard = document.createElement("section"); ruleCard.className = "sla-skill-rule";
        const number = document.createElement("span"); number.className = "sla-skill-rule-number"; number.textContent = String(index + 1);
        const body = document.createElement("div");
        const ruleTitle = document.createElement("div"); ruleTitle.className = "sla-skill-rule-title"; ruleTitle.textContent = rule.title || `Quy tắc ${index + 1}`;
        const ruleCopy = document.createElement("p"); ruleCopy.className = "sla-skill-rule-copy"; ruleCopy.textContent = rule.rule || "Chưa có diễn giải chi tiết.";
        body.append(ruleTitle, ruleCopy);
        if (rule.evidence) {
          const evidence = document.createElement("blockquote"); evidence.className = "sla-skill-evidence";
          const label = document.createElement("strong"); label.textContent = "Bằng chứng SLA: "; evidence.append(label, document.createTextNode(rule.evidence)); body.append(evidence);
        }
        ruleCard.append(number, body); list.append(ruleCard);
      });
      detail.append(list);
    }
    trigger.addEventListener("click", () => {
      const expanded = detail.hidden;
      detail.hidden = !expanded;
      trigger.setAttribute("aria-expanded", String(expanded));
      expand.textContent = expanded ? "Thu gọn" : `Xem ${content.rules.length || ""} quy tắc`;
      if (!notification?.read) void markNotificationRead(notification);
    });
    item.append(trigger, detail);
    return item;
  }
  function createNotification(notification) {
    const isDevFollowReport = String(notification?.id || "").startsWith("dev-follow:");
    const isSlaSkill = String(notification?.id || "").startsWith("sla-skill:");
    if (isSlaSkill) return createSlaSkillNotification(notification);
    const item = document.createElement("article"); item.className = `notification${notification?.read ? "" : " unread"}`;
    item.addEventListener("pointerenter", (event) => showNotificationTooltip(event, notification));
    item.addEventListener("pointermove", positionTicketTooltip);
    item.addEventListener("pointerleave", hideTicketTooltip);
    const link = document.createElement("a"); link.className = "notification-link";
    link.href = notificationUrl(notification); link.target = "_blank"; link.rel = "noreferrer";
    const top = document.createElement("div"); top.className = "notification-top";
    const title = document.createElement("span"); title.className = "notification-title";
    title.textContent = isDevFollowReport ? (notification?.title || "Dev follow") : (notification?.metadata?.ticketSubject || notification?.title || "Helpdesk notification");
    top.append(title);
    if (!notification?.read) { const dot = document.createElement("span"); dot.className = "notification-dot"; dot.title = "Unread"; top.append(dot); }
    const message = document.createElement("span"); message.className = "notification-message";
    message.textContent = notification?.message || notification?.body || notification?.title || "Open the related ticket";
    const time = document.createElement("time"); time.className = "notification-time"; time.textContent = notificationTime(notification?.createdAt);
    link.append(top, message, time); item.append(link);
    link.addEventListener("click", () => { if (!notification?.read) void markNotificationRead(notification); });
    const canMoveToWaitingCustomer = Boolean(
      notification?.metadata?.canMoveToWaitingCustomer
      || notification?.metadata?.status === "awaiting_customer_confirmation",
    );
    const movedToWaitingCustomer = Boolean(notification?.metadata?.movedToWaitingCustomer);
    if (isDevFollowReport && canMoveToWaitingCustomer && !movedToWaitingCustomer) {
      const nextStatus = "waiting_customer";
      const movedFlag = "movedToWaitingCustomer";
      const actions = document.createElement("div"); actions.className = "notification-card-actions";
      const move = document.createElement("button"); move.className = "move"; move.type = "button"; move.textContent = "Move to wait customer";
      move.addEventListener("click", async () => {
        move.disabled = true;
        try {
          const id = notification?.metadata?.ticketInternalId;
          if (!id) throw new Error("Thiếu mã nội bộ của ticket.");
          await request({ type: "move-ticket", ticket: { id }, nextStatus });
          notification.metadata[movedFlag] = true;
          const { devDoneNotifications = [] } = await chrome.storage.local.get({ devDoneNotifications: [] });
          await chrome.storage.local.set({ devDoneNotifications: devDoneNotifications.map((item) => item.id === notification.id ? notification : item) });
          await Promise.all([loadTickets(), loadNotifications()]);
        } catch (error) {
          setNotificationStatus(error.message || String(error), true);
          move.disabled = false;
        }
      });
      actions.append(move); item.append(actions);
    }
    return item;
  }
  function setNotificationStatus(message = "", isError = false) {
    const status = screen.querySelector(".status"); if (!status) return; status.textContent = message; status.classList.toggle("error", isError);
  }
  function renderNotifications() {
    screen.className = "screen"; screen.replaceChildren();
    const tabs = document.createElement("div"); tabs.className = "notification-tabs";
    [["general", "Thông báo chung"], ["dev_done", "Dev báo done"], ["date_follow", "Date Follow"], ["sla_skill", "Skill SLA"]].forEach(([key, label]) => {
      const tab = document.createElement("button"); tab.type = "button"; tab.textContent = label;
      tab.className = `notification-tab${state.notificationSection === key ? " active" : ""}`;
      tab.addEventListener("click", () => {
        state.notificationSection = key;
        state.showUnreadOnly = false;
        state.notifications = key === "dev_done"
          ? state.devDoneNotifications
          : key === "date_follow"
            ? state.dateFollowNotifications
            : key === "sla_skill"
              ? state.slaSkillNotifications
              : state.generalNotifications;
        renderNotifications();
        void loadNotifications({ showLoading: false });
      });
      tabs.append(tab);
    });
    const scanScheduleTags = renderScanScheduleTags();
    const summary = document.createElement("div"); summary.className = "home-summary";
    const unread = state.notifications.filter((notification) => !notification?.read).length;
    const count = document.createElement("span"); count.className = "count-pill";
    count.textContent = `${state.notifications.length} notification${state.notifications.length === 1 ? "" : "s"}${unread ? ` · ${unread} new` : ""}`;
    const refresh = document.createElement("button"); refresh.className = "refresh"; refresh.type = "button"; refresh.textContent = "Refresh"; refresh.addEventListener("click", () => void loadNotifications({ showLoading: true }));
    summary.append(count, refresh);
    const actions = document.createElement("div"); actions.className = "notification-actions";
    const unreadFilter = document.createElement("button"); unreadFilter.type = "button"; unreadFilter.textContent = "Unread only";
    unreadFilter.classList.toggle("active", state.showUnreadOnly); unreadFilter.setAttribute("aria-pressed", String(state.showUnreadOnly));
    unreadFilter.addEventListener("click", () => { state.showUnreadOnly = !state.showUnreadOnly; renderNotifications(); });
    const readAll = document.createElement("button"); readAll.type = "button"; readAll.textContent = "Read all"; readAll.disabled = unread === 0;
    readAll.addEventListener("click", readAllNotifications); actions.append(unreadFilter, readAll);
    const status = document.createElement("p"); status.className = "status";
    const list = document.createElement("div"); list.className = "notification-list";
    const visibleNotifications = state.showUnreadOnly ? state.notifications.filter((notification) => !notification?.read) : state.notifications;
    if (!visibleNotifications.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = state.showUnreadOnly ? "No unread notifications." : "No notifications yet."; list.append(empty); }
    else visibleNotifications.forEach((notification) => list.append(createNotification(notification)));
    screen.append(tabs, scanScheduleTags, summary, actions, status, list);
  }
  function appendAiInlineText(container, text) {
    const fragments = String(text || "").split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
    fragments.forEach((fragment) => {
      if (!fragment) return;
      if (fragment.startsWith("`") && fragment.endsWith("`")) {
        const code = document.createElement("code"); code.textContent = fragment.slice(1, -1); container.append(code);
      } else if (fragment.startsWith("**") && fragment.endsWith("**")) {
        const strong = document.createElement("strong"); strong.textContent = fragment.slice(2, -2); container.append(strong);
      } else container.append(document.createTextNode(fragment));
    });
  }
  function aiSectionTitle(line) {
    const title = String(line || "").trim().replace(/^#{1,6}\s*/, "").replace(/^\*\*|\*\*:?$/g, "").replace(/:$/, "").trim();
    return /^(kết luận|context|ngữ cảnh|bằng chứng|khuyến nghị|đề xuất|next steps?|recommendation)$/i.test(title) ? title : "";
  }
  function setAssistantResponseText(bubble, text) {
    bubble.className = "bubble assistant ai-response";
    bubble.replaceChildren();
    let list = null;
    String(text || "").split(/\r?\n/).forEach((rawLine) => {
      const line = rawLine.trim();
      if (!line) { list = null; return; }
      const section = aiSectionTitle(line);
      if (section) {
        const heading = document.createElement("div"); heading.className = "ai-response-section"; heading.textContent = section; bubble.append(heading); list = null; return;
      }
      const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
      if (bullet) {
        if (!list) { list = document.createElement("ul"); list.className = "ai-response-list"; bubble.append(list); }
        const item = document.createElement("li"); appendAiInlineText(item, bullet[1]); list.append(item); return;
      }
      const paragraph = document.createElement("p"); paragraph.className = "ai-response-copy"; appendAiInlineText(paragraph, line); bubble.append(paragraph); list = null;
    });
    if (!bubble.childNodes.length) bubble.textContent = "AI did not return a response.";
  }
  function chatIcon(name) {
    const paths = {
      bot: '<rect x="4" y="7" width="16" height="13" rx="4"/><path d="M12 3v4M9 12h.01M15 12h.01M9 16h6M1 12v3M23 12v3"/>',
      user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
      send: '<path d="m5 12 7-7 7 7M12 5v14"/>',
      home: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>',
      chat: '<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/><path d="M7 8h10M7 12h6"/>',
      notifications: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
      checking: '<path d="M9 4h6l1 2h3v15H5V6h3l1-2Z"/><path d="m9 14 2 2 4-5"/>',
      analytics: '<path d="M4 20h16"/><path d="M6 17V9M11 17V4M16 17v-6"/>',
      settings: '<path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 2 3h3l1-3 3-1 2-3-2-2 1-3-2-3-3 1-2-3Z"/><circle cx="11.5" cy="11.5" r="3"/>',
    };
    return `<svg class="chat-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.chat}</svg>`;
  }
  function createChatBubble(role, text, timestamp = null, animate = true, canonical = false) {
    const row = document.createElement("div"); row.className = `chat-message ${role}${animate ? " is-new" : ""}`;
    const avatar = document.createElement("span"); avatar.className = "message-avatar";
    avatar.innerHTML = chatIcon(role === "user" ? "user" : "bot"); avatar.setAttribute("aria-hidden", "true");
    const body = document.createElement("div"); body.className = "message-body";
    const bubble = document.createElement("div"); bubble.className = `bubble ${role}`;
    if (role === "assistant" && canonical) { bubble.className = "bubble assistant ai-response han-auto-report"; HanAutoView.renderComment(bubble, text); }
    else if (role === "assistant") setAssistantResponseText(bubble, text);
    else if (role === "thinking") {
      bubble.innerHTML = '<span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>';
      row.setAttribute("role", "status"); row.setAttribute("aria-label", "AI đang trả lời");
    }
    else bubble.textContent = text;
    body.append(bubble);
    if (role !== "thinking") {
      const time = document.createElement("time"); time.className = "message-time";
      const date = timestamp ? new Date(timestamp) : null;
      const valid = date && !Number.isNaN(date.getTime());
      time.textContent = `${role === "user" ? "You" : "Andrew AI"} · ${valid ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Earlier message"}`;
      if (valid) { time.dateTime = date.toISOString(); time.title = date.toLocaleString(); }
      body.append(time);
    }
    // Speaker button: reads this answer aloud on this device (speech-player.js).
    if (role === "assistant" && speechPlayer) body.append(speechPlayer.button(() => ({ text: bubble.innerText })));
    row.append(avatar, body);
    return row;
  }
  function defaultChatMessages() {
    return [];
  }
  function appendChatMessage(messages, role, text) {
    const message = { role, text, timestamp: Date.now() };
    state.chatMessages.push(message);
    const row = createChatBubble(role, text, message.timestamp);
    messages.append(row);
    return row;
  }
  function renderChatEmptyState(messages, input) {
    const empty = document.createElement("section"); empty.className = "chat-empty";
    empty.innerHTML = `<div class="chat-empty-art">${chatIcon("bot")}</div><h3>Welcome to Andrew AI</h3><p>Gỡ rối ticket, tìm câu trả lời.<br>Bắt đầu bằng một câu hỏi bên dưới.</p>`;
    const suggestions = document.createElement("div"); suggestions.className = "chat-suggestions";
    ["Kiểm tra ticket #123", "Tóm tắt vấn đề của ticket", "Gợi ý hướng xử lý"].forEach((prompt) => {
      const chip = document.createElement("button"); chip.type = "button"; chip.className = "chat-suggestion"; chip.textContent = prompt;
      chip.addEventListener("click", () => {
        input.value = prompt; input.dispatchEvent(new Event("input")); input.focus();
        if (prompt.includes("#123")) input.setSelectionRange(prompt.indexOf("#123"), prompt.length);
      });
      suggestions.append(chip);
    });
    empty.append(suggestions); messages.append(empty);
  }
  function conversationHoverText(conversation) {
    const ticket = conversation?.selectedTicket;
    const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
    const firstQuestion = messages.find((message) => message?.role === "user")?.text;
    const last = messages.at(-1);
    const updated = conversation?.updatedAt ? new Date(conversation.updatedAt) : null;
    return [
      `Conversation: ${conversationTitle(conversation)}`,
      ticket?.ticketId || ticket?.id ? `Ticket: ${ticket.ticketId || ticket.id} · ${ticket.subject || "No subject"}` : "",
      firstQuestion ? `Câu hỏi đầu: ${firstQuestion}` : "",
      last?.text ? `Tin nhắn cuối (${last.role === "user" ? "bạn" : "AI"}): ${last.text}` : "",
      `${messages.length} tin nhắn${updated && !Number.isNaN(updated.getTime()) ? ` · cập nhật ${updated.toLocaleString("vi-VN")}` : ""}`,
    ].filter(Boolean).join("\n\n");
  }
  function showConversationTooltip(event, conversation) {
    ticketTooltip.textContent = conversationHoverText(conversation);
    ticketTooltip.classList.add("conversation");
    ticketTooltip.hidden = false;
    positionTicketTooltip(event);
  }
  function conversationTitle(conversation) {
    const ticket = conversation?.selectedTicket;
    if (ticket?.ticketId || ticket?.id) return `${ticket.ticketId || ticket.id} · ${ticket.subject || "Ticket review"}`;
    const firstQuestion = (conversation?.messages || []).find((message) => message?.role === "user")?.text;
    return firstQuestion || "New AI conversation";
  }
  async function loadSavedConversations() {
    const { [CHAT_HISTORY_STORAGE_KEY]: stored = [] } = await chrome.storage.local.get({ [CHAT_HISTORY_STORAGE_KEY]: [] });
    return (Array.isArray(stored) ? stored : []).filter((conversation) =>
      conversation && typeof conversation.chatId === "string" && Array.isArray(conversation.messages),
    );
  }
  async function saveActiveConversation() {
    if (!state.chatMessages.some((message) => message?.role === "user")) return;
    const saved = await loadSavedConversations();
    const previous = saved.find((conversation) => conversation.chatId === state.chatId);
    const messages = state.chatMessages.slice(-MAX_SAVED_MESSAGES_PER_CONVERSATION);
    // Opening an automatic review without typing anything must not reorder the history.
    if (AutomaticHistory.isAutomatic(previous) && messages.every((message) => message?.auto)) return;
    const conversation = {
      chatId: state.chatId,
      selectedTicket: state.selectedTicket || null,
      messages,
      createdAt: previous?.createdAt || Date.now(),
      updatedAt: Date.now(),
      ...AutomaticHistory.originFields(previous),
    };
    const next = AutomaticHistory.cap([conversation, ...saved.filter((item) => item.chatId !== state.chatId)]);
    state.savedConversations = next;
    await chrome.storage.local.set({ [CHAT_HISTORY_STORAGE_KEY]: next });
  }
  async function startNewConversation() {
    await saveActiveConversation();
    state.chatId = createChatId();
    state.selectedTicket = null;
    state.chatMessages = defaultChatMessages();
    state.chatHistoryOpen = false;
    showScreen("chat");
  }
  async function openChatHistory() {
    await saveActiveConversation();
    // Pull the latest automatic reviews first; a stopped local service only means no new entries.
    try { await request({ type: "sync-automatic-history" }); } catch {}
    state.savedConversations = await loadSavedConversations();
    state.chatHistoryOpen = true;
    renderHeader(); renderNavigation(); renderChat();
  }
  function closeChatHistory() {
    state.chatHistoryOpen = false;
    renderHeader(); renderNavigation(); renderChat();
  }
  function renderChatHistory() {
    const list = document.createElement("section"); list.className = "chat-history-list";
    const title = document.createElement("h3"); title.className = "chat-history-title"; title.textContent = "Conversation history";
    const copy = document.createElement("p"); copy.className = "chat-history-copy"; copy.textContent = "Select a previous conversation to continue it.";
    list.append(title, copy);
    if (!state.savedConversations.length) {
      const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "No saved conversations yet."; list.append(empty);
    } else {
      state.savedConversations.forEach((conversation) => {
        const row = document.createElement("div"); row.className = "chat-history-row";
        row.addEventListener("pointerenter", (event) => showConversationTooltip(event, conversation));
        row.addEventListener("pointermove", positionTicketTooltip);
        row.addEventListener("pointerleave", hideTicketTooltip);
        const item = document.createElement("button"); item.className = "chat-history-item"; item.type = "button";
        const heading = document.createElement("strong"); heading.textContent = conversationTitle(conversation);
        const preview = document.createElement("span"); preview.textContent = (conversation.messages || []).at(-1)?.text || "Open conversation";
        item.append(heading, preview);
        const ticketRef = conversationTicketRef(conversation);
        if (ticketRef) { const ticketLine = document.createElement("span"); ticketLine.className = "chat-history-ticket"; ticketLine.textContent = `Ticket ${ticketRef}`; item.append(ticketLine); }
        if (AutomaticHistory.isAutomatic(conversation)) {
          const badge = document.createElement("span"); badge.className = `chat-history-auto ${conversation.automatic?.status || ""}`; badge.textContent = AutomaticHistory.statusLabel(conversation); item.append(badge);
        }
        item.addEventListener("click", () => {
          state.chatId = conversation.chatId;
          state.selectedTicket = conversation.selectedTicket || null;
          state.chatMessages = conversation.messages.slice(-MAX_SAVED_MESSAGES_PER_CONVERSATION);
          state.chatHistoryOpen = false;
          renderHeader(); renderNavigation(); renderChat();
        });
        // One button: a conversation attached to a ticket opens every trace of that ticket
        // (automatic review + all chats); a free conversation opens only its own chat traces.
        const tracing = document.createElement("button"); tracing.className = `chat-history-trace${ticketRef ? " ticket" : ""}`; tracing.type = "button"; tracing.textContent = "Tracing";
        tracing.title = ticketRef ? `Mở toàn bộ tracing của ticket ${ticketRef}` : "Mở tracing của conversation này";
        tracing.addEventListener("click", (event) => {
          event.stopPropagation();
          window.open(historyTraceUrl(conversation), "_blank", "noopener,noreferrer");
        });
        row.append(item, tracing);
        list.append(row);
      });
    }
    screen.append(list);
  }
  function followDate(value) {
    const date = new Date(typeof value === "number" ? value : String(value || ""));
    return Number.isNaN(date.getTime()) ? "Chưa có" : date.toLocaleString();
  }
  async function openFollowDev(ticket) {
    state.chatSection = "follow"; state.followDevDetail = { ticket }; state.followDevLoading = true; state.followDevMail = "";
    showScreen("chat");
    try {
      state.followDevDetail = await request({ type: "get-dev-follow-detail", ticket });
    } catch (error) { state.followDevDetail = { ticket, error: error.message || String(error) }; }
    finally { state.followDevLoading = false; if (state.screen === "chat" && state.chatSection === "follow") renderChat(); }
  }
  function renderFollowDev() {
    const detail = state.followDevDetail || {};
    const ticket = detail.ticket || {};
    const panel = document.createElement("section"); panel.className = "follow-dev-panel";
    if (state.followDevLoading) { panel.textContent = "Đang kiểm tra ticket và Slack thread…"; screen.append(panel); return; }
    if (detail.error) { panel.textContent = `Không thể tải follow dev: ${detail.error}`; screen.append(panel); return; }
    const controls = document.createElement("div"); controls.className = "follow-dev-controls";
    const ticketButton = document.createElement("button"); ticketButton.className = "active"; ticketButton.type = "button"; ticketButton.textContent = "Ticket"; ticketButton.addEventListener("click", () => window.open(ticketUrl(ticket), "_blank", "noopener,noreferrer"));
    const threadButton = document.createElement("button"); threadButton.type = "button"; threadButton.textContent = "Thread"; threadButton.disabled = !ticket.slackLink; threadButton.addEventListener("click", () => window.open(ticket.slackLink, "_blank", "noopener,noreferrer"));
    const mailButton = document.createElement("button"); mailButton.type = "button"; mailButton.textContent = "Mail";
    mailButton.addEventListener("click", async () => {
      mailButton.disabled = true; mailButton.textContent = "Đang soạn…";
      try { const result = await request({ type: "generate-dev-follow-mail", ticket, slack: detail.slack }); state.followDevMail = result.mail || "TS Elite 2 chưa tạo được mail."; renderChat(); }
      catch (error) { state.followDevMail = `Không thể tạo mail: ${error.message}`; renderChat(); }
    });
    controls.append(ticketButton, threadButton, mailButton); panel.append(controls);
    const followBlocked = /\b(blocked|block)\b/i.test(String(detail.slack?.lastUpdatedText || ""));
    const followStatus = detail.slack?.done ? "Done" : followBlocked ? "Blocked" : "Chưa done";
    const rows = [
      ["Title ticket", ticket.subject || "—"],
      ["Description", ticket.description || "—"],
      ["Member", ticketMemberSummary(ticket)],
      ["Ngày báo dev", followDate(detail.slack?.reportedAt)],
      ["Dev Assigned", (detail.slack?.assignees || []).join(", ") || "Chưa xác định"],
      ["Status", followStatus],
      ["Notion hoặc MR", ""],
      ["Tình trạng báo khách", detail.customerNotified ? `Đã báo khách (${followDate(detail.customerUpdateAt)})` : "Chưa thấy xác nhận đã báo khách"],
      ["Last Follow at", followDate(detail.lastFollowAt)],
      ["Last Updated", detail.slack?.lastUpdatedText ? `${followDate(detail.slack.lastUpdatedAt)} · ${detail.slack.lastUpdatedText}` : "Chưa có update"],
    ];
    const cardForLabel = (label) => label === "Title ticket" || label === "Description" ? "overview" : label === "Member" || label === "Ngày báo dev" || label === "Dev Assigned" ? "assignment" : "status";
    const cards = new Map();
    const cardTitles = { overview: "Ticket overview", assignment: "Phân công", status: "Theo dõi" };
    rows.forEach(([label, value]) => {
      const cardKey = cardForLabel(label);
      let card = cards.get(cardKey);
      if (!card) {
        card = document.createElement("section"); card.className = "follow-dev-card";
        const heading = document.createElement("h3"); heading.textContent = cardTitles[cardKey]; card.append(heading);
        cards.set(cardKey, card); panel.append(card);
      }
      const row = document.createElement("div"); row.className = "follow-dev-row";
      const name = document.createElement("strong"); name.textContent = `${label}: `;
      const content = document.createElement("span"); content.textContent = value;
      if (label === "Description") content.className = "follow-dev-description";
      if (label === "Status") content.classList.add(detail.slack?.done ? "status-done" : followBlocked ? "status-blocked" : "status-pending");
      if (label === "Notion hoặc MR") {
        const links = detail.slack?.workLinks || [];
        if (!links.length) content.textContent = "Không có";
        else { content.textContent = ""; links.forEach((link, index) => { const item = document.createElement("a"); item.href = link; item.target = "_blank"; item.rel = "noreferrer"; item.textContent = index ? " · Link" : "Link"; content.append(item); }); }
      }
      row.append(name, content); card.append(row);
    });
    if (state.followDevMail) { const mail = document.createElement("pre"); mail.className = "follow-dev-mail"; mail.textContent = state.followDevMail; panel.append(mail); }
    screen.append(panel);
  }
  // --- news ---
  // Daily bulletin (technology, new AI models, Claude) built by the TS Management web; the shared view (news-view.js)
  // reads it through the background, which also keeps the latest bulletin in chrome.storage for offline use.
  let newsView = null; let newsButton = null;
  const newsStorage = { get: async (key) => (await chrome.storage.local.get({ [key]: null }))[key], set: (key, value) => chrome.storage.local.set({ [key]: value }) };
  async function refreshNewsBadge() {
    if (!newsButton || !globalThis.NewsView) return;
    try {
      const result = await request({ type: "news", path: "today?meta=1" });
      const read = await newsStorage.get(globalThis.NewsView.READ_KEY);
      newsButton.setUnread(globalThis.NewsView.unread(result.data?.meta, read));
    } catch { newsButton.setUnread(false); }
  }
  function renderNews() {
    screen.className = "screen"; screen.replaceChildren();
    newsView?.destroy(); newsView = null;
    if (!globalThis.NewsView) { const missing = document.createElement("p"); missing.className = "empty"; missing.textContent = "Chưa nạp được mục NEWS; tải lại extension."; screen.append(missing); return; }
    chrome.storage.local.get({ newsCache: null }).then(({ newsCache }) => {
      if (state.screen !== "news") return;
      newsView = globalThis.NewsView.mount(screen, {
        api: async (path) => (await request({ type: "news", path: path.replace(/^\//, "") })).data,
        refresh: async () => (await request({ type: "news-refresh" })).data,
        storage: newsStorage, cache: newsCache,
      });
    });
  }
  // --- analytics ---
  // Accuracy of the AI checks (Đại tá's reactions on the posted review comments) and the Train AI feedback form.
  // The shared view (analytics-view.js) talks to the local tracing web through the background.
  let analyticsView = null;
  function renderAnalytics() {
    screen.className = "screen"; screen.replaceChildren();
    analyticsView?.destroy(); analyticsView = null;
    if (!globalThis.AnalyticsView) { const missing = document.createElement("p"); missing.className = "empty"; missing.textContent = "Chưa nạp được mục Analytics; tải lại extension."; screen.append(missing); return; }
    analyticsView = globalThis.AnalyticsView.mount(screen, {
      api: async (path, { method = "GET", body } = {}) => (await request({ type: "analytics", path, method, body })).data,
      openUrl: (url) => window.open(url, "_blank", "noopener,noreferrer"),
    });
  }
  // --- checking ticket ---
  // Hachimi's check-ticket runs, read by the background from the local tracing web. Watching is read-only;
  // questions typed here go through the normal chat of that ticket's conversation.
  const CHAT_SECTIONS = [["chat", "Chat bot"], ["follow", "Follow dev"]];
  let stopHanAuto = null;
  let checkingRun = 0; // bumped on every render of this page, which stops the polling of the view it replaced
  const checkingNode = (tag, className = "", text = null) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== null) node.textContent = text; return node; };
  async function pollChecking(token, node, work, delay) {
    while (token === checkingRun && node.isConnected) {
      if (document.visibilityState === "visible") await work();
      await new Promise((done) => setTimeout(done, delay()));
    }
  }
  const checkingTraceUrl = (run) => !run.ticket ? TRACE_WEB_URL : `${ticketTraceUrl(run.ticket)}${run.source === "automatic" ? `?open=automatic:${encodeURIComponent(run.externalId)}` : ""}`;
  const checkingPill = (run) => checkingNode("span", `checking-pill ${run.status}`, run.statusLabel);
  const checkingTime = (value) => { const date = new Date(value || ""); return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("vi-VN"); };
  async function hanAutoRequest(path, { method = "GET", body, signal } = {}) {
    const requestId = crypto.randomUUID();
    const abort = () => { void request({ type: "han-auto-cancel", requestId }).catch(() => {}); };
    if (signal?.aborted) throw new Error("Đã hủy đọc ticket.");
    signal?.addEventListener("abort", abort, { once: true });
    try { return await request({ type: "han-auto-request", requestId, path, method, ...(body === undefined ? {} : { body }) }); }
    finally { signal?.removeEventListener("abort", abort); }
  }
  async function openCheckingRun(run) {
    await saveActiveConversation();
    // Pull the latest automatic reviews first, so an automatic run continues its History conversation.
    try { await request({ type: "sync-automatic-history" }); } catch {}
    state.savedConversations = await loadSavedConversations();
    const saved = state.savedConversations.find((conversation) => conversation.chatId === run.chatId) || null;
    state.chatId = run.chatId; state.selectedTicket = saved?.selectedTicket || run.selectedTicket || null;
    state.chatMessages = (saved?.messages || []).slice(-MAX_SAVED_MESSAGES_PER_CONVERSATION); state.chatHistoryOpen = false;
    state.checking.open = run;
    if (state.screen === "checking") renderChecking();
  }
  function renderChecking() {
    checkingRun += 1;
    screen.className = "screen chat-screen"; screen.replaceChildren();
    if (stopHanAuto) { stopHanAuto(); stopHanAuto = null; }
    screen.append(HanAutoView.tabs(state.checking.tab || "cmt", tab => { state.checking.tab = tab; renderHeader(); renderChecking(); }));
    if (state.checking.tab === "auto") {
      const panel = checkingNode("section", "han-auto-panel"); screen.append(panel);
      stopHanAuto = HanAutoView.mountTickets(panel, { request: hanAutoRequest });
      return;
    }
    // The chat tab may have moved on to another conversation since this run was opened.
    if (state.checking.open && state.checking.open.chatId !== state.chatId) state.checking.open = null;
    if (state.checking.open) { renderCheckingRun(state.checking.open); return; }
    const list = checkingNode("section", "chat-history-list checking-list"); screen.append(list);
    let painted = null;
    const paint = () => {
      const signature = JSON.stringify([state.checking.sessions, state.checking.error, state.checking.loaded]);
      if (signature === painted) return; painted = signature;
      list.replaceChildren(checkingNode("p", "chat-history-copy", "Các lượt Hachimi check ticket. Mở một lượt để xem quá trình check và hỏi thêm Hachimi về ticket đó."));
      if (state.checking.error) list.append(checkingNode("p", "empty", state.checking.error));
      if (!state.checking.sessions.length && !state.checking.error) list.append(checkingNode("p", "empty", state.checking.loaded ? "Chưa có lượt check ticket nào." : "Đang tải các lượt check…"));
      state.checking.sessions.forEach((run) => {
        const item = checkingNode("button", "chat-history-item checking-item"); item.type = "button";
        const meta = checkingNode("span", "checking-meta"); meta.append(checkingPill(run), document.createTextNode([run.sourceLabel, run.category, checkingTime(run.startedAt)].filter(Boolean).join(" · ")));
        item.append(checkingNode("strong", "", `${run.ticket || "Không có mã ticket"} · ${run.subject || "Check ticket"}`), checkingNode("span", "", run.lastText || "Chưa có bước nào."), meta);
        item.addEventListener("click", () => { item.disabled = true; void openCheckingRun(run); });
        list.append(item);
      });
    };
    paint();
    void pollChecking(checkingRun, list, async () => {
      try { state.checking.sessions = (await request({ type: "checking-sessions" })).sessions || []; state.checking.error = ""; }
      catch (error) { state.checking.error = `Không tải được các lượt check: ${error.message}`; }
      state.checking.loaded = true; paint();
    }, () => 5_000);
  }
  function createCheckingStep(event) {
    const row = checkingNode("div", `checking-step kind-${event.kind}`); const body = checkingNode("div", "checking-step-body");
    const head = checkingNode("div", "checking-step-head"); head.append(checkingNode("strong", "", event.label));
    if (event.phase) head.append(checkingNode("span", "checking-step-phase", event.phase));
    const at = new Date(event.at); head.append(checkingNode("time", "", Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString("vi-VN")));
    body.append(head);
    if (event.kind === "result") { const report = checkingNode("div"); setAssistantResponseText(report, event.text); report.className = "checking-report ai-response"; body.append(report); }
    else if (event.text) {
      const text = checkingNode("p", "checking-step-text", event.text); body.append(text);
      if (event.text.length > 600) {
        text.classList.add("clamped");
        const more = checkingNode("button", "checking-step-more", "Xem thêm"); more.type = "button";
        more.addEventListener("click", () => { more.textContent = text.classList.toggle("clamped") ? "Xem thêm" : "Thu gọn"; });
        body.append(more);
      }
    }
    row.append(checkingNode("span", "checking-step-dot"), body); return row;
  }
  function renderCheckingRun(opened) {
    let run = opened; let cursor = -1; let waitingRow = null;
    const bar = checkingNode("div", "chat-context checking-bar");
    const back = checkingNode("button", "checking-back", "‹ Danh sách"); back.type = "button"; back.addEventListener("click", () => { state.checking.open = null; renderChecking(); });
    const pillSlot = checkingNode("span", "checking-pill-slot"); pillSlot.append(checkingPill(run));
    const ticket = checkingNode("button", "checking-link", "Ticket"); ticket.type = "button"; ticket.disabled = !run.ticket;
    ticket.addEventListener("click", () => window.open(`${HELP_DESK_URL}/t/${encodeURIComponent(run.ticket)}`, "_blank", "noopener,noreferrer"));
    const tracing = checkingNode("button", "checking-link", "Tracing"); tracing.type = "button"; tracing.addEventListener("click", () => window.open(checkingTraceUrl(run), "_blank", "noopener,noreferrer"));
    bar.append(back, checkingNode("span", "checking-title", `${run.ticket || run.sourceLabel} · ${run.subject || "Check ticket"}`), pillSlot, ticket, tracing);
    const messages = checkingNode("div", "chat-messages"); messages.setAttribute("role", "log"); messages.setAttribute("aria-label", "Quá trình check ticket và hội thoại");
    const steps = checkingNode("section", "checking-steps"); const status = checkingNode("p", "checking-steps-status", "Đang tải quá trình check…");
    steps.append(checkingNode("h4", "", "Quá trình Hachimi check ticket"), status);
    messages.append(steps, checkingNode("p", "checking-chat-hint", "Hỏi thêm Hachimi về ticket này ở ô bên dưới. Việc hỏi không chạy lại lượt check và không đăng comment."));
    // The review's own messages are already shown as steps; only the questions asked afterwards are chat bubbles.
    state.chatMessages.filter((message) => !message.auto).forEach((message) => messages.append(createChatBubble(message.role, message.text, message.timestamp, false)));
    const { form } = createChatForm(messages, "Hỏi Hachimi về lượt check này…");
    screen.append(bar, messages, form);
    void pollChecking(checkingRun, messages, async () => {
      try {
        const data = await request({ type: "checking-events", id: run.id, after: cursor });
        const follow = cursor === -1 || messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
        (data.events || []).forEach((event) => {
          cursor = Math.max(cursor, event.seq);
          const row = createCheckingStep(event);
          // Heartbeats while waiting are one line that keeps its latest time.
          if (event.kind === "waiting" && waitingRow) waitingRow.replaceWith(row); else steps.append(row);
          waitingRow = event.kind === "waiting" ? row : null;
        });
        if (data.session) { run = data.session; state.checking.open = run; pillSlot.replaceChildren(checkingPill(run)); }
        status.textContent = cursor === -1 ? "Chưa có bước nào được ghi nhận." : run.running ? "Hachimi đang check, các bước mới tự hiện ở đây." : "";
        status.className = "checking-steps-status"; status.hidden = !status.textContent;
        if ((data.events || []).length && follow) messages.scrollTop = messages.scrollHeight;
      } catch (error) { status.textContent = `Không tải được quá trình check: ${error.message}`; status.className = "checking-steps-status error"; status.hidden = false; }
    }, () => run.running ? 2_500 : 15_000);
  }
  function createChatForm(messages, placeholder) {
    const form = document.createElement("form"); form.className = "chat-form";
    const input = document.createElement("textarea"); input.className = "chat-input"; input.rows = 1; input.placeholder = placeholder;
    input.setAttribute("aria-label", "Message Andrew AI");
    input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 112)}px`; });
    const send = document.createElement("button"); send.className = "send"; send.type = "submit"; send.innerHTML = chatIcon("send"); send.setAttribute("aria-label", "Send message"); send.title = "Send message";
    input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } });
    form.addEventListener("submit", async (event) => { event.preventDefault(); const text = input.value.trim(); if (!text || send.disabled) return; input.value = ""; input.style.height = "auto"; await sendChat(text, messages, send); });
    form.append(input, send);
    return { form, input };
  }
  function renderChat() {
    const previousTabs = screen.querySelector(".chat-tabs");
    screen.className = `screen chat-screen${state.chatSection === "follow" ? " follow-dev-screen" : ""}`; screen.replaceChildren();
    const tabs = previousTabs || document.createElement("div"); tabs.className = "chat-tabs";
    tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Chat sections");
    if (!previousTabs) CHAT_SECTIONS.forEach(([key, label], index) => {
      const tab = document.createElement("button"); tab.type = "button"; tab.textContent = label; tab.className = `chat-tab${state.chatSection === key ? " active" : ""}`;
      tab.dataset.section = key; tab.setAttribute("role", "tab");
      tab.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const last = CHAT_SECTIONS.length - 1;
        const next = event.key === "Home" ? 0 : event.key === "End" ? last : event.key === "ArrowRight" ? (index === last ? 0 : index + 1) : (index === 0 ? last : index - 1);
        state.chatSection = CHAT_SECTIONS[next][0];
        renderChat(); tabs.querySelector(".active").focus();
      });
      tab.addEventListener("click", () => { state.chatSection = key; renderChat(); }); tabs.append(tab);
    });
    screen.append(tabs);
    // Flush the retained underline's starting position before moving it.
    if (previousTabs) void tabs.offsetWidth;
    tabs.dataset.active = state.chatSection;
    tabs.querySelectorAll("button").forEach((tab) => {
      const active = tab.dataset.section === state.chatSection;
      tab.classList.toggle("active", active); tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1;
    });
    if (state.chatSection === "follow") { renderFollowDev(); return; }
    if (state.chatHistoryOpen) { renderChatHistory(); return; }
    if (state.selectedTicket) {
      const context = document.createElement("div"); context.className = "chat-context";
      const label = document.createElement("span"); label.textContent = `Checking: ${state.selectedTicket.ticketId || state.selectedTicket.id} · ${state.selectedTicket.subject || "No subject"}`;
      const clear = document.createElement("button"); clear.className = "clear-context"; clear.type = "button"; clear.title = "Clear selected ticket"; clear.textContent = "×";
      clear.addEventListener("click", () => { state.selectedTicket = null; renderChat(); }); context.append(label, clear); screen.append(context);
    }
    const messages = document.createElement("div"); messages.className = "chat-messages";
    messages.setAttribute("role", "log"); messages.setAttribute("aria-label", "Conversation"); messages.setAttribute("aria-live", "polite");
    // Older saved conversations may contain the former synthetic welcome bubble.
    const visibleMessages = state.chatMessages.filter((message) => !(message.role === "assistant" && message.text === "Welcome to Andrew AI" && !message.timestamp));
    visibleMessages.forEach((message) => messages.append(createChatBubble(message.role, message.text, message.timestamp, false, message.canonical === true)));
    const { form, input } = createChatForm(messages, state.selectedTicket ? "Ask AI to check this ticket…" : "Ask AI about a ticket…");
    if (!visibleMessages.length) renderChatEmptyState(messages, input);
    screen.append(messages, form); messages.scrollTop = messages.scrollHeight;
  }
  // "đọc" / "đọc <số>" / "dừng": read aloud instead of asking the AI. The audio comes from the TS Management web (Piper).
  const speechPlayer = globalThis.SpeechPlayer ? globalThis.SpeechPlayer.create({
    prepare: async (payload) => (await request({ type: "speech-prepare", ...payload })).data,
    audio: async (id, index) => { const binary = atob((await request({ type: "speech-audio", id, index })).audio); const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i); return bytes.buffer; },
  }) : null;
  async function runSpeechCommand(command, text, messages, send) {
    send.disabled = true; messages.querySelector(".chat-empty")?.remove();
    const lastAnswer = () => [...state.chatMessages].reverse().find((message) => message.role === "assistant" && !message.speechNote && message.text) || null;
    const answer = lastAnswer();
    appendChatMessage(messages, "user", text);
    try {
      await speechPlayer.handleCommand(command, {
        lastAnswer: () => answer,
        say: (role, content, extra = {}) => { appendChatMessage(messages, role, content); Object.assign(state.chatMessages[state.chatMessages.length - 1], extra); messages.scrollTop = messages.scrollHeight; },
      });
    } finally { try { await saveActiveConversation(); } finally { send.disabled = false; } }
  }
  // MCP_V2_INTENT_BEGIN
  function ticketReviewRequest(text, ticket) {
    const command = String(text || "").trim().replace(/\s+/g, " ");
    // Only complete investigation commands. A selected ticket or previous review
    // alone never promotes a question/mail into another investigation.
    const match = command.match(/^(check ticket|check tiếp|check tiep|check lại|check lai|recheck)(?:\s+(.+))?$/i);
    if (!match || command.endsWith("?")) return {};
    const followUp = match[1].toLowerCase() !== "check ticket";
    let reference = String(match[2] || (followUp ? ticket?.ticketId || "" : "")).trim();
    if (followUp) reference = reference.replace(/^ticket\s+/i, "");
    const url = reference.match(/^https:\/\/helpdesk\.avada\.net\/(?:t|tickets)\/([A-Za-z0-9_-]+)\/?$/i);
    if (url) reference = url[1];
    if (!/^[A-Z][A-Z0-9]{1,12}-\d{6}-[A-Za-z0-9]+$/.test(reference)) {
      throw new Error("Hãy chọn ticket hoặc dùng Check ticket <mã ticket Helpdesk hợp lệ>.");
    }
    return { intent: "ticket-review", reviewFollowUp: followUp, ticket: { ticketId: reference } };
  }
  // MCP_V2_INTENT_END
  async function sendChat(text, messages, send) {
    const speechCommand = speechPlayer ? globalThis.SpeechPlayer.parseCommand(text) : null;
    if (speechCommand) return runSpeechCommand(speechCommand, text, messages, send);
    send.disabled = true; messages.querySelector(".chat-empty")?.remove(); appendChatMessage(messages, "user", text);
    const thinking = createChatBubble("thinking", "AI đang kiểm tra…"); messages.append(thinking); messages.scrollTop = messages.scrollHeight;
    // The background re-fetches this ticket plus its complete action/comment
    // history just before it calls TS Elite AI. Passing the ticket object here
    // gives it a stable ID without exposing the Helpdesk key to the AI service.
    try {
      const result = await request({ type: "ai-chat", message: text, chatId: state.chatId, ticket: state.selectedTicket, ...ticketReviewRequest(text, state.selectedTicket) });
      if (result.answer) {
        thinking.remove(); appendChatMessage(messages, "assistant", result.answer); messages.scrollTop = messages.scrollHeight;
      } else await streamAiResponse(result.jobId, messages, thinking);
    }
    catch (error) {
      thinking.remove(); const response = error.message === "AI_LOGIN_REQUIRED" ? "Hãy kết nối TS Elite 2 trong Settings trước khi chat." : error.message;
      appendChatMessage(messages, "assistant", response); messages.scrollTop = messages.scrollHeight;
    } finally { try { await saveActiveConversation(); } finally { send.disabled = false; } }
  }
  function streamAiResponse(jobId, messages, thinking) {
    return new Promise((resolve) => {
      const port = chrome.runtime.connect({ name: `ai-stream:${jobId}` }); let text = ""; let response = null; let finished = false;
      const timestamp = Date.now();
      const finish = () => { if (finished) return; finished = true; thinking.remove(); if (text) state.chatMessages.push({ role: "assistant", text, timestamp }); try { port.disconnect(); } catch {} resolve(); };
      port.onMessage.addListener((event) => {
        if (event.type === "text") { thinking.remove(); if (!response) { response = createChatBubble("assistant", "", timestamp); messages.append(response); } text += event.content || ""; setAssistantResponseText(response.querySelector(".bubble"), text); messages.scrollTop = messages.scrollHeight; }
        else if (event.type === "done") { if (!text && event.result) { text = event.result; messages.append(createChatBubble("assistant", text, timestamp)); } finish(); }
        else if (event.type === "error") { thinking.remove(); const errorText = event.message || "AI could not complete this request."; appendChatMessage(messages, "assistant", errorText); finish(); }
        else if (event.type === "stream_end") finish();
      });
      port.onDisconnect.addListener(() => { if (!finished && !text) finish(); });
    });
  }
  // MCP_V2_SETTINGS_CARD_BEGIN
  // Kept identical in both UI entrypoints; the test checks parity.
  function createMcpV2SettingsCard({ read, write }) {
    const card = document.createElement("section"); card.className = "setting-card mcp-v2-settings";
    const title = document.createElement("h4"); title.textContent = "chiến dịch MCP V2";
    const copy = document.createElement("p");
    copy.textContent = "OFF: giữ luồng check ticket hiện tại. ON: dùng AI điều tra qua MCP V2 theo các khả năng đã xác minh bên dưới. Cấu hình dùng chung cho web và extension.";
    const label = document.createElement("label"); label.className = "setting-switch"; label.htmlFor = "mcp-v2-enabled";
    const name = document.createElement("span"); name.textContent = "Bật chiến dịch MCP V2";
    const input = document.createElement("input"); input.id = "mcp-v2-enabled"; input.type = "checkbox";
    input.setAttribute("role", "switch"); input.setAttribute("aria-label", name.textContent);
    input.setAttribute("aria-describedby", "mcp-v2-selected mcp-v2-effective mcp-v2-remote-capability mcp-v2-browser-capability mcp-v2-status");
    input.disabled = true;
    const track = document.createElement("span"); track.className = "switch-track"; track.setAttribute("aria-hidden", "true");
    label.append(name, input, track);
    const selected = document.createElement("p"); selected.id = "mcp-v2-selected"; selected.className = "settings-status";
    const effective = document.createElement("p"); effective.id = "mcp-v2-effective"; effective.className = "settings-status";
    const readiness = document.createElement("p"); readiness.className = "settings-status";
    const remoteCapability = document.createElement("p"); remoteCapability.id = "mcp-v2-remote-capability";
    const browserCapability = document.createElement("p"); browserCapability.id = "mcp-v2-browser-capability";
    const status = document.createElement("p"); status.id = "mcp-v2-status"; status.className = "settings-status";
    status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "Đọc lại cấu hình";
    retry.className = "secondary";
    card.append(title, copy, label, selected, effective, remoteCapability, browserCapability, readiness, status, retry);
    // Unknown is different from the server's default OFF. Never write defaults on mount.
    let snapshot = null, sequence = 0, disposed = false, saving = false, refreshing = false, pendingChoice = false;
    function normalize(value) {
      if (!value || typeof value.enabled !== "boolean" || typeof value.available !== "boolean" ||
          !["current", "mcp-v2"].includes(value.effectiveEngine) ||
          !Number.isSafeInteger(value.revision) || value.revision < 0) {
        throw new Error("Backend trả cấu hình MCP V2 không hợp lệ.");
      }
      const capability = key => typeof value.capabilities?.[key]?.available === "boolean"
        ? value.capabilities[key].available : null;
      return { enabled: value.enabled, available: value.available, effectiveEngine: value.effectiveEngine,
        reason: typeof value.reason === "string" ? value.reason : "", revision: value.revision,
        capabilities: { remoteMcp: capability("remoteMcp"), browser: capability("browser"), cssPreview: capability("cssPreview") } };
    }
    function paint(message = "", error = false, verified = true) {
      input.checked = saving ? pendingChoice : snapshot?.enabled === true;
      input.disabled = !snapshot || !verified || saving || refreshing;
      retry.disabled = saving || refreshing;
      card.setAttribute("aria-busy", String(saving || refreshing));
      selected.textContent = snapshot
        ? `Đã chọn: ${snapshot.enabled ? "ON — MCP V2" : "OFF — luồng hiện tại"}${verified ? "" : " (lần đọc gần nhất)"}.`
        : "Đã chọn: chưa đọc được cấu hình chung.";
      if (!verified || !snapshot) {
        effective.textContent = "Luồng có hiệu lực: chưa xác minh.";
      } else if (snapshot.enabled && !snapshot.available) {
        effective.textContent = `MCP V2 đang bị chặn: ${snapshot.reason || "chưa sẵn sàng"}. Không tự chuyển sang luồng cũ.`;
      } else {
        effective.textContent = snapshot.effectiveEngine
          ? `Luồng có hiệu lực cho lượt check mới: ${snapshot.effectiveEngine === "mcp-v2" ? "MCP V2" : "luồng hiện tại"}.`
          : "Luồng có hiệu lực: chưa được backend xác nhận.";
      }
      effective.className = `settings-status${snapshot?.enabled && !snapshot.available ? " error" : ""}`;
      readiness.textContent = verified && snapshot && !snapshot.enabled && !snapshot.available
        ? `MCP V2 chưa sẵn sàng: ${snapshot.reason || "backend chưa xác nhận khả năng sử dụng"}.` : "";
      readiness.hidden = !readiness.textContent;
      // Capability readiness is independent of the selected engine and top-level available.
      // Missing fields or a failed read never inherit an earlier ready state.
      const capabilities = verified ? snapshot?.capabilities : null;
      const remoteReady = capabilities?.remoteMcp;
      const browserReady = typeof capabilities?.browser === "boolean" && typeof capabilities?.cssPreview === "boolean"
        ? capabilities.browser && capabilities.cssPreview : null;
      const capabilityText = value => value === true ? "sẵn sàng" : value === false ? "chưa sẵn sàng" : "chưa xác minh";
      remoteCapability.textContent = `MCP đọc dữ liệu: ${capabilityText(remoteReady)}`;
      browserCapability.textContent = `Trình duyệt/CSS: ${capabilityText(browserReady)}`;
      remoteCapability.className = `settings-status${remoteReady === true ? " ok" : ""}`;
      browserCapability.className = `settings-status${browserReady === true ? " ok" : ""}`;
      status.textContent = message;
      status.className = `settings-status${error ? " error" : ""}`;
    }
    async function refresh() {
      if (disposed || saving) return;
      const request = ++sequence;
      refreshing = true; paint("Đang đọc cấu hình chung…", false, false);
      try {
        const next = normalize(await read());
        if (disposed || request !== sequence) return;
        snapshot = next; refreshing = false; paint("Đã đọc cấu hình chung.");
      } catch (error) {
        if (disposed || request !== sequence) return;
        refreshing = false;
        paint(`Chưa đọc được cấu hình chung: ${error.message}`, true, false);
      }
    }
    input.addEventListener("change", async () => {
      if (disposed || saving || refreshing || !snapshot) return;
      const desired = input.checked, revision = snapshot.revision;
      const restoreFocus = input === input.getRootNode().activeElement;
      pendingChoice = desired;
      const request = ++sequence;
      saving = true; refreshing = false; paint("Đang lưu lựa chọn…", false, false);
      let writeError = null;
      try { await write({ enabled: desired, revision }); }
      catch (error) { writeError = error; }
      if (disposed || request !== sequence) return;
      // Exactly one write; an uncertain reply is reconciled by GET, never retried.
      try {
        const next = normalize(await read());
        if (disposed || request !== sequence) return;
        snapshot = next; saving = false;
        const message = writeError
          ? `Chưa xác nhận lần lưu: ${writeError.message}. Đã đọc lại giá trị hiện tại từ máy chủ.`
          : next.enabled === desired
            ? "Đã lưu và đọc lại cấu hình chung."
            : "Giá trị máy chủ khác lựa chọn vừa lưu. Đã hiển thị cấu hình mới nhất.";
        paint(message, Boolean(writeError) || next.enabled !== desired);
        const active = input.getRootNode().activeElement;
        if (restoreFocus && (!active || active === document.body)) input.focus();
      } catch (error) {
        if (disposed || request !== sequence) return;
        saving = false;
        paint(`Chưa xác minh kết quả lưu: ${error.message}. Bấm Đọc lại cấu hình; không tự gửi lại lệnh lưu.`, true, false);
      }
    });
    retry.addEventListener("click", refresh);
    const onFocus = () => { if (!disposed && card.isConnected) void refresh(); };
    const onVisible = () => { if (document.visibilityState === "visible") onFocus(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    paint("Đang chờ đọc cấu hình chung.", false, false);
    return { element: card, refresh, dispose() {
      disposed = true; sequence++;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    } };
  }
  // MCP_V2_SETTINGS_CARD_END
  let mcpV2SettingsCard = null;
  let reactionSettingsCard = null;
  async function renderSettings() {
    mcpV2SettingsCard?.dispose();
    reactionSettingsCard?.dispose();
    screen.className = "screen"; screen.replaceChildren();
    const settings = document.createElement("section"); settings.className = "settings"; settings.innerHTML = '<h3>Widget settings</h3><p class="settings-copy">Change the Helpdesk key, widget display, position, and AI connection.</p>';
    const ticketCard = document.createElement("section"); ticketCard.className = "setting-card"; ticketCard.innerHTML = '<h4>Helpdesk API key</h4><p>Leave this field blank to keep the currently saved key.</p><label for="ticket-api-key">Avada Helpdesk API key</label>';
    const key = document.createElement("input"); key.id = "ticket-api-key"; key.type = "password"; key.autocomplete = "off"; key.placeholder = "avd_…";
    const displayLabel = document.createElement("label"); displayLabel.htmlFor = "widget-display"; displayLabel.textContent = "Widget display";
    const display = document.createElement("select"); display.id = "widget-display"; display.innerHTML = '<option value="panel">Open widget panel</option><option value="bubble">Chat bubble (click to open)</option>';
    const positionLabel = document.createElement("label"); positionLabel.htmlFor = "widget-position"; positionLabel.textContent = "Widget position";
    const position = document.createElement("select"); position.id = "widget-position"; position.innerHTML = '<option value="bottom-left">Bottom left</option><option value="bottom-right">Bottom right</option>';
    const themeSwitch = document.createElement("label"); themeSwitch.className = "setting-switch"; themeSwitch.htmlFor = "widget-theme"; themeSwitch.innerHTML = '<span>Dark mode</span><input id="widget-theme" type="checkbox" role="switch" aria-label="Dark mode"><span class="switch-track" aria-hidden="true"></span>';
    const theme = themeSwitch.querySelector("input");
    const save = document.createElement("button"); save.className = "primary settings-save"; save.type = "button"; save.textContent = "Save settings";
    const ticketStatus = document.createElement("p"); ticketStatus.className = "settings-status"; ticketCard.append(key, displayLabel, display, positionLabel, position, themeSwitch, save, ticketStatus);
    theme.addEventListener("change", async () => {
      const widgetTheme = theme.checked ? "dark" : "light";
      theme.disabled = true;
      try {
        await chrome.storage.local.set({ widgetTheme });
        applyTheme(widgetTheme);
      } finally {
        theme.disabled = false;
      }
    });
    save.addEventListener("click", async () => {
      const existing = await chrome.storage.local.get({ apiKey: "" }); const apiKey = key.value.trim() || existing.apiKey;
      if (!apiKey) { ticketStatus.textContent = "Enter an API key first."; ticketStatus.className = "settings-status error"; return; }
      await chrome.storage.local.set({ apiKey, widgetDisplay: display.value, widgetPosition: position.value }); applyPosition(position.value); applyWidgetDisplay(display.value, true); key.value = "";
      ticketStatus.textContent = "Ticket settings saved."; ticketStatus.className = "settings-status ok";
    });
    const awakeCard = document.createElement("section"); awakeCard.className = "setting-card"; awakeCard.innerHTML = '<h4>Giữ màn hình luôn bật</h4><p>Khi bật, Chrome sẽ yêu cầu thiết bị không tự tắt màn hình. Khi tắt, thiết bị sẽ trở lại cài đặt thời gian tắt màn hình mặc định.</p>';
    const awakeSwitch = document.createElement("label"); awakeSwitch.className = "setting-switch"; awakeSwitch.htmlFor = "keep-screen-awake"; awakeSwitch.innerHTML = '<span>Luôn bật màn hình</span><input id="keep-screen-awake" type="checkbox" role="switch" aria-label="Luôn bật màn hình"><span class="switch-track" aria-hidden="true"></span>';
    const keepScreenAwake = awakeSwitch.querySelector("input");
    const awakeStatus = document.createElement("p"); awakeStatus.className = "settings-status";
    keepScreenAwake.addEventListener("change", async () => {
      const enabled = keepScreenAwake.checked;
      keepScreenAwake.disabled = true;
      try {
        await request({ type: "set-keep-screen-awake", enabled });
        awakeStatus.textContent = enabled ? "Màn hình sẽ được giữ luôn bật khi Chrome đang chạy." : "Đã dùng lại thời gian tắt màn hình của thiết bị.";
        awakeStatus.className = "settings-status ok";
      } catch (error) {
        keepScreenAwake.checked = !enabled;
        awakeStatus.textContent = `Không thể cập nhật chế độ màn hình: ${error.message}`;
        awakeStatus.className = "settings-status error";
      } finally {
        keepScreenAwake.disabled = false;
      }
    });
    awakeCard.append(awakeSwitch, awakeStatus);
    const autoConnectCard = document.createElement("section"); autoConnectCard.className = "setting-card"; autoConnectCard.innerHTML = '<h4>Tự kết nối local</h4><p>Tự khởi chạy Telegram bot, Hachimi local và Helpdesk webhook bridge khi extension mở. Tắt tùy chọn này không ngắt các tiến trình đang chạy.</p>';
    const autoConnectSwitch = document.createElement("label"); autoConnectSwitch.className = "setting-switch"; autoConnectSwitch.htmlFor = "auto-connect-local-services"; autoConnectSwitch.innerHTML = '<span>Tự kết nối khi mở extension</span><input id="auto-connect-local-services" type="checkbox" role="switch" aria-label="Tự kết nối khi mở extension"><span class="switch-track" aria-hidden="true"></span>';
    const autoConnectLocalServices = autoConnectSwitch.querySelector("input");
    const autoConnectStatus = document.createElement("p"); autoConnectStatus.className = "settings-status";
    autoConnectLocalServices.addEventListener("change", async () => {
      const enabled = autoConnectLocalServices.checked;
      autoConnectLocalServices.disabled = true;
      try {
        await request({ type: "set-auto-connect-local-services", enabled });
        autoConnectStatus.textContent = enabled ? "Extension sẽ tự kết nối Telegram, Hachimi và webhook bridge khi mở." : "Đã tắt tự kết nối cho các lần mở sau.";
        autoConnectStatus.className = "settings-status ok";
      } catch (error) {
        autoConnectLocalServices.checked = !enabled;
        autoConnectStatus.textContent = `Không thể cập nhật tự kết nối: ${error.message}`;
        autoConnectStatus.className = "settings-status error";
      } finally {
        autoConnectLocalServices.disabled = false;
      }
    });
    autoConnectCard.append(autoConnectSwitch, autoConnectStatus);
    const aiCard = document.createElement("section"); aiCard.className = "setting-card"; aiCard.innerHTML = '<h4>AI provider</h4><p>Chọn Hachimi, TS Elite 2, hoặc dùng cả hai: TS Elite 2 tra cứu trước rồi Hachimi tổng hợp cùng tài liệu ELITE2 local.</p>';
    const providerChoices = document.createElement("div"); providerChoices.style.cssText = "display:grid;gap:8px;margin:11px 0;";
    const eliteChoice = document.createElement("label"); eliteChoice.style.cssText = "display:flex;align-items:center;gap:8px;margin:0;cursor:pointer;";
    const eliteRadio = document.createElement("input"); eliteRadio.type = "radio"; eliteRadio.name = "ai-provider"; eliteRadio.value = "elite2"; eliteRadio.style.cssText = "width:auto;padding:0;";
    eliteChoice.append(eliteRadio, document.createTextNode("TS Elite 2"));
    const hachimiChoice = document.createElement("label"); hachimiChoice.style.cssText = "display:flex;align-items:center;gap:8px;margin:0;cursor:pointer;";
    const hachimiRadio = document.createElement("input"); hachimiRadio.type = "radio"; hachimiRadio.name = "ai-provider"; hachimiRadio.value = "hachimi"; hachimiRadio.style.cssText = "width:auto;padding:0;";
    hachimiChoice.append(hachimiRadio, document.createTextNode("Hachimi local (máy này)"));
    const combinedChoice = document.createElement("label"); combinedChoice.style.cssText = "display:flex;align-items:center;gap:8px;margin:0;cursor:pointer;";
    const combinedRadio = document.createElement("input"); combinedRadio.type = "radio"; combinedRadio.name = "ai-provider"; combinedRadio.value = "hachimi-elite2"; combinedRadio.style.cssText = "width:auto;padding:0;";
    combinedChoice.append(combinedRadio, document.createTextNode("Hachimi + TS Elite 2"));
    providerChoices.append(hachimiChoice, eliteChoice, combinedChoice);
    const saveAi = document.createElement("button"); saveAi.className = "primary"; saveAi.type = "button"; saveAi.textContent = "Lưu AI provider";
    const connect = document.createElement("button"); connect.className = "secondary"; connect.type = "button";
    const copyCodexCommand = document.createElement("button"); copyCodexCommand.className = "secondary"; copyCodexCommand.type = "button"; copyCodexCommand.textContent = "Copy lệnh Hachimi local";
    const aiStatus = document.createElement("p"); aiStatus.className = "settings-status";
    const refreshAiStatus = async () => {
      if (eliteRadio.checked) {
        const elite = await request({ type: "ai-auth-status" });
        connect.hidden = false; copyCodexCommand.hidden = true;
        connect.textContent = elite.connected ? "Kết nối lại TS Elite 2" : "Kết nối TS Elite 2";
        aiStatus.textContent = elite.connected ? "TS Elite 2 đã sẵn sàng." : "TS Elite 2 chưa được kết nối.";
        aiStatus.className = `settings-status${elite.connected ? " ok" : ""}`;
      } else if (hachimiRadio.checked) {
        const hachimi = await request({ type: "codex-bridge-status" });
        connect.hidden = true; copyCodexCommand.hidden = hachimi.running;
        aiStatus.textContent = hachimi.running ? (hachimi.busy ? "Hachimi đang xử lý…" : "Hachimi local đã sẵn sàng.") : "Hachimi local đang được extension tự khởi động. Nếu vẫn chưa chạy, hãy copy lệnh dự phòng.";
        aiStatus.className = `settings-status${hachimi.running ? " ok" : ""}`;
      } else {
        const [elite, hachimi] = await Promise.all([request({ type: "ai-auth-status" }), request({ type: "codex-bridge-status" })]);
        connect.hidden = elite.connected; copyCodexCommand.hidden = hachimi.running;
        connect.textContent = "Kết nối TS Elite 2";
        if (!elite.connected) aiStatus.textContent = "TS Elite 2 chưa được kết nối.";
        else if (!hachimi.running) aiStatus.textContent = "Hachimi local đang được extension tự khởi động. Nếu vẫn chưa chạy, hãy copy lệnh dự phòng.";
        else aiStatus.textContent = hachimi.busy ? "Hachimi đang tổng hợp kết quả TS Elite 2…" : "Hachimi + TS Elite 2 đã sẵn sàng.";
        aiStatus.className = `settings-status${elite.connected && hachimi.running ? " ok" : ""}`;
      }
    };
    eliteRadio.addEventListener("change", () => { void refreshAiStatus(); });
    hachimiRadio.addEventListener("change", () => { void refreshAiStatus(); });
    combinedRadio.addEventListener("change", () => { void refreshAiStatus(); });
    connect.addEventListener("click", async () => { await request({ type: "ai-login" }); aiStatus.textContent = "Complete the TS Elite sign-in in the opened tab, then return here."; aiStatus.className = "settings-status"; });
    copyCodexCommand.addEventListener("click", async () => {
      await navigator.clipboard.writeText(CODEX_BRIDGE_START_COMMAND);
      aiStatus.textContent = "Đã copy. Mở Terminal, dán lệnh và nhấn Enter."; aiStatus.className = "settings-status ok";
    });
    saveAi.addEventListener("click", async () => {
      const aiProvider = combinedRadio.checked ? "hachimi-elite2" : hachimiRadio.checked ? "hachimi" : "elite2";
      saveAi.disabled = true; aiStatus.textContent = "Đang lưu lựa chọn AI…"; aiStatus.className = "settings-status";
      try {
        await chrome.storage.local.set({ aiProvider });
        if (aiProvider === "hachimi" || aiProvider === "hachimi-elite2") {
          await request({ type: "codex-bridge-start" });
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        await refreshAiStatus();
      } catch (error) {
        aiStatus.textContent = `Không thể bật Hachimi: ${error.message}. Hãy dùng nút Copy lệnh Hachimi local.`; aiStatus.className = "settings-status error";
      } finally { saveAi.disabled = false; }
    });
    aiCard.append(providerChoices, saveAi, connect, copyCodexCommand, aiStatus);
    const telegramCard = document.createElement("section"); telegramCard.className = "setting-card"; telegramCard.innerHTML = "<h4>Telegram bot</h4><p>Extension tự kết nối bot khi khởi động. Chỉ thông báo phát sinh sau lần kết nối hiện tại mới được gửi. Bot chạy nền sau khi bạn đóng widget hoặc Terminal.</p>";
    const connectTelegram = document.createElement("button"); connectTelegram.className = "primary"; connectTelegram.type = "button"; connectTelegram.textContent = "Kết nối lại Telegram";
    const copyTelegramCommand = document.createElement("button"); copyTelegramCommand.className = "secondary"; copyTelegramCommand.type = "button"; copyTelegramCommand.textContent = "Copy lệnh dự phòng";
    const telegramStatus = document.createElement("p"); telegramStatus.className = "settings-status";
    const refreshTelegramStatus = async () => {
      connectTelegram.disabled = true;
      try {
        const result = await request({ type: "telegram-notifier-status" });
        connectTelegram.textContent = "Kết nối lại Telegram";
        telegramStatus.textContent = result.running ? "Telegram bot đang kết nối và theo dõi ticket." : "Telegram bot đang tắt.";
        telegramStatus.className = `settings-status${result.running ? " ok" : ""}`;
      } catch (error) {
        telegramStatus.textContent = `Không kiểm tra được Telegram: ${error.message}`;
        telegramStatus.className = "settings-status error";
      } finally {
        connectTelegram.disabled = false;
      }
    };
    connectTelegram.addEventListener("click", async () => {
      connectTelegram.disabled = true;
      telegramStatus.textContent = "Đang kết nối Telegram…"; telegramStatus.className = "settings-status";
      try {
        const result = await request({ type: "telegram-notifier-reconnect" });
        connectTelegram.textContent = "Kết nối lại Telegram";
        telegramStatus.textContent = result.started ? "Telegram bot đã kết nối và đang theo dõi ticket." : "Telegram bot đang kết nối và theo dõi ticket.";
        telegramStatus.className = "settings-status ok";
      } catch (error) {
        telegramStatus.textContent = `Không thể kết nối Telegram: ${error.message}`;
        telegramStatus.className = "settings-status error";
      } finally {
        connectTelegram.disabled = false;
      }
    });
    copyTelegramCommand.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(TELEGRAM_BOT_START_COMMAND);
        telegramStatus.textContent = "Đã copy. Mở Terminal, dán lệnh và nhấn Enter."; telegramStatus.className = "settings-status ok";
      } catch {
        telegramCommand.focus(); telegramCommand.select();
        const copied = document.execCommand("copy");
        telegramStatus.textContent = copied ? "Đã copy. Mở Terminal, dán lệnh và nhấn Enter." : "Hãy copy lệnh trong ô phía trên.";
        telegramStatus.className = copied ? "settings-status ok" : "settings-status error";
      }
    });
    telegramCard.append(connectTelegram, copyTelegramCommand, telegramStatus); settings.append(ticketCard, awakeCard, autoConnectCard, aiCard, telegramCard); screen.append(settings);
    mcpV2SettingsCard = createMcpV2SettingsCard({
      read: async () => (await request({ type: "mcp-v2-settings", action: "read" })).settings,
      write: payload => request({ type: "mcp-v2-settings", action: "save", ...payload }),
    });
    settings.insertBefore(mcpV2SettingsCard.element, ticketCard);
    void mcpV2SettingsCard.refresh();
    if (globalThis.AnalyticsView?.settingsCard) {
      reactionSettingsCard = globalThis.AnalyticsView.settingsCard({ api: async (path, { method = "GET", body } = {}) => (await request({ type: "analytics", path, method, body })).data });
      settings.insertBefore(reactionSettingsCard.element, ticketCard);
      void reactionSettingsCard.refresh();
    }
    const stored = await chrome.storage.local.get({ apiKey: "", widgetDisplay: "panel", widgetPosition: "bottom-right", widgetTheme: "light", keepScreenAwake: false, autoConnectLocalServices: true, aiProvider: "elite2" }); display.value = stored.widgetDisplay === "bubble" ? "bubble" : "panel"; position.value = stored.widgetPosition === "bottom-left" ? "bottom-left" : "bottom-right"; theme.checked = stored.widgetTheme === "dark"; keepScreenAwake.checked = Boolean(stored.keepScreenAwake); autoConnectLocalServices.checked = Boolean(stored.autoConnectLocalServices); combinedRadio.checked = stored.aiProvider === "hachimi-elite2"; hachimiRadio.checked = !combinedRadio.checked && (stored.aiProvider === "hachimi" || stored.aiProvider === "codex-local"); eliteRadio.checked = !combinedRadio.checked && !hachimiRadio.checked;
    awakeStatus.textContent = keepScreenAwake.checked ? "Màn hình sẽ được giữ luôn bật khi Chrome đang chạy." : "Đang dùng thời gian tắt màn hình của thiết bị.";
    autoConnectStatus.textContent = autoConnectLocalServices.checked ? "Tự kết nối đang bật." : "Tự kết nối đang tắt."; autoConnectStatus.className = `settings-status${autoConnectLocalServices.checked ? " ok" : ""}`;
    ticketStatus.textContent = stored.apiKey ? "A Helpdesk API key is saved." : "No Helpdesk API key saved yet."; ticketStatus.className = `settings-status${stored.apiKey ? " ok" : ""}`;
    void refreshAiStatus(); void refreshTelegramStatus();
  }
  async function loadTickets() {
    if (state.ticketRequest) return state.ticketRequest;
    const isVisible = state.screen === "home";
    const refresh = isVisible ? screen.querySelector('[data-action="refresh-tickets"]') : null;
    if (refresh) refresh.disabled = true;
    if (isVisible) setHomeStatus("Loading Andrew's tickets…");
    state.ticketRequest = (async () => {
      try {
        const { groups } = await request({ type: "get-ticket-groups" });
        state.groups = groups;
        if (state.screen === "home") renderHome();
      } catch (error) {
        if (state.screen === "home") setHomeStatus(`Could not load tickets: ${error.message}`, true);
      } finally {
        state.ticketRequest = null;
        if (refresh) refresh.disabled = false;
      }
    })();
    return state.ticketRequest;
  }
  async function loadSlaSkillNotifications() {
    if (state.notificationRequest) return state.notificationRequest;
    const isVisible = state.screen === "notifications" && state.notificationSection === "sla_skill";
    const refresh = isVisible ? screen.querySelector(".refresh") : null;
    if (refresh) refresh.disabled = true;
    state.notificationRequest = (async () => {
      try {
        const [{ slaSkillNotifications = [] }, { schedules = [] }] = await Promise.all([
          chrome.storage.local.get({ slaSkillNotifications: [] }),
          request({ type: "get-auto-scan-schedules" }).catch(() => ({ schedules: [] })),
        ]);
        state.scanSchedules = Array.isArray(schedules) ? schedules : [];
        const marked = await applyLocalNotificationState(slaSkillNotifications || []);
        const slaSkillIds = new Set((slaSkillNotifications || []).map(notificationId));
        state.slaSkillNotifications = marked.filter((item) => slaSkillIds.has(notificationId(item)));
        if (state.notificationSection === "sla_skill") state.notifications = state.slaSkillNotifications;
        if (isVisible) renderNotifications();
      } catch (error) {
        if (isVisible) setNotificationStatus(`Could not load Skill SLA: ${error.message}`, true);
      } finally {
        state.notificationRequest = null;
        if (refresh) refresh.disabled = false;
      }
    })();
    return state.notificationRequest;
  }
  async function loadNotifications({ showLoading = true } = {}) {
    // Skill SLA is generated by the two-hour background alarm and persisted
    // locally. It must not poll the Helpdesk notification API every 15 seconds.
    if (state.notificationSection === "sla_skill") return loadSlaSkillNotifications();
    if (state.notificationRequest) return state.notificationRequest;
    const isVisible = state.screen === "notifications";
    const refresh = isVisible ? screen.querySelector(".refresh") : null;
    if (refresh) refresh.disabled = true;
    if (isVisible && showLoading) setNotificationStatus("Loading notifications…");
    state.notificationRequest = (async () => {
      try {
        const [{ notifications }, { devDoneNotifications = [], dateFollowNotifications = [], slaSkillNotifications = [] }, { schedules = [] }] = await Promise.all([
          request({ type: "get-notifications" }),
          chrome.storage.local.get({ devDoneNotifications: [], dateFollowNotifications: [], slaSkillNotifications: [] }),
          request({ type: "get-auto-scan-schedules" }).catch(() => ({ schedules: [] })),
        ]);
        state.scanSchedules = Array.isArray(schedules) ? schedules : [];
        const marked = await applyLocalNotificationState([...(notifications || []), ...(devDoneNotifications || []), ...(dateFollowNotifications || []), ...(slaSkillNotifications || [])]);
        const devIds = new Set((devDoneNotifications || []).map(notificationId));
        const dateFollowIds = new Set((dateFollowNotifications || []).map(notificationId));
        const slaSkillIds = new Set((slaSkillNotifications || []).map(notificationId));
        state.devDoneNotifications = marked.filter((item) => devIds.has(notificationId(item)));
        state.dateFollowNotifications = marked.filter((item) => dateFollowIds.has(notificationId(item)));
        state.slaSkillNotifications = marked.filter((item) => slaSkillIds.has(notificationId(item)));
        state.generalNotifications = marked.filter((item) => !devIds.has(notificationId(item)) && !dateFollowIds.has(notificationId(item)) && !slaSkillIds.has(notificationId(item)));
        state.notifications = state.notificationSection === "dev_done" ? state.devDoneNotifications : state.notificationSection === "date_follow" ? state.dateFollowNotifications : state.generalNotifications;
        if (state.screen === "notifications") renderNotifications();
      } catch (error) {
        if (state.screen === "notifications") setNotificationStatus(`Could not load notifications: ${error.message}`, true);
      } finally {
        state.notificationRequest = null;
        if (refresh) refresh.disabled = false;
      }
    })();
    return state.notificationRequest;
  }
  async function followDevFixTickets() {
    try {
      const result = await request({ type: "follow-dev-fixing" });
      state.devFollowDue = Object.fromEntries((result.due || []).map((item) => [item.ticketId || item.id, item]));
      if (state.screen === "home") renderHome();
      if (result.completed || result.updates) {
        await Promise.all([loadTickets(), loadNotifications()]);
      }
    } catch (error) {
      // The widget continues to work when the local bridge has not been
      // installed yet; Settings exposes the existing bridge start control.
      console.warn("Dev follow-up did not run:", error.message || error);
    }
  }
  async function readAllNotifications() {
    const button = screen.querySelector(".notification-actions button:last-child"); if (button) button.disabled = true;
    setNotificationStatus("Marking all notifications as read in this widget…");
    try {
      await rememberReadNotificationIds(state.notifications.map(notificationId));
      state.notifications.forEach((notification) => { notification.read = true; });
      if (state.screen === "notifications") { renderNotifications(); setNotificationStatus("All notifications marked as read in this widget."); }
    } catch (error) { setNotificationStatus(`Could not update notification state: ${error.message}`, true); }
    finally { if (button && state.screen === "notifications") button.disabled = false; }
  }
  async function markNotificationRead(notification) {
    if (!notification?.id || notification.read) return;
    try {
      await rememberReadNotificationIds([notificationId(notification)]);
      notification.read = true;
      if (state.screen === "notifications") renderNotifications();
    } catch (error) {
      if (state.screen === "notifications") setNotificationStatus(`Could not update notification state: ${error.message}`, true);
    }
  }
  function startWebhookEventStream() {
    let source = null;
    let reconnectTimer = null;
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
    };
    const connect = () => {
      if (stopped || !host.isConnected) return;
      try {
        source = new EventSource(HELPDESK_WEBHOOK_EVENTS_URL);
        source.addEventListener("ticket-change", (event) => {
          let update = {};
          try { update = JSON.parse(event.data); } catch {}
          console.info("Helpdesk webhook event received", update?.eventType || "unknown");
          // Both requests deduplicate concurrent webhook deliveries. Refresh
          // ticket state immediately; notification data is needed only while
          // its screen is visible and is refreshed then without a loading UI.
          void loadTickets();
          if (state.screen === "notifications") void loadNotifications({ showLoading: false });
        });
        source.onerror = () => {
          source?.close();
          if (stopped || !host.isConnected || reconnectTimer) return;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, 5_000);
        };
      } catch (error) {
        console.warn("Helpdesk webhook stream unavailable:", error);
        if (!stopped && host.isConnected) reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 5_000);
      }
    };
    connect();
    return stop;
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.widgetPosition) applyPosition(changes.widgetPosition.newValue === "bottom-left" ? "bottom-left" : "bottom-right");
    if (changes.widgetDisplay) applyWidgetDisplay(changes.widgetDisplay.newValue, state.screen === "settings" && state.widgetOpen);
    if (changes.widgetTheme) applyTheme(changes.widgetTheme.newValue);
    if (changes.aiAuthToken) state.aiConnected = Boolean(changes.aiAuthToken.newValue);
    if (changes[CHAT_HISTORY_STORAGE_KEY] && state.chatHistoryOpen && state.screen === "chat") {
      void loadSavedConversations().then((conversations) => { state.savedConversations = conversations; if (state.chatHistoryOpen && state.screen === "chat") renderChat(); });
    }
    if (changes.slaSkillNotifications && state.screen === "notifications" && state.notificationSection === "sla_skill") {
      void loadSlaSkillNotifications();
    }
    if ((changes.aiAuthToken || changes.aiProvider || changes.widgetDisplay || changes.widgetPosition || changes.keepScreenAwake) && state.screen === "settings") renderSettings();
  });
  chrome.storage.local.get({ widgetDisplay: "panel", widgetPosition: "bottom-right", widgetTheme: "light" }).then(async ({ widgetDisplay, widgetPosition, widgetTheme }) => {
    applyPosition(widgetPosition === "bottom-left" ? "bottom-left" : "bottom-right");
    applyWidgetDisplay(widgetDisplay, false);
    applyTheme(widgetTheme);
    try { state.aiConnected = (await request({ type: "ai-auth-status" })).connected; } catch {}
    showScreen("home"); loadTickets(); loadNotifications(); void loadFeatureFollow();
    const stopWebhookEventStream = startWebhookEventStream();
    const reconciliation = setInterval(() => {
      if (!host.isConnected) {
        clearInterval(reconciliation);
        stopWebhookEventStream();
        return;
      }
      if (state.widgetOpen) void loadTickets();
      if (state.screen === "notifications") void loadNotifications({ showLoading: false });
    }, RECONCILIATION_INTERVAL_MS);
  });
})();
