// NEWS panel shared by the extension widget and the TS Management web: the day's bulletin (Claude · new AI models ·
// technology, plus the daily sections "10 mẹo dùng AI", "10 tính năng hay của Claude và Codex" and "10 tool/extension
// hay dùng với AI" in `bulletin.tips`) built by the TS Management web server (scripts/news-store.mjs, scripts/news-tips.mjs). The host supplies `api(path)` (GET
// /api/news/…), `refresh()` (optional, POST /api/news/refresh), `openUrl`, `storage` (read state per device) and
// `cache` (last bulletin saved on the device, shown when the server is unreachable). Read-only view; no AI call here.
globalThis.NewsView = (() => {
  const GROUPS = [["claude", "Claude", "🟣"], ["models", "Model AI mới", "🧠"], ["tech", "Công nghệ", "🛰️"]];
  const READ_KEY = "newsRead";
  // Daily sections under the three news groups (bulletin.tips.<key>); bulletins built before 13/10/2026 have no `tips` → hidden.
  const TIPS = [["aiTips", "10 mẹo dùng AI", "💡"], ["toolFeatures", "10 tính năng hay của Claude và Codex", "🧰"], ["aiTools", "10 tool/extension hay dùng với AI", "🧩"]];
  const KIND_LABEL = { mcp: "MCP server", chrome: "Extension Chrome", vscode: "Extension VS Code", cli: "CLI", desktop: "App desktop", web: "Dịch vụ web", other: "Khác" };
  const TIPS_OPEN_KEY = "newsTipsOpen";
  const TOOL_LABEL = { claude: "Claude", codex: "Codex", both: "Claude · Codex" };
  const css = `
    .news-screen { display:grid;gap:12px;padding:12px 14px 22px;color:var(--chat-text,#282335);font-size:12px; }
    .news-screen *,.news-screen *::before,.news-screen *::after { box-sizing:border-box; }
    .news-bar { display:flex;flex-wrap:wrap;align-items:center;gap:6px; }
    .news-bar .news-date { flex:1;min-width:0;font-weight:800;font-size:13px;color:var(--chat-text,#282335); }
    .news-nav,.news-refresh { border:1px solid var(--chat-line,rgba(124,58,237,.16));border-radius:999px;cursor:pointer;padding:5px 10px;color:var(--chat-accent-text,#6d28d9);background:var(--chat-soft,rgba(124,58,237,.09));font-size:11px;font-weight:800;white-space:nowrap; }
    .news-nav:disabled,.news-refresh:disabled { cursor:default;opacity:.45; }
    .news-status { margin:0;min-height:14px;color:var(--chat-muted,#746b85);font-size:11px;line-height:1.4; }.news-status.error { color:#dc2626; }
    .news-group { display:grid;gap:8px; }.news-group h4 { display:flex;align-items:center;gap:6px;margin:4px 0 0;font-size:13px;color:var(--chat-text,#282335); }
    .news-group h4 b { border-radius:999px;padding:1px 7px;color:var(--chat-accent-text,#6d28d9);background:var(--chat-soft,rgba(124,58,237,.09));font-size:10px; }
    .news-item { display:block;border:1px solid var(--chat-line,rgba(124,58,237,.16));border-radius:12px;padding:10px 12px;background:#fff;color:inherit;text-decoration:none; }
    .news-item:hover { border-color:var(--chat-accent,#7c3aed);background:var(--chat-surface,#f1edf8); }
    .news-item strong { display:block;font-size:12.5px;line-height:1.4;color:var(--chat-text,#282335); }
    .news-item .news-meta { display:block;margin-top:3px;color:var(--chat-muted,#746b85);font-size:10px; }
    .news-item p { margin:6px 0 0;color:var(--chat-text,#282335);font-size:11.5px;line-height:1.5; }.news-item p.original { color:var(--chat-muted,#746b85);font-style:italic; }
    .news-empty { margin:0;padding:10px;border:1px dashed var(--chat-line,rgba(124,58,237,.16));border-radius:10px;color:var(--chat-muted,#746b85);font-size:11px;text-align:center; }
    .news-sources { margin:0;color:var(--chat-muted,#746b85);font-size:10px;line-height:1.5; }
    .news-button { position:relative;display:inline-flex;align-items:center;gap:5px;height:30px;border:1px solid rgba(255,255,255,.55);border-radius:9px;cursor:pointer;padding:0 10px;color:#fff;background:rgba(255,255,255,.22);font-size:11px;font-weight:900;letter-spacing:.06em;text-shadow:0 1px 1px rgba(0,0,0,.18); }
    .news-button:hover { background:rgba(255,255,255,.34); }
    .news-button .news-dot { display:none;width:8px;height:8px;border-radius:50%;background:#ff5a5f;box-shadow:0 0 0 2px rgba(255,255,255,.7); }.news-button.unread .news-dot { display:inline-block; }
    .news-tips { border:1px solid var(--chat-line,rgba(124,58,237,.16));border-radius:12px;background:#fff; }
    .news-tips > summary { display:flex;align-items:center;gap:6px;cursor:pointer;padding:9px 12px;font-size:13px;font-weight:800;color:var(--chat-text,#282335);list-style:none; }
    .news-tips > summary::-webkit-details-marker { display:none; }
    .news-tips > summary::after { content:"›";margin-left:auto;color:var(--chat-muted,#746b85);font-size:16px;line-height:1;transition:transform .15s; }
    .news-tips[open] > summary::after { transform:rotate(90deg); }
    .news-tips > summary b { border-radius:999px;padding:1px 7px;color:var(--chat-accent-text,#6d28d9);background:var(--chat-soft,rgba(124,58,237,.09));font-size:10px; }
    .news-tips ol { margin:0;padding:0 12px 10px 12px;list-style:none;counter-reset:tip; }
    .news-tips li { counter-increment:tip;display:grid;grid-template-columns:22px minmax(0,1fr);gap:0 6px;padding:7px 0;border-top:1px dashed var(--chat-line,rgba(124,58,237,.16)); }
    .news-tips li::before { content:counter(tip);grid-row:1 / span 2;width:20px;height:20px;border-radius:50%;background:var(--chat-soft,rgba(124,58,237,.09));color:var(--chat-accent-text,#6d28d9);font-size:10px;font-weight:800;line-height:20px;text-align:center; }
    .news-tips li strong { display:block;font-size:12.5px;line-height:1.4;color:var(--chat-text,#282335); }
    .news-tips li strong .news-tool { margin-left:6px;border-radius:999px;padding:0 6px;color:var(--chat-muted,#746b85);background:var(--chat-surface,#f1edf8);font-size:9.5px;font-weight:700;vertical-align:middle; }
    .news-tips li p { margin:3px 0 0;color:var(--chat-text,#282335);font-size:11.5px;line-height:1.5; }
    .news-tips li a { color:var(--chat-accent-text,#6d28d9);font-weight:700;text-decoration:none;white-space:nowrap; }.news-tips li a:hover { text-decoration:underline; }
    .news-tips li a.news-download { display:inline-block;margin-top:4px;border:1px solid var(--chat-line,rgba(124,58,237,.16));border-radius:999px;padding:2px 9px;background:var(--chat-soft,rgba(124,58,237,.09));font-size:10.5px; }
    .news-tips li .news-unverified { display:inline-block;margin:4px 0 0 6px;border-radius:999px;padding:2px 7px;color:#9a3412;background:#ffedd5;font-size:9.5px;font-weight:700; }
    .news-tips .news-empty { margin:0 12px 10px; }
    :host([data-theme="dark"]) .news-item,.news-screen.dark .news-item,:host([data-theme="dark"]) .news-tips,.news-screen.dark .news-tips { background:#1e1e2a;color:var(--chat-text,#f1edf9); }
  `;
  const node = (tag, className = "", text = null) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== null) element.textContent = text; return element; };
  const formatTime = value => { const date = new Date(value || ""); return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }); };
  const formatDate = value => { const [y, m, d] = String(value || "").split("-"); return d ? `${d}/${m}/${y}` : String(value || ""); };
  const todayKey = () => { const now = new Date(); const pad = n => String(n).padStart(2, "0"); return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`; };

  // Unread when today's bulletin exists and this device has not opened that build yet.
  function unread(meta, read) { return Boolean(meta?.builtAt) && meta.date === todayKey() && !(read && read.date === meta.date && read.builtAt === meta.builtAt); }

  // The "NEWS" header button with its unread dot. setUnread(bool) repaints it.
  function button(onClick) {
    const control = node("button", "news-button"); control.type = "button"; control.setAttribute("aria-label", "Tin tức công nghệ hôm nay"); control.title = "NEWS: tin công nghệ, model AI và Claude hôm nay";
    control.append(node("span", "", "NEWS"), node("span", "news-dot"));
    control.addEventListener("click", onClick);
    return { element: control, setUnread: value => control.classList.toggle("unread", Boolean(value)) };
  }

  function renderItems(container, bulletin) {
    container.replaceChildren();
    let total = 0;
    for (const [key, label, icon] of GROUPS) {
      const items = bulletin?.groups?.[key] || []; total += items.length;
      const group = node("section", "news-group"); const head = node("h4"); head.append(node("span", "", icon), document.createTextNode(label), node("b", "", String(items.length))); group.append(head);
      if (!items.length) group.append(node("p", "news-empty", "Hôm nay chưa có tin trong nhóm này."));
      items.forEach(item => {
        const link = node("a", "news-item"); link.href = item.url; link.target = "_blank"; link.rel = "noopener noreferrer";
        link.append(node("strong", "", item.title), node("span", "news-meta", [item.sourceLabel || item.source, formatTime(item.publishedAt), item.extra?.points ? `${item.extra.points} điểm HN` : ""].filter(Boolean).join(" · ")));
        if (item.summary) link.append(node("p", "", item.summary));
        else if (item.description) link.append(node("p", "original", item.description));
        group.append(link);
      });
      container.append(group);
    }
    return total;
  }

  // The two daily sections. `open` remembers which ones the device collapsed; `building` tells whether today's build may still add them.
  function renderTips(container, bulletin, { open = {}, building = false, onToggle = () => {} } = {}) {
    const tips = bulletin?.tips;
    const pending = !tips && building && bulletin?.date === todayKey();
    if (!tips && !pending) return 0;
    let total = 0;
    for (const [key, label, icon] of TIPS) {
      const items = Array.isArray(tips?.[key]) ? tips[key] : []; total += items.length;
      const details = node("details", "news-tips"); details.open = open[key] !== false;
      const head = node("summary"); head.append(node("span", "", icon), document.createTextNode(label), node("b", "", pending ? "…" : String(items.length)));
      details.append(head);
      if (!items.length) details.append(node("p", "news-empty", pending ? "Đang tạo bằng Codex, vài phút nữa sẽ có…" : `${tips?.error || "Hôm nay chưa tạo được mục này"}${/Làm mới/.test(tips?.error || "") ? "" : ". Thử Làm mới."}`));
      else {
        const list = node("ol");
        items.forEach(item => {
          const row = node("li"); const title = node("strong", "", item.title);
          if (item.tool && TOOL_LABEL[item.tool]) title.append(node("span", "news-tool", TOOL_LABEL[item.tool]));
          if (key === "aiTools" && item.kind) title.append(node("span", "news-tool", KIND_LABEL[item.kind] || item.kind));
          const body = node("p", "", item.body || "");
          if (item.url && key === "aiTools") {
            const link = node("a", "news-download", "Tải / Trang chủ ↗"); link.href = item.url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.title = item.url;
            body.append(document.createTextNode(" "), link);
            if (item.linkStatus === "unverified") body.append(node("span", "news-unverified", "chưa kiểm được link"));
          } else if (item.url) { const link = node("a", "", "Tài liệu ↗"); link.href = item.url; link.target = "_blank"; link.rel = "noopener noreferrer"; body.append(document.createTextNode(" "), link); }
          row.append(title, body); list.append(row);
        });
        details.append(list);
        if (tips.error) details.append(node("p", "news-empty", tips.error));
      }
      details.addEventListener("toggle", () => onToggle(key, details.open));
      container.append(details);
    }
    return total;
  }

  // mount(root, { api, refresh?, openUrl?, storage: { get(key) → Promise|value, set(key, value) }, cache?, dark? }) → { destroy }
  function mount(root, { api, refresh = null, storage, cache = null, dark = false } = {}) {
    const screen = node("div", `news-screen${dark ? " dark" : ""}`); root.append(screen);
    const bar = node("div", "news-bar"); const prev = node("button", "news-nav", "‹ Hôm trước"); prev.type = "button"; const next = node("button", "news-nav", "Hôm sau ›"); next.type = "button";
    const title = node("span", "news-date", "NEWS"); bar.append(prev, title, next);
    let refreshButton = null;
    if (refresh) { refreshButton = node("button", "news-refresh", "Làm mới"); refreshButton.type = "button"; bar.append(refreshButton); }
    const status = node("p", "news-status"); const list = node("div"); const tipsBox = node("div", "news-group"); const sources = node("p", "news-sources");
    screen.append(bar, status, list, tipsBox, sources);
    let dates = []; let current = ""; let destroyed = false; let poll = null; let tipsOpen = {}; let lastBulletin = null; let lastBuilding = false;
    const saveTipsOpen = (key, value) => { tipsOpen = { ...tipsOpen, [key]: value }; try { void storage?.set(TIPS_OPEN_KEY, tipsOpen); } catch { /* per-device convenience */ } };
    const paintTips = () => renderTips(tipsBox, lastBulletin, { open: tipsOpen, building: lastBuilding, onToggle: saveTipsOpen });

    const paint = (bulletin, note = "") => {
      current = bulletin?.date || current;
      title.textContent = bulletin ? `Bản tin ${formatDate(bulletin.date)}${bulletin.date === todayKey() ? " (hôm nay)" : ""}` : "NEWS";
      const total = renderItems(list, bulletin);
      lastBulletin = bulletin; const tipsTotal = paintTips();
      const failed = (bulletin?.sources || []).filter(source => !source.ok);
      const tipsNote = bulletin?.tips ? ` · ${tipsTotal} mẹo/tính năng/tool${bulletin.tips.error ? " (chưa đủ)" : ""}` : lastBuilding && bulletin?.date === todayKey() ? " · đang tạo mẹo/tính năng/tool…" : "";
      sources.textContent = bulletin ? `${total} tin · tạo lúc ${formatTime(bulletin.builtAt)}${bulletin.summarized ? " · đã tóm tắt tiếng Việt" : bulletin.summaryError ? ` · ${bulletin.summaryError}` : " · đang tóm tắt tiếng Việt…"}${tipsNote}${failed.length ? ` · nguồn lỗi: ${failed.map(source => `${source.label || source.id} (${source.error})`).join(", ")}` : ""}` : "";
      status.className = "news-status"; status.textContent = note;
      const index = dates.indexOf(current); prev.disabled = index < 0 || index >= dates.length - 1; next.disabled = index <= 0;
    };
    const markRead = async bulletin => { if (bulletin?.date === todayKey() && bulletin.builtAt) { try { await storage?.set(READ_KEY, { date: bulletin.date, builtAt: bulletin.builtAt }); } catch { /* per-device convenience */ } } };

    async function load(date = "today") {
      status.className = "news-status"; status.textContent = "Đang tải bản tin…";
      try {
        const data = await api(date === "today" ? "/today" : `/${date}`);
        if (destroyed) return;
        try { dates = (await api("/dates")).dates || dates; } catch { /* navigation only */ }
        const bulletin = data.bulletin || data;
        lastBuilding = Boolean(data.building);
        if (!bulletin?.date) { paint(null, data.building ? "Đang tải tin hôm nay từ các nguồn, vài giây nữa sẽ có…" : "Chưa có bản tin."); if (data.building) schedulePoll(); return; }
        paint(bulletin, data.building ? "Bản tin hôm nay đang được cập nhật; hiện bản gần nhất." : "");
        if (data.building || (bulletin.date === todayKey() && !bulletin.summarized && !bulletin.summaryError)) schedulePoll(); else clearTimeout(poll);
        if (bulletin.date === todayKey()) await markRead(bulletin);
      } catch (error) {
        if (destroyed) return;
        lastBuilding = false;
        if (cache?.date) { paint(cache, `Chưa kết nối được server (${error.message}); hiện bản tin đã lưu lúc ${formatTime(cache.builtAt)}.`); }
        else { paint(null); status.className = "news-status error"; status.textContent = `Không tải được bản tin: ${error.message}`; }
      }
    }
    function schedulePoll() { clearTimeout(poll); poll = setTimeout(() => { if (!destroyed && document.visibilityState === "visible") void load(current && current !== todayKey() ? current : "today"); }, 8_000); }
    prev.addEventListener("click", () => { const index = dates.indexOf(current); if (index >= 0 && dates[index + 1]) void load(dates[index + 1]); });
    next.addEventListener("click", () => { const index = dates.indexOf(current); if (index > 0) void load(dates[index - 1]); });
    refreshButton?.addEventListener("click", async () => {
      refreshButton.disabled = true; status.textContent = "Đang tải lại tin hôm nay từ các nguồn…";
      try { await refresh(); schedulePoll(); } catch (error) { status.className = "news-status error"; status.textContent = `Không làm mới được: ${error.message}`; }
      finally { refreshButton.disabled = false; }
    });
    (async () => { try { const saved = await storage?.get(TIPS_OPEN_KEY); if (saved && typeof saved === "object") tipsOpen = saved; } catch { /* default: open */ } if (!destroyed) await load("today"); })();
    return { destroy: () => { destroyed = true; clearTimeout(poll); screen.remove(); } };
  }

  return { css, mount, button, unread, READ_KEY };
})();
