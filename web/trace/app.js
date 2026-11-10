/* Hachimi Trace UI — vanilla JS, talks to /api and listens on /api/stream (SSE). */
(() => {
  const $ = id => document.getElementById(id);
  const state = { sessions: [], total: 0, offset: 0, selected: null, detail: null, hiddenKinds: new Set(), hiddenSourceTypes: new Set(), retentionDays: 10, filters: { q: '', source: '', status: '', chatId: '', ticket: '' }, contextNote: '' };
  const PAGE = 60;
  const HELPDESK = 'https://helpdesk.avada.net/tickets/';
  const KIND_LABEL = { start: 'bắt đầu', phase: 'pha', waiting: 'chờ', text: 'text', thinking: 'suy luận', tool: 'tool', observation: 'quan sát', note: 'ghi chú', warning: 'cảnh báo', result: 'kết quả', done: 'xong', error: 'lỗi', cancelled: 'hủy' };
  const SOURCE_LABEL = { docs: 'Docs', skill: 'Skill', kb: 'KB', elite: 'TS Elite 2', ticket: 'Ticket', url: 'Link', artifact: 'Artifact', file: 'File' };
  const STATUS_LABEL = { used: 'đã dùng', unavailable: 'không truy cập được', read: 'đã đọc' };
  let toastTimer;
  // Phone layout (same query as style.css): the list and the session are two screens and the page itself scrolls.
  const PHONE = matchMedia('(max-width: 760px), (max-height: 500px) and (pointer: coarse)');
  let listScroll = 0;
  // Positions are set here (top of a session, last place in the list), not by the browser's own restoration.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  function showDetail(on) {
    const shown = document.body.classList.contains('show-detail');
    if (on && !shown) listScroll = window.scrollY;
    document.body.classList.toggle('show-detail', on);
    if (PHONE.matches && (on || shown)) window.scrollTo(0, on ? 0 : listScroll);
  }
  // navigator.clipboard needs a secure context; http://<local domain> is not one, so fall back to a hidden textarea.
  const copyText = async text => {
    if (window.isSecureContext && navigator.clipboard) return navigator.clipboard.writeText(text);
    const area = document.createElement('textarea'); area.value = text; area.setAttribute('readonly', ''); area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(area); area.select();
    try { if (!document.execCommand('copy')) throw new Error('Trình duyệt không cho sao chép'); } finally { area.remove(); }
  };

  const api = async (path, options = {}) => {
    const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  };
  const toast = message => { const el = $('toast'); el.textContent = message; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3200); };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  const fmtDate = iso => iso ? new Date(iso).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const rel = iso => {
    if (!iso) return '';
    const diff = (Date.parse(iso) - Date.now()) / 1000; const abs = Math.abs(diff);
    const unit = abs < 60 ? [Math.round(abs), 'giây'] : abs < 3600 ? [Math.round(abs / 60), 'phút'] : abs < 86400 ? [Math.round(abs / 3600), 'giờ'] : [Math.round(abs / 86400), 'ngày'];
    return diff < 0 ? `${unit[0]} ${unit[1]} trước` : `sau ${unit[0]} ${unit[1]}`;
  };
  const badge = (text, cls = '') => text ? `<span class="badge ${esc(cls)}">${esc(text)}</span>` : '';

  /* ---------- stats ---------- */
  async function loadStats() {
    try {
      const s = await api('/api/stats');
      state.retentionDays = s.retention_days; $('retentionDays').textContent = s.retention_days;
      $('stSessions').textContent = s.sessions; $('stActive').textContent = s.active_sessions; $('stEvents').textContent = s.events;
      $('stArtifacts').textContent = s.artifacts; $('stSources').textContent = s.sources ?? 0; $('stExpiring').textContent = s.expiring_soon; $('stStorage').textContent = s.storage || '–';
      // Other devices on the network are read-only: the server refuses writes, so the buttons are not offered.
      for (const id of ['btnSync', 'btnPurge', 'btnDelete']) $(id).hidden = Boolean(s.read_only);
      const purge = s.last_purge; $('stPurge').textContent = purge ? `${fmtDate(purge.ran_at)} · xóa ${purge.deleted_sessions}` : 'chưa chạy';
    } catch (error) { $('stPurge').textContent = 'lỗi: ' + error.message; }
  }

  /* ---------- session list ---------- */
  async function loadSessions({ append = false } = {}) {
    const params = new URLSearchParams({ ...state.filters, limit: PAGE, offset: append ? state.offset : 0 });
    const data = await api('/api/sessions?' + params);
    state.sessions = append ? state.sessions.concat(data.sessions) : data.sessions;
    state.total = data.total; state.offset = state.sessions.length;
    renderSessions();
  }
  function renderSessions() {
    const list = $('sessions');
    list.innerHTML = state.sessions.map(s => {
      const ref = s.ticket_reference || s.external_id;
      const expSoon = Date.parse(s.expires_at) - Date.now() < 86400e3;
      const status = s.terminal ? (s.status || s.last_kind || 'done') : (s.status || 'running');
      return `<li class="session ${state.selected === s.id ? 'active' : ''}" data-id="${s.id}" role="option">
        <div class="top"><span class="ref">${esc(ref)}</span>${badge(s.source, 'source')}</div>
        <div class="subject" title="${esc(s.subject || '')}">${esc(s.subject || '(không có tiêu đề)')}</div>
        <div class="bottom">${badge(status, status)}${badge(s.category, 'category')}<span>${s.event_count} sự kiện${s.source_count ? ` · ${s.source_count} nguồn` : ''}${s.artifact_count ? ` · ${s.artifact_count} artifact` : ''}</span><span class="expire ${expSoon ? 'soon' : ''}" title="Hết hạn ${fmtDate(s.expires_at)}">⌛ ${rel(s.expires_at)}</span></div>
        ${s.last_text ? `<div class="last">${esc(s.last_text)}</div>` : ''}
        <div class="last">${fmtDate(s.started_at || s.created_at)}${s.phase ? ` · ${esc(s.phase)}` : ''}</div>
      </li>`;
    }).join('');
    $('listCount').textContent = `${state.sessions.length}/${state.total} phiên`;
    const chip = $('contextChip'); chip.hidden = !state.filters.chatId && !state.filters.ticket && !state.contextNote;
    $('contextText').textContent = state.contextNote || (state.filters.chatId ? `Conversation ${state.filters.chatId}` : state.filters.ticket ? `Ticket ${state.filters.ticket} (mọi nguồn)` : '');
    $('btnMore').hidden = state.sessions.length >= state.total;
  }

  /* ---------- detail ---------- */
  async function openSession(id, { keepHash = false } = {}) {
    state.selected = id; state.detail = await api('/api/sessions/' + id);
    if (!keepHash) location.hash = 'session/' + id;
    renderSessions(); renderDetail(); showDetail(true);
  }
  function renderDetail() {
    const d = state.detail; if (!d) return;
    const s = d.session;
    $('emptyDetail').hidden = true; $('sessionView').hidden = false;
    const status = s.terminal ? (s.status || 'done') : (s.status || 'running');
    $('sBadges').innerHTML = badge(s.source, 'source') + badge(status, status) + badge(s.category, 'category') + (s.trigger ? badge(s.trigger, 'source') : '');
    $('sTitle').textContent = [s.ticket_reference, s.subject].filter(Boolean).join(' · ') || s.external_id;
    $('sRef').textContent = s.ticket_reference || s.external_id;
    const duration = s.started_at && s.ended_at ? ` · kéo dài ${Math.round((Date.parse(s.ended_at) - Date.parse(s.started_at)) / 1000)}s` : '';
    $('sMeta').textContent = `id ${s.source}:${s.external_id} · bắt đầu ${fmtDate(s.started_at || s.created_at)}${duration} · pha ${s.phase || '–'} · hết hạn ${fmtDate(s.expires_at)} (${rel(s.expires_at)})`;
    const link = $('sTicketLink'); link.hidden = !s.ticket_reference; if (s.ticket_reference) link.href = HELPDESK + s.ticket_reference;
    $('cEvents').textContent = d.events.length; $('cArtifacts').textContent = d.artifacts.length; $('cSources').textContent = (d.sources || []).length;
    renderKindFilter(); renderTimeline(); renderSourceTypeFilter(); renderSources();
    $('artifactList').innerHTML = d.artifacts.map(a => `<li data-id="${a.id}"><span>${esc(a.name)}</span><span class="run">${esc(a.run_id.slice(0, 8))} · ${a.size ?? 0}b</span></li>`).join('') || '<li>Không có artifact</li>';
    $('artifactName').textContent = 'Chọn một artifact'; $('artifactContent').textContent = '';
    $('metadata').textContent = JSON.stringify({ ...s, metadata: s.metadata }, null, 2);
  }
  function renderKindFilter() {
    const kinds = [...new Set(state.detail.events.map(e => e.kind))];
    $('kindFilter').innerHTML = kinds.map(k => `<label class="${state.hiddenKinds.has(k) ? 'off' : ''}"><input type="checkbox" data-kind="${esc(k)}" ${state.hiddenKinds.has(k) ? '' : 'checked'}> ${esc(KIND_LABEL[k] || k)} <span class="count">${state.detail.events.filter(e => e.kind === k).length}</span></label>`).join('');
  }
  // The few payload fields worth reading without opening the payload: attempt, duration, who handled the request, why it failed.
  const ms = value => value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
  function payloadFacts(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
    const facts = [];
    if (Number.isInteger(payload.attempt)) facts.push(`lần ${payload.attempt}${Number.isInteger(payload.maxAttempts) ? `/${payload.maxAttempts}` : ''}`);
    if (Number.isFinite(payload.elapsedMs)) facts.push(`⏱ ${ms(payload.elapsedMs)}`);
    if (Number.isFinite(payload.retryInMs)) facts.push(`thử lại sau ${ms(payload.retryInMs)}`);
    if (payload.consumer) facts.push(`bên xử lý: ${payload.consumer}`);
    if (Number.isInteger(payload.httpStatus)) facts.push(`HTTP ${payload.httpStatus}`);
    if (payload.code) facts.push(String(payload.code).slice(0, 80));
    if (payload.runId) facts.push(`run ${String(payload.runId).slice(0, 8)}`);
    const hint = payload.hint ? `<div class="hint">${esc(payload.hint)}</div>` : '';
    return facts.length || hint ? `<div class="facts">${facts.map(fact => `<span>${esc(fact)}</span>`).join('')}</div>${hint}` : '';
  }
  function eventHtml(e, fresh = false) {
    const long = (e.text || '').length > 900;
    const facts = payloadFacts(e.payload);
    const payload = e.payload ? `<details><summary>payload</summary><pre>${esc(JSON.stringify(e.payload, null, 2))}</pre></details>` : '';
    return `<li class="ev k-${esc(e.kind)} ${fresh ? 'new' : ''}" data-seq="${e.seq}">
      <div class="head"><span class="time" title="${esc(e.at)}">${fmtTime(e.at)}</span><span class="kind">${esc(KIND_LABEL[e.kind] || e.kind)}</span>${e.phase ? `<span>· ${esc(e.phase)}</span>` : ''}${e.actor ? `<span>· ${esc(e.actor)}</span>` : ''}<span>#${e.seq}</span></div>
      ${e.text || payload ? `<div class="body">${e.text ? `<div class="text ${long ? 'long' : ''}">${esc(e.text)}</div>${long ? '<button class="link expand">Xem đầy đủ</button>' : ''}` : ''}${facts}${payload}</div>` : ''}
      ${e.sources?.length ? `<div class="ev-sources" title="Nguồn dữ liệu AI đã lấy ở bước này">${e.sources.map(sourceChip).join('')}</div>` : ''}
    </li>`;
  }

  /* ---------- data sources ---------- */
  // Sources with local content open the viewer page; link-only sources open the link itself. Both in a new window.
  const sourceHref = src => src.path || src.type === 'kb' || !src.url ? `/source/${src.id}` : src.url;
  const sourceChip = src => `<a class="src-chip t-${esc(src.type)}" href="${esc(sourceHref(src))}" target="_blank" rel="noopener noreferrer" title="${esc(src.path || src.url || src.label)}"><span class="t">${esc(SOURCE_LABEL[src.type] || src.type)}</span><span class="l">${esc(src.label)}</span></a>`;
  function renderSourceTypeFilter() {
    const sources = state.detail?.sources || [];
    const types = [...new Set(sources.map(s => s.type))];
    $('sourceTypeFilter').innerHTML = types.map(t => `<label class="${state.hiddenSourceTypes.has(t) ? 'off' : ''}"><input type="checkbox" data-type="${esc(t)}" ${state.hiddenSourceTypes.has(t) ? '' : 'checked'}> <span class="badge t-${esc(t)}">${esc(SOURCE_LABEL[t] || t)}</span> <span class="count">${sources.filter(s => s.type === t).length}</span></label>`).join('');
  }
  function sourceCard(src) {
    const status = src.metadata?.status ? `<span class="badge status-${esc(src.metadata.status)}">${esc(STATUS_LABEL[src.metadata.status] || src.metadata.status)}</span>` : '';
    const where = src.path || src.url || '';
    return `<li><a class="source-card t-${esc(src.type)}" href="${esc(sourceHref(src))}" target="_blank" rel="noopener noreferrer">
      <div class="sc-top"><span class="badge t-${esc(src.type)}">${esc(SOURCE_LABEL[src.type] || src.type)}</span><span class="sc-label">${esc(src.label)}</span>${status}<span class="sc-open" aria-hidden="true">↗</span></div>
      ${where ? `<div class="sc-path" title="${esc(where)}">${esc(where)}${src.locator && src.locator !== src.label ? ` · ${esc(src.locator)}` : ''}</div>` : ''}
      ${src.excerpt ? `<div class="sc-excerpt">${esc(src.excerpt)}</div>` : ''}
    </a></li>`;
  }
  function renderSources() {
    const d = state.detail; if (!d) return;
    const sources = (d.sources || []).filter(s => !state.hiddenSourceTypes.has(s.type));
    const groups = new Map();
    for (const src of sources) (groups.get(src.event_seq) ?? groups.set(src.event_seq, []).get(src.event_seq)).push(src);
    const bySeq = new Map(d.events.map(e => [e.seq, e]));
    const html = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([seq, list]) => {
      const e = bySeq.get(seq);
      const head = e
        ? `<span class="time">${fmtTime(e.at)}</span><span class="kind k-${esc(e.kind)}">${esc(KIND_LABEL[e.kind] || e.kind)}</span>${e.phase ? `<span class="phase">· ${esc(e.phase)}</span>` : ''}<span class="sg-text" title="${esc(e.text || '')}">${esc((e.text || '').split('\n')[0].slice(0, 160))}</span><span class="seq">#${seq}</span>`
        : `<span class="kind">phiên</span><span class="sg-text">Nguồn gắn với cả phiên</span>`;
      return `<li class="source-group"><div class="sg-head">${head}</div><ul class="source-cards">${list.map(sourceCard).join('')}</ul></li>`;
    }).join('');
    $('sourceGroups').innerHTML = html || `<li class="tail">${(d.sources || []).length ? 'Đã ẩn hết theo bộ lọc.' : 'Chưa ghi nhận nguồn dữ liệu nào cho phiên này.'}</li>`;
  }
  function renderTimeline() {
    const events = state.detail.events.filter(e => !state.hiddenKinds.has(e.kind));
    $('timeline').innerHTML = events.map(e => eventHtml(e)).join('') || '<li class="tail">Chưa có sự kiện.</li>';
    $('tail').textContent = state.detail.session.terminal ? 'Phiên đã kết thúc.' : 'Đang chờ sự kiện mới… (realtime)';
  }
  function appendEvents(events) {
    const d = state.detail; if (!d) return;
    const known = new Set(d.events.map(e => e.seq));
    const fresh = events.filter(e => !known.has(e.seq));
    if (!fresh.length) return;
    d.events.push(...fresh); d.events.sort((a, b) => a.seq - b.seq);
    if (fresh.some(e => ['done', 'error', 'cancelled'].includes(e.kind))) d.session.terminal = true;
    d.sources = d.sources || [];
    const knownSources = new Set(d.sources.map(s => s.id));
    for (const e of fresh) for (const src of e.sources || []) if (!knownSources.has(src.id)) { knownSources.add(src.id); d.sources.push(src); }
    $('cEvents').textContent = d.events.length; $('cSources').textContent = d.sources.length; renderKindFilter(); renderSourceTypeFilter(); renderSources();
    const timeline = $('timeline');
    if (timeline.querySelector('.tail')) timeline.innerHTML = '';
    for (const e of fresh) if (!state.hiddenKinds.has(e.kind)) timeline.insertAdjacentHTML('beforeend', eventHtml(e, true));
    $('tail').textContent = d.session.terminal ? 'Phiên đã kết thúc.' : 'Đang chờ sự kiện mới… (realtime)';
    // Follow new events only while the reader is already at the end (the page scrolls on a phone, the panel on a desktop).
    const scroller = PHONE.matches ? document.scrollingElement : $('detail');
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 200) scroller.scrollTop = scroller.scrollHeight;
  }

  /* ---------- live stream ---------- */
  let refreshTimer;
  const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { loadSessions(); loadStats(); }, 400); };
  function connect() {
    const es = new EventSource('/api/stream');
    const live = $('live');
    es.onopen = () => { live.className = $('liveMini').className = 'live on'; $('liveText').textContent = 'Realtime'; };
    es.onerror = () => { live.className = $('liveMini').className = 'live off'; $('liveText').textContent = 'Mất kết nối, đang thử lại…'; };
    es.onmessage = ({ data }) => {
      let msg; try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === 'hello') { state.retentionDays = msg.retentionDays; $('retentionDays').textContent = msg.retentionDays; return; }
      if (msg.type === 'events') { if (msg.sessionId === state.selected) appendEvents(msg.events); scheduleRefresh(); }
      else if (msg.type === 'sync') { scheduleRefresh(); if (state.selected) refreshSelected(); }
      else if (msg.type === 'purge') { if (msg.deletedSessions) toast(`Đã dọn ${msg.deletedSessions} phiên hết hạn`); scheduleRefresh(); }
      else if (msg.type === 'deleted') { if (msg.sessionId === state.selected) clearDetail(); scheduleRefresh(); }
    };
  }
  async function refreshSelected() {
    try { const events = await api(`/api/sessions/${state.selected}/events?after=${state.detail?.events.at(-1)?.seq ?? -1}`); appendEvents(events); } catch { /* deleted */ }
  }
  function clearDetail({ keepHash = false } = {}) { state.selected = null; state.detail = null; $('sessionView').hidden = true; $('emptyDetail').hidden = false; showDetail(false); if (!keepHash) location.hash = ''; renderSessions(); }

  // The access key of a LAN device is kept in a cookie by the server; drop it from the address bar.
  if (new URLSearchParams(location.search).has('key')) history.replaceState(null, '', location.pathname + location.hash);

  /* ---------- routing ---------- */
  // #session/<id> · #trace/<source>/<externalId> · #chat/<chatId>[?ticket=<ref>] (per-conversation link from the widget)
  // #ticket/<ref>[?open=<source>:<externalId>] lists every trace of the ticket and opens the named one first
  async function route() {
    const hash = decodeURIComponent(location.hash.slice(1));
    const session = hash.match(/^session\/(\d+)$/);
    const trace = hash.match(/^trace\/([a-z0-9_-]+)\/([^?]+)$/);
    const chat = hash.match(/^chat\/([^?]+)(?:\?(.*))?$/);
    const ticketRoute = hash.match(/^ticket\/([A-Za-z0-9_-]+)(?:\?(.*))?$/);
    state.filters.chatId = ''; state.filters.ticket = ''; state.contextNote = '';
    if (ticketRoute) {
      state.filters.ticket = ticketRoute[1]; state.filters.q = ''; $('q').value = '';
      await loadSessions();
      if (!state.sessions.length) { state.contextNote = `Chưa có trace nào cho ticket ${ticketRoute[1]}`; renderSessions(); clearDetail({ keepHash: true }); return; }
      const [source, externalId] = (new URLSearchParams(ticketRoute[2] || '').get('open') || '').split(':');
      const wanted = state.sessions.find(item => item.source === source && item.external_id === externalId);
      await openSession((wanted || state.sessions[0]).id, { keepHash: true });
      return;
    }
    if (chat) {
      const chatId = chat[1]; const ticket = new URLSearchParams(chat[2] || '').get('ticket') || '';
      state.filters.chatId = chatId; state.filters.q = ''; $('q').value = '';
      await loadSessions();
      if (!state.sessions.length && ticket) {
        state.filters.chatId = ''; state.filters.q = ticket; $('q').value = ticket;
        state.contextNote = `Conversation này chưa có trace gắn chatId; đang hiển thị các phiên của ticket ${ticket}`;
        await loadSessions();
      }
      if (!state.sessions.length) { state.contextNote = `Chưa có trace nào cho conversation ${chatId}`; renderSessions(); clearDetail({ keepHash: true }); return; }
      await openSession(state.sessions[0].id, { keepHash: true });
      return;
    }
    await loadSessions();
    if (trace) {
      try { const { id } = await api(`/api/sessions/lookup?source=${encodeURIComponent(trace[1])}&id=${encodeURIComponent(trace[2])}`); await openSession(id); }
      catch { toast('Không tìm thấy trace ' + trace[1] + ':' + trace[2]); }
    } else if (session) {
      openSession(Number(session[1])).catch(() => { location.hash = ''; });
    }
  }
  window.addEventListener('hashchange', () => {
    const h = location.hash;
    if (h.startsWith('#chat/') || h.startsWith('#trace/') || h.startsWith('#ticket/')) return route();
    // Browser back/forward (the swipe gesture on a phone) moves between the list and a session.
    const session = h.match(/^#session\/(\d+)$/);
    if (!session) showDetail(false);
    else if (Number(session[1]) === state.selected) { if (!document.body.classList.contains('show-detail')) showDetail(true); }
    else openSession(Number(session[1]), { keepHash: true }).catch(() => showDetail(false));
  });

  /* ---------- wiring ---------- */
  let searchTimer;
  $('q').addEventListener('input', e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.filters.q = e.target.value.trim(); loadSessions(); }, 250); });
  $('fSource').addEventListener('change', e => { state.filters.source = e.target.value; loadSessions(); });
  $('fStatus').addEventListener('change', e => { state.filters.status = e.target.value; loadSessions(); });
  $('btnMore').addEventListener('click', () => loadSessions({ append: true }));
  $('contextClear').addEventListener('click', () => { state.filters.chatId = ''; state.filters.ticket = ''; state.filters.q = ''; state.contextNote = ''; $('q').value = ''; location.hash = ''; loadSessions(); });
  $('sessions').addEventListener('click', e => { const li = e.target.closest('.session'); if (li) openSession(Number(li.dataset.id)).catch(err => toast(err.message)); });
  $('btnBack').addEventListener('click', () => showDetail(false));
  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === tab.dataset.tab));
    if (!PHONE.matches) return;
    // The tab bar is stuck to the top while reading: start the new panel at its beginning.
    tab.scrollIntoView({ block: 'nearest', inline: 'center' });
    const head = document.querySelector('.session-head');
    const start = head.offsetTop + head.offsetHeight - document.querySelector('.detail-bar').offsetHeight;
    if (window.scrollY > start) window.scrollTo(0, start);
  }));
  $('kindFilter').addEventListener('change', e => { const kind = e.target.dataset.kind; if (!kind) return; e.target.checked ? state.hiddenKinds.delete(kind) : state.hiddenKinds.add(kind); renderKindFilter(); renderTimeline(); });
  $('sourceTypeFilter').addEventListener('change', e => { const type = e.target.dataset.type; if (!type) return; e.target.checked ? state.hiddenSourceTypes.delete(type) : state.hiddenSourceTypes.add(type); renderSourceTypeFilter(); renderSources(); });
  $('timeline').addEventListener('click', e => { if (e.target.classList.contains('expand')) { const text = e.target.previousElementSibling; text.classList.remove('long'); e.target.remove(); } });
  $('artifactList').addEventListener('click', async e => {
    const li = e.target.closest('li[data-id]'); if (!li) return;
    document.querySelectorAll('.artifact-list li').forEach(x => x.classList.toggle('active', x === li));
    const a = await api(`/api/sessions/${state.selected}/artifacts/${li.dataset.id}`);
    $('artifactName').textContent = `${a.name} (${a.run_id})`;
    $('artifactContent').textContent = a.content_json ? JSON.stringify(a.content_json, null, 2) : (a.content || '');
    if (PHONE.matches) document.querySelector('.artifact-body').scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  $('btnCopyId').addEventListener('click', () => { const s = state.detail?.session; if (s) copyText(`${s.source}:${s.external_id}`).then(() => toast('Đã sao chép id')).catch(err => toast(err.message)); });
  $('btnDelete').addEventListener('click', async () => {
    const s = state.detail?.session; if (!s || !confirm(`Xóa phiên ${s.ticket_reference || s.external_id} khỏi DB?`)) return;
    await api('/api/sessions/' + s.id, { method: 'DELETE' }); toast('Đã xóa phiên'); clearDetail(); loadSessions(); loadStats();
  });
  $('btnPurge').addEventListener('click', async e => {
    e.target.disabled = true;
    try { const r = await api('/api/retention/run', { method: 'POST' }); toast(`Đã dọn ${r.deletedSessions} phiên quá ${r.retentionDays} ngày`); loadSessions(); loadStats(); }
    catch (err) { toast('Dọn thất bại: ' + err.message); } finally { e.target.disabled = false; }
  });
  $('btnSync').addEventListener('click', async e => {
    e.target.disabled = true;
    try { const r = await api('/api/sync', { method: 'POST' }); toast(`Đồng bộ: ${r.sessions} phiên, +${r.events} sự kiện, +${r.artifacts} artifact`); loadSessions(); loadStats(); }
    catch (err) { toast('Đồng bộ thất bại: ' + err.message); } finally { e.target.disabled = false; }
  });

  (async () => {
    await loadStats();
    await route();
    connect();
    setInterval(loadStats, 60000);
    setInterval(renderSessions, 60000); // keep relative expiry text fresh
  })();
})();
