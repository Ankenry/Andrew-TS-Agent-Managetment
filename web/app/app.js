(() => {
  "use strict";
  const HELP_DESK_URL = "https://helpdesk.avada.net";
  const ACCESS_KEY_STORAGE = "tsWebAccessKey";
  const THEME_STORAGE = "tsWebTheme";
  const RECONCILIATION_INTERVAL_MS = 30 * 60_000;
  const MAX_SAVED_MESSAGES_PER_CONVERSATION = 100;
  const GROUPS = [
    { key: "pending", label: "Pending", action: { label: "Move to doing", nextStatus: "doing" } },
    { key: "doing", label: "Doing", action: { label: "Wait customer", nextStatus: "waiting_customer" }, bulkAction: { label: "Move all → wait", nextStatus: "waiting_customer" } },
    { key: "waiting_customer", label: "Wait customer", action: { label: "Move to done", nextStatus: "done" }, bulkAction: { label: "Move all → done", nextStatus: "done" }, keepAndrewOnly: true, showDetails: true },
    { key: "dev_fixing", label: "Dev fix", slackOnly: true },
    // Feature Request tickets (Helpdesk tsStatus feature_request), followed by the feature-follow skill (12/10/2026).
    { key: "feature_request", label: "Feature", slackOnly: true, feature: true },
  ];
  const createChatId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const state = {
    screen: "home", groups: {}, ticketsAt: "", bootstrap: null, live: false,
    notifications: [], generalNotifications: [], devDoneNotifications: [], dateFollowNotifications: [], slaSkillNotifications: [], generalError: "",
    scanSchedules: [], devFollowDue: {}, featureFollow: null, featureFollowError: "", notificationSection: "general", showUnreadOnly: false,
    chatSection: "chat", checking: { tab: "cmt", sessions: [], loaded: false, error: "", open: null }, followDevDetail: null, followDevLoading: false, followDevMail: "",
    ticketRequest: null, notificationRequest: null,
    selectedTicket: null, chatId: createChatId(), chatMessages: [], chatHistoryOpen: false, savedConversations: [],
    selectedDoingTicketIds: new Set(), selectedWaitingCustomerTicketIds: new Set(), expandedTicketDetails: new Set(), expandedGroups: new Set(["pending", "doing"]),
    ticketManagement: { team: "TS2", tickets: [], members: [], loading: false, error: "" },
    wakeLock: null,
  };

  const header = document.getElementById("header");
  const screen = document.getElementById("screen");
  const navigation = document.getElementById("nav");
  const toastEl = document.getElementById("toast");

  // --- helpers ------------------------------------------------------------
  const el = (tag, className = "", text = null) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== null) node.textContent = text; return node; };
  const accessKey = () => { try { return localStorage.getItem(ACCESS_KEY_STORAGE) || ""; } catch { return ""; } };
  const withKey = (url) => { const key = accessKey(); if (!key) return url; const u = new URL(url, location.origin); u.searchParams.set("key", key); return u.pathname + u.search; };
  async function api(path, { method = "GET", body } = {}) {
    const response = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json", ...(accessKey() ? { "X-TS-Web-Key": accessKey() } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    if (response.status === 401) { await requestAccessKey(true); return api(path, { method, body }); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || `Request failed (HTTP ${response.status}).`);
    return data;
  }
  let toastTimer = null;
  function toast(message, isError = false) {
    toastEl.textContent = message; toastEl.classList.toggle("error", isError); toastEl.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.hidden = true; }, isError ? 6000 : 3500);
  }
  function confirmBulkAction(label, detail) { return window.confirm(`Bạn đã chọn “${label}”.\n\n${detail}\n\nTiếp tục thực hiện?`); }
  const openExternal = (url) => { if (url) window.open(url, "_blank", "noopener,noreferrer"); };
  const ticketUrl = (ticket) => `${HELP_DESK_URL}/t/${encodeURIComponent(ticket.ticketId || ticket.id)}`;
  const ticketRef = (ticket) => String(ticket?.ticketId || ticket?.id || "");
  function ticketMemberSummary(ticket) {
    const members = Array.isArray(ticket.members) ? ticket.members : [];
    const memberIds = Array.isArray(ticket.memberIds) ? ticket.memberIds : [];
    const count = members.length || memberIds.length;
    const names = members.map((m) => m?.displayName || m?.name || m?.email || m?.memberId || m?.id).filter(Boolean);
    const label = `${count} member${count === 1 ? "" : "s"}`;
    return names.length ? `${label}: ${names.join(", ")}` : label;
  }
  function ticketHoverText(ticket) {
    const members = Array.isArray(ticket?.members) ? ticket.members.map((m) => m?.displayName || m?.name || m?.email || m?.memberId).filter(Boolean).join(", ") : "";
    return [`Title: ${ticket?.subject || "No subject"}`, `App: ${ticket?.appName || ticket?.app || "Unknown"}`, `Description: ${ticket?.description || ticket?.content || "No description"}`, `Members: ${members || "No members"}`].join("\n");
  }
  const formatTime = (value) => { const d = new Date(typeof value === "number" ? value : String(value || "")); return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("vi-VN"); };
  function applyTheme(theme) {
    const resolved = theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = resolved;
    try { localStorage.setItem(THEME_STORAGE, resolved); } catch {}
  }
  function initialTheme() {
    try { const stored = localStorage.getItem(THEME_STORAGE); if (stored) return stored; } catch {}
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      const area = document.createElement("textarea"); area.value = text; area.style.position = "fixed"; area.style.opacity = "0"; document.body.append(area); area.select();
      let ok = false; try { ok = document.execCommand("copy"); } catch {} area.remove(); return ok;
    }
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
      dfu: '<circle cx="12" cy="5" r="2"/><path d="M5 9h14M12 9v6m0 0-3 6m3-6 3 6"/>',
      settings: '<path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 2 3h3l1-3 3-1 2-3-2-2 1-3-2-3-3 1-2-3Z"/><circle cx="11.5" cy="11.5" r="3"/>',
    };
    return `<svg class="chat-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.chat}</svg>`;
  }

  // --- access key ---------------------------------------------------------
  let pinPromise = null;
  function requestAccessKey(failed = false) {
    if (pinPromise) return pinPromise;
    const dialog = document.getElementById("pin-dialog"); const form = document.getElementById("pin-form"); const input = document.getElementById("pin-input"); const error = document.getElementById("pin-error");
    error.textContent = failed && accessKey() ? "Mã truy cập không đúng. Thử lại." : "";
    input.value = "";
    pinPromise = new Promise((resolve) => {
      const onSubmit = (event) => { event.preventDefault(); try { localStorage.setItem(ACCESS_KEY_STORAGE, input.value.trim()); } catch {} form.removeEventListener("submit", onSubmit); dialog.close(); pinPromise = null; resolve(); };
      form.addEventListener("submit", onSubmit);
      dialog.showModal(); input.focus();
    });
    return pinPromise;
  }

  // --- header / nav -------------------------------------------------------
  function renderHeader() {
    header.replaceChildren();
    if (state.screen === "chat") {
      header.className = "head chat-head";
      const back = el("button", `back${state.chatHistoryOpen ? " history-back" : ""}`); back.type = "button"; back.innerHTML = `<span>‹</span> ${state.chatHistoryOpen ? "Back to chat" : "Back to tickets"}`;
      back.addEventListener("click", () => state.chatHistoryOpen ? closeChatHistory() : showScreen("home"));
      const title = el("div", "head-title"); title.innerHTML = `<h2>${state.chatHistoryOpen ? "Conversation history" : state.chatSection === "follow" ? "Follow dev" : "Chat bot"}</h2><p class="subtitle">Andrew AI · TS Elite 2 / Hachimi</p>`;
      const actions = el("div", "chat-header-actions");
      const more = el("button", "head-button", "⋯"); more.type = "button"; more.setAttribute("aria-label", "More chat actions");
      const menu = el("div", "chat-overflow-menu"); menu.hidden = true;
      const clear = el("button", "", "Clear conversations"); clear.type = "button"; clear.addEventListener("click", () => { menu.hidden = true; state.chatSection = "chat"; void startNewConversation(); });
      const history = el("button", "", "History"); history.type = "button"; history.addEventListener("click", () => { menu.hidden = true; state.chatSection = "chat"; void openChatHistory(); });
      const tracing = el("button", "", "Tracing"); tracing.type = "button"; tracing.addEventListener("click", () => { menu.hidden = true; openExternal(traceWebUrl()); });
      menu.append(clear, history, tracing);
      more.addEventListener("click", (event) => { event.stopPropagation(); menu.hidden = !menu.hidden; });
      document.addEventListener("pointerdown", (event) => { if (!menu.hidden && !menu.contains(event.target) && event.target !== more) menu.hidden = true; }, { capture: true });
      actions.append(more, menu);
      header.append(back, title, actions);
      return;
    }
    header.className = "head";
    const heading = el("div");
    if (state.screen === "settings") heading.innerHTML = '<h2>Settings</h2><p class="subtitle">Web preferences · local services</p>';
    else if (state.screen === "checking") heading.innerHTML = (state.checking.tab === "auto" ? '<h2>Checking ticket</h2><p class="subtitle">Ticket tự động · Đúng/Sai và góp ý</p>' : '<h2>Checking ticket</h2><p class="subtitle">Quá trình Hachimi check ticket · hỏi thêm Hachimi</p>');
    else if (state.screen === "analytics") heading.innerHTML = '<h2>Analytics</h2><p class="subtitle">Đánh giá trực tiếp · reaction lịch sử</p>';
    else if (state.screen === "dfu") heading.innerHTML = '<h2>DFY Accessibility</h2><p class="subtitle">Ticket Done For You · report accessibility scan · AI phân tích issue</p>';
    else if (state.screen === "news") heading.innerHTML = '<h2>NEWS</h2><p class="subtitle">Công nghệ · Model AI mới · Claude · cập nhật 08:00 hằng ngày</p>';
    else if (state.screen === "notifications") heading.innerHTML = '<h2>Notifications</h2><p class="subtitle">Latest updates for Andrew</p>';
    else if (state.screen === "ticket-management") heading.innerHTML = '<h2>Ticket Management</h2><p class="subtitle">Open pending and doing tickets by TS team</p>';
    else heading.innerHTML = '<div class="brand"><img class="brand-logo" src="/icons/bigmouse2-rounded-128.png" alt="TS Management logo"><div><h2>TS Management</h2><p class="subtitle">Pending · Doing · Wait customer · Dev fix · Feature</p><p class="subtitle">---edit by Andrew---</p></div></div>';
    const actions = el("div", "head-actions");
    // Ticket page: the NEWS button sits left of the Live pill (the web has no close button there).
    if (state.screen === "home" && globalThis.NewsView) { const news = globalThis.NewsView.button(() => showScreen("news")); newsButton = news; actions.append(news.element); void refreshNewsBadge(); }
    const live = el("span", "head-pill"); live.innerHTML = `<span class="live-dot${state.live ? " on" : ""}"></span>${state.live ? "Live" : "Offline"}`; live.title = state.live ? "Đang nhận cập nhật realtime" : "Chưa kết nối realtime";
    actions.append(live);
    if (state.screen === "ticket-management" || state.screen === "news") { const back = el("button", "head-button", "×"); back.type = "button"; back.setAttribute("aria-label", "Back to tickets"); back.addEventListener("click", () => showScreen("home")); actions.append(back); }
    header.append(heading, actions);
  }
  function unreadCount() { return [...state.generalNotifications, ...state.devDoneNotifications, ...state.dateFollowNotifications, ...state.slaSkillNotifications].filter((n) => !n?.read).length; }
  function renderNavigation() {
    if (!navigation.childElementCount) {
      const brand = el("div", "nav-brand"); brand.innerHTML = '<img src="/icons/bigmouse2-rounded-128.png" alt=""><span>TS Management<small>Avada Helpdesk · Andrew</small></span>'; navigation.append(brand);
      [["home", "Tickets"], ["chat", "Chat bot"], ["checking", "Checking"], ["analytics", "Analytics"], ["dfu", "DFY Accessibility"], ["notifications", "Notifications"], ["settings", "Settings"]].forEach(([name, label]) => {
        const button = el("button", "nav-button"); button.type = "button"; button.dataset.screen = name;
        // Settings: chỉ icon, nằm cuối thanh điều hướng (CSS .nav-settings đẩy xuống đáy sidebar trên desktop).
        if (name === "settings") { button.classList.add("nav-settings"); button.setAttribute("aria-label", label); button.title = label; button.innerHTML = `<span class="nav-icon">${chatIcon(name)}</span>`; }
        // DFY Accessibility (screen key stays "dfu"): full label on the desktop sidebar, "DFY" on the phone bottom bar (7 items must fit).
        else if (name === "dfu") button.innerHTML = `<span class="nav-icon">${chatIcon(name)}</span><span><span class="nav-long">${label}</span><span class="nav-short">DFY</span></span>`;
        else button.innerHTML = `<span class="nav-icon">${chatIcon(name)}</span><span>${label}</span>`;
        button.addEventListener("click", () => { if (name === "chat") state.chatHistoryOpen = false; else void saveActiveConversation(); showScreen(name); });
        navigation.append(button);
      });
    }
    navigation.querySelectorAll("button").forEach((button) => {
      const active = button.dataset.screen === state.screen || ((state.screen === "ticket-management" || state.screen === "news") && button.dataset.screen === "home");
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
      const existing = button.querySelector(".nav-badge"); if (existing) existing.remove();
      if (button.dataset.screen === "notifications") { const unread = unreadCount(); if (unread) button.append(el("span", "nav-badge", unread > 99 ? "99+" : String(unread))); }
    });
  }
  function showScreen(name, ticket = null) {
    if (name !== "checking" && stopHanAuto) { stopHanAuto(); stopHanAuto = null; }
    mcpV2SettingsCard?.dispose();
    reactionSettingsCard?.dispose();
    state.screen = name; if (ticket) state.selectedTicket = ticket;
    renderHeader(); renderNavigation();
    screen.scrollTop = 0;
    if (name === "home") renderHome();
    if (name === "chat") renderChat();
    if (name === "checking") renderChecking();
    if (name === "analytics") renderAnalytics();
    if (name === "dfu") renderDfu();
    if (name === "news") renderNews();
    if (name === "notifications") { renderNotifications(); void loadNotifications(); }
    if (name === "ticket-management") { renderTicketManagement(); void loadTicketManagement(); }
    if (name === "settings") void renderSettings();
  }

  // --- tickets ------------------------------------------------------------
  async function startTicketCheck(ticket) {
    const id = ticketRef(ticket) || "this ticket";
    await saveActiveConversation();
    state.selectedTicket = ticket; state.chatId = createChatId(); state.chatMessages = []; state.chatHistoryOpen = false; state.chatSection = "chat";
    showScreen("chat", ticket);
    const messages = screen.querySelector(".chat-messages"); const send = screen.querySelector(".send");
    if (messages && send) void sendChat(`Check ticket ${id}`, messages, send);
  }
  function actionButton(label, className, handler) {
    const button = el("button", className, label); button.type = "button";
    button.addEventListener("click", async () => { button.disabled = true; try { await handler(button); } catch (error) { setHomeStatus(error.message, true); toast(error.message, true); } finally { button.disabled = false; } });
    return button;
  }
  function createTicket(ticket, group, onSelectionChange = null) {
    const selectable = group.key === "doing" || group.key === "waiting_customer";
    const row = el("div", `ticket${selectable ? " selectable" : ""}`);
    const reference = ticketRef(ticket);
    if (selectable) {
      const set = group.key === "doing" ? state.selectedDoingTicketIds : state.selectedWaitingCustomerTicketIds;
      const checkbox = el("input", "ticket-select"); checkbox.type = "checkbox"; checkbox.checked = set.has(reference); checkbox.setAttribute("aria-label", `Chọn ticket ${reference}`);
      checkbox.addEventListener("change", () => { if (checkbox.checked) set.add(reference); else set.delete(reference); onSelectionChange?.(); });
      row.append(checkbox);
    }
    const feature = group.feature ? featureSummaryFor(ticket) : null;
    const devReminder = group.key === "dev_fixing" ? state.devFollowDue[reference] : feature?.reminderDue ? feature : null;
    const destination = group.slackOnly ? ticket.slackLink : ticketUrl(ticket);
    if (destination) {
      const link = el("a", "link"); link.href = destination; link.target = "_blank"; link.rel = "noreferrer";
      link.append(el("span", "id", reference), el("span", "subject", ticket.subject || "No subject"));
      if (group.showDetails) link.append(el("span", "ticket-members", ticketMemberSummary(ticket)), el("span", "ticket-description", ticket.description || "No description"));
      row.append(link);
    } else row.append(el("span", "subject", `${reference}: no Slack link`));
    const actions = el("div", "ticket-actions");
    if (group.key === "doing") {
      const check = el("button", "ask-ai", "Check"); check.type = "button"; check.title = "Check this Doing ticket with AI"; check.addEventListener("click", () => { void startTicketCheck(ticket); }); actions.append(check);
    }
    if (group.key === "waiting_customer") actions.append(actionButton("Move to doing", "move", async () => { await api("/tickets/move", { method: "POST", body: { ticket, nextStatus: "doing" } }); await loadTickets(); }));
    if (group.action && group.key !== "doing" && group.key !== "waiting_customer") actions.append(actionButton(group.action.label, "move", async () => { await api("/tickets/move", { method: "POST", body: { ticket, nextStatus: group.action.nextStatus } }); await loadTickets(); }));
    if (group.key === "dev_fixing" || group.feature) { const follow = el("button", "ask-ai", "Follow dev"); follow.type = "button"; follow.addEventListener("click", () => { void openFollowDev(ticket); }); actions.append(follow); }
    if (group.feature) actions.append(actionButton("Quét", "move feature-scan", async () => { await runFeatureScan(reference); }));
    if ((group.key === "dev_fixing" || group.feature) && ticket.slackLink) { const open = el("button", "move", "Mở Slack"); open.type = "button"; open.addEventListener("click", () => openExternal(ticket.slackLink)); actions.append(open); }
    if (!group.showDetails) {
      // Hover tooltips do not exist on touch devices: details toggle inline instead.
      const info = el("button", "info", "ⓘ"); info.type = "button"; info.title = "Chi tiết ticket"; info.setAttribute("aria-label", `Chi tiết ticket ${reference}`);
      const details = el("pre", "ticket-details", ticketHoverText(ticket)); details.hidden = !state.expandedTicketDetails.has(reference);
      info.setAttribute("aria-expanded", String(!details.hidden));
      info.addEventListener("click", () => { details.hidden = !details.hidden; info.setAttribute("aria-expanded", String(!details.hidden)); if (details.hidden) state.expandedTicketDetails.delete(reference); else state.expandedTicketDetails.add(reference); });
      actions.append(info); row.append(actions, details);
    } else row.append(actions);
    if (devReminder) {
      actions.prepend(el("p", "dev-reminder-warning", group.feature ? `⚠ Cần nhắc dev follow up (${feature.silentHours} giờ không có update)` : "⚠ Cần nhắc dev follow up"));
      // Same Slack reminder as Dev fix (bridge /dev-remind); it only runs when Đại tá clicks the button.
      actions.append(actionButton("Nhắc dev", "move dev-remind", async () => { await api("/dev/remind", { method: "POST", body: { ticket } }); setHomeStatus(`Đã nhắc dev cho ticket ${reference}.`); toast(`Đã nhắc dev cho ticket ${reference}.`); if (group.feature) await loadFeatureFollow(); else await followDevFixTickets(); }));
    }
    if (group.feature) row.append(featureProgressBlock(ticket, feature));
    return row;
  }
  // --- Feature section: progress from skills/feature-follow (timer state + manual preview scan) ---------------
  function featureSummaryFor(ticket) {
    const payload = state.featureFollow; if (!payload || !ticket) return null;
    return payload.tickets?.[String(ticket.id || "")] || payload.byReference?.[String(ticket.ticketId || "")] || null;
  }
  const timeLabel = (value) => { const date = new Date(value || ""); return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }); };
  function featureProgressBlock(ticket, feature) {
    const block = el("div", "feature-progress");
    if (!feature) {
      const note = state.featureFollow ? (state.featureFollow.skillInstalled ? "Chưa quét: chưa có đánh giá từ feature-follow cho ticket này." : "Chưa cài skill feature-follow; chưa có tiến độ.") : state.featureFollowError ? `Không đọc được tiến độ: ${state.featureFollowError}` : "Đang đọc tiến độ…";
      block.append(el("p", "feature-note", note)); return block;
    }
    const head = el("div", "feature-head");
    head.append(el("span", `feature-pill status-${feature.status || "unknown"}`, feature.statusLabel || "Chưa quét"));
    if (feature.waitingFor) head.append(el("span", "feature-meta", `chờ: ${feature.waitingFor}`));
    if (feature.draftKind && feature.draftKind !== "none") head.append(el("span", "feature-meta", `mail nháp: ${feature.draftKind}`));
    block.append(head);
    if (feature.progressShort) block.append(el("p", "feature-text", feature.progressShort));
    const when = [];
    if (feature.assessedAt) when.push(`${feature.source === "scan" ? "quét tay" : "AI đánh giá"} ${timeLabel(feature.assessedAt)}`);
    if (feature.latestSlackAt) when.push(`Slack cập nhật ${timeLabel(feature.latestSlackAt)}`);
    if (feature.postedAt) when.push(`comment tiến độ ${timeLabel(feature.postedAt)}`);
    if (when.length) block.append(el("p", "feature-meta-line", when.join(" · ")));
    if (feature.scanError) block.append(el("p", "feature-note error", `Lượt quét lỗi: ${feature.scanError}`));
    const previews = [["Xem comment", feature.scanComment], ["Xem nháp", feature.scanDraft || feature.draftMail]].filter(([, content]) => content);
    if (previews.length) {
      const bar = el("div", "feature-previews");
      for (const [label, content] of previews) {
        const pre = el("pre", "ticket-details feature-preview", content); pre.hidden = true;
        const button = el("button", "info", label); button.type = "button"; button.setAttribute("aria-expanded", "false");
        button.addEventListener("click", () => { pre.hidden = !pre.hidden; button.setAttribute("aria-expanded", String(!pre.hidden)); });
        bar.append(button); block.append(bar, pre);
      }
    }
    return block;
  }
  let featurePollTimer = null;
  async function loadFeatureFollow() {
    try { state.featureFollow = await api("/feature/follow"); state.featureFollowError = ""; }
    catch (error) { state.featureFollowError = error.message; }
    if (state.screen === "home") renderHome();
    if (state.featureFollow?.running && !featurePollTimer) featurePollTimer = setTimeout(() => { featurePollTimer = null; void loadFeatureFollow(); }, 4_000);
  }
  async function runFeatureScan(reference = "") {
    const result = await api("/feature/scan", { method: "POST", body: reference ? { ticket: reference } : {} });
    state.featureFollow = result; state.featureFollowError = "";
    setHomeStatus(reference ? `Đang quét ticket ${reference} (preview, không đăng)…` : "Đang quét các ticket Feature (preview, không đăng)…");
    if (state.screen === "home") renderHome();
    if (result.running && !featurePollTimer) featurePollTimer = setTimeout(() => { featurePollTimer = null; void loadFeatureFollow(); }, 4_000);
  }
  function createCategory(group, tickets) {
    const category = el("section", "category");
    if (state.expandedGroups.has(group.key)) category.classList.add("expanded");
    const categoryHeader = el("div", "category-header");
    const toggle = el("button", "toggle"); toggle.type = "button"; toggle.append(el("span", "arrow", "›"), el("span", "name", group.label), el("span", "count", String(tickets.length)));
    toggle.addEventListener("click", () => { const open = category.classList.toggle("expanded"); if (open) state.expandedGroups.add(group.key); else state.expandedGroups.delete(group.key); }); categoryHeader.append(toggle);
    if (group.bulkAction && tickets.length) {
      const groupActions = el("div", "group-actions");
      const set = group.key === "doing" ? state.selectedDoingTicketIds : state.selectedWaitingCustomerTicketIds;
      const ids = new Set(tickets.map(ticketRef)); set.forEach((id) => { if (!ids.has(id)) set.delete(id); });
      const selection = el("label", "selection"); const selectAll = el("input"); selectAll.type = "checkbox"; selectAll.setAttribute("aria-label", `Chọn tất cả ticket ${group.label}`);
      const selectedCount = el("span"); selection.append(selectAll, selectedCount, el("span", "", "Select all"));
      const moveSelected = el("button", "all"); moveSelected.type = "button";
      const keepAndrew = group.keepAndrewOnly ? el("button", "keep-andrew", "Keep Andrew") : null; if (keepAndrew) keepAndrew.type = "button";
      const verb = group.key === "doing" ? "wait" : "done";
      const selectedTickets = () => tickets.filter((t) => set.has(ticketRef(t)));
      const sync = () => {
        const selected = selectedTickets(); const isAll = selected.length === tickets.length;
        selectAll.checked = isAll; selectAll.indeterminate = selected.length > 0 && !isAll;
        selectedCount.textContent = selected.length ? `${selected.length} selected` : "";
        moveSelected.disabled = selected.length === 0; if (keepAndrew) keepAndrew.disabled = selected.length === 0;
        moveSelected.textContent = isAll ? group.bulkAction.label : selected.length > 1 ? `Move ${selected.length} to ${verb}` : `Move to ${verb}`;
        if (keepAndrew) keepAndrew.textContent = isAll || selected.length <= 1 ? "Keep Andrew" : `Keep Andrew (${selected.length})`;
      };
      const setInputsDisabled = (disabled) => { selectAll.disabled = disabled; category.querySelectorAll(".ticket-select").forEach((c) => { c.disabled = disabled; }); };
      selectAll.addEventListener("change", () => { tickets.forEach((t) => { if (selectAll.checked) set.add(ticketRef(t)); else set.delete(ticketRef(t)); }); sync(); category.querySelectorAll(".ticket-select").forEach((c) => { c.checked = selectAll.checked; }); });
      moveSelected.addEventListener("click", async () => {
        const selected = selectedTickets(); if (!selected.length) return;
        const isAll = selected.length === tickets.length;
        const label = isAll ? group.bulkAction.label : selected.length > 1 ? `Move ${selected.length} to ${verb}` : `Move to ${verb}`;
        const detail = isAll ? `Tất cả ticket ${group.label} sẽ được chuyển sang trạng thái ${group.bulkAction.nextStatus}.` : `${selected.length} ticket đã chọn sẽ được chuyển sang trạng thái ${group.bulkAction.nextStatus}.`;
        if (!confirmBulkAction(label, detail)) return;
        moveSelected.disabled = true; if (keepAndrew) keepAndrew.disabled = true; setInputsDisabled(true);
        try {
          let moved = 0; let failed = 0;
          if (isAll) { const result = await api("/tickets/move-all", { method: "POST", body: { status: group.key, nextStatus: group.bulkAction.nextStatus } }); moved = result.moved; failed = result.failed?.length || 0; }
          else for (const ticket of selected) { try { await api("/tickets/move", { method: "POST", body: { ticket, nextStatus: group.bulkAction.nextStatus } }); moved += 1; } catch { failed += 1; } }
          const message = `Đã chuyển ${moved} ticket(s) sang ${group.bulkAction.nextStatus}.${failed ? ` ${failed} ticket(s) thất bại.` : ""}`;
          setHomeStatus(message, Boolean(failed)); toast(message, Boolean(failed)); set.clear(); await loadTickets();
        } catch (error) { setHomeStatus(error.message, true); } finally { setInputsDisabled(false); sync(); }
      });
      keepAndrew?.addEventListener("click", async () => {
        const selected = selectedTickets(); if (!selected.length) return;
        const isAll = selected.length === tickets.length;
        if (!confirmBulkAction("Keep Andrew", isAll ? `Andrew sẽ là người được assign duy nhất trên tất cả ticket ${group.label}.` : `Andrew sẽ là người được assign duy nhất trên ${selected.length} ticket đã chọn.`)) return;
        moveSelected.disabled = true; keepAndrew.disabled = true; setInputsDisabled(true);
        try {
          let updated = 0; let unchanged = 0; let failed = 0;
          if (isAll) { const result = await api("/tickets/keep-andrew", { method: "POST", body: { status: group.key } }); updated = result.updated; unchanged = result.unchanged; failed = result.failed?.length || 0; }
          else for (const ticket of selected) { try { const result = await api("/tickets/keep-andrew-ticket", { method: "POST", body: { ticket } }); if (result.changed) updated += 1; else unchanged += 1; } catch { failed += 1; } }
          const message = `Đã giữ Andrew là người duy nhất trên ${updated} ticket(s). ${unchanged} ticket(s) không cần thay đổi.${failed ? ` ${failed} ticket(s) thất bại.` : ""}`;
          setHomeStatus(message, Boolean(failed)); toast(message, Boolean(failed)); set.clear(); await loadTickets();
        } catch (error) { setHomeStatus(error.message, true); } finally { setInputsDisabled(false); sync(); }
      });
      sync(); groupActions.append(selection, moveSelected); if (keepAndrew) groupActions.append(keepAndrew);
      categoryHeader.append(groupActions);
      category.addEventListener("selection-changed", sync);
    }
    if (group.feature) {
      const groupActions = el("div", "group-actions feature-actions");
      const follow = state.featureFollow;
      const note = el("span", "feature-scan-note", follow?.running ? `Đang quét${follow.runningTicket ? ` ${follow.runningTicket}` : ""}…` : follow?.scanAt ? `Quét tay ${timeLabel(follow.scanAt)}` : follow?.stateAt ? `Timer ${timeLabel(follow.stateAt)}` : "Chưa quét");
      const scan = actionButton(follow?.running ? "Đang quét…" : "Quét", "all feature-scan-all", async () => { await runFeatureScan(); });
      scan.disabled = Boolean(follow?.running) || !tickets.length;
      groupActions.append(note, scan); categoryHeader.append(groupActions);
    }
    const items = el("div", "items");
    if (!tickets.length) items.append(el("p", "empty", `No ${group.label.toLowerCase()} tickets.`));
    else tickets.forEach((ticket) => items.append(createTicket(ticket, group, () => category.dispatchEvent(new Event("selection-changed")))));
    category.append(categoryHeader, items);
    return category;
  }
  function setHomeStatus(message = "", isError = false) { const status = screen.querySelector(".status"); if (!status) return; status.textContent = message; status.classList.toggle("error", isError); }
  function renderHome() {
    screen.className = "screen home-screen"; screen.replaceChildren();
    const summary = el("div", "home-summary");
    const total = GROUPS.reduce((sum, group) => sum + (state.groups[group.key] || []).length, 0);
    const count = el("span", "count-pill", `${total} ticket${total === 1 ? "" : "s"}${state.ticketsAt ? ` · ${new Date(state.ticketsAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}` : ""}`);
    const controls = el("div", "group-actions");
    const management = el("button", "refresh", "Ticket Management"); management.type = "button"; management.addEventListener("click", () => showScreen("ticket-management"));
    const refresh = el("button", "refresh", "Refresh"); refresh.type = "button"; refresh.dataset.action = "refresh-tickets"; refresh.addEventListener("click", () => void loadTickets());
    controls.append(management, refresh); summary.append(count, controls);
    const status = el("p", "status");
    const categories = el("div", "categories");
    GROUPS.forEach((group) => categories.append(createCategory(group, state.groups[group.key] || [])));
    screen.append(summary, status, categories);
    if (!state.bootstrap?.settings?.hasApiKey) setHomeStatus("Chưa có Helpdesk API key. Vào Settings để nhập key.", true);
  }
  async function loadTickets() {
    if (state.ticketRequest) return state.ticketRequest;
    const isVisible = state.screen === "home";
    const refresh = isVisible ? screen.querySelector('[data-action="refresh-tickets"]') : null;
    if (refresh) refresh.disabled = true;
    if (isVisible) setHomeStatus("Loading Andrew's tickets…");
    state.ticketRequest = (async () => {
      try { const { groups, at } = await api("/tickets/groups"); state.groups = groups; state.ticketsAt = at; if (state.screen === "home") renderHome(); }
      catch (error) { if (state.screen === "home") setHomeStatus(`Could not load tickets: ${error.message}`, true); }
      finally { state.ticketRequest = null; if (refresh) refresh.disabled = false; }
    })();
    return state.ticketRequest;
  }

  // --- ticket management --------------------------------------------------
  function renderTicketManagement() {
    screen.className = "screen ticket-management"; screen.replaceChildren();
    const { team, tickets, members, loading, error } = state.ticketManagement;
    const toolbar = el("div", "management-toolbar");
    const label = el("label", "", "TS team"); label.htmlFor = "ticket-management-team";
    const select = el("select"); select.id = "ticket-management-team"; select.innerHTML = '<option value="TS1">TS1</option><option value="TS2">TS2</option>'; select.value = team;
    select.addEventListener("change", () => { state.ticketManagement.team = select.value; void loadTicketManagement(); });
    toolbar.append(label, select);
    const summary = el("p", "management-summary", loading ? "Loading ticket management…" : error ? error : `${tickets.length} open ticket${tickets.length === 1 ? "" : "s"} in ${team}`);
    const memberCard = el("section", "management-card"); memberCard.append(el("h3", "", "Tickets by member"));
    if (!loading && !members.length) memberCard.append(el("p", "empty", "No assigned TS tickets."));
    else {
      const totalAssignments = members.reduce((t, m) => t + m.count, 0);
      members.forEach((member, index) => {
        const row = el("div", "management-member"); const dot = el("span", "management-dot"); dot.style.background = ["#2563eb", "#10b981", "#f59e0b", "#ef4444", "#3b82f6", "#ec4899", "#06b6d4"][index % 7];
        row.append(dot, el("span", "", member.name), el("span", "management-member-count", `${member.count} (${totalAssignments ? ((member.count / totalAssignments) * 100).toFixed(1) : "0.0"}%)`)); memberCard.append(row);
      });
    }
    const ticketCard = el("section", "management-card"); ticketCard.append(el("h3", "", "Open tickets"));
    if (!loading && !tickets.length) ticketCard.append(el("p", "empty", "No pending or doing tickets for this team."));
    else tickets.forEach((ticket) => {
      const item = el("a", "management-ticket"); item.href = ticketUrl(ticket); item.target = "_blank"; item.rel = "noreferrer";
      const meta = el("span", "management-ticket-meta");
      meta.append(el("span", "management-badge", ticket.tsStatus || "pending"), el("span", "", `Member: ${(ticket.members || []).map((m) => m?.displayName || m?.name || m?.email || m?.memberId).filter(Boolean).join(", ") || "No member"}`), el("span", "", `Created: ${formatTime(ticket.createdAt) || "Unknown date"}`), el("span", "", `Level: ${ticket.level ?? "—"}`), el("span", "", `App: ${ticket.appName || "—"}`));
      item.append(el("span", "management-ticket-title", ticket.subject || "No subject"), meta); ticketCard.append(item);
    });
    screen.append(toolbar, summary, memberCard, ticketCard);
  }
  async function loadTicketManagement() {
    if (state.ticketManagement.loading) return;
    state.ticketManagement.loading = true; state.ticketManagement.error = "";
    if (state.screen === "ticket-management") renderTicketManagement();
    try { const data = await api(`/ticket-management?team=${encodeURIComponent(state.ticketManagement.team)}`); state.ticketManagement.tickets = data.tickets || []; state.ticketManagement.members = data.members || []; }
    catch (error) { state.ticketManagement.error = `Could not load ticket management: ${error.message}`; }
    finally { state.ticketManagement.loading = false; if (state.screen === "ticket-management") renderTicketManagement(); }
  }

  // --- notifications ------------------------------------------------------
  function notificationUrl(notification) {
    const link = String(notification?.link || "").trim(); if (link) return new URL(link, HELP_DESK_URL).href;
    const id = notification?.metadata?.ticketId; return id ? `${HELP_DESK_URL}/t/${encodeURIComponent(id)}` : HELP_DESK_URL;
  }
  function nextScanLabel(schedule) {
    if (schedule?.enabled === false) return `${schedule.label} · quét tự động đang tắt`;
    const next = new Date(schedule?.scheduledAt || "");
    if (Number.isNaN(next.getTime())) return `${schedule?.label || "Quét tự động"} · đang xác định lịch`;
    return `${schedule.label} · lần scan kế tiếp ${next.toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })}`;
  }
  function renderScanScheduleTags() {
    const key = { dev_done: "dev_follow", date_follow: "date_follow", sla_skill: "sla_skill" }[state.notificationSection];
    const schedule = key ? state.scanSchedules.find((item) => item.key === key) : null;
    if (!schedule) return document.createDocumentFragment();
    const tags = el("div", "scan-schedule-tags"); const tag = el("span", "scan-schedule-tag active", nextScanLabel(schedule));
    const run = el("button", "scan-schedule-tag", "Quét ngay"); run.type = "button";
    run.addEventListener("click", async () => { run.disabled = true; run.textContent = "Đang quét…"; try { const result = await api("/scans/run", { method: "POST", body: { key } }); toast(result.running ? "Đang có lượt quét chạy, vui lòng chờ." : "Đã quét xong."); await loadNotifications({ showLoading: false }); } catch (error) { toast(error.message, true); } finally { run.disabled = false; run.textContent = "Quét ngay"; } });
    tags.append(tag, run); return tags;
  }
  const notificationId = (n) => String(n?.id || "");
  function parseSlaSkillDetail(detail) {
    const blocks = String(detail || "").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    const source = blocks.find((b) => /^Nguồn\s*:/i.test(b))?.replace(/^Nguồn\s*:\s*/i, "") || "Avada Bot · Quét SLA";
    const summaryBlock = blocks.find((b) => /^Tóm tắt/i.test(b));
    const summary = summaryBlock ? summaryBlock.replace(/^Tóm tắt[^:]*:\s*/i, "") : "Bản tin SLA mới cần được rà soát.";
    const rules = blocks.filter((b) => /^\d+\.\s+/.test(b)).map((block) => {
      const [heading = "", ...lines] = block.split("\n");
      return { title: heading.replace(/^\d+\.\s*/, "").trim(), rule: (lines.find((l) => /^Quy tắc\s*:/i.test(l)) || "").replace(/^Quy tắc\s*:\s*/i, "").trim(), evidence: (lines.find((l) => /^Bằng chứng SLA\s*:/i.test(l)) || "").replace(/^Bằng chứng SLA\s*:\s*/i, "").trim() };
    }).filter((r) => r.title || r.rule || r.evidence);
    return { source, summary, rules };
  }
  function createSlaSkillNotification(notification) {
    const content = parseSlaSkillDetail(notification?.metadata?.detail);
    const item = el("article", `notification sla-skill-card${notification?.read ? "" : " unread"}`);
    const trigger = el("button", "sla-skill-trigger"); trigger.type = "button"; trigger.setAttribute("aria-expanded", "false");
    const heading = el("div", "sla-skill-heading"); const titleWrap = el("div", "sla-skill-title-wrap");
    titleWrap.append(el("div", "sla-skill-title", notification?.title || "Skill SLA"), el("span", "sla-skill-source", content.source));
    heading.append(el("span", "sla-skill-icon", "SLA"), titleWrap);
    if (!notification?.read) heading.append(el("span", "notification-dot"));
    const footer = el("div", "sla-skill-footer"); const expand = el("span", "sla-skill-expand", `Xem ${content.rules.length || ""} quy tắc`);
    footer.append(el("time", "", formatTime(notification?.createdAt)), expand);
    trigger.append(heading, el("p", "sla-skill-summary", content.summary), footer);
    const detail = el("div", "sla-skill-detail"); detail.hidden = true;
    if (!content.rules.length) detail.append(el("p", "sla-skill-empty", "Chưa trích được quy tắc chi tiết từ bản tin SLA này."));
    else {
      const list = el("div", "sla-skill-rules");
      content.rules.forEach((rule, index) => {
        const card = el("section", "sla-skill-rule"); const body = el("div");
        body.append(el("div", "sla-skill-rule-title", rule.title || `Quy tắc ${index + 1}`), el("p", "sla-skill-rule-copy", rule.rule || "Chưa có diễn giải chi tiết."));
        if (rule.evidence) { const evidence = el("blockquote", "sla-skill-evidence"); evidence.append(el("strong", "", "Bằng chứng SLA: "), document.createTextNode(rule.evidence)); body.append(evidence); }
        card.append(el("span", "sla-skill-rule-number", String(index + 1)), body); list.append(card);
      });
      detail.append(list);
    }
    trigger.addEventListener("click", () => { const expanded = detail.hidden; detail.hidden = !expanded; trigger.setAttribute("aria-expanded", String(expanded)); expand.textContent = expanded ? "Thu gọn" : `Xem ${content.rules.length || ""} quy tắc`; if (!notification?.read) void markNotificationRead(notification); });
    item.append(trigger, detail); return item;
  }
  function createNotification(notification) {
    const id = notificationId(notification);
    if (id.startsWith("sla-skill:")) return createSlaSkillNotification(notification);
    const isDevFollowReport = id.startsWith("dev-follow:");
    const item = el("article", `notification${notification?.read ? "" : " unread"}`);
    const link = el("a", "notification-link"); link.href = notificationUrl(notification); link.target = "_blank"; link.rel = "noreferrer";
    const top = el("div", "notification-top");
    top.append(el("span", "notification-title", isDevFollowReport ? (notification?.title || "Dev follow") : (notification?.metadata?.ticketSubject || notification?.title || "Helpdesk notification")));
    if (!notification?.read) top.append(el("span", "notification-dot"));
    link.append(top, el("span", "notification-message", notification?.message || notification?.body || notification?.title || "Open the related ticket"), el("time", "notification-time", formatTime(notification?.createdAt)));
    link.addEventListener("click", () => { if (!notification?.read) void markNotificationRead(notification); });
    item.append(link);
    const detailText = notification?.metadata?.detail;
    const actions = el("div", "notification-card-actions");
    if (detailText) {
      const detail = el("pre", "notification-detail", detailText); detail.hidden = true;
      const toggle = el("button", "move", "Chi tiết"); toggle.type = "button"; toggle.addEventListener("click", () => { detail.hidden = !detail.hidden; toggle.textContent = detail.hidden ? "Chi tiết" : "Thu gọn"; if (!notification?.read) void markNotificationRead(notification); });
      actions.append(toggle); item.append(detail);
    }
    if (notification?.metadata?.slackLink) { const slack = el("button", "move", "Mở Slack"); slack.type = "button"; slack.addEventListener("click", () => openExternal(notification.metadata.slackLink)); actions.append(slack); }
    const canMove = Boolean(notification?.metadata?.canMoveToWaitingCustomer || notification?.metadata?.status === "awaiting_customer_confirmation");
    if (isDevFollowReport && canMove && !notification?.metadata?.movedToWaitingCustomer) {
      const move = el("button", "ask-ai", "Move to wait customer"); move.type = "button";
      move.addEventListener("click", async () => {
        move.disabled = true;
        try {
          const internalId = notification?.metadata?.ticketInternalId; if (!internalId) throw new Error("Thiếu mã nội bộ của ticket.");
          await api("/tickets/move", { method: "POST", body: { ticket: { id: internalId }, nextStatus: "waiting_customer" } });
          await api("/notifications/dev-follow/moved", { method: "POST", body: { id } });
          toast("Đã chuyển ticket sang wait customer.");
          await Promise.all([loadTickets(), loadNotifications({ showLoading: false })]);
        } catch (error) { setNotificationStatus(error.message, true); move.disabled = false; }
      });
      actions.append(move);
    }
    if (actions.childElementCount) item.append(actions);
    return item;
  }
  function setNotificationStatus(message = "", isError = false) { const status = screen.querySelector(".status"); if (!status) return; status.textContent = message; status.classList.toggle("error", isError); }
  function currentSectionNotifications() {
    return state.notificationSection === "dev_done" ? state.devDoneNotifications : state.notificationSection === "date_follow" ? state.dateFollowNotifications : state.notificationSection === "sla_skill" ? state.slaSkillNotifications : state.generalNotifications;
  }
  function renderNotifications() {
    screen.className = "screen"; screen.replaceChildren();
    state.notifications = currentSectionNotifications();
    const tabs = el("div", "tabs");
    [["general", "Thông báo chung"], ["dev_done", "Dev báo done"], ["date_follow", "Date Follow"], ["sla_skill", "Skill SLA"]].forEach(([key, label]) => {
      const tab = el("button", `tab${state.notificationSection === key ? " active" : ""}`, label); tab.type = "button";
      tab.addEventListener("click", () => { state.notificationSection = key; state.showUnreadOnly = false; renderNotifications(); });
      tabs.append(tab);
    });
    const summary = el("div", "home-summary");
    const unread = state.notifications.filter((n) => !n?.read).length;
    const count = el("span", "count-pill", `${state.notifications.length} notification${state.notifications.length === 1 ? "" : "s"}${unread ? ` · ${unread} new` : ""}`);
    const refresh = el("button", "refresh", "Refresh"); refresh.type = "button"; refresh.addEventListener("click", () => void loadNotifications({ showLoading: true }));
    summary.append(count, refresh);
    const actions = el("div", "notification-actions");
    const unreadFilter = el("button", `${state.showUnreadOnly ? "active" : ""}`, "Unread only"); unreadFilter.type = "button"; unreadFilter.setAttribute("aria-pressed", String(state.showUnreadOnly)); unreadFilter.addEventListener("click", () => { state.showUnreadOnly = !state.showUnreadOnly; renderNotifications(); });
    const readAll = el("button", "", "Read all"); readAll.type = "button"; readAll.disabled = unread === 0; readAll.addEventListener("click", readAllNotifications);
    actions.append(unreadFilter, readAll);
    const status = el("p", "status");
    if (state.notificationSection === "general" && state.generalError) { status.textContent = `Could not load Helpdesk notifications: ${state.generalError}`; status.classList.add("error"); }
    const list = el("div", "notification-list");
    const visible = state.showUnreadOnly ? state.notifications.filter((n) => !n?.read) : state.notifications;
    if (!visible.length) list.append(el("p", "empty", state.showUnreadOnly ? "No unread notifications." : "No notifications yet."));
    else visible.forEach((n) => list.append(createNotification(n)));
    screen.append(tabs, renderScanScheduleTags(), summary, actions, status, list);
  }
  async function loadNotifications({ showLoading = true } = {}) {
    if (state.notificationRequest) return state.notificationRequest;
    const isVisible = state.screen === "notifications";
    const refresh = isVisible ? screen.querySelector(".refresh") : null; if (refresh) refresh.disabled = true;
    if (isVisible && showLoading) setNotificationStatus("Loading notifications…");
    state.notificationRequest = (async () => {
      try {
        const data = await api("/notifications");
        state.generalNotifications = data.general || []; state.generalError = data.generalError || "";
        state.devDoneNotifications = data.devDone || []; state.dateFollowNotifications = data.dateFollow || []; state.slaSkillNotifications = data.slaSkill || [];
        state.scanSchedules = Array.isArray(data.schedules) ? data.schedules : [];
        renderNavigation();
        if (state.screen === "notifications") renderNotifications();
      } catch (error) { if (state.screen === "notifications") setNotificationStatus(`Could not load notifications: ${error.message}`, true); }
      finally { state.notificationRequest = null; if (refresh) refresh.disabled = false; }
    })();
    return state.notificationRequest;
  }
  async function readAllNotifications() {
    setNotificationStatus("Marking all notifications as read…");
    try { await api("/notifications/read", { method: "POST", body: { ids: state.notifications.map(notificationId) } }); state.notifications.forEach((n) => { n.read = true; }); renderNavigation(); if (state.screen === "notifications") { renderNotifications(); setNotificationStatus("All notifications marked as read."); } }
    catch (error) { setNotificationStatus(`Could not update notification state: ${error.message}`, true); }
  }
  async function markNotificationRead(notification) {
    if (!notification?.id || notification.read) return;
    try { await api("/notifications/read", { method: "POST", body: { ids: [notificationId(notification)] } }); notification.read = true; renderNavigation(); if (state.screen === "notifications") renderNotifications(); }
    catch (error) { if (state.screen === "notifications") setNotificationStatus(`Could not update notification state: ${error.message}`, true); }
  }
  async function followDevFixTickets() {
    try {
      const result = await api("/dev/follow-scan", { method: "POST", body: {} });
      state.devFollowDue = Object.fromEntries((result.due || []).map((item) => [item.ticketId || item.id, item]));
      if (state.screen === "home") renderHome();
      if (result.updates) await Promise.all([loadTickets(), loadNotifications({ showLoading: false })]);
    } catch (error) { console.warn("Dev follow-up did not run:", error.message || error); }
  }

  // --- chat ---------------------------------------------------------------
  function appendAiInlineText(container, text) {
    String(text || "").split(/(`[^`]+`|\*\*[^*]+\*\*|https?:\/\/[^\s)]+)/g).forEach((fragment) => {
      if (!fragment) return;
      if (fragment.startsWith("`") && fragment.endsWith("`")) container.append(el("code", "", fragment.slice(1, -1)));
      else if (fragment.startsWith("**") && fragment.endsWith("**")) container.append(el("strong", "", fragment.slice(2, -2)));
      else if (/^https?:\/\//.test(fragment)) { const a = el("a", "", fragment); a.href = fragment; a.target = "_blank"; a.rel = "noreferrer"; container.append(a); }
      else container.append(document.createTextNode(fragment));
    });
  }
  function aiSectionTitle(line) {
    const title = String(line || "").trim().replace(/^#{1,6}\s*/, "").replace(/^\*\*|\*\*:?$/g, "").replace(/:$/, "").trim();
    return /^(kết luận|context|ngữ cảnh|bằng chứng|khuyến nghị|đề xuất|next steps?|recommendation|sources)$/i.test(title) ? title : "";
  }
  function setAssistantResponseText(bubble, text) {
    bubble.className = "bubble assistant ai-response"; bubble.replaceChildren();
    let list = null;
    String(text || "").split(/\r?\n/).forEach((rawLine) => {
      const line = rawLine.trim(); if (!line) { list = null; return; }
      const section = aiSectionTitle(line); if (section) { bubble.append(el("div", "ai-response-section", section)); list = null; return; }
      const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
      if (bullet) { if (!list) { list = el("ul", "ai-response-list"); bubble.append(list); } const item = el("li"); appendAiInlineText(item, bullet[1]); list.append(item); return; }
      const paragraph = el("p", "ai-response-copy"); appendAiInlineText(paragraph, line); bubble.append(paragraph); list = null;
    });
    if (!bubble.childNodes.length) bubble.textContent = "AI did not return a response.";
  }
  function createChatBubble(role, text, timestamp = null, animate = true, canonical = false) {
    const row = el("div", `chat-message ${role}${animate ? " is-new" : ""}`);
    const avatar = el("span", "message-avatar"); avatar.innerHTML = chatIcon(role === "user" ? "user" : "bot"); avatar.setAttribute("aria-hidden", "true");
    const body = el("div", "message-body"); const bubble = el("div", `bubble ${role}`);
    if (role === "assistant" && canonical) { bubble.className = "bubble assistant ai-response han-auto-report"; HanAutoView.renderComment(bubble, text); }
    else if (role === "assistant") setAssistantResponseText(bubble, text);
    else if (role === "thinking") { bubble.innerHTML = '<span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>'; row.setAttribute("role", "status"); row.setAttribute("aria-label", "AI đang trả lời"); }
    else bubble.textContent = text;
    body.append(bubble);
    if (role !== "thinking") {
      const time = el("time", "message-time"); const date = timestamp ? new Date(timestamp) : null; const valid = date && !Number.isNaN(date.getTime());
      time.textContent = `${role === "user" ? "You" : "Andrew AI"} · ${valid ? date.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }) : "Earlier message"}`;
      body.append(time);
    }
    // Speaker button: reads this answer aloud on this device (speech-player.js).
    if (role === "assistant" && speechPlayer) body.append(speechPlayer.button(() => ({ text: bubble.innerText })));
    row.append(avatar, body); return row;
  }
  function appendChatMessage(messages, role, text) { const message = { role, text, timestamp: Date.now() }; state.chatMessages.push(message); const row = createChatBubble(role, text, message.timestamp); messages.append(row); return row; }
  function renderChatEmptyState(messages, input) {
    const empty = el("section", "chat-empty");
    empty.innerHTML = `<div class="chat-empty-art">${chatIcon("bot")}</div><h3>Welcome to Andrew AI</h3><p>Gỡ rối ticket, tìm câu trả lời.<br>Bắt đầu bằng một câu hỏi bên dưới.</p>`;
    const suggestions = el("div", "chat-suggestions");
    ["Check ticket CHATTY-000000-xxxxxx", "Tóm tắt vấn đề của ticket", "Gợi ý hướng xử lý"].forEach((prompt) => {
      const chip = el("button", "chat-suggestion", prompt); chip.type = "button";
      chip.addEventListener("click", () => { input.value = prompt; input.dispatchEvent(new Event("input")); input.focus(); const at = prompt.indexOf("CHATTY"); if (at !== -1) input.setSelectionRange(at, prompt.length); });
      suggestions.append(chip);
    });
    empty.append(suggestions); messages.append(empty);
  }
  const conversationTicketRef = (c) => c?.selectedTicket?.ticketId || c?.selectedTicket?.id || "";
  // The server picks an address this device can open (local name on this machine, LAN name/IP elsewhere).
  // A stored access key is passed once so the tracing web accepts this device.
  const traceWebUrl = () => `${state.bootstrap?.traceWebUrl || "http://andrewtstracing.localhost:5077"}/${accessKey() ? `?key=${encodeURIComponent(accessKey())}` : ""}`;
  const conversationTraceUrl = (c) => { const ticket = conversationTicketRef(c); return `${traceWebUrl()}#chat/${encodeURIComponent(c.chatId)}${ticket ? `?ticket=${encodeURIComponent(ticket)}` : ""}`; };
  const ticketTraceUrl = (ref) => `${traceWebUrl()}#ticket/${encodeURIComponent(ref)}`;
  // Automatic reviews synced by the server (origin "automatic") open their own trace inside the ticket view.
  const isAutomaticConversation = (c) => c?.origin === "automatic";
  const AUTOMATIC_STATUS_LABELS = { running: "Đang check", done: "Đã comment", uncertain: "Chưa xác nhận comment", failed: "Cần kiểm tra" };
  const historyTraceUrl = (c) => {
    const ref = conversationTicketRef(c); if (!ref) return conversationTraceUrl(c);
    const jobId = isAutomaticConversation(c) ? c.automatic?.jobId : "";
    return `${ticketTraceUrl(ref)}${jobId ? `?open=automatic:${encodeURIComponent(jobId)}` : ""}`;
  };
  function conversationTitle(c) {
    const ticket = c?.selectedTicket; if (ticket?.ticketId || ticket?.id) return `${ticket.ticketId || ticket.id} · ${ticket.subject || "Ticket review"}`;
    return (c?.messages || []).find((m) => m?.role === "user")?.text || "New AI conversation";
  }
  async function saveActiveConversation() {
    if (!state.chatMessages.some((m) => m?.role === "user")) return;
    try { const { conversations } = await api("/chats", { method: "PUT", body: { conversation: { chatId: state.chatId, selectedTicket: state.selectedTicket || null, messages: state.chatMessages.slice(-MAX_SAVED_MESSAGES_PER_CONVERSATION) } } }); state.savedConversations = conversations || []; }
    catch (error) { console.warn("Could not save conversation:", error.message); }
  }
  async function startNewConversation() { await saveActiveConversation(); state.chatId = createChatId(); state.selectedTicket = null; state.chatMessages = []; state.chatHistoryOpen = false; showScreen("chat"); }
  async function openChatHistory() { await saveActiveConversation(); try { state.savedConversations = (await api("/chats")).conversations || []; } catch {} state.chatHistoryOpen = true; renderHeader(); renderNavigation(); renderChat(); }
  function closeChatHistory() { state.chatHistoryOpen = false; renderHeader(); renderNavigation(); renderChat(); }
  function renderChatHistory() {
    const list = el("section", "chat-history-list");
    list.append(el("h3", "chat-history-title", "Conversation history"), el("p", "chat-history-copy", "Select a previous conversation to continue it. History is shared by every device using this web."));
    if (!state.savedConversations.length) list.append(el("p", "empty", "No saved conversations yet."));
    else state.savedConversations.forEach((conversation) => {
      const row = el("div", "chat-history-row");
      const item = el("button", "chat-history-item"); item.type = "button";
      item.append(el("strong", "", conversationTitle(conversation)), el("span", "", (conversation.messages || []).at(-1)?.text || "Open conversation"));
      const ref = conversationTicketRef(conversation); if (ref) item.append(el("span", "chat-history-ticket", `Ticket ${ref}`));
      if (isAutomaticConversation(conversation)) item.append(el("span", `chat-history-auto ${conversation.automatic?.status || ""}`, `Auto check · ${conversation.automatic?.statusLabel || AUTOMATIC_STATUS_LABELS[conversation.automatic?.status] || "Đã ghi nhận"}`));
      item.addEventListener("click", () => { state.chatId = conversation.chatId; state.selectedTicket = conversation.selectedTicket || null; state.chatMessages = (conversation.messages || []).slice(-MAX_SAVED_MESSAGES_PER_CONVERSATION); state.chatHistoryOpen = false; renderHeader(); renderNavigation(); renderChat(); });
      const tracing = el("button", `chat-history-trace${ref ? " ticket" : ""}`, "Tracing"); tracing.type = "button"; tracing.title = ref ? `Mở toàn bộ tracing của ticket ${ref}` : "Mở tracing của conversation này";
      tracing.addEventListener("click", (event) => { event.stopPropagation(); openExternal(historyTraceUrl(conversation)); });
      const remove = el("button", "chat-history-delete", "×"); remove.type = "button"; remove.title = "Xóa conversation";
      remove.addEventListener("click", async (event) => { event.stopPropagation(); if (!window.confirm("Xóa conversation này khỏi lịch sử?")) return; try { state.savedConversations = (await api("/chats", { method: "DELETE", body: { chatId: conversation.chatId } })).conversations || []; renderChat(); } catch (error) { toast(error.message, true); } });
      row.append(item, tracing, remove); list.append(row);
    });
    screen.append(list);
  }
  const followDate = (value) => formatTime(value) || "Chưa có";
  async function openFollowDev(ticket) {
    state.chatSection = "follow"; state.followDevDetail = { ticket }; state.followDevLoading = true; state.followDevMail = "";
    showScreen("chat");
    try { state.followDevDetail = await api("/dev/follow-detail", { method: "POST", body: { ticket } }); }
    catch (error) { state.followDevDetail = { ticket, error: error.message }; }
    finally { state.followDevLoading = false; if (state.screen === "chat" && state.chatSection === "follow") renderChat(); }
  }
  function renderFollowDev() {
    const detail = state.followDevDetail || {}; const ticket = detail.ticket || {};
    const panel = el("section", "follow-dev-panel");
    if (!ticket || !Object.keys(ticket).length) { panel.append(el("p", "empty", "Chọn “Follow dev” trên một ticket Dev fix để xem chi tiết thread Slack.")); screen.append(panel); return; }
    if (state.followDevLoading) { panel.textContent = "Đang kiểm tra ticket và Slack thread…"; screen.append(panel); return; }
    if (detail.error) { panel.textContent = `Không thể tải follow dev: ${detail.error}`; screen.append(panel); return; }
    const controls = el("div", "follow-dev-controls");
    const ticketButton = el("button", "active", "Ticket"); ticketButton.type = "button"; ticketButton.addEventListener("click", () => openExternal(ticketUrl(ticket)));
    const threadButton = el("button", "", "Thread"); threadButton.type = "button"; threadButton.disabled = !ticket.slackLink; threadButton.addEventListener("click", () => openExternal(ticket.slackLink));
    const mailButton = el("button", "", "Mail"); mailButton.type = "button";
    mailButton.addEventListener("click", async () => {
      mailButton.disabled = true; mailButton.textContent = "Đang soạn…";
      try { const result = await api("/dev/follow-mail", { method: "POST", body: { ticket, slack: detail.slack } }); state.followDevMail = result.mail || "TS Elite 2 chưa tạo được mail."; }
      catch (error) { state.followDevMail = `Không thể tạo mail: ${error.message}`; }
      renderChat();
    });
    controls.append(ticketButton, threadButton, mailButton); panel.append(controls);
    const followBlocked = /\b(blocked|block)\b/i.test(String(detail.slack?.lastUpdatedText || ""));
    const followStatus = detail.slack?.done ? "Done" : followBlocked ? "Blocked" : "Chưa done";
    const rows = [
      ["Title ticket", ticket.subject || "—"], ["Description", ticket.description || "—"], ["Member", ticketMemberSummary(ticket)],
      ["Ngày báo dev", followDate(detail.slack?.reportedAt)], ["Dev Assigned", (detail.slack?.assignees || []).join(", ") || "Chưa xác định"], ["Status", followStatus], ["Notion hoặc MR", ""],
      ["Tình trạng báo khách", detail.customerNotified ? `Đã báo khách (${followDate(detail.customerUpdateAt)})` : "Chưa thấy xác nhận đã báo khách"],
      ["Last Follow at", followDate(detail.lastFollowAt)], ["Last Updated", detail.slack?.lastUpdatedText ? `${followDate(detail.slack.lastUpdatedAt)} · ${detail.slack.lastUpdatedText}` : "Chưa có update"],
    ];
    const cardForLabel = (label) => label === "Title ticket" || label === "Description" ? "overview" : label === "Member" || label === "Ngày báo dev" || label === "Dev Assigned" ? "assignment" : "status";
    const cards = new Map(); const cardTitles = { overview: "Ticket overview", assignment: "Phân công", status: "Theo dõi" };
    rows.forEach(([label, value]) => {
      const key = cardForLabel(label); let card = cards.get(key);
      if (!card) { card = el("section", "follow-dev-card"); card.append(el("h3", "", cardTitles[key])); cards.set(key, card); panel.append(card); }
      const row = el("div", "follow-dev-row"); const content = el("span", "", value);
      if (label === "Description") content.className = "follow-dev-description";
      if (label === "Status") content.classList.add(detail.slack?.done ? "status-done" : followBlocked ? "status-blocked" : "status-pending");
      if (label === "Notion hoặc MR") {
        const links = detail.slack?.workLinks || [];
        if (!links.length) content.textContent = "Không có";
        else { content.textContent = ""; links.forEach((link, index) => { const a = el("a", "", index ? " · Link" : "Link"); a.href = link; a.target = "_blank"; a.rel = "noreferrer"; content.append(a); }); }
      }
      row.append(el("strong", "", `${label}: `), content); card.append(row);
    });
    if (state.followDevMail) {
      const mail = el("pre", "follow-dev-mail", state.followDevMail); panel.append(mail);
      const copy = el("button", "secondary", "Copy mail"); copy.type = "button"; copy.addEventListener("click", async () => { toast((await copyText(state.followDevMail)) ? "Đã copy mail." : "Không copy được, hãy chọn và copy thủ công.", false); }); panel.append(copy);
    }
    screen.append(panel);
  }
  // --- news ---------------------------------------------------------------
  // Daily bulletin (technology, new AI models, Claude) served by this web (/api/news/*); the view is /news-view.js,
  // the same file as the extension. Read state is kept per device in localStorage.
  let newsView = null; let newsButton = null;
  // The NEWS button lives in the Tickets header, so its styles are needed before the panel is ever opened.
  if (globalThis.NewsView && !document.getElementById("news-view-style")) { const style = document.createElement("style"); style.id = "news-view-style"; style.textContent = globalThis.NewsView.css; document.head.append(style); }
  const newsStorage = { get: (key) => { try { return JSON.parse(localStorage.getItem(`ts-web:${key}`) || "null"); } catch { return null; } }, set: (key, value) => { try { localStorage.setItem(`ts-web:${key}`, JSON.stringify(value)); } catch { /* per-device convenience */ } } };
  async function refreshNewsBadge() {
    if (!newsButton || !globalThis.NewsView) return;
    try { const result = await api("/news/today?meta=1"); newsButton.setUnread(globalThis.NewsView.unread(result.meta, newsStorage.get(globalThis.NewsView.READ_KEY))); }
    catch { newsButton.setUnread(false); }
  }
  function renderNews() {
    screen.className = "screen"; screen.replaceChildren();
    newsView?.destroy(); newsView = null;
    if (!globalThis.NewsView) { screen.append(el("p", "empty", "Chưa nạp được mục NEWS; tải lại trang.")); return; }
    const loopback = ["127.0.0.1", "localhost", "andrewtsmanagement.com"].includes(location.hostname);
    newsView = globalThis.NewsView.mount(screen, {
      api: (path) => api(`/news${path}`),
      refresh: loopback ? () => api("/news/refresh", { method: "POST", body: {} }) : null,
      storage: newsStorage,
      dark: window.matchMedia?.("(prefers-color-scheme: dark)").matches && document.documentElement.dataset.theme !== "light",
    });
  }
  // --- analytics ----------------------------------------------------------
  // Accuracy of the AI checks (Đại tá's reactions on the posted review comments) and the Train AI feedback form;
  // the shared view (/analytics-view.js, same file as the extension) reaches the tracing web through /api/analytics.
  let analyticsView = null;
  function renderAnalytics() {
    screen.className = "screen"; screen.replaceChildren();
    analyticsView?.destroy(); analyticsView = null;
    if (!globalThis.AnalyticsView) { screen.append(el("p", "empty", "Chưa nạp được mục Analytics; tải lại trang.")); return; }
    if (!document.getElementById("analytics-view-style")) { const style = document.createElement("style"); style.id = "analytics-view-style"; style.textContent = globalThis.AnalyticsView.css; document.head.append(style); }
    analyticsView = globalThis.AnalyticsView.mount(screen, {
      api: (path, options) => api(`/analytics${path}`, options),
      openUrl: (url) => window.open(url, "_blank", "noopener,noreferrer"),
      dark: window.matchMedia?.("(prefers-color-scheme: dark)").matches && document.documentElement.dataset.theme !== "light",
    });
  }
  // --- DFY Accessibility (internal key dfu) --------------------------------------------------
  // Done For You tickets + scan report upload + AI analysis (web/app/dfu-accessibility.js, server /api/dfu/*).
  let dfuView = null;
  function renderDfu() {
    screen.className = "screen"; screen.replaceChildren();
    dfuView?.destroy(); dfuView = null;
    if (!globalThis.DfuAccessibilityView) { screen.append(el("p", "empty", "Chưa nạp được mục DFY Accessibility; tải lại trang.")); return; }
    if (!document.getElementById("dfu-view-style")) { const style = document.createElement("style"); style.id = "dfu-view-style"; style.textContent = globalThis.DfuAccessibilityView.css; document.head.append(style); }
    dfuView = globalThis.DfuAccessibilityView.mount(screen, { api: (path, options) => api(`/dfu${path}`, options), openUrl: openExternal, helpdeskUrl: HELP_DESK_URL });
  }
  // --- checking ticket ----------------------------------------------------
  // Hachimi's check-ticket runs, read from the tracing web through the server (/api/checking). Watching is
  // read-only; questions typed here go through the normal chat of that ticket's conversation.
  let stopHanAuto = null;
  let checkingRun = 0; // bumped on every render of this page, which stops the polling of the view it replaced
  async function pollChecking(token, node, work, delay) {
    while (token === checkingRun && node.isConnected) {
      if (document.visibilityState === "visible") await work();
      await new Promise((done) => setTimeout(done, delay()));
    }
  }
  const checkingTraceUrl = (run) => !run.ticket ? traceWebUrl() : `${ticketTraceUrl(run.ticket)}${run.source === "automatic" ? `?open=automatic:${encodeURIComponent(run.externalId)}` : ""}`;
  const checkingPill = (run) => el("span", `checking-pill ${run.status}`, run.statusLabel);
  async function hanAutoRequest(path, { method = "GET", body, signal } = {}) {
    const response = await fetch(`/api${path}`, { method, signal,
      headers: { "Content-Type": "application/json", "X-Han-Assessment-Request": "1", ...(accessKey() ? { "X-TS-Web-Key": accessKey() } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || `Không đọc được Han auto (HTTP ${response.status}).`), { status: response.status });
    return data;
  }
  async function openCheckingRun(run) {
    await saveActiveConversation();
    let saved = null;
    try { state.savedConversations = (await api("/chats")).conversations || []; saved = state.savedConversations.find((c) => c.chatId === run.chatId) || null; } catch {}
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
      const panel = el("section", "han-auto-panel"); screen.append(panel);
      stopHanAuto = HanAutoView.mountTickets(panel, { request: hanAutoRequest });
      return;
    }
    // The chat tab may have moved on to another conversation since this run was opened.
    if (state.checking.open && state.checking.open.chatId !== state.chatId) state.checking.open = null;
    if (state.checking.open) { renderCheckingRun(state.checking.open); return; }
    const list = el("section", "chat-history-list checking-list"); screen.append(list);
    let painted = null;
    const paint = () => {
      const signature = JSON.stringify([state.checking.sessions, state.checking.error, state.checking.loaded]);
      if (signature === painted) return; painted = signature;
      list.replaceChildren(el("p", "chat-history-copy", "Các lượt Hachimi check ticket. Mở một lượt để xem quá trình check và hỏi thêm Hachimi về ticket đó."));
      if (state.checking.error) list.append(el("p", "status error", state.checking.error));
      if (!state.checking.sessions.length && !state.checking.error) list.append(el("p", "empty", state.checking.loaded ? "Chưa có lượt check ticket nào." : "Đang tải các lượt check…"));
      state.checking.sessions.forEach((run) => {
        const item = el("button", "chat-history-item checking-item"); item.type = "button";
        const meta = el("span", "checking-meta"); meta.append(checkingPill(run), document.createTextNode([run.sourceLabel, run.category, formatTime(run.startedAt)].filter(Boolean).join(" · ")));
        item.append(el("strong", "", `${run.ticket || "Không có mã ticket"} · ${run.subject || "Check ticket"}`), el("span", "", run.lastText || "Chưa có bước nào."), meta);
        item.addEventListener("click", () => { item.disabled = true; void openCheckingRun(run); });
        list.append(item);
      });
    };
    paint();
    void pollChecking(checkingRun, list, async () => {
      try { state.checking.sessions = (await api("/checking/sessions")).sessions || []; state.checking.error = ""; }
      catch (error) { state.checking.error = `Không tải được các lượt check: ${error.message}`; }
      state.checking.loaded = true; paint();
    }, () => 5_000);
  }
  function createCheckingStep(event) {
    const row = el("div", `checking-step kind-${event.kind}`); const body = el("div", "checking-step-body");
    const head = el("div", "checking-step-head"); head.append(el("strong", "", event.label));
    if (event.phase) head.append(el("span", "checking-step-phase", event.phase));
    const at = new Date(event.at); head.append(el("time", "", Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString("vi-VN")));
    body.append(head);
    if (event.kind === "result") { const report = el("div"); setAssistantResponseText(report, event.text); report.className = "checking-report ai-response"; body.append(report); }
    else if (event.text) {
      const text = el("p", "checking-step-text", event.text); body.append(text);
      if (event.text.length > 600) {
        text.classList.add("clamped");
        const more = el("button", "checking-step-more", "Xem thêm"); more.type = "button";
        more.addEventListener("click", () => { more.textContent = text.classList.toggle("clamped") ? "Xem thêm" : "Thu gọn"; });
        body.append(more);
      }
    }
    row.append(el("span", "checking-step-dot"), body); return row;
  }
  function renderCheckingRun(opened) {
    let run = opened; let cursor = -1; let waitingRow = null;
    const bar = el("div", "chat-context checking-bar");
    const back = el("button", "checking-back", "‹ Danh sách"); back.type = "button"; back.addEventListener("click", () => { state.checking.open = null; renderChecking(); });
    const pillSlot = el("span", "checking-pill-slot"); pillSlot.append(checkingPill(run));
    const ticket = el("button", "checking-link", "Ticket"); ticket.type = "button"; ticket.disabled = !run.ticket; ticket.addEventListener("click", () => openExternal(`${HELP_DESK_URL}/t/${encodeURIComponent(run.ticket)}`));
    const tracing = el("button", "checking-link", "Tracing"); tracing.type = "button"; tracing.addEventListener("click", () => openExternal(checkingTraceUrl(run)));
    bar.append(back, el("span", "checking-title", `${run.ticket || run.sourceLabel} · ${run.subject || "Check ticket"}`), pillSlot, ticket, tracing);
    const messages = el("div", "chat-messages"); messages.setAttribute("role", "log"); messages.setAttribute("aria-label", "Quá trình check ticket và hội thoại");
    const steps = el("section", "checking-steps"); const status = el("p", "checking-steps-status", "Đang tải quá trình check…");
    steps.append(el("h4", "", "Quá trình Hachimi check ticket"), status);
    messages.append(steps, el("p", "checking-chat-hint", "Hỏi thêm Hachimi về ticket này ở ô bên dưới. Việc hỏi không chạy lại lượt check và không đăng comment."));
    // The review's own messages are already shown as steps; only the questions asked afterwards are chat bubbles.
    state.chatMessages.filter((m) => !m.auto).forEach((m) => messages.append(createChatBubble(m.role, m.text, m.timestamp, false)));
    const { form } = createChatForm(messages, "Hỏi Hachimi về lượt check này…");
    screen.append(bar, messages, form);
    void pollChecking(checkingRun, messages, async () => {
      try {
        const data = await api(`/checking/sessions/${run.id}/events?after=${cursor}`);
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
    const form = el("form", "chat-form");
    const input = el("textarea", "chat-input"); input.rows = 1; input.placeholder = placeholder; input.setAttribute("aria-label", "Message Andrew AI");
    input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; });
    const send = el("button", "send"); send.type = "submit"; send.innerHTML = chatIcon("send"); send.setAttribute("aria-label", "Send message");
    input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } });
    form.addEventListener("submit", async (event) => { event.preventDefault(); const text = input.value.trim(); if (!text || send.disabled) return; input.value = ""; input.style.height = "auto"; await sendChat(text, messages, send); });
    form.append(input, send);
    return { form, input };
  }
  function renderChat() {
    screen.className = "screen chat-screen"; screen.replaceChildren();
    const tabs = el("div", "chat-tabs"); tabs.setAttribute("role", "tablist"); tabs.dataset.active = state.chatSection;
    [["chat", "Chat bot"], ["follow", "Follow dev"]].forEach(([key, label]) => {
      const tab = el("button", `chat-tab${state.chatSection === key ? " active" : ""}`, label); tab.type = "button"; tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(state.chatSection === key));
      tab.addEventListener("click", () => { state.chatSection = key; renderHeader(); renderChat(); }); tabs.append(tab);
    });
    screen.append(tabs);
    if (state.chatSection === "follow") { renderFollowDev(); return; }
    if (state.chatHistoryOpen) { renderChatHistory(); return; }
    if (state.selectedTicket) {
      const context = el("div", "chat-context");
      const clear = el("button", "clear-context", "×"); clear.type = "button"; clear.title = "Clear selected ticket"; clear.addEventListener("click", () => { state.selectedTicket = null; renderChat(); });
      context.append(el("span", "", `Checking: ${ticketRef(state.selectedTicket)} · ${state.selectedTicket.subject || "No subject"}`), clear); screen.append(context);
    }
    const messages = el("div", "chat-messages"); messages.setAttribute("role", "log"); messages.setAttribute("aria-label", "Conversation");
    state.chatMessages.forEach((m) => messages.append(createChatBubble(m.role, m.text, m.timestamp, false, m.canonical === true)));
    const { form, input } = createChatForm(messages, state.selectedTicket ? "Ask AI to check this ticket…" : "Ask AI about a ticket…");
    if (!state.chatMessages.length) renderChatEmptyState(messages, input);
    screen.append(messages, form); messages.scrollTop = messages.scrollHeight;
  }
  // "đọc" / "đọc <số>" / "dừng": read aloud instead of asking the AI. The server synthesizes the audio with Piper.
  const speechPlayer = globalThis.SpeechPlayer ? globalThis.SpeechPlayer.create({
    prepare: (payload) => api("/speech/prepare", { method: "POST", body: payload }),
    audio: async (id, index) => {
      const response = await fetch(`/api/speech/audio/${id}/${index}`, { headers: accessKey() ? { "X-TS-Web-Key": accessKey() } : {} });
      if (!response.ok) throw new Error(`Không lấy được tiếng đọc (HTTP ${response.status}).`);
      return response.arrayBuffer();
    },
  }) : null;
  if (speechPlayer && !document.getElementById("speech-player-style")) { const style = document.createElement("style"); style.id = "speech-player-style"; style.textContent = globalThis.SpeechPlayer.css; document.head.append(style); }
  async function runSpeechCommand(command, text, messages, send) {
    send.disabled = true; messages.querySelector(".chat-empty")?.remove();
    const answer = [...state.chatMessages].reverse().find((message) => message.role === "assistant" && !message.speechNote && message.text) || null;
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
    const thinking = createChatBubble("thinking", ""); messages.append(thinking); messages.scrollTop = messages.scrollHeight;
    try {
      const result = await api("/ai/chat", { method: "POST", body: { message: text, chatId: state.chatId, ticket: state.selectedTicket, ...ticketReviewRequest(text, state.selectedTicket) } });
      if (result.answer) { thinking.remove(); appendChatMessage(messages, "assistant", result.answer); messages.scrollTop = messages.scrollHeight; }
      else await streamAiResponse(result.jobId, messages, thinking);
    } catch (error) {
      thinking.remove();
      appendChatMessage(messages, "assistant", error.message === "AI_LOGIN_REQUIRED" ? "Hãy kết nối TS Elite 2 trong Settings trước khi chat." : error.message); messages.scrollTop = messages.scrollHeight;
    } finally { try { await saveActiveConversation(); } finally { send.disabled = false; } }
  }
  function streamAiResponse(jobId, messages, thinking) {
    return new Promise((resolve) => {
      const source = new EventSource(withKey(`/api/ai/stream/${encodeURIComponent(jobId)}`));
      let text = ""; let response = null; let finished = false; const timestamp = Date.now();
      const finish = () => { if (finished) return; finished = true; thinking.remove(); if (text) state.chatMessages.push({ role: "assistant", text, timestamp }); source.close(); resolve(); };
      source.onmessage = (raw) => {
        let event = {}; try { event = JSON.parse(raw.data); } catch { return; }
        if (event.type === "text") { thinking.remove(); if (!response) { response = createChatBubble("assistant", "", timestamp); messages.append(response); } text += event.content || ""; setAssistantResponseText(response.querySelector(".bubble"), text); messages.scrollTop = messages.scrollHeight; }
        else if (event.type === "done") { if (!text && event.result) { text = event.result; messages.append(createChatBubble("assistant", text, timestamp)); } finish(); }
        else if (event.type === "error") { thinking.remove(); appendChatMessage(messages, "assistant", event.message || "AI could not complete this request."); finish(); }
        else if (event.type === "stream_end") finish();
      };
      source.onerror = () => { if (!finished && !text) { thinking.remove(); appendChatMessage(messages, "assistant", "Mất kết nối luồng trả lời AI. Hãy thử lại."); } finish(); };
    });
  }

  // --- settings -----------------------------------------------------------
  function switchRow(id, label) {
    const row = el("label", "setting-switch"); row.htmlFor = id;
    row.innerHTML = `<span>${label}</span><input id="${id}" type="checkbox" role="switch" aria-label="${label}"><span class="switch-track" aria-hidden="true"></span>`;
    return { row, input: row.querySelector("input") };
  }
  async function toggleWakeLock(enabled, status) {
    if (!enabled) { try { await state.wakeLock?.release(); } catch {} state.wakeLock = null; status.textContent = "Đã dùng lại thời gian tắt màn hình của thiết bị."; status.className = "settings-status ok"; return false; }
    if (!("wakeLock" in navigator)) {
      status.textContent = window.isSecureContext ? "Trình duyệt này không hỗ trợ Screen Wake Lock." : "Trình duyệt chỉ cho giữ màn hình sáng trên HTTPS hoặc localhost. Khi có domain HTTPS, tùy chọn này sẽ hoạt động; tạm thời hãy tắt tự khóa màn hình trong cài đặt thiết bị.";
      status.className = "settings-status error"; return false;
    }
    try { state.wakeLock = await navigator.wakeLock.request("screen"); state.wakeLock.addEventListener("release", () => { state.wakeLock = null; }); status.textContent = "Màn hình sẽ được giữ luôn bật khi tab này đang mở."; status.className = "settings-status ok"; return true; }
    catch (error) { status.textContent = `Không thể giữ màn hình: ${error.message}`; status.className = "settings-status error"; return false; }
  }
  document.addEventListener("visibilitychange", async () => { if (document.visibilityState === "visible" && state.wakeLockWanted && !state.wakeLock && "wakeLock" in navigator) { try { state.wakeLock = await navigator.wakeLock.request("screen"); } catch {} } });
  // MCP_V2_TRANSPORT_BEGIN
  async function mcpV2SettingsRequest(action, payload) {
    let response;
    try {
      response = await fetch("/api/mcp-v2/settings", {
        method: action === "save" ? "PUT" : "GET", cache: "no-store",
        headers: { "Content-Type": "application/json", ...(accessKey() ? { "X-TS-Web-Key": accessKey() } : {}) },
        signal: AbortSignal.timeout(10_000),
        ...(action === "save" ? { body: JSON.stringify({ enabled: payload.enabled, expectedRevision: payload.revision }) } : {}),
      });
    } catch {
      throw new Error("Không kết nối được máy chủ cấu hình MCP V2.");
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || `MCP V2 trả về HTTP ${response.status}.`);
    return data;
  }
  // MCP_V2_TRANSPORT_END
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
    const settings = el("section", "settings"); settings.innerHTML = '<h3>Web settings</h3><p class="settings-copy">Helpdesk key, giao diện, AI provider, dịch vụ local và link chia sẻ trong mạng LAN.</p>';
    const stored = state.bootstrap?.settings || {};

    // Helpdesk key + theme
    const ticketCard = el("section", "setting-card"); ticketCard.innerHTML = '<h4>Helpdesk API key</h4><p>Key được lưu trên máy chủ web (runtime/ts-web/settings.json), dùng chung cho mọi thiết bị. Để trống để giữ key hiện tại.</p>';
    const keyLabel = el("label", "field", "Avada Helpdesk API key"); keyLabel.htmlFor = "ticket-api-key";
    const key = el("input", "field"); key.id = "ticket-api-key"; key.type = "password"; key.autocomplete = "off"; key.placeholder = "avd_…";
    const themeSwitch = switchRow("web-theme", "Dark mode"); themeSwitch.input.checked = document.documentElement.dataset.theme === "dark";
    themeSwitch.input.addEventListener("change", () => { applyTheme(themeSwitch.input.checked ? "dark" : "light"); void api("/settings", { method: "POST", body: { widgetTheme: themeSwitch.input.checked ? "dark" : "light" } }).catch(() => {}); });
    const save = el("button", "primary", "Save settings"); save.type = "button";
    const ticketStatus = el("p", `settings-status${stored.hasApiKey ? " ok" : ""}`, stored.hasApiKey ? `A Helpdesk API key is saved (${stored.apiKeySource === ".env_my" ? "từ .env_my" : "đã nhập trong Settings"}).` : "No Helpdesk API key saved yet.");
    save.addEventListener("click", async () => {
      const apiKey = key.value.trim();
      if (!apiKey && !stored.hasApiKey) { ticketStatus.textContent = "Enter an API key first."; ticketStatus.className = "settings-status error"; return; }
      try { const result = await api("/settings", { method: "POST", body: { ...(apiKey ? { apiKey } : {}) } }); state.bootstrap.settings = result.settings; key.value = ""; ticketStatus.textContent = "Ticket settings saved."; ticketStatus.className = "settings-status ok"; void loadTickets(); }
      catch (error) { ticketStatus.textContent = error.message; ticketStatus.className = "settings-status error"; }
    });
    ticketCard.append(keyLabel, key, themeSwitch.row, el("div", "row"), save, ticketStatus);

    // Wake lock
    const awakeCard = el("section", "setting-card"); awakeCard.innerHTML = '<h4>Giữ màn hình luôn bật</h4><p>Khi bật, trình duyệt sẽ yêu cầu thiết bị không tự tắt màn hình trong lúc tab này mở (Screen Wake Lock, cần HTTPS hoặc localhost).</p>';
    const awake = switchRow("keep-screen-awake", "Luôn bật màn hình"); awake.input.checked = Boolean(state.wakeLock);
    const awakeStatus = el("p", "settings-status", state.wakeLock ? "Màn hình đang được giữ luôn bật." : "Đang dùng thời gian tắt màn hình của thiết bị.");
    awake.input.addEventListener("change", async () => { awake.input.disabled = true; state.wakeLockWanted = awake.input.checked; const ok = await toggleWakeLock(awake.input.checked, awakeStatus); if (awake.input.checked && !ok) { awake.input.checked = false; state.wakeLockWanted = false; } awake.input.disabled = false; });
    awakeCard.append(awake.row, awakeStatus);

    // Auto connect + auto scans
    const autoCard = el("section", "setting-card"); autoCard.innerHTML = '<h4>Tự động hóa trên máy chủ web</h4><p>Máy chủ web tự khởi chạy Telegram bot, Hachimi local, webhook bridge, database và tracing web khi bật. Quét tự động gồm Dev Fix (mỗi giờ), Date Follow (5 phút), Skill SLA (2 giờ) và trả lời AI cho Telegram.</p>';
    const autoConnect = switchRow("auto-connect-local-services", "Tự kết nối dịch vụ local"); autoConnect.input.checked = stored.autoConnectLocalServices !== false;
    const autoScans = switchRow("auto-scans", "Quét tự động (Dev Fix / Date Follow / SLA)"); autoScans.input.checked = stored.autoScans !== false;
    const autoStatus = el("p", "settings-status", "Lưu ý: nếu extension Chrome cũng đang chạy quét tự động, hãy tắt một bên để tránh tạo mail nháp trùng.");
    const bindToggle = (toggle, field, okText) => toggle.input.addEventListener("change", async () => {
      toggle.input.disabled = true;
      try { const result = await api("/settings", { method: "POST", body: { [field]: toggle.input.checked } }); state.bootstrap.settings = result.settings; autoStatus.textContent = okText(toggle.input.checked); autoStatus.className = "settings-status ok"; }
      catch (error) { toggle.input.checked = !toggle.input.checked; autoStatus.textContent = error.message; autoStatus.className = "settings-status error"; }
      finally { toggle.input.disabled = false; }
    });
    bindToggle(autoConnect, "autoConnectLocalServices", (on) => on ? "Máy chủ web sẽ tự kết nối các dịch vụ local." : "Đã tắt tự kết nối (không dừng tiến trình đang chạy).");
    bindToggle(autoScans, "autoScans", (on) => on ? "Quét tự động đang bật trên máy chủ web." : "Đã tắt quét tự động trên máy chủ web.");
    autoCard.append(autoConnect.row, autoScans.row, autoStatus);

    // AI provider
    const aiCard = el("section", "setting-card"); aiCard.innerHTML = '<h4>AI provider</h4><p>Chọn Hachimi, TS Elite 2, hoặc dùng cả hai: TS Elite 2 tra cứu trước rồi Hachimi tổng hợp cùng tài liệu ELITE2 local.</p>';
    const providerChoices = el("div", "radio-list");
    const radios = {};
    [["hachimi", "Hachimi local (máy này)"], ["elite2", "TS Elite 2"], ["hachimi-elite2", "Hachimi + TS Elite 2"]].forEach(([value, label]) => {
      const choice = el("label"); const radio = el("input"); radio.type = "radio"; radio.name = "ai-provider"; radio.value = value; radios[value] = radio; choice.append(radio, document.createTextNode(label)); providerChoices.append(choice);
    });
    (radios[stored.aiProvider] || radios.elite2).checked = true;
    const saveAi = el("button", "primary", "Lưu AI provider"); saveAi.type = "button";
    const connect = el("button", "secondary", "Kết nối TS Elite 2"); connect.type = "button";
    const tokenLabel = el("label", "field", "Dán token TS Elite 2 (hoặc cả URL ext-login-done#…)"); tokenLabel.htmlFor = "ai-token"; tokenLabel.hidden = true;
    const tokenInput = el("input", "field"); tokenInput.id = "ai-token"; tokenInput.type = "password"; tokenInput.autocomplete = "off"; tokenInput.placeholder = "eyJ…"; tokenInput.hidden = true;
    const saveToken = el("button", "secondary", "Lưu token"); saveToken.type = "button"; saveToken.hidden = true;
    const aiStatus = el("p", "settings-status");
    const refreshAiStatus = async () => {
      try {
        const status = await api("/ai/status"); const provider = Object.values(radios).find((r) => r.checked)?.value || "elite2";
        const eliteText = status.connected ? `TS Elite 2 đã sẵn sàng${status.tokenSource === ".env_my" ? " (token từ .env_my)" : ""}.` : status.tokenInvalid ? "Token TS Elite 2 đã hết hạn hoặc bị từ chối. Bấm Kết nối TS Elite 2 để lấy token mới." : "TS Elite 2 chưa được kết nối.";
        const hachimiText = status.hachimi.running ? (status.hachimi.busy ? "Hachimi đang xử lý…" : "Hachimi local đã sẵn sàng.") : "Hachimi local chưa chạy; máy chủ web sẽ tự khởi động, hoặc bấm Start trong Dịch vụ local.";
        aiStatus.textContent = provider === "elite2" ? eliteText : provider === "hachimi" ? hachimiText : `${eliteText} ${hachimiText}`;
        const ok = provider === "elite2" ? status.connected : provider === "hachimi" ? status.hachimi.running : status.connected && status.hachimi.running;
        aiStatus.className = `settings-status${ok ? " ok" : ""}`;
        connect.textContent = status.connected ? "Kết nối lại TS Elite 2" : "Kết nối TS Elite 2";
      } catch (error) { aiStatus.textContent = error.message; aiStatus.className = "settings-status error"; }
    };
    Object.values(radios).forEach((radio) => radio.addEventListener("change", () => void refreshAiStatus()));
    connect.addEventListener("click", () => {
      openExternal(state.bootstrap?.aiLoginUrl || "https://ts2.avada.net/ext-login");
      tokenLabel.hidden = false; tokenInput.hidden = false; saveToken.hidden = false;
      aiStatus.textContent = "Đăng nhập TS Elite 2 ở tab vừa mở. Khi trang chuyển tới ext-login-done#…, copy toàn bộ URL (hoặc phần sau dấu #) và dán vào ô bên trên rồi bấm Lưu token."; aiStatus.className = "settings-status";
    });
    saveToken.addEventListener("click", async () => {
      saveToken.disabled = true;
      try { await api("/ai/token", { method: "POST", body: { token: tokenInput.value } }); tokenInput.value = ""; tokenLabel.hidden = true; tokenInput.hidden = true; saveToken.hidden = true; state.bootstrap.aiConnected = true; await refreshAiStatus(); toast("Đã lưu token TS Elite 2."); }
      catch (error) { aiStatus.textContent = error.message; aiStatus.className = "settings-status error"; }
      finally { saveToken.disabled = false; }
    });
    saveAi.addEventListener("click", async () => {
      const provider = Object.values(radios).find((r) => r.checked)?.value || "elite2";
      saveAi.disabled = true; aiStatus.textContent = "Đang lưu lựa chọn AI…"; aiStatus.className = "settings-status";
      try { const result = await api("/ai/provider", { method: "POST", body: { provider } }); state.bootstrap.settings.aiProvider = result.provider; if (result.warning) toast(`Không thể bật Hachimi: ${result.warning}`, true); await refreshAiStatus(); }
      catch (error) { aiStatus.textContent = error.message; aiStatus.className = "settings-status error"; }
      finally { saveAi.disabled = false; }
    });
    const aiRow = el("div", "row"); aiRow.append(saveAi, connect);
    aiCard.append(providerChoices, aiRow, tokenLabel, tokenInput, saveToken, aiStatus);

    // Local services
    const servicesCard = el("section", "setting-card"); servicesCard.innerHTML = '<h4>Dịch vụ local</h4><p>Các tiến trình chạy trên máy chủ web. Telegram bot chỉ gửi thông báo phát sinh sau lần kết nối hiện tại.</p>';
    const serviceList = el("div", "service-list"); const servicesStatus = el("p", "settings-status", "Đang kiểm tra…");
    const refreshServices = async () => {
      serviceList.replaceChildren();
      try {
        const status = await api("/services/status");
        const rows = [
          ["Telegram bot", status.telegram, "reconnect", "Kết nối lại"], ["Hachimi local bridge", status.hachimi, "codex-start", "Start"], ["Helpdesk webhook bridge", status.webhook, "webhook-bridge-start", "Start"],
          ["Hachimi database", status.db, "db-start", "Start"], ["Hachimi tracing web", status.traceWeb, "trace-web-start", "Start"],
        ];
        rows.forEach(([name, info, action, label]) => {
          const row = el("div", "service-row"); const nameEl = el("span", "service-name");
          nameEl.append(el("span", `dot ${info?.running ? "on" : "off"}`), document.createTextNode(name)); row.append(nameEl);
          if (name === "Hachimi tracing web" && info?.url) { const open = el("button", "", "Mở"); open.type = "button"; open.addEventListener("click", () => openExternal(info.url)); row.append(open); }
          const act = el("button", "", label); act.type = "button";
          act.addEventListener("click", async () => { act.disabled = true; act.textContent = "…"; try { const result = await api(`/services/${action}`, { method: "POST", body: {} }); toast(result.started ? `${name}: đã khởi động.` : `${name}: đang chạy.`); } catch (error) { toast(error.message, true); } finally { await refreshServices(); } });
          row.append(act); serviceList.append(row);
        });
        servicesStatus.textContent = `Cập nhật ${new Date().toLocaleTimeString("vi-VN")}.`; servicesStatus.className = "settings-status";
      } catch (error) { servicesStatus.textContent = `Không kiểm tra được dịch vụ: ${error.message}`; servicesStatus.className = "settings-status error"; }
    };
    const refreshServicesButton = el("button", "secondary", "Kiểm tra lại"); refreshServicesButton.type = "button"; refreshServicesButton.addEventListener("click", () => void refreshServices());
    servicesCard.append(serviceList, el("div", "row"), refreshServicesButton, servicesStatus);

    // Share
    const shareCard = el("section", "setting-card"); shareCard.innerHTML = '<h4>Chia sẻ web trong mạng LAN</h4><p>Mở các link này trên thiết bị khác cùng Wi-Fi/mạng. Trên iPhone: Safari → Chia sẻ → Thêm vào Màn hình chính để dùng như app.</p>';
    const shareList = el("div", "share-list");
    const urls = [state.bootstrap?.tailscaleUrl, state.bootstrap?.mdnsUrl, state.bootstrap?.publicUrl, location.origin, ...((state.bootstrap?.lan || []).map((item) => item.url))].filter(Boolean).filter((u, i, arr) => arr.indexOf(u) === i);
    urls.forEach((url) => {
      const row = el("div", "share-row"); const code = el("code", "", url);
      const copy = el("button", "", "Copy"); copy.type = "button"; copy.addEventListener("click", async () => { toast((await copyText(url)) ? "Đã copy link." : "Không copy được.", false); });
      row.append(code, copy); shareList.append(row);
    });
    if (state.bootstrap?.pinRequired) shareCard.append(el("p", "settings-status", "Web đang yêu cầu mã truy cập (TS_WEB_PIN); nhớ chia sẻ mã cho thiết bị khác."));
    if (state.bootstrap?.tailscaleUrl) shareCard.append(el("p", "settings-status ok", `Link cố định từ mọi mạng (Wi-Fi khác, 4G) qua Tailscale: ${state.bootstrap.tailscaleUrl}. Thiết bị phải bật app Tailscale${state.bootstrap.tailscaleOwnerOnly ? " và thuộc tài khoản được phép" : ""}.`));
    if (state.bootstrap?.mdnsUrl) shareCard.append(el("p", "settings-status ok", `Link cố định cho mọi thiết bị cùng Wi-Fi: ${state.bootstrap.mdnsUrl} (không đổi khi IP đổi).`));
    if (state.bootstrap?.publicUrl) shareCard.append(el("p", "settings-status", `${state.bootstrap.publicUrl} chỉ mở được trên thiết bị có bản ghi hosts/DNS trỏ về máy chủ web. Thiết bị khác dùng link IP.`));
    shareCard.append(shareList);

    const grid = el("div", "settings-grid"); grid.append(ticketCard, awakeCard, autoCard, aiCard, servicesCard, shareCard); settings.append(grid); screen.append(settings);
    mcpV2SettingsCard = createMcpV2SettingsCard({
      read: () => mcpV2SettingsRequest("read"),
      write: payload => mcpV2SettingsRequest("save", payload),
    });
    grid.prepend(mcpV2SettingsCard.element);
    void mcpV2SettingsCard.refresh();
    if (globalThis.AnalyticsView?.settingsCard) {
      reactionSettingsCard = globalThis.AnalyticsView.settingsCard({ api: (path, options) => api(`/analytics${path}`, options) });
      grid.insertBefore(reactionSettingsCard.element, ticketCard);
      void reactionSettingsCard.refresh();
    }
    void refreshAiStatus(); void refreshServices();
  }

  // --- live events + boot -------------------------------------------------
  function startEventStream() {
    let source = null; let timer = null;
    const connect = () => {
      source = new EventSource(withKey("/api/events"));
      source.addEventListener("hello", () => { state.live = true; renderHeader(); });
      source.addEventListener("ticket-change", () => { void loadTickets(); if (state.screen === "notifications") void loadNotifications({ showLoading: false }); });
      source.addEventListener("notifications-changed", () => { void loadNotifications({ showLoading: false }); });
      source.addEventListener("feature-follow-changed", () => { void loadFeatureFollow(); });
      source.onerror = () => { source.close(); if (state.live) { state.live = false; renderHeader(); } if (!timer) timer = setTimeout(() => { timer = null; connect(); }, 5_000); };
    };
    connect();
  }
  async function boot() {
    applyTheme(initialTheme());
    renderNavigation();
    let health = {}; try { health = await (await fetch("/api/health", { cache: "no-store" })).json(); } catch {}
    if (health.pinRequired && !accessKey()) await requestAccessKey(false);
    try { state.bootstrap = await api("/bootstrap"); state.bootstrap.pinRequired = Boolean(health.pinRequired); }
    catch (error) { state.bootstrap = { settings: {}, lan: [] }; toast(`Không tải được cấu hình: ${error.message}`, true); }
    if (!localStorage.getItem(THEME_STORAGE) && state.bootstrap?.settings?.widgetTheme) applyTheme(state.bootstrap.settings.widgetTheme);
    showScreen("home");
    void loadTickets(); void loadNotifications({ showLoading: false }); void followDevFixTickets(); void loadFeatureFollow();
    startEventStream();
    setInterval(() => { if (document.visibilityState === "visible") { void loadTickets(); if (state.screen === "notifications") void loadNotifications({ showLoading: false }); } }, RECONCILIATION_INTERVAL_MS);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void loadTickets(); });
  }
  boot();
})();
