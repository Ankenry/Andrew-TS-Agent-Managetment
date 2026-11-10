// "Analytics" section shared by the extension widget and the TS Management web: how often the AI check was right,
// judged by Đại tá's reaction on each AI review comment (👍 = đúng, 😢 = chưa đúng), plus the feedback form that
// trains later checks. Pure DOM; the host supplies `api` (talks to the local tracing web, scripts/hachimi-trace-web.mjs)
// and `openUrl`. Nothing here posts comments, reacts or changes ticket state.
globalThis.AnalyticsView = (() => {
  const VERDICT = {
    correct: { label: "AI check đúng", short: "Đúng", icon: "👍", className: "correct" },
    incorrect: { label: "AI check chưa đúng", short: "Chưa đúng", icon: "😢", className: "incorrect" },
    pending: { label: "Chưa đánh giá", short: "Chưa đánh giá", icon: "⏳", className: "pending" },
  };
  const RANGES = [["7", "7 ngày"], ["30", "30 ngày"], ["custom", "Tùy chọn"]];

  // Colors are status colors (validated green/red pair, see dataviz skill): identity is also carried by the icon, the
  // label and the hatched texture on the "chưa đúng" slice, never by color alone.
  const css = `
    .an-screen { display:grid;gap:14px;padding:14px 14px 22px;color:var(--chat-text,#282335);font-size:12px; }
    .an-screen *,.an-screen *::before,.an-screen *::after { box-sizing:border-box; }
    .an-card { border:1px solid var(--chat-line,rgba(124,58,237,.16));border-radius:14px;padding:12px;background:var(--chat-surface,#f1edf8); }
    .an-card h4 { margin:0 0 8px;color:var(--chat-text,#282335);font-size:13px; }
    .an-card .an-copy { margin:0 0 8px;color:var(--chat-muted,#746b85);font-size:11px;line-height:1.45; }
    .an-toolbar { display:flex;flex-wrap:wrap;align-items:center;gap:6px; }
    .an-seg { display:inline-flex;border:1px solid var(--chat-line,rgba(124,58,237,.16));border-radius:999px;padding:3px;background:var(--chat-soft,rgba(124,58,237,.09)); }
    .an-seg button { border:0;border-radius:999px;cursor:pointer;padding:6px 10px;color:var(--chat-muted,#746b85);background:transparent;font-size:11px;font-weight:800; }
    .an-seg button.active { color:#fff;background:var(--chat-accent,#7c3aed); }
    .an-custom { display:flex;flex-wrap:wrap;align-items:center;gap:6px;width:100%; }
    .an-custom input { width:auto;min-width:0;flex:1 1 120px;border:1px solid var(--chat-line,rgba(124,58,237,.16));border-radius:8px;padding:6px 8px;color:var(--chat-text,#282335);background:#fff;font-size:11px; }
    .an-button { border:0;border-radius:8px;cursor:pointer;padding:7px 10px;color:#fff;background:var(--chat-accent,#7c3aed);font-size:11px;font-weight:800;white-space:nowrap; }
    .an-button.secondary { color:var(--chat-accent-text,#6d28d9);background:var(--chat-soft,rgba(124,58,237,.09)); }
    .an-button:disabled { cursor:wait;opacity:.55; }
    .an-sync { margin-left:auto;display:flex;align-items:center;gap:6px;color:var(--chat-muted,#746b85);font-size:10px; }
    .an-status { margin:0;min-height:14px;color:var(--chat-muted,#746b85);font-size:11px;line-height:1.4; }.an-status.error { color:#dc2626; }.an-status.ok { color:#15803d; }
    .an-kpis { display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px; }
    .an-kpi { border:1px solid var(--chat-line,rgba(124,58,237,.16));border-radius:12px;padding:10px 8px;background:var(--chat-surface,#f1edf8);text-align:center; }
    .an-kpi strong { display:block;font-size:20px;line-height:1.1;color:var(--chat-text,#282335); }.an-kpi.hero strong { font-size:26px;color:var(--chat-accent-text,#6d28d9); }
    .an-kpi span { display:block;margin-top:4px;color:var(--chat-muted,#746b85);font-size:10px;line-height:1.25; }
    .an-charts { display:grid;gap:12px;min-width:0; }.an-charts > * { min-width:0; }
    @media (min-width:960px) { .an-charts { grid-template-columns:minmax(300px,2fr) minmax(0,3fr); } }
    .an-pie { display:flex;align-items:center;gap:14px; }.an-pie svg { width:132px;height:132px;flex:0 0 132px; }
    .an-legend { display:grid;gap:6px;min-width:0;flex:1; }.an-legend-item { display:flex;align-items:center;gap:8px;font-size:11px;color:var(--chat-text,#282335); }
    .an-swatch { width:12px;height:12px;flex:0 0 12px;border-radius:3px; }.an-swatch.correct { background:var(--an-correct); }.an-swatch.incorrect { background:var(--an-incorrect);background-image:repeating-linear-gradient(135deg,rgba(255,255,255,.55) 0 2px,transparent 2px 5px); }.an-swatch.pending { background:var(--chat-muted,#746b85);opacity:.45; }
    .an-legend-item b { margin-left:auto;font-weight:800; }
    .an-bars { position:relative;min-width:0; }.an-bars svg { display:block;max-width:100%;height:170px;overflow:visible; }
    .an-bars .an-grid { stroke:var(--chat-line,rgba(124,58,237,.16));stroke-width:1; }.an-bars .an-axis-text { fill:var(--chat-muted,#746b85);font-size:9px; }
    .an-bar { fill:var(--chat-accent,#7c3aed);cursor:pointer; }.an-bar:hover { fill:var(--chat-accent-text,#6d28d9); }.an-bar-empty { fill:var(--chat-muted,#746b85);opacity:.25; }
    .an-bar-hit { fill:transparent;cursor:pointer; }.an-bar-label { fill:var(--chat-text,#282335);font-size:9px;font-weight:800;text-anchor:middle; }
    .an-tip { position:absolute;z-index:3;pointer-events:none;border:1px solid var(--chat-line,rgba(124,58,237,.16));border-radius:8px;padding:6px 8px;color:#fff;background:#2a1c40;font-size:10px;line-height:1.4;white-space:nowrap;transform:translate(-50%,-110%); }
    .an-lists { display:grid;gap:12px; }
    .an-list { display:grid;gap:6px; }.an-list-head { display:flex;align-items:center;gap:8px; }.an-list-head h4 { margin:0; }.an-count { border-radius:999px;padding:2px 8px;font-size:10px;font-weight:800;color:#fff; }.an-count.correct { background:var(--an-correct); }.an-count.incorrect { background:var(--an-incorrect); }
    .an-item { display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;align-items:start;border:1px solid var(--chat-line,rgba(124,58,237,.16));border-radius:11px;padding:9px 10px;background:#fff; }
    .an-item-main { min-width:0; }.an-item-main strong { display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--chat-accent-text,#6d28d9); }
    .an-item-main span { display:block;overflow:hidden;margin-top:2px;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--chat-text,#282335); }.an-item-main small { display:block;margin-top:3px;color:var(--chat-muted,#746b85);font-size:10px; }
    .an-item-actions { display:flex;flex-direction:column;gap:4px; }.an-item-actions button { border:1px solid var(--chat-line,rgba(124,58,237,.16));border-radius:8px;cursor:pointer;padding:4px 8px;color:var(--chat-accent-text,#6d28d9);background:var(--chat-soft,rgba(124,58,237,.09));font-size:10px;font-weight:800;white-space:nowrap; }
    .an-item-actions button.primary { color:#fff;background:var(--chat-accent,#7c3aed);border-color:transparent; }
    .an-empty { margin:0;padding:10px;border:1px dashed var(--chat-line,rgba(124,58,237,.16));border-radius:10px;color:var(--chat-muted,#746b85);font-size:11px;text-align:center; }
    .an-more { border:0;cursor:pointer;padding:4px 0;color:var(--chat-accent-text,#6d28d9);background:transparent;font-size:11px;font-weight:800;text-align:left; }
    .an-form { display:grid;gap:8px; }.an-form label { display:block;margin:0 0 3px;color:var(--chat-muted,#746b85);font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.04em; }
    .an-form input,.an-form textarea { width:100%;border:1px solid var(--chat-line,rgba(124,58,237,.16));border-radius:9px;padding:8px 9px;outline:none;color:var(--chat-text,#282335);background:#fff;font-size:12px; }
    .an-form textarea { min-height:96px;resize:vertical;line-height:1.45; }.an-form input:focus,.an-form textarea:focus { border-color:var(--chat-accent,#7c3aed);box-shadow:0 0 0 3px var(--chat-soft,rgba(124,58,237,.09)); }
    .an-form-row { display:flex;align-items:center;gap:8px; }.an-form-row .an-status { flex:1; }
    .an-feedback-list { display:grid;gap:6px;margin-top:8px; }.an-feedback { border:1px solid var(--chat-line,rgba(124,58,237,.16));border-radius:10px;padding:8px 10px;background:#fff;font-size:11px; }
    .an-feedback strong { color:var(--chat-accent-text,#6d28d9); }.an-feedback p { margin:4px 0 0;white-space:pre-wrap;line-height:1.45;color:var(--chat-text,#282335); }.an-feedback small { display:block;margin-top:3px;color:var(--chat-muted,#746b85);font-size:10px; }
    .an-screen { --an-correct:#16a34a;--an-incorrect:#be123c; }
    :host([data-theme="dark"]) .an-screen,:root[data-theme="dark"] .an-screen,.an-screen.dark { --an-correct:#16a34a;--an-incorrect:#f43f5e; }
    :host([data-theme="dark"]) .an-item,:host([data-theme="dark"]) .an-feedback,:host([data-theme="dark"]) .an-form input,:host([data-theme="dark"]) .an-form textarea,:host([data-theme="dark"]) .an-custom input,
    .an-screen.dark .an-item,.an-screen.dark .an-feedback,.an-screen.dark .an-form input,.an-screen.dark .an-form textarea,.an-screen.dark .an-custom input { background:#1e1e2a;color:var(--chat-text,#f1edf9); }
    @media (max-width:360px) { .an-kpis { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  `;

  const SVG = "http://www.w3.org/2000/svg";
  const node = (tag, className = "", text = null) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== null) element.textContent = text; return element; };
  const svg = (tag, attributes = {}) => { const element = document.createElementNS(SVG, tag); for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value)); return element; };
  const formatTime = value => { const date = new Date(value || ""); return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" }); };
  const formatRate = value => value === null || value === undefined ? "—" : `${Number(value).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`;
  const dateInput = ms => { const date = new Date(ms); const pad = n => String(n).padStart(2, "0"); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; };
  const polar = (cx, cy, r, angle) => [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];

  function arcPath(cx, cy, outer, inner, start, end) {
    const [x1, y1] = polar(cx, cy, outer, start); const [x2, y2] = polar(cx, cy, outer, end);
    const [x3, y3] = polar(cx, cy, inner, end); const [x4, y4] = polar(cx, cy, inner, start);
    const large = end - start > Math.PI ? 1 : 0;
    return `M${x1} ${y1}A${outer} ${outer} 0 ${large} 1 ${x2} ${y2}L${x3} ${y3}A${inner} ${inner} 0 ${large} 0 ${x4} ${y4}Z`;
  }

  // Donut: share of judged tickets the AI got right, with the hero rate in the middle and direct labels on the slices.
  function renderPie(totals) {
    const wrap = node("div", "an-pie");
    const chart = svg("svg", { viewBox: "0 0 132 132", role: "img", "aria-label": `Tỉ lệ AI check đúng ${formatRate(totals.rate)}: ${totals.correct} đúng, ${totals.incorrect} chưa đúng` });
    const defs = svg("defs");
    const pattern = svg("pattern", { id: "an-hatch", patternUnits: "userSpaceOnUse", width: 6, height: 6, patternTransform: "rotate(135)" });
    pattern.append(svg("rect", { width: 6, height: 6, fill: "var(--an-incorrect)" }), svg("rect", { width: 2, height: 6, fill: "rgba(255,255,255,.5)" }));
    defs.append(pattern); chart.append(defs);
    const cx = 66, cy = 66, outer = 60, inner = 40;
    if (!totals.judged) chart.append(svg("circle", { cx, cy, r: (outer + inner) / 2, fill: "none", stroke: "var(--chat-line,rgba(124,58,237,.16))", "stroke-width": outer - inner }));
    else {
      const slices = [["correct", totals.correct, "var(--an-correct)"], ["incorrect", totals.incorrect, "url(#an-hatch)"]].filter(([, count]) => count > 0);
      let angle = -Math.PI / 2;
      for (const [verdict, count, fill] of slices) {
        const sweep = (count / totals.judged) * Math.PI * 2;
        const end = slices.length === 1 ? angle + Math.PI * 2 - 0.0001 : angle + sweep;
        const path = svg("path", { d: arcPath(cx, cy, outer, inner, angle, end), fill, stroke: "var(--chat-surface,#f1edf8)", "stroke-width": slices.length > 1 ? 2 : 0 });
        path.append(svg("title")); path.firstChild.textContent = `${VERDICT[verdict].label}: ${count} (${formatRate((count / totals.judged) * 100)})`;
        chart.append(path);
        if (sweep > 0.55) {
          const [lx, ly] = polar(cx, cy, (outer + inner) / 2, angle + sweep / 2);
          const label = svg("text", { x: lx, y: ly + 3, "text-anchor": "middle", fill: "#fff", "font-size": 10, "font-weight": 800 }); label.textContent = `${Math.round((count / totals.judged) * 100)}%`; chart.append(label);
        }
        angle = end;
      }
    }
    const hero = svg("text", { x: cx, y: cy + 2, "text-anchor": "middle", fill: "var(--chat-text,#282335)", "font-size": 18, "font-weight": 800 }); hero.textContent = formatRate(totals.rate);
    const sub = svg("text", { x: cx, y: cy + 16, "text-anchor": "middle", fill: "var(--chat-muted,#746b85)", "font-size": 8 }); sub.textContent = totals.judged ? `${totals.judged} đã đánh giá` : "chưa có đánh giá";
    chart.append(hero, sub);
    const legend = node("div", "an-legend");
    for (const verdict of ["correct", "incorrect", "pending"]) {
      const item = node("div", "an-legend-item"); const meta = VERDICT[verdict];
      item.append(node("span", `an-swatch ${meta.className}`), node("span", "", `${meta.icon} ${meta.label}`), node("b", "", String(totals[verdict] || 0)));
      legend.append(item);
    }
    wrap.append(chart, legend); return wrap;
  }

  // Columns: % correct per day (≤ 31 days) or per week, one hue; buckets without a judged ticket show a faint stub.
  // The SVG is drawn in real pixels at the width the card gives it (and redrawn when that width changes), so text and
  // bars keep their proportions on a phone, in the extension panel and on a wide desktop alike. A fixed viewBox with
  // preserveAspectRatio="none" stretched everything horizontally once the card was wider than the drawing (11/10/2026).
  function renderBars(buckets) {
    const wrap = node("div", "an-bars");
    const tip = node("div", "an-tip"); tip.hidden = true;
    const height = 170, left = 30, right = 8, top = 14, bottom = 26;
    let chart = null; let drawnWidth = 0;
    const draw = width => {
      chart?.remove(); drawnWidth = width;
      chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, width, height, role: "img", "aria-label": "Tỉ lệ AI check đúng theo thời gian" });
      const plotW = width - left - right, plotH = height - top - bottom;
      for (const tick of [0, 25, 50, 75, 100]) {
        const y = top + plotH - (tick / 100) * plotH;
        chart.append(svg("line", { x1: left, x2: width - right, y1: y, y2: y, class: "an-grid" }));
        const text = svg("text", { x: left - 5, y: y + 3, "text-anchor": "end", class: "an-axis-text" }); text.textContent = `${tick}%`; chart.append(text);
      }
      const count = Math.max(buckets.length, 1); const slot = plotW / count;
      // Bars stay slim on a phone and grow on a wide screen, but never into wide slabs.
      const barW = Math.max(3, Math.min(Math.max(26, slot * 0.45), 56, slot - 2));
      const labelEvery = Math.max(1, Math.ceil((count * 34) / plotW));
      buckets.forEach((bucket, index) => {
        const x = left + index * slot + (slot - barW) / 2;
        const judged = bucket.judged > 0;
        const h = judged ? Math.max(2, (bucket.rate / 100) * plotH) : 2;
        const y = top + plotH - h;
        const bar = svg("rect", { x, y, width: barW, height: h, rx: judged ? Math.min(4, barW / 2) : 1, class: judged ? "an-bar" : "an-bar-empty" });
        const hit = svg("rect", { x: left + index * slot, y: top, width: slot, height: plotH, class: "an-bar-hit" });
        const show = () => { tip.textContent = judged ? `${bucket.label}: ${formatRate(bucket.rate)} (${bucket.correct}/${bucket.judged} đúng${bucket.pending ? `, ${bucket.pending} chưa đánh giá` : ""})` : `${bucket.label}: chưa có ticket được đánh giá`; tip.hidden = false; tip.style.left = `${left + index * slot + slot / 2}px`; tip.style.top = `${y}px`; };
        const hide = () => { tip.hidden = true; };
        for (const target of [bar, hit]) { target.addEventListener("pointerenter", show); target.addEventListener("pointermove", show); target.addEventListener("pointerleave", hide); }
        chart.append(hit, bar);
        if (judged && slot >= 24) { const value = svg("text", { x: x + barW / 2, y: y - 3, class: "an-bar-label" }); value.textContent = `${Math.round(bucket.rate)}%`; chart.append(value); }
        // Labels every n-th bucket only, so neighbours never overlap on narrow screens; the tooltip names every bar.
        if (index % labelEvery === 0) { const label = svg("text", { x: left + index * slot + slot / 2, y: height - 8, "text-anchor": "middle", class: "an-axis-text" }); label.textContent = bucket.label; chart.append(label); }
      });
      wrap.prepend(chart);
    };
    draw(360);
    wrap.append(tip);
    // Redraw at the real width once the card is laid out and whenever it changes (window resize, panel resize).
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(entries => { const width = Math.round(entries[0]?.contentRect?.width || 0); if (width >= 120 && width !== drawnWidth) draw(width); });
      observer.observe(wrap);
    }
    return wrap;
  }

  function renderTicketList(title, verdict, tickets, { openUrl, onFeedback, api, range, pageInfo = {} }) {
    const section = node("section", "an-list"); const meta = VERDICT[verdict];
    const head = node("div", "an-list-head"); head.append(node("h4", "", `${meta.icon} ${title}`), node("span", `an-count ${meta.className}`, String(pageInfo.total ?? tickets.length))); section.append(head);
    if (!tickets.length) { section.append(node("p", "an-empty", "Chưa có kết quả trong nhóm này.")); return section; }
    const LIMIT = 8; let shown = LIMIT;
    const list = node("div", "an-list"); section.append(list);
    const paint = () => {
      list.replaceChildren();
      tickets.slice(0, shown).forEach(ticket => {
        const item = node("div", "an-item"); const main = node("div", "an-item-main");
        main.append(node("strong", "", `${ticket.ticket || ticket.ticketId}${ticket.category ? ` · ${ticket.category}` : ""}`), node("span", "", ticket.subject || ticket.excerpt || "Báo cáo check ticket"), node("small", "", [formatTime(ticket.commentAt), ticket.emoji ? `react ${ticket.emoji}` : "", ticket.feedbackCount ? `${ticket.feedbackCount} feedback` : ""].filter(Boolean).join(" · ")));
        const judgment = ticket.judgmentSource === "direct-assessment" ? "Đánh giá trực tiếp" : ticket.judgmentSource === "auto-unassessed" ? "Chưa đánh giá" : "Reaction lịch sử";
        main.append(node("small", "", judgment + (ticket.assessmentRevision ? ` · lần ${ticket.assessmentRevision}` : "") + (ticket.delivery?.label ? ` · ${ticket.delivery.label}` : "")));
        if (ticket.sourceConflict) main.append(node("small", "", "Nguồn đã đổi; đánh giá cũ thuộc bản kết quả đã lưu."));
        if (ticket.note) main.append(node("p", "", `Góp ý: ${ticket.note}`));
        const actions = node("div", "an-item-actions");
        const open = node("button", "", "Mở ticket"); open.type = "button"; open.addEventListener("click", () => openUrl(ticket.url));
        const feedback = node("button", "primary", "Train AI riêng"); feedback.type = "button"; feedback.addEventListener("click", () => onFeedback(ticket));
        actions.append(open, feedback); item.append(main, actions); list.append(item);
      });
      if (tickets.length > shown) { const more = node("button", "an-more", `Xem thêm ${tickets.length - shown} kết quả đã tải`); more.type = "button"; more.addEventListener("click", () => { shown += LIMIT; paint(); }); list.append(more); }
      else if (pageInfo.nextCursor && api) {
        const more = node("button", "an-more", "Đọc thêm kết quả từ máy chủ"); more.type = "button";
        more.addEventListener("click", async () => { more.disabled = true; try {
          const data = await api('/tickets?' + new URLSearchParams({ ...range, verdict, limit: '100', cursor: pageInfo.nextCursor }));
          const ids = new Set(tickets.map(t => t.effectiveId || t.commentId));
          for (const row of data.tickets || []) if (!ids.has(row.effectiveId || row.commentId)) { tickets.push(row); ids.add(row.effectiveId || row.commentId); }
          pageInfo.nextCursor = data.nextCursor; pageInfo.total = data.total; shown += LIMIT; paint();
        } catch (error) { more.textContent = error.message; more.disabled = false; } }); list.append(more);
      }
    };
    paint(); return section;
  }

  function renderFeedbackForm({ api, onTrained }) {
    const card = node("section", "an-card an-feedback-card");
    card.append(node("h4", "", "Feedback để train AI"), node("p", "an-copy", "Chọn Feedback ở một ticket phía trên (hoặc dán link ticket), mô tả AI check đúng/chưa đúng ở đâu và nên trả lời thế nào, rồi bấm Train AI. Đây là luồng huấn luyện riêng. Góp ý Đúng/Sai ở Han auto không tự được đưa vào đây."));
    const form = node("form", "an-form");
    const ticketLabel = node("label", "", "Ticket"); ticketLabel.htmlFor = "an-ticket";
    const ticket = node("input"); ticket.id = "an-ticket"; ticket.placeholder = "Dán link ticket Helpdesk hoặc mã ticket (AIR-261002-QSGTPD)"; ticket.autocomplete = "off"; ticket.spellcheck = false;
    const descriptionLabel = node("label", "", "Description"); descriptionLabel.htmlFor = "an-description";
    const description = node("textarea"); description.id = "an-description"; description.placeholder = "AI check đúng/chưa đúng ở điểm nào? Lần sau nên kiểm tra hoặc trả lời ra sao?";
    const row = node("div", "an-form-row"); const status = node("p", "an-status");
    const train = node("button", "an-button", "Train AI"); train.type = "submit";
    row.append(status, train);
    form.append(ticketLabel, ticket, descriptionLabel, description, row);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      train.disabled = true; status.className = "an-status"; status.textContent = "Đang lưu feedback…";
      try {
        const saved = await api("/train", { method: "POST", body: { ticket: ticket.value.trim(), description: description.value.trim() } });
        status.className = "an-status ok"; status.textContent = `Đã train: feedback #${saved.id} cho ${saved.ticket} được lưu vào database và sẽ dùng cho các lượt check sau.`;
        description.value = ""; onTrained?.(saved);
      } catch (error) { status.className = "an-status error"; status.textContent = `Chưa lưu được: ${error.message}`; }
      finally { train.disabled = false; }
    });
    card.append(form);
    const history = node("div", "an-feedback-list"); card.append(history);
    return { card, ticket, description, history };
  }

  function renderFeedbackHistory(container, feedback) {
    container.replaceChildren();
    if (!feedback.length) return;
    const toggle = node("button", "an-more", `Đã train ${feedback.length} feedback · xem`); toggle.type = "button";
    const list = node("div", "an-feedback-list"); list.hidden = true;
    feedback.slice(0, 20).forEach(item => {
      const row = node("div", "an-feedback"); const meta = VERDICT[item.verdict] || VERDICT.pending;
      row.append(node("strong", "", `${item.ticket}${item.category ? ` · ${item.category}` : ""} · ${meta.icon} ${meta.short}`), node("p", "", item.description), node("small", "", formatTime(item.createdAt)));
      list.append(row);
    });
    toggle.addEventListener("click", () => { list.hidden = !list.hidden; toggle.textContent = `Đã train ${feedback.length} feedback · ${list.hidden ? "xem" : "ẩn"}`; });
    container.append(toggle, list);
  }

  // mount(root, { api(path, { method, body }), openUrl(url), dark }) → { refresh, destroy }
  function mount(root, { api, openUrl = url => window.open(url, "_blank", "noopener,noreferrer"), dark = false } = {}) {
    const screen = node("div", `an-screen${dark ? " dark" : ""}`); root.append(screen);
    let range = { days: "7" }; let busy = false; let destroyed = false; let painted = ""; let lastStatus = "";
    const visible = () => !destroyed && screen.isConnected && document.visibilityState === "visible";
    const toolbar = node("section", "an-card"); const bar = node("div", "an-toolbar"); const seg = node("div", "an-seg");
    const custom = node("div", "an-custom"); custom.hidden = true;
    const from = node("input"); from.type = "date"; const to = node("input"); to.type = "date";
    const apply = node("button", "an-button secondary", "Áp dụng"); apply.type = "button";
    custom.append(node("span", "", "Từ"), from, node("span", "", "đến"), to, apply);
    const buttons = new Map();
    RANGES.forEach(([key, label]) => {
      const button = node("button", key === range.days ? "active" : "", label); button.type = "button";
      button.addEventListener("click", () => {
        buttons.forEach((other, otherKey) => other.classList.toggle("active", otherKey === key));
        custom.hidden = key !== "custom";
        if (key !== "custom") { range = { days: key }; void load(); }
        else { if (!from.value) from.value = dateInput(Date.now() - 30 * 86_400_000); if (!to.value) to.value = dateInput(Date.now()); }
      });
      buttons.set(key, button); seg.append(button);
    });
    apply.addEventListener("click", () => {
      if (!from.value || !to.value) return;
      range = { from: new Date(`${from.value}T00:00:00`).toISOString(), to: new Date(`${to.value}T23:59:59`).toISOString() };
      void load();
    });
    const sync = node("div", "an-sync"); const syncButton = node("button", "an-button secondary", "Đồng bộ reaction"); syncButton.type = "button"; syncButton.disabled = true; const syncText = node("span");
    let reactionEnabled = false;
    syncButton.addEventListener("click", async () => {
      if (!reactionEnabled) return;
      syncButton.disabled = true; syncText.textContent = "Đang đọc reaction trên Helpdesk…";
      try {
        await api("/sync", { method: "POST", body: {} });
        // The sync runs on the server; follow it until it ends, then repaint.
        for (let i = 0; i < 40; i += 1) { await new Promise(done => setTimeout(done, 3_000)); const state = await api("/sync"); if (!state.running) break; syncText.textContent = "Đang đọc reaction trên Helpdesk…"; }
        await load();
      }
      catch (error) { syncText.textContent = `Không đồng bộ được: ${error.message}`; }
      finally { syncButton.disabled = !reactionEnabled; }
    });
    sync.append(syncButton, syncText); bar.append(seg, sync, custom);
    const status = node("p", "an-status");
    toolbar.append(bar, status); screen.append(toolbar);
    const kpis = node("section", "an-kpis"); const charts = node("section", "an-charts"); const lists = node("section", "an-lists"); screen.append(kpis, charts, lists);
    const form = renderFeedbackForm({ api, onTrained: () => void loadFeedback() }); screen.append(form.card);
    const focusFeedback = ticket => {
      form.ticket.value = ticket.url || ticket.ticket || "";
      form.card.scrollIntoView({ behavior: "smooth", block: "start" });
      setTimeout(() => form.description.focus(), 250);
    };

    async function loadFeedback() {
      try { const data = await api("/feedback?limit=100"); if (!destroyed) renderFeedbackHistory(form.history, data.feedback || []); } catch { /* history is optional */ }
    }
    async function load() {
      if (busy || destroyed) return; busy = true;
      status.className = "an-status"; status.textContent = "Đang tải số liệu…";
      try {
        const params = new URLSearchParams(range).toString();
        const data = await api(`/summary?${params}`);
        if (destroyed) return;
        const syncState = data.sync || {};
        reactionEnabled = syncState.enabled === true;
        syncButton.disabled = !reactionEnabled;
        syncText.textContent = !reactionEnabled ? "Đồng bộ reaction đang tắt trong Settings." : syncState.running ? "Đang đồng bộ…" : syncState.lastRun ? `Đồng bộ lúc ${formatTime(syncState.lastRun)}${syncState.lastError ? ` · ${syncState.lastError}` : ""}` : "Chưa đồng bộ reaction.";
        // Repaint only when the figures changed, so a background refresh never disturbs what the user is reading.
        const signature = JSON.stringify([data.totals, data.buckets, ['correct','incorrect','pending'].map(v => (data[v] || []).map(t => [t.effectiveId || t.commentId, t.verdict, t.judgmentSource, t.assessmentRevision, t.note, t.delivery, t.sourceConflict, t.feedbackCount])), data.allTime, data.excludedCount, (data.excludedRows || []).map(r=>r.effectiveId)]);
        if (signature === painted) { status.textContent = `${lastStatus} · cập nhật ${new Date().toLocaleTimeString("vi-VN")}`; return; }
        painted = signature;
        const totals = data.totals || { correct: 0, incorrect: 0, pending: 0, judged: 0, total: 0, rate: null };
        kpis.replaceChildren();
        [["hero", formatRate(totals.rate), "Tỉ lệ AI check đúng"], ["", String(totals.correct), "Đúng"], ["", String(totals.incorrect), "Sai"], ["", String(totals.pending), "⏳ Chưa đánh giá"]].forEach(([className, value, label]) => {
          const tile = node("div", `an-kpi ${className}`.trim()); tile.append(node("strong", "", value), node("span", "", label)); kpis.append(tile);
        });
        charts.replaceChildren();
        const pieCard = node("section", "an-card"); pieCard.append(node("h4", "", "Tỉ lệ ticket AI check đúng / chưa đúng"), renderPie(totals)); charts.append(pieCard);
        const barCard = node("section", "an-card"); const buckets = data.buckets || [];
        barCard.append(node("h4", "", `Tỉ lệ check đúng theo ${buckets.length > 31 ? "tuần" : "ngày"}`), node("p", "an-copy", "Mỗi cột = số kết quả Đúng chia cho số kết quả đã đánh giá theo ngày/tuần của lượt check. Đánh giá trực tiếp ưu tiên khi có cùng report; reaction lịch sử được giữ."), renderBars(buckets)); charts.append(barCard);
        lists.replaceChildren(...['correct','incorrect','pending'].map(verdict => renderTicketList(verdict === 'correct' ? 'Kết quả AI — Đúng' : verdict === 'incorrect' ? 'Kết quả AI — Sai' : 'Kết quả chưa đánh giá', verdict, data[verdict] || [], { openUrl, onFeedback: focusFeedback, api, range: data.range, pageInfo: data.listPages?.[verdict] || {} })));
        if (data.excludedCount) {
          const warning = node("details", "an-card"); warning.append(node("summary", "", `${data.excludedCount} dòng cần đối chiếu binding — chưa tính vào tổng`));
          for (const row of data.excludedRows || []) warning.append(node("p", "", `${row.ticket || row.ticketId || row.reportId}: dữ liệu lịch sử được giữ; chưa đủ bằng chứng để hợp nhất.`));
          if (data.excludedCount > (data.excludedRows || []).length) warning.append(node("p", "", `Đang hiển thị ${(data.excludedRows || []).length}/${data.excludedCount} dòng cảnh báo.`));
          lists.append(warning);
        }
        const allTime = data.allTime || {};
        lastStatus = `${totals.total} báo cáo AI trong khoảng đã chọn (${totals.judged} đã đánh giá). Toàn bộ: ${allTime.correct || 0} đúng · ${allTime.incorrect || 0} chưa đúng · ${allTime.pending || 0} chưa đánh giá${allTime.rate !== null && allTime.rate !== undefined ? ` · ${formatRate(allTime.rate)} đúng` : ""}.`;
        status.textContent = lastStatus + (data.excludedCount ? ` · ${data.excludedCount} dòng có binding mâu thuẫn chưa được tính vào tổng.` : "");
      } catch (error) {
        status.className = "an-status error"; status.textContent = `Không tải được số liệu: ${error.message}`;
      } finally { busy = false; }
    }
    void load(); void loadFeedback();
    // While the page is open: re-read reactions of the recent tickets every minute (the server rate-limits this) and
    // refresh the figures every 15 s, so a new 👍/😢 shows up without a reload.
    const refreshTimer = setInterval(() => { if (visible()) void load(); }, 15_000);
    const recentSync = () => { if (visible() && reactionEnabled) api("/sync", { method: "POST", body: { recentDays: 3 } }).catch(() => {}); };
    const syncTimer = setInterval(recentSync, 60_000);
    setTimeout(recentSync, 1_500);
    return { refresh: load, destroy: () => { destroyed = true; clearInterval(refreshTimer); clearInterval(syncTimer); screen.remove(); } };
  }

  function settingsCard({ api }) {
    const card = document.createElement('section'); card.className = 'setting-card reaction-analytics-settings';
    const title = document.createElement('h4'); title.textContent = 'Reaction Analytics';
    const copy = document.createElement('p'); copy.textContent = 'OFF: dừng đọc reaction từ Helpdesk, gồm quét nền mỗi 10 phút và đồng bộ khi mở Analytics. Số liệu đã lưu vẫn xem được. Cấu hình dùng chung cho web và extension.';
    const label = document.createElement('label'); label.className = 'setting-switch';
    const name = document.createElement('span'); name.textContent = 'Bật đồng bộ reaction Analytics';
    const input = document.createElement('input'); input.type = 'checkbox'; input.setAttribute('role','switch'); input.setAttribute('aria-label',name.textContent); input.disabled = true;
    const track = document.createElement('span'); track.className = 'switch-track'; track.setAttribute('aria-hidden','true');
    label.append(name,input,track);
    const status = document.createElement('p'); status.className = 'settings-status'; status.setAttribute('role','status'); status.setAttribute('aria-live','polite');
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'secondary'; retry.textContent = 'Đọc lại cấu hình';
    card.append(title,copy,label,status,retry);
    let snapshot = null, disposed = false, busy = false;
    const paint = (message = '', error = false) => {
      input.checked = snapshot?.enabled === true;
      input.disabled = !snapshot || busy;
      retry.disabled = busy;
      status.textContent = message || (snapshot ? `Đang ${snapshot.enabled ? 'ON' : 'OFF'} · dùng chung cho web và extension.` : 'Chưa đọc được cấu hình.');
      status.className = `settings-status${error ? ' error' : snapshot ? ' ok' : ''}`;
    };
    async function refresh() {
      if (disposed || busy) return;
      busy = true; paint('Đang đọc cấu hình…');
      try {
        const value = await api('/reaction-settings');
        if (disposed) return;
        if (typeof value?.enabled !== 'boolean' || !Number.isSafeInteger(value.revision)) throw Error('Cấu hình không hợp lệ.');
        snapshot = value; busy = false; paint();
      } catch (error) { if (!disposed) { busy = false; paint(`Chưa đọc được cấu hình: ${error.message}`, true); input.disabled = true; } }
    }
    input.addEventListener('change', async () => {
      if (disposed || busy || !snapshot) return;
      const desired = input.checked, revision = snapshot.revision;
      busy = true; paint('Đang lưu lựa chọn…');
      let writeError = null;
      try { await api('/reaction-settings', { method:'PUT', body:{ enabled:desired, expectedRevision:revision } }); }
      catch (error) { writeError = error; }
      if (disposed) return;
      try {
        const value = await api('/reaction-settings');
        if (disposed) return;
        if (typeof value?.enabled !== 'boolean' || !Number.isSafeInteger(value.revision)) throw Error('Cấu hình không hợp lệ.');
        snapshot = value; busy = false;
        paint(writeError ? `Chưa xác nhận lần lưu: ${writeError.message}. Đã đọc lại giá trị hiện tại.` : value.enabled === desired ? `Đã ${desired ? 'bật' : 'tắt'} và xác nhận trên máy chủ.` : 'Giá trị máy chủ đã thay đổi; hiển thị giá trị mới nhất.', Boolean(writeError) || value.enabled !== desired);
      } catch (error) { busy = false; paint(`Chưa xác minh kết quả lưu: ${error.message}. Bấm Đọc lại cấu hình.`, true); input.disabled = true; }
    });
    retry.addEventListener('click',refresh);
    const onVisible = () => { if (document.visibilityState === 'visible' && card.isConnected) void refresh(); };
    document.addEventListener('visibilitychange',onVisible);
    return { element:card, refresh, dispose() { disposed = true; document.removeEventListener('visibilitychange',onVisible); } };
  }

  return { css, mount, VERDICT, settingsCard };
})();
