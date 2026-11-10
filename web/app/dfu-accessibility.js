// "DFY Accessibility" section of the TS Management web (internal name dfu kept in file/route/css names): Andrew's Done For You tickets, the scan report (.md) uploaded
// for the ticket chosen with "Run", and the report's figures + the AI analysis of its issues. Pure DOM; the host gives
// `api` (→ /api/dfu/*) and `openUrl`. Nothing here posts comments, changes a ticket or marks it done.
globalThis.DfuAccessibilityView = (() => {
  const ACTIVE_KEY = "ts-web:dfuActiveTicket";
  const POLL_MS = 4_000;
  const SEVERITY = { critical: ["Critical", "critical"], serious: ["Serious", "critical"], major: ["Major", "major"], moderate: ["Moderate", "major"], minor: ["Minor", "minor"] };
  const VERDICT = { false_positive: ["Thường là false positive", "fp"], real: ["Lỗi thật", "real"], verify: ["Cần verify", "verify"] };
  const TS_STATUS = { pending: "Pending", doing: "Doing", waiting_customer: "Wait customer", dev_fixing: "Dev fix", waiting_permission: "Wait permission", done_for_you: "Done for you" };

  const css = `
    .dfu-screen { display:grid;gap:14px;padding:14px 14px calc(22px + var(--safe-bottom,0px));color:var(--text,#1f1f29);font-size:12px; }
    .dfu-screen *,.dfu-screen *::before,.dfu-screen *::after { box-sizing:border-box; }
    .dfu-card { border:1px solid var(--line,#e7e5eb);border-radius:14px;padding:14px;background:var(--panel-2,#fff); }
    .dfu-card-head { display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:6px; }
    .dfu-card-head h3 { margin:0;font-size:14px;font-weight:800; }
    .dfu-card-head .dfu-step { display:grid;width:22px;height:22px;place-items:center;border-radius:50%;color:#fff;background:var(--brand,#604893);font-size:11px;font-weight:800; }
    .dfu-copy { margin:0 0 10px;color:var(--muted,#667085);font-size:11px;line-height:1.5; }
    .dfu-pill { display:inline-block;border-radius:999px;padding:3px 8px;font-size:10px;font-weight:800;line-height:1.3;white-space:nowrap;color:var(--brand,#604893);background:var(--brand-soft,#eee7ff); }
    .dfu-pill.ok { color:var(--ok,#166534);background:rgba(22,163,74,.12); }.dfu-pill.warn { color:var(--warn,#b45309);background:rgba(245,158,11,.14); }.dfu-pill.bad { color:var(--danger,#b42318);background:var(--danger-bg,#fff1f1); }.dfu-pill.muted { color:var(--muted,#667085);background:var(--line-2,#f0f2f6); }
    .dfu-button { border:0;border-radius:8px;cursor:pointer;padding:8px 11px;color:var(--brand,#604893);background:var(--brand-soft-2,#f0ebff);font-size:11px;font-weight:800;white-space:nowrap; }
    .dfu-button.primary { color:#fff;background:var(--brand-2,#765ab8); }.dfu-button.danger { color:#fff;background:#dc2626; }
    .dfu-button:disabled { cursor:not-allowed;opacity:.5; }
    .dfu-status { margin:6px 0 0;min-height:14px;color:var(--muted,#667085);font-size:11px;line-height:1.45;white-space:pre-wrap; }.dfu-status.error { color:var(--danger,#b42318); }.dfu-status.ok { color:var(--ok,#166534); }
    .dfu-toolbar { margin-left:auto;display:flex;flex-wrap:wrap;align-items:center;gap:6px; }
    .dfu-tickets { display:grid;gap:8px; }
    .dfu-ticket { display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;border:1px solid var(--line,#e7e5eb);border-radius:12px;padding:10px 12px;background:var(--panel,#fbfbfc); }
    .dfu-ticket.active { border-color:var(--brand-2,#765ab8);box-shadow:0 0 0 3px var(--chat-soft,rgba(124,58,237,.09)); }
    .dfu-ticket-main { min-width:0; }.dfu-ticket-main a { color:var(--brand-2,#765ab8);font-size:11px;font-weight:800;text-decoration:none;letter-spacing:.02em; }
    .dfu-ticket-main strong { display:block;margin-top:2px;font-size:13px;font-weight:650;line-height:1.35;overflow-wrap:anywhere;color:var(--text-2,#334155); }
    .dfu-ticket-meta { display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px;color:var(--muted,#667085);font-size:10px; }
    .dfu-ticket-side { display:grid;gap:6px;justify-items:end; }
    .dfu-empty { margin:0;padding:12px;border:1px dashed var(--line,#e7e5eb);border-radius:10px;color:var(--muted,#667085);font-size:11px;text-align:center; }
    .dfu-target { display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 10px;padding:9px 11px;border-radius:10px;background:var(--brand-soft-2,#f0ebff);color:var(--text,#1f1f29);font-size:11px;line-height:1.4; }
    .dfu-target.idle { background:var(--line-2,#f0f2f6);color:var(--muted,#667085); }
    .dfu-target .dfu-toolbar { margin-left:auto; }
    .dfu-drop { position:relative;display:grid;place-items:center;gap:6px;min-height:150px;padding:18px;border:2px dashed var(--brand-3,#9578e4);border-radius:14px;background:var(--brand-soft-2,#f0ebff);text-align:center;color:var(--text,#1f1f29);transition:background .15s,border-color .15s; }
    .dfu-drop svg { width:34px;height:34px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;color:var(--brand-2,#765ab8); }
    .dfu-drop p { margin:0;font-size:12px;font-weight:700; }.dfu-drop small { color:var(--muted,#667085);font-size:10px; }
    .dfu-drop.over { border-style:solid;background:var(--brand-soft,#eee7ff); }
    .dfu-drop.disabled { border-color:var(--line,#e7e5eb);background:var(--line-2,#f0f2f6);color:var(--muted-2,#98a2b3);cursor:not-allowed;filter:grayscale(1);opacity:.75; }
    .dfu-drop.disabled svg { color:var(--muted-2,#98a2b3); }.dfu-drop.disabled .dfu-button { pointer-events:none;opacity:.6; }
    .dfu-drop input[type=file] { position:absolute;width:1px;height:1px;opacity:0;pointer-events:none; }
    .dfu-kpis { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:8px 0 10px; }
    .dfu-kpi { border:1px solid var(--line,#e7e5eb);border-radius:12px;padding:10px 8px;background:var(--panel,#fbfbfc);text-align:center; }
    .dfu-kpi strong { display:block;font-size:20px;line-height:1.1; }.dfu-kpi.score strong { font-size:28px; }.dfu-kpi.good strong { color:var(--ok,#166534); }.dfu-kpi.mid strong { color:var(--warn,#b45309); }.dfu-kpi.low strong { color:var(--danger,#b42318); }
    .dfu-kpi span { display:block;margin-top:4px;color:var(--muted,#667085);font-size:10px;line-height:1.25; }
    .dfu-meta { display:grid;gap:4px;margin:0 0 10px;color:var(--muted,#667085);font-size:11px;line-height:1.45; }.dfu-meta a { color:var(--brand-2,#765ab8); }
    .dfu-meta code { font-size:10px; }
    .dfu-analysis { display:grid;gap:8px;margin:10px 0; }
    .dfu-analysis h4 { margin:0;font-size:13px; }.dfu-analysis p { margin:0;line-height:1.5;white-space:pre-wrap; }
    .dfu-analysis ol { margin:0;padding-left:18px;line-height:1.5; }
    .dfu-note { padding:9px 11px;border-left:3px solid var(--note-accent,#0f766e);border-radius:8px;background:var(--note-accent-soft,#e6f5f1);color:var(--text-2,#334155);line-height:1.5; }
    .dfu-running { display:flex;align-items:center;gap:8px;padding:9px 11px;border-radius:10px;background:var(--brand-soft-2,#f0ebff);color:var(--brand,#604893);font-weight:700; }
    .dfu-tickets-loading { margin-bottom:8px;font-weight:600;font-size:12px;flex-wrap:wrap; }
    .dfu-progress { flex:1 1 100%;display:flex;align-items:center;gap:8px;font-weight:600;font-size:11px;color:var(--brand,#5b3df5); }
    .dfu-progress-bar { flex:1 1 auto;height:8px;border-radius:999px;background:var(--line-2,#e6e1f8);overflow:hidden; }
    .dfu-progress-bar > span { display:block;height:100%;border-radius:999px;background:var(--brand,#5b3df5);transition:width .4s ease; }
    .dfu-progress-bar.error > span { background:var(--danger,#b42318); }.dfu-progress-bar.done > span { background:var(--ok,#166534); }
    .dfu-progress-pct { flex:none;min-width:38px;text-align:right;font-variant-numeric:tabular-nums; }
    .dfu-spinner { flex:none;width:14px;height:14px;border:2px solid var(--brand-3,#9578e4);border-top-color:transparent;border-radius:50%;animation:dfu-spin .8s linear infinite; }
    @keyframes dfu-spin { to { transform:rotate(360deg); } }
    .dfu-issues { margin-top:10px;border:1px solid var(--line,#e7e5eb);border-radius:12px;overflow:hidden; }
    .dfu-issues-head { padding:10px 12px;border-bottom:1px solid var(--line,#e7e5eb);background:var(--panel,#fbfbfc); }.dfu-issues-head h4 { margin:0;font-size:13px; }.dfu-issues-head p { margin:3px 0 0;color:var(--muted,#667085);font-size:11px; }
    .dfu-row { border-bottom:1px solid var(--line-2,#f0f2f6); }.dfu-row:last-child { border-bottom:0; }
    .dfu-row-main { display:flex;flex-wrap:wrap;align-items:flex-start;gap:0 10px;padding:0 12px; }
    .dfu-row-main:hover { background:var(--brand-soft-2,#f0ebff); }
    .dfu-row-toggle { flex:1 1 320px;min-width:0;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 10px;align-items:start;border:0;padding:10px 0;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit; }
    .dfu-row-check { flex:1 1 100%;display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:0 0 10px; }
    .dfu-row-check input { flex:1 1 170px;min-width:0;padding:6px 8px;border:1px solid var(--line,#d0d5dd);border-radius:8px;font:inherit;font-size:11px;background:var(--panel,#fff);color:inherit; }
    .dfu-row-check input:disabled { opacity:.6; }
    .dfu-check-status { flex:1 1 100%;font-size:10.5px;line-height:1.45;color:var(--muted,#667085);overflow-wrap:anywhere; }.dfu-check-status.posted { color:var(--ok,#166534); }.dfu-check-status.error { color:var(--danger,#b42318); }.dfu-check-status.running { color:var(--brand,#5b3df5); }
    .dfu-check-status a, .dfu-check-status button { color:inherit;font:inherit;text-decoration:underline;background:none;border:0;padding:0;cursor:pointer; }
    .dfu-comment { margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--panel-2,#f6f7f9);border:1px solid var(--line-2,#f0f2f6);border-radius:8px;padding:8px 10px;max-height:420px;overflow:auto; }
    .dfu-row-title { font-size:12px;font-weight:700;line-height:1.4;color:var(--text-2,#334155);overflow-wrap:anywhere; }
    .dfu-row-summary { margin-top:3px;color:var(--muted,#667085);font-size:11px;line-height:1.45; }
    .dfu-row-tags { display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;align-items:center;font-size:10px;color:var(--muted,#667085); }
    .dfu-chevron { color:var(--muted,#667085);font-size:14px;transition:transform .15s; }.dfu-row.open .dfu-chevron { transform:rotate(180deg); }
    .dfu-sev { border-radius:999px;padding:2px 8px;font-size:10px;font-weight:800; }.dfu-sev.critical { color:#7c2d12;background:#fed7aa; }.dfu-sev.major { color:#78350f;background:#fde68a; }.dfu-sev.minor { color:#1e3a8a;background:#dbeafe; }
    .dfu-verdict { border-radius:999px;padding:2px 8px;font-size:10px;font-weight:800; }.dfu-verdict.fp { color:#065f46;background:#d1fae5; }.dfu-verdict.real { color:#991b1b;background:#fee2e2; }.dfu-verdict.verify { color:#92400e;background:#fef3c7; }.dfu-verdict.pending { color:var(--muted,#667085);background:var(--line-2,#f0f2f6); }
    .dfu-row-detail { display:grid;gap:8px;padding:0 12px 12px 12px;border-top:1px dashed var(--line-2,#f0f2f6);padding-top:10px;background:var(--panel,#fbfbfc); }
    .dfu-row-detail h5 { margin:0 0 3px;font-size:11px;font-weight:800;color:var(--text-2,#334155); }.dfu-row-detail p { margin:0;line-height:1.5;white-space:pre-wrap;color:var(--text,#1f1f29); }
    .dfu-locations { display:grid;gap:4px;margin:0;padding:0;list-style:none; }.dfu-locations li { padding:6px 9px;border-radius:8px;background:var(--line-2,#f0f2f6);font-size:11px;font-weight:700;overflow-wrap:anywhere; }
    .dfu-elements { margin:0;padding:8px 10px;border-radius:8px;background:var(--line-2,#f0f2f6);font-size:10px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
    .dfu-raw { max-height:360px;overflow:auto;margin:8px 0 0;padding:10px;border:1px solid var(--line,#e7e5eb);border-radius:10px;background:var(--panel,#fbfbfc);font-size:10px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
    .dfu-versions { display:grid;gap:6px;margin:8px 0 0; }.dfu-version { display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--line,#e7e5eb);border-radius:10px;font-size:11px; }.dfu-version.current { border-color:var(--brand-2,#765ab8); }
    .dfu-version .dfu-toolbar { margin-left:auto; }
    :root[data-theme="dark"] .dfu-drop { background:var(--brand-soft,#2e2443); }:root[data-theme="dark"] .dfu-drop.disabled { background:var(--panel,#11121a);border-color:var(--line,#363646); }
    :root[data-theme="dark"] .dfu-sev.critical { color:#fed7aa;background:#7c2d12; }:root[data-theme="dark"] .dfu-sev.major { color:#fde68a;background:#78350f; }:root[data-theme="dark"] .dfu-sev.minor { color:#dbeafe;background:#1e3a8a; }
    :root[data-theme="dark"] .dfu-verdict.fp { color:#d1fae5;background:#065f46; }:root[data-theme="dark"] .dfu-verdict.real { color:#fee2e2;background:#991b1b; }:root[data-theme="dark"] .dfu-verdict.verify { color:#fef3c7;background:#92400e; }
    @media (min-width:1024px) { .dfu-screen { width:min(1180px,100%);margin:0 auto;padding:18px 16px 24px; } .dfu-kpis { grid-template-columns:repeat(6,minmax(0,1fr)); } .dfu-row-toggle { grid-template-columns:minmax(0,1fr) 150px 110px 70px 60px auto;align-items:center; } .dfu-row-check { flex:0 0 300px;align-self:stretch;padding:10px 0 10px 10px;border-left:1px dashed var(--line-2,#f0f2f6);align-content:center; } .dfu-row-tags { margin-top:0;display:contents; } .dfu-row-tags .dfu-hide-desktop { display:none; } }
    @media (max-width:1023px) { .dfu-row-tags .dfu-hide-mobile { display:none; } .dfu-row-toggle .dfu-row-tags { grid-column:1 / -1; } .dfu-row-toggle .dfu-chevron { grid-row:1; grid-column:2; } }
  `;

  const node = (tag, className = "", text = null) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== null) element.textContent = text; return element; };
  const button = (label, className = "dfu-button", handler = null) => { const element = node("button", className, label); element.type = "button"; if (handler) element.addEventListener("click", handler); return element; };
  const formatTime = value => { const date = new Date(value || ""); return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" }); };
  const formatSize = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const scoreClass = score => score === null || score === undefined ? "" : score >= 90 ? "good" : score >= 70 ? "mid" : "low";
  const riskClass = risk => ({ LOW: "ok", MEDIUM: "warn", HIGH: "bad" })[String(risk || "").toUpperCase()] || "muted";
  const readStorage = () => { try { return localStorage.getItem(ACTIVE_KEY) || ""; } catch { return ""; } };
  const writeStorage = value => { try { if (value) localStorage.setItem(ACTIVE_KEY, value); else localStorage.removeItem(ACTIVE_KEY); } catch {} };
  const readFileText = file => new Promise((done, fail) => { const reader = new FileReader(); reader.onerror = () => fail(new Error("Không đọc được file.")); reader.onload = () => done(String(reader.result || "")); reader.readAsText(file); });

  function reportPill(report) {
    if (!report) return node("span", "dfu-pill muted", "Chưa có report");
    const status = report.analysisStatus;
    const label = `Report v${report.version}${report.score !== null && report.score !== undefined ? ` · điểm ${report.score}` : ""} · ${status === "done" ? "đã phân tích" : status === "running" ? "đang phân tích" : status === "error" ? "phân tích lỗi" : "chưa phân tích"}`;
    return node("span", `dfu-pill ${status === "done" ? "ok" : status === "error" ? "bad" : status === "running" ? "warn" : ""}`, label);
  }

  // mount(root, { api(path, { method, body }), openUrl(url), helpdeskUrl }) → { refresh, destroy }
  function mount(root, { api, openUrl = url => window.open(url, "_blank", "noopener,noreferrer"), helpdeskUrl = "https://helpdesk.avada.net" } = {}) {
    const screen = node("div", "dfu-screen"); root.append(screen);
    const state = { tickets: [], ticketsAt: "", active: null, report: null, viewing: null, replaceMode: false, busy: false, versions: null, raw: null, open: new Set(), checks: {}, checksFor: null, checksJson: "", imageDraft: {}, showComment: new Set(), loadingTickets: false, ticketsError: "", ticketsProgress: null };
    let destroyed = false; let pollTimer = null; let checkTimer = null; let progressTimer = null;
    // Progress bar (order of 2026-10-11 "đếm %"): <div class="dfu-progress"><div class="dfu-progress-bar"><span></span></div><span class="dfu-progress-pct">40%</span></div>
    function progressBar(percent, kind = "") { const wrap = node("div", "dfu-progress"); const bar = node("div", `dfu-progress-bar${kind ? ` ${kind}` : ""}`); const fill = node("span"); fill.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`; bar.append(fill); const pct = node("span", "dfu-progress-pct", `${Math.max(0, Math.min(100, Math.round(Number(percent) || 0)))}%`); wrap.append(bar, pct); wrap.update = value => { fill.style.width = `${Math.max(0, Math.min(100, Number(value) || 0))}%`; pct.textContent = `${Math.max(0, Math.min(100, Math.round(Number(value) || 0)))}%`; }; return wrap; }
    const visible = () => !destroyed && screen.isConnected && document.visibilityState === "visible";

    // --- block 1: tickets ---------------------------------------------------
    const ticketsCard = node("section", "dfu-card");
    const ticketsHead = node("div", "dfu-card-head"); ticketsHead.append(node("span", "dfu-step", "1"), node("h3", "", "Ticket Done For You của Andrew"));
    const ticketsCount = node("span", "dfu-pill", "…");
    const ticketsTools = node("div", "dfu-toolbar"); const refreshButton = button("Làm mới", "dfu-button", () => void loadTickets(true)); ticketsTools.append(ticketsCount, refreshButton);
    ticketsHead.append(ticketsTools);
    const ticketsCopy = node("p", "dfu-copy", "Ticket [DFY] hoặc tsStatus Done for you mà Andrew là member và chưa tick Done trên Helpdesk (ô Done của ticket), dù đang ở status nào. Bấm Run ở ticket cần làm để mở khối nộp report bên dưới.");
    const ticketsStatus = node("p", "dfu-status"); const ticketsList = node("div", "dfu-tickets");
    ticketsCard.append(ticketsHead, ticketsCopy, ticketsStatus, ticketsList);

    // --- block 2: upload --------------------------------------------------
    const uploadCard = node("section", "dfu-card");
    const uploadHead = node("div", "dfu-card-head"); uploadHead.append(node("span", "dfu-step", "2"), node("h3", "", "Report accessibility scan"));
    const uploadCopy = node("p", "dfu-copy", "Nộp file report .md xuất từ Accessibility scanner cho ticket đang chọn: chọn từ thiết bị hoặc kéo file thả vào khung. Khung chỉ mở sau khi bấm Run; ticket đã có report thì phải chọn Thay thế trước.");
    const target = node("div", "dfu-target idle");
    const drop = node("div", "dfu-drop disabled"); drop.setAttribute("aria-disabled", "true");
    drop.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0-4 4m4-4 4 4"/><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>';
    const dropText = node("p", "", "Kéo file .md thả vào đây"); const dropSmall = node("small", "", "hoặc");
    const fileInput = node("input"); fileInput.type = "file"; fileInput.accept = ".md,.markdown,text/markdown,text/plain"; fileInput.id = "dfu-file-input"; fileInput.disabled = true;
    const pickButton = button("Chọn từ thiết bị", "dfu-button primary", () => { if (!canUpload()) return; fileInput.click(); }); pickButton.disabled = true;
    drop.append(dropText, dropSmall, pickButton, fileInput);
    const uploadStatus = node("p", "dfu-status");
    uploadCard.append(uploadHead, uploadCopy, target, drop, uploadStatus);

    // --- block 3: report ----------------------------------------------------
    const reportCard = node("section", "dfu-card");
    const reportHead = node("div", "dfu-card-head"); reportHead.append(node("span", "dfu-step", "3"), node("h3", "", "Thông tin report"));
    const reportTools = node("div", "dfu-toolbar"); reportHead.append(reportTools);
    const reportBody = node("div"); const reportStatus = node("p", "dfu-status");
    reportCard.append(reportHead, reportBody, reportStatus);
    screen.append(ticketsCard, uploadCard, reportCard);

    const canUpload = () => Boolean(state.active) && !state.busy && (!state.report || state.replaceMode);
    const activeTicket = () => state.tickets.find(ticket => ticket.id === state.active) || null;
    const ticketLink = ticket => `${helpdeskUrl}/t/${encodeURIComponent(ticket.ticketId || ticket.id)}`;

    function setStatus(element, message, kind = "") { element.className = `dfu-status${kind ? ` ${kind}` : ""}`; element.textContent = message || ""; }

    let ticketsLoadingUi = null;
    function stopProgressPolling() { clearTimeout(progressTimer); progressTimer = null; }
    // While the list loads, GET /tickets/progress every second and move the bar in place (no re-render, no flicker).
    function pollTicketsProgress() {
      stopProgressPolling();
      if (!state.loadingTickets || destroyed) return;
      progressTimer = setTimeout(async () => {
        try { const p = await api("/tickets/progress"); if (!destroyed && state.loadingTickets) { state.ticketsProgress = p; if (ticketsLoadingUi) { ticketsLoadingUi.bar.update(p.active ? p.percent : state.ticketsProgress?.percent ?? 0); ticketsLoadingUi.detail.textContent = p.active ? `${p.text} · ${Math.round((p.elapsedMs || 0) / 1000)} giây` : "Đang hoàn tất…"; } } } catch { /* keep polling */ }
        pollTicketsProgress();
      }, 1000);
    }
    function renderTickets() {
      ticketsList.replaceChildren(); ticketsLoadingUi = null;
      ticketsCount.textContent = state.loadingTickets && !state.tickets.length ? "…" : `${state.tickets.length} ticket`;
      // Loading state (order of 2026-10-11): a spinner + text inside the block, so the first load (~20–30 s: nine
      // Helpdesk status lists) is not mistaken for a broken page. On refresh the old rows stay under the spinner.
      if (state.loadingTickets) {
        const running = node("div", "dfu-running dfu-tickets-loading"); running.setAttribute("role", "status");
        const p = state.ticketsProgress; const text = node("span", "", state.tickets.length ? "Đang làm mới danh sách ticket DFY trên Helpdesk…" : "Đang tải danh sách ticket DFY trên Helpdesk… lần đầu có thể mất 20–30 giây (đọc 9 trạng thái ticket).");
        const bar = progressBar(p?.percent ?? 0); const detail = node("span", "dfu-progress-detail", p?.text || "Đang kết nối Helpdesk…");
        running.append(node("span", "dfu-spinner"), text, bar, detail); ticketsList.append(running);
        ticketsLoadingUi = { bar, detail };
        if (!state.tickets.length) return;
      }
      if (!state.tickets.length) { ticketsList.append(node("p", "dfu-empty", state.ticketsError ? `Không tải được danh sách: ${state.ticketsError}` : "Không có ticket Done For You nào đang mở.")); return; }
      for (const ticket of state.tickets) {
        const row = node("div", `dfu-ticket${ticket.id === state.active ? " active" : ""}`); row.dataset.ticket = ticket.id;
        const main = node("div", "dfu-ticket-main");
        const link = node("a", "", ticket.ticketId || ticket.id); link.href = ticketLink(ticket); link.target = "_blank"; link.rel = "noreferrer";
        main.append(link, node("strong", "", ticket.subject || "(không có tiêu đề)"));
        const meta = node("div", "dfu-ticket-meta");
        if (ticket.store) meta.append(node("span", "", ticket.store));
        if (ticket.appName) meta.append(node("span", "", `· ${ticket.appName}`));
        if (ticket.createdAt) meta.append(node("span", "", `· ${formatTime(ticket.createdAt)}`));
        meta.append(node("span", "dfu-pill muted", TS_STATUS[ticket.tsStatus] || ticket.tsStatus || "?"));
        if (ticket.ticketStatus && ticket.ticketStatus !== "open") meta.append(node("span", "dfu-pill muted", ticket.ticketStatus));
        main.append(meta);
        const side = node("div", "dfu-ticket-side");
        side.append(reportPill(ticket.report));
        const run = button(ticket.id === state.active ? "Đang chọn" : "Run", `dfu-button${ticket.id === state.active ? "" : " primary"}`, () => void selectTicket(ticket));
        run.dataset.action = "run"; run.setAttribute("aria-pressed", String(ticket.id === state.active));
        side.append(run);
        row.append(main, side); ticketsList.append(row);
      }
    }

    function renderTarget() {
      target.replaceChildren();
      const ticket = activeTicket();
      const enabled = canUpload();
      drop.classList.toggle("disabled", !enabled); drop.setAttribute("aria-disabled", String(!enabled));
      fileInput.disabled = !enabled; pickButton.disabled = !enabled;
      if (!ticket) { target.className = "dfu-target idle"; target.append(node("span", "", "Chưa chọn ticket. Bấm Run ở một ticket trong danh sách trên để nộp report.")); return; }
      target.className = "dfu-target";
      const label = node("span"); label.innerHTML = `Ticket <strong>${ticket.ticketId || ticket.id}</strong> · ${ticket.subject || ""}`;
      target.append(label);
      const tools = node("div", "dfu-toolbar");
      if (state.report && !state.replaceMode) {
        target.append(node("span", "dfu-pill warn", `Đã có report v${state.report.version} (${formatTime(state.report.uploadedAt)})`));
        tools.append(button("Thay thế bằng file mới", "dfu-button primary", () => { state.replaceMode = true; renderTarget(); setStatus(uploadStatus, `Chế độ thay thế: file nộp tiếp sẽ thành phiên bản ${state.report.version + 1} của ticket ${ticket.ticketId || ticket.id}; bản cũ vẫn được giữ trong lịch sử.`); }));
      } else if (state.report && state.replaceMode) {
        target.append(node("span", "dfu-pill warn", `Thay thế report v${state.report.version}`));
        tools.append(button("Hủy thay thế", "dfu-button", () => { state.replaceMode = false; renderTarget(); setStatus(uploadStatus, ""); }));
      } else target.append(node("span", "dfu-pill ok", "Chưa có report · nộp file mới"));
      tools.append(button("Bỏ chọn", "dfu-button", () => { state.active = null; state.report = null; state.viewing = null; state.replaceMode = false; writeStorage(""); stopPolling(); stopCheckPolling(); renderTickets(); renderTarget(); renderReport(); setStatus(uploadStatus, ""); }));
      target.append(tools);
    }

    async function selectTicket(ticket) {
      state.active = ticket.id; state.replaceMode = false; state.versions = null; state.raw = null; state.open = new Set(); writeStorage(ticket.id);
      renderTickets(); renderTarget(); setStatus(uploadStatus, "Đang kiểm tra report đã lưu của ticket này…");
      try {
        const data = await api(`/reports/${encodeURIComponent(ticket.id)}`);
        if (destroyed || state.active !== ticket.id) return;
        state.report = data.report || null; state.viewing = state.report;
        setStatus(uploadStatus, state.report ? `Ticket đã có report v${state.report.version} (${state.report.filename}, ${formatTime(state.report.uploadedAt)}). Xem ở khối 3; muốn nộp file mới thì bấm "Thay thế bằng file mới".` : "Chưa có report cho ticket này. Chọn file .md hoặc kéo thả vào khung.");
        ticket.report = state.report ? { ...ticket.report, version: state.report.version, analysisStatus: state.report.analysisStatus, score: state.report.parsed?.header?.score ?? null } : null;
      } catch (error) { state.report = null; state.viewing = null; setStatus(uploadStatus, `Không đọc được report đã lưu: ${error.message}`, "error"); }
      renderTickets(); renderTarget(); renderReport(); schedulePolling(); scheduleCheckPolling();
      uploadCard.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    async function upload(file) {
      const ticket = activeTicket();
      if (!ticket) { setStatus(uploadStatus, "Bấm Run ở một ticket trước.", "error"); return; }
      if (!canUpload()) { setStatus(uploadStatus, state.report ? 'Ticket đã có report. Bấm "Thay thế bằng file mới" trước khi nộp.' : "Khung nộp đang khóa.", "error"); return; }
      if (!/\.(md|markdown|txt)$/i.test(file.name)) { setStatus(uploadStatus, `"${file.name}" không phải file .md.`, "error"); return; }
      state.busy = true; renderTarget(); setStatus(uploadStatus, `Đang nộp ${file.name} (${formatSize(file.size)})…`);
      try {
        const content = await readFileText(file);
        const data = await api(`/reports/${encodeURIComponent(ticket.id)}`, { method: "POST", body: { filename: file.name, content, ticketReference: ticket.ticketId, subject: ticket.subject, store: ticket.store, replace: state.replaceMode } });
        state.report = data.report; state.viewing = data.report; state.replaceMode = false; state.versions = null; state.raw = null; state.open = new Set();
        ticket.report = { version: data.report.version, analysisStatus: data.report.analysisStatus, score: data.report.parsed?.header?.score ?? null };
        setStatus(uploadStatus, `${data.replaced ? `Đã thay report v${data.replaced} bằng` : "Đã lưu"} phiên bản ${data.report.version}${data.sameAsPrevious ? " (nội dung giống hệt bản trước)" : ""}. AI đang phân tích Issue Details…`, "ok");
      } catch (error) {
        setStatus(uploadStatus, `Nộp report thất bại: ${error.message}`, "error");
      } finally { state.busy = false; fileInput.value = ""; renderTickets(); renderTarget(); renderReport(); schedulePolling(); }
    }
    fileInput.addEventListener("change", () => { const file = fileInput.files?.[0]; if (file) void upload(file); });
    ["dragenter", "dragover"].forEach(type => drop.addEventListener(type, event => { event.preventDefault(); if (canUpload()) { drop.classList.add("over"); event.dataTransfer.dropEffect = "copy"; } else event.dataTransfer.dropEffect = "none"; }));
    ["dragleave", "drop"].forEach(type => drop.addEventListener(type, () => drop.classList.remove("over")));
    drop.addEventListener("drop", event => { event.preventDefault(); if (!canUpload()) { setStatus(uploadStatus, state.active ? 'Ticket đã có report: bấm "Thay thế bằng file mới" trước.' : "Bấm Run ở một ticket trước khi kéo file vào.", "error"); return; } const file = event.dataTransfer?.files?.[0]; if (file) void upload(file); });

    // --- report rendering ---------------------------------------------------
    function kpi(value, label, className = "") { const tile = node("div", `dfu-kpi ${className}`.trim()); tile.append(node("strong", "", value === null || value === undefined || value === "" ? "—" : String(value)), node("span", "", label)); return tile; }
    function renderReport() {
      reportBody.replaceChildren(); reportTools.replaceChildren(); setStatus(reportStatus, "");
      const report = state.viewing;
      if (!state.active) { reportBody.append(node("p", "dfu-empty", "Chọn ticket (Run) để xem report đã lưu hoặc nộp report mới.")); return; }
      if (!report) { reportBody.append(node("p", "dfu-empty", "Ticket này chưa có report. Nộp file .md ở khối 2; thông tin và phân tích AI sẽ hiện ở đây.")); return; }
      const header = report.parsed?.header || {}; const stats = report.parsed?.stats || {}; const groups = report.parsed?.groups || [];
      const isCurrent = state.report && report.id === state.report.id;
      if (state.checksFor !== report.id) { state.checksFor = report.id; state.checks = {}; state.checksJson = ""; state.imageDraft = {}; state.showComment = new Set(); void loadChecks(report.id).then(changed => { if (changed && state.viewing?.id === report.id) { renderReport(); scheduleCheckPolling(); } }); }
      if (!isCurrent) reportBody.append(node("p", "dfu-note", `Đang xem phiên bản cũ v${report.version}. Phiên bản hiện tại là v${state.report?.version ?? "?"}.`));
      const kpis = node("div", "dfu-kpis");
      kpis.append(kpi(header.score, "Accessibility score", `score ${scoreClass(header.score)}`), kpi(header.totalIssues ?? stats.criteria, "Tổng issue"), kpi(header.legalRisk || "—", "Legal risk"), kpi(header.breakdown?.critical, "Critical"), kpi(header.breakdown?.major, "Major"), kpi(header.breakdown?.minor, "Minor"));
      reportBody.append(kpis);
      const meta = node("div", "dfu-meta");
      if (header.url) { const line = node("div"); line.append("Store: "); const link = node("a", "", header.url); link.href = header.url; link.target = "_blank"; link.rel = "noreferrer"; line.append(link); meta.append(line); }
      if (header.scannedAt) meta.append(node("div", "", `Scan lúc: ${header.scannedAt} (giờ trên report)`));
      const fileLine = node("div"); fileLine.append(`File: ${report.filename} · ${formatSize(report.size || 0)} · v${report.version} · nộp ${formatTime(report.uploadedAt)} · hash `); const hash = node("code", "", String(report.hash || "").slice(0, 12)); fileLine.append(hash); meta.append(fileLine);
      meta.append(node("div", "", `Parse: ${stats.blocks ?? 0} khối Issue Details → ${stats.criteria ?? 0} mã WCAG, ${stats.instances ?? 0} instance trên ${stats.pages ?? 0} trang.`));
      reportBody.append(meta);
      // tools
      const analyzeAgain = button(report.analysisStatus === "running" ? "Đang phân tích…" : "Phân tích lại", "dfu-button primary", async () => {
        analyzeAgain.disabled = true;
        try { await api(`/report/${report.id}/analyze`, { method: "POST", body: {} }); report.analysisStatus = "running"; report.analysisError = ""; renderReport(); schedulePolling(); }
        catch (error) { setStatus(reportStatus, `Không chạy lại được: ${error.message}`, "error"); analyzeAgain.disabled = false; }
      });
      analyzeAgain.disabled = report.analysisStatus === "running";
      const rawButton = button(state.raw && state.raw.id === report.id ? "Ẩn file md" : "Xem file md", "dfu-button", async () => {
        if (state.raw && state.raw.id === report.id) { state.raw = null; renderReport(); return; }
        rawButton.disabled = true;
        try { const data = await api(`/report/${report.id}?content=1`); state.raw = { id: report.id, text: data.report?.mdContent || "" }; renderReport(); }
        catch (error) { setStatus(reportStatus, `Không tải được file: ${error.message}`, "error"); rawButton.disabled = false; }
      });
      const versionsButton = button(state.versions ? "Ẩn lịch sử" : "Lịch sử phiên bản", "dfu-button", async () => {
        if (state.versions) { state.versions = null; renderReport(); return; }
        versionsButton.disabled = true;
        try { const data = await api(`/reports/${encodeURIComponent(state.active)}/versions`); state.versions = data.versions || []; renderReport(); }
        catch (error) { setStatus(reportStatus, `Không tải được lịch sử: ${error.message}`, "error"); versionsButton.disabled = false; }
      });
      reportTools.append(analyzeAgain, rawButton, versionsButton);
      // analysis
      const analysisBox = node("div", "dfu-analysis");
      const analysis = report.analysis;
      if (report.analysisStatus === "running") { const running = node("div", "dfu-running"); running.append(node("span", "dfu-spinner"), node("span", "", "AI đang tóm tắt và phân tích Issue Details theo checklist DFU (thường 1–3 phút)…")); analysisBox.append(running); }
      else if (report.analysisStatus === "error") analysisBox.append(node("p", "dfu-status error", `Phân tích AI thất bại: ${report.analysisError || "không rõ lý do"}. Bấm "Phân tích lại".`));
      else if (report.analysisStatus === "pending") analysisBox.append(node("p", "dfu-status", 'Chưa phân tích. Bấm "Phân tích lại" để AI tóm tắt Issue Details.'));
      if (analysis) {
        if (analysis.overview) { const h = node("h4", "", "Tổng quan (AI)"); analysisBox.append(h, node("p", "", analysis.overview)); }
        if (analysis.scoreNote) analysisBox.append(node("p", "dfu-note", `${analysis.scoreNote}${analysis.deductionTotal ? ` (tổng điểm trừ theo checklist của các mã có số: −${analysis.deductionTotal})` : ""}`));
        if (analysis.priorities?.length) { analysisBox.append(node("h4", "", "Nên làm trước")); const list = node("ol"); analysis.priorities.forEach(text => list.append(node("li", "", text))); analysisBox.append(list); }
        if (report.analyzedAt) analysisBox.append(node("p", "dfu-status", `Phân tích lúc ${formatTime(report.analyzedAt)}.`));
      }
      reportBody.append(analysisBox);
      // issues table
      const issues = node("div", "dfu-issues");
      const head = node("div", "dfu-issues-head"); head.append(node("h4", "", "Accessibility issues"), node("p", "", "Mỗi dòng là một mã WCAG của report (các khối Issue Details cùng mã được gộp). Bấm vào dòng để xem mô tả, phân tích AI, việc cần làm và vị trí lỗi."));
      issues.append(head);
      if (!groups.length) issues.append(node("p", "dfu-empty", "Không parse được Issue Details nào trong file này."));
      const aiByKey = new Map((analysis?.issues || []).map(item => [item.key, item]));
      for (const group of groups) {
        const ai = aiByKey.get(group.key) || null;
        const row = node("div", `dfu-row${state.open.has(group.key) ? " open" : ""}`);
        const main = node("div", "dfu-row-main");
        const toggle = node("button", "dfu-row-toggle"); toggle.type = "button"; toggle.setAttribute("aria-expanded", String(state.open.has(group.key)));
        const title = node("div");
        title.append(node("div", "dfu-row-title", group.title || `WCAG ${group.wcag}`));
        title.append(node("div", "dfu-row-summary", ai?.summary || (report.analysisStatus === "running" ? "AI đang tóm tắt…" : (group.descriptions[0] || "").slice(0, 160))));
        const [sevLabel, sevClass] = SEVERITY[group.severity] || [group.severity || "—", "minor"];
        const sev = node("span", `dfu-sev ${sevClass}`, sevLabel);
        const verdictMeta = ai ? VERDICT[ai.verdict] || VERDICT.verify : null;
        const verdict = node("span", `dfu-verdict ${verdictMeta ? verdictMeta[1] : "pending"}`, verdictMeta ? verdictMeta[0] : report.analysisStatus === "running" ? "đang phân tích" : "chưa phân tích");
        const instances = node("span", "", `${group.instances} instance${group.instances === 1 ? "" : "s"}`);
        const wcag = node("span", "", `WCAG ${group.wcag || "—"}`);
        const deduction = node("span", "", group.deduction ? `−${group.deduction} điểm` : "");
        const tags = node("div", "dfu-row-tags"); tags.append(sev, verdict, instances, wcag, deduction);
        const chevron = node("span", "dfu-chevron", "⌄");
        toggle.append(title, tags, chevron);
        toggle.addEventListener("click", () => { if (state.open.has(group.key)) state.open.delete(group.key); else state.open.add(group.key); row.classList.toggle("open"); toggle.setAttribute("aria-expanded", String(state.open.has(group.key))); detail.hidden = !state.open.has(group.key); });
        main.append(toggle, renderCheckArea(report, group, isCurrent));
        const detail = node("div", "dfu-row-detail"); detail.hidden = !state.open.has(group.key);
        const section = (label, text) => { if (!text) return; const wrap = node("div"); wrap.append(node("h5", "", label), node("p", "", text)); detail.append(wrap); };
        section("Description (scanner)", group.descriptions.join("\n"));
        if (ai) { section(`Phân tích AI · ${ai.confidence === "high" ? "tin cậy cao" : ai.confidence === "medium" ? "tin cậy vừa" : "tin cậy thấp"} · người làm: ${ai.owner}`, ai.analysis); section("Việc cần làm (AI)", ai.action); }
        section("Action needed (scanner)", group.actions.join("\n"));
        if (group.pages.length) { const wrap = node("div"); wrap.append(node("h5", "", `Locations · ${group.pages.length} trang`)); const list = node("ul", "dfu-locations"); group.pages.slice(0, 40).forEach(page => list.append(node("li", "", `${(header.url || "").replace(/\/$/, "")}${page}`))); if (group.pages.length > 40) list.append(node("li", "", `… còn ${group.pages.length - 40} trang`)); wrap.append(list); detail.append(wrap); }
        if (group.elements.length) { const wrap = node("div"); wrap.append(node("h5", "", "Element mẫu")); wrap.append(node("pre", "dfu-elements", group.elements.join("\n"))); detail.append(wrap); }
        const check = state.checks[group.key];
        if (check && state.showComment.has(group.key) && check.commentText) { const wrap = node("div"); wrap.append(node("h5", "", check.status === "posted" ? `Comment đã đăng lên ticket (${formatTime(check.postedAt)})` : "Nội dung comment (chưa đăng)"), node("pre", "dfu-comment", check.commentText)); detail.append(wrap); }
        row.append(main, detail); issues.append(row);
      }
      reportBody.append(issues);
      if (state.versions) {
        const list = node("div", "dfu-versions");
        state.versions.forEach(version => {
          const item = node("div", `dfu-version${version.id === report.id ? " current" : ""}`);
          item.append(node("strong", "", `v${version.version}`), node("span", "", `${version.filename} · ${formatSize(version.size || 0)} · ${formatTime(version.uploadedAt)}`), node("span", "dfu-pill muted", version.score !== null && version.score !== undefined ? `điểm ${version.score}` : "—"), node("span", "dfu-pill muted", version.analysisStatus));
          const tools = node("div", "dfu-toolbar");
          if (version.id !== report.id) tools.append(button("Xem", "dfu-button", async () => { try { const data = await api(`/report/${version.id}`); state.viewing = data.report; state.raw = null; state.open = new Set(); renderReport(); } catch (error) { setStatus(reportStatus, error.message, "error"); } }));
          item.append(tools); list.append(item);
        });
        reportBody.append(node("h4", "", "Lịch sử phiên bản"), list);
      }
      if (state.raw && state.raw.id === report.id) reportBody.append(node("pre", "dfu-raw", state.raw.text));
    }

    // --- "Start check" per issue row (order of 2026-10-11) -----------------------
    // Input for the image link + button. Click → POST /report/:id/checks → the server gathers evidence, asks the
    // AI for the cause/fix, posts the comment as Andrew; the row polls until posted/error. A posted issue asks
    // for confirmation before a second run (a new comment would be posted).
    const CHECK_STATUS = { running: "running", posted: "posted", error: "error", done: "" };
    function renderCheckArea(report, group, isCurrent) {
      const area = node("div", "dfu-row-check");
      const check = state.checks[group.key] || null;
      const running = check?.status === "running";
      const input = node("input"); input.type = "url"; input.placeholder = "URL ảnh mô phỏng lỗi (capture.avada.io/…)"; input.autocomplete = "off"; input.spellcheck = false;
      input.value = state.imageDraft[group.key] ?? check?.imageUrl ?? ""; input.disabled = running || !isCurrent;
      input.addEventListener("input", () => { state.imageDraft[group.key] = input.value; });
      input.addEventListener("click", event => event.stopPropagation());
      const run = button(running ? "Đang check…" : check?.status === "posted" ? "Check lại" : "Start check", "dfu-button primary", () => void startCheck(report, group, input.value, check));
      run.disabled = running || !isCurrent; if (!isCurrent) run.title = "Chỉ chạy trên phiên bản report hiện tại.";
      const status = node("div", `dfu-check-status ${CHECK_STATUS[check?.status] || ""}`.trim());
      if (check) {
        const ticket = activeTicket();
        if (running) { status.append(progressBar(check.progress ?? 0), node("span", "", `${check.step || "Đang bắt đầu…"} · bắt đầu ${formatTime(check.startedAt)}`)); }
        else if (check.status === "error" && (check.progress || 0) > 0) status.append(progressBar(check.progress, "error"), node("span", "", `Dừng ở ${check.step || "bước đang chạy"}. `));
        else if (check.status === "posted") { status.append(`Đã comment lên ticket lúc ${formatTime(check.postedAt)}${check.commentId ? ` (id ${check.commentId})` : ""}. `); if (ticket) { const link = node("a", "", "Mở ticket"); link.href = ticketLink(ticket); link.target = "_blank"; link.rel = "noreferrer"; status.append(link, " · "); } }
        else if (check.status === "done") status.append(`Đã tổng hợp lúc ${formatTime(check.finishedAt)}, chưa đăng comment (lượt chạy thử). `);
        else if (check.status === "error") status.append(`Lỗi: ${check.error || "không rõ"}${check.commentText ? " · nội dung đã tổng hợp vẫn xem được. " : " · bấm Start check để chạy lại."}`);
        if (check.commentText && !running) { const show = node("button", "", state.showComment.has(group.key) ? "Ẩn nội dung" : "Xem nội dung"); show.type = "button"; show.addEventListener("click", () => { if (state.showComment.has(group.key)) state.showComment.delete(group.key); else { state.showComment.add(group.key); state.open.add(group.key); } renderReport(); }); status.append(show); }
      } else status.append(isCurrent ? "Dán URL ảnh mô phỏng lỗi rồi bấm Start check: AI tổng hợp nguyên nhân + cách sửa và comment lên ticket." : "");
      area.append(input, run, status);
      return area;
    }
    async function startCheck(report, group, imageUrl, previous) {
      const url = String(imageUrl || "").trim();
      if (!url) { setStatus(reportStatus, `Dán URL ảnh mô phỏng lỗi cho mã ${group.wcag || group.key} trước khi Start check.`, "error"); return; }
      if (!/^https?:\/\/\S+$/i.test(url)) { setStatus(reportStatus, "URL ảnh không hợp lệ (cần dạng https://…).", "error"); return; }
      const force = previous?.status === "posted";
      if (force && !window.confirm(`Issue ${group.wcag || group.key} đã được comment lên ticket lúc ${formatTime(previous.postedAt)}.\nChạy lại sẽ đăng THÊM một comment mới lên ticket. Tiếp tục?`)) return;
      state.checks[group.key] = { ...(previous || {}), status: "running", startedAt: new Date().toISOString(), imageUrl: url, commentText: "", error: "" }; state.showComment.delete(group.key); renderReport();
      try {
        const data = await api(`/report/${report.id}/checks`, { method: "POST", body: { issueKey: group.key, imageUrl: url, force } });
        state.checks[group.key] = { ...state.checks[group.key], id: data.id };
        setStatus(reportStatus, `Đã bắt đầu check mã ${group.wcag || group.key}; comment sẽ được đăng lên ticket khi AI xong.`, "ok");
      } catch (error) {
        state.checks[group.key] = previous ? { ...previous } : null; if (!state.checks[group.key]) delete state.checks[group.key];
        setStatus(reportStatus, `Không chạy được Start check: ${error.message}`, "error"); renderReport(); return;
      }
      scheduleCheckPolling();
    }
    async function loadChecks(reportId) {
      try { const data = await api(`/report/${reportId}/checks`); if (destroyed || state.viewing?.id !== reportId) return false; const json = JSON.stringify(data.checks || {}); if (json === state.checksJson) return false; state.checks = data.checks || {}; state.checksJson = json; return true; }
      catch { return false; }
    }
    function stopCheckPolling() { clearTimeout(checkTimer); checkTimer = null; }
    function scheduleCheckPolling() {
      stopCheckPolling();
      const report = state.viewing;
      if (!report || !Object.values(state.checks).some(check => check?.status === "running")) return;
      checkTimer = setTimeout(async () => {
        if (destroyed || state.viewing?.id !== report.id) return;
        if (visible() && await loadChecks(report.id)) renderReport();
        scheduleCheckPolling();
      }, POLL_MS);
    }

    // --- polling while the analysis runs -------------------------------------
    function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
    function schedulePolling() {
      stopPolling();
      const report = state.viewing;
      if (!report || report.analysisStatus !== "running") return;
      pollTimer = setTimeout(async () => {
        if (destroyed || !state.viewing || state.viewing.id !== report.id) return;
        try {
          if (visible()) {
            const data = await api(`/report/${report.id}`);
            if (destroyed || !state.viewing || state.viewing.id !== report.id) return;
            if (data.report && data.report.analysisStatus !== "running") {
              state.viewing = data.report; if (state.report && state.report.id === data.report.id) state.report = data.report;
              const ticket = activeTicket(); if (ticket && ticket.report) ticket.report.analysisStatus = data.report.analysisStatus;
              renderTickets(); renderReport(); return;
            }
          }
        } catch { /* keep polling */ }
        schedulePolling();
      }, POLL_MS);
    }

    async function loadTickets(force = false) {
      refreshButton.disabled = true; state.loadingTickets = true; state.ticketsError = ""; state.ticketsProgress = null; renderTickets(); pollTicketsProgress(); setStatus(ticketsStatus, force ? "Đang đọc lại ticket Done For You trên Helpdesk (bỏ cache)…" : "Đang đọc ticket Done For You trên Helpdesk…");
      try {
        const data = await api(`/tickets${force ? "?refresh=1" : ""}`);
        if (destroyed) return;
        state.loadingTickets = false; stopProgressPolling(); state.tickets = data.tickets || []; state.ticketsAt = data.at || "";
        setStatus(ticketsStatus, `${state.tickets.length} ticket · cập nhật ${formatTime(state.ticketsAt)}${data.partial?.length ? ` · danh sách ${data.partial.join(", ")} quá dài, chỉ đọc được 2000 ticket mới nhất mỗi trạng thái` : ""}${data.dbError ? ` · không đọc được trạng thái report: ${data.dbError}` : ""}${data.retentionDays ? ` · report tự xóa sau ${data.retentionDays} ngày kể từ lần nộp đầu` : ""}`, data.dbError ? "error" : "");
        renderTickets();
        const remembered = readStorage();
        if (!state.active && remembered && state.tickets.some(ticket => ticket.id === remembered)) await selectTicket(state.tickets.find(ticket => ticket.id === remembered));
      } catch (error) { if (!destroyed) { state.loadingTickets = false; stopProgressPolling(); state.ticketsError = error.message; renderTickets(); setStatus(ticketsStatus, `Không tải được danh sách: ${error.message}`, "error"); } }
      finally { refreshButton.disabled = false; }
    }

    renderTickets(); renderTarget(); renderReport();
    void loadTickets();
    return { refresh: () => loadTickets(true), destroy: () => { destroyed = true; stopPolling(); stopCheckPolling(); stopProgressPolling(); screen.remove(); } };
  }

  return { css, mount, VERDICT, SEVERITY };
})();
