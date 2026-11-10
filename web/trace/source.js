/* Hachimi Trace — standalone source viewer (/source/<id>): shows the doc / skill / KB chunk / link an AI step consulted. */
(() => {
  const $ = id => document.getElementById(id);
  const TYPE_LABEL = { docs: 'Docs', skill: 'Skill', kb: 'KB', elite: 'TS Elite 2', ticket: 'Ticket', url: 'Link', artifact: 'Artifact', file: 'File' };
  const KIND_LABEL = { start: 'bắt đầu', phase: 'pha', waiting: 'chờ', text: 'text', thinking: 'suy luận', tool: 'tool', observation: 'quan sát', note: 'ghi chú', warning: 'cảnh báo', result: 'kết quả', done: 'xong', error: 'lỗi', cancelled: 'hủy' };
  const HELPDESK = 'https://helpdesk.avada.net/tickets/';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const fmtDate = iso => iso ? new Date(iso).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  let toastTimer;
  // navigator.clipboard needs a secure context; http://<local domain> is not one, so fall back to a hidden textarea.
  const copyText = async text => {
    if (window.isSecureContext && navigator.clipboard) return navigator.clipboard.writeText(text);
    const area = document.createElement('textarea'); area.value = text; area.setAttribute('readonly', ''); area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(area); area.select();
    try { if (!document.execCommand('copy')) throw new Error('Trình duyệt không cho sao chép'); } finally { area.remove(); }
  };
  const toast = message => { const el = $('toast'); el.textContent = message; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2500); };

  /* ---------- minimal safe Markdown → HTML (input is escaped first; only http(s) links are linked) ---------- */
  function inline(text) {
    return text
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
  }
  function markdown(raw) {
    // YAML front matter (skill files) becomes a small key/value block; HTML comments are dropped.
    let text = String(raw).replace(/<!--[\s\S]*?-->/g, '');
    let front = '';
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (fm) {
      text = text.slice(fm[0].length);
      const rows = fm[1].split(/\r?\n/).map(l => l.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean);
      if (rows.length) front = `<dl class="front-matter">${rows.map(([, k, v]) => `<dt>${esc(k)}</dt><dd>${inline(esc(v))}</dd>`).join('')}</dl>`;
    }
    const lines = esc(text).split('\n');
    const out = front ? [front] : []; const headings = [];
    let i = 0;
    const flushParagraph = buffer => { if (buffer.length) out.push(`<p>${inline(buffer.join(' '))}</p>`); buffer.length = 0; };
    const paragraph = [];
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        flushParagraph(paragraph);
        const lang = line.replace(/^\s*```/, '').trim();
        const code = []; i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
        i++; out.push(`<pre class="code" data-lang="${esc(lang)}"><code>${code.join('\n')}</code></pre>`); continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        flushParagraph(paragraph);
        const level = heading[1].length; const id = `h-${headings.length}`;
        headings.push({ id, level, text: heading[2].replace(/<[^>]+>/g, '') });
        out.push(`<h${level} id="${id}">${inline(heading[2])}</h${level}>`); i++; continue;
      }
      if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { flushParagraph(paragraph); out.push('<hr>'); i++; continue; }
      if (/^\s*&gt;\s?/.test(line)) {
        flushParagraph(paragraph); const quote = [];
        while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) quote.push(lines[i++].replace(/^\s*&gt;\s?/, ''));
        out.push(`<blockquote>${markdown(quote.map(q => q.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")).join('\n')).html}</blockquote>`); continue;
      }
      if (/^\s*\|/.test(line)) {
        flushParagraph(paragraph); const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
        const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => inline(cell.trim()));
        const body = rows.filter(row => !/^\s*\|?\s*:?-{2,}/.test(row));
        if (body.length) {
          const [head, ...rest] = body;
          out.push(`<table><thead><tr>${cells(head).map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rest.map(r => `<tr>${cells(r).map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
        }
        continue;
      }
      const list = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (list) {
        flushParagraph(paragraph);
        const ordered = /\d/.test(list[2]); const items = [];
        while (i < lines.length) {
          const item = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (item && /\d/.test(item[2]) === ordered) { items.push(item[3]); i++; }
          else if (items.length && /^\s{2,}\S/.test(lines[i]) && !lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+/)) { items[items.length - 1] += ' ' + lines[i].trim(); i++; }
          else break;
        }
        out.push(`<${ordered ? 'ol' : 'ul'}>${items.map(item => `<li>${inline(item)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
      }
      if (!line.trim()) { flushParagraph(paragraph); i++; continue; }
      paragraph.push(line.trim()); i++;
    }
    flushParagraph(paragraph);
    return { html: out.join('\n'), headings };
  }

  /* ---------- excerpt highlight ---------- */
  const collapse = text => text.replace(/\s+/g, ' ').trim();
  // Candidate needles: the whole excerpt, then the part after a citation dash/colon, then shorter prefixes.
  function needles(excerpt) {
    const base = collapse(excerpt || '');
    const parts = [base, ...base.split(/\s[—–-]\s|:\s/).slice(1)].map(p => p.replace(/[*`"“”]/g, '').trim()).filter(p => p.length >= 12);
    const out = [];
    for (const part of parts) for (const len of [120, 60, 32]) { const n = part.slice(0, len).toLowerCase(); if (n.length >= 12 && !out.includes(n)) out.push(n); }
    return out;
  }
  function highlight(container, excerpt, locator) {
    const candidates = needles(excerpt);
    if (candidates.length) {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      const nodes = []; let text = '';
      for (let node = walker.nextNode(); node; node = walker.nextNode()) { nodes.push({ node, start: text.length }); text += node.nodeValue; }
      const collapsed = text.toLowerCase().replace(/\s+/g, ' ');
      // Map collapsed index back to raw index.
      const rawIndex = []; let inSpace = false;
      for (let k = 0; k < text.length; k++) { const space = /\s/.test(text[k]); if (space && inSpace) continue; rawIndex.push(k); inSpace = space; }
      let at = -1; let needle = '';
      for (const candidate of candidates) { at = collapsed.indexOf(candidate); if (at >= 0) { needle = candidate; break; } }
      if (at >= 0) {
        const start = rawIndex[at]; const end = rawIndex[Math.min(at + needle.length - 1, rawIndex.length - 1)] + 1;
        const first = nodes.findLast(n => n.start <= start); const last = nodes.findLast(n => n.start < end);
        try {
          const range = document.createRange();
          range.setStart(first.node, start - first.start); range.setEnd(last.node, Math.min(end - last.start, last.node.nodeValue.length));
          const mark = document.createElement('mark'); mark.className = 'hit';
          if (first === last) range.surroundContents(mark); else { mark.appendChild(range.extractContents()); range.insertNode(mark); }
          return mark;
        } catch { /* range crossed elements: fall back to node */ }
        const mark = document.createElement('mark'); mark.className = 'hit';
        first.node.parentNode.insertBefore(mark, first.node); mark.appendChild(first.node);
        return mark;
      }
    }
    if (locator) {
      const target = collapse(locator).toLowerCase();
      const heading = [...container.querySelectorAll('h1,h2,h3,h4,h5,h6')].find(h => collapse(h.textContent).toLowerCase() === target)
        || [...container.querySelectorAll('h1,h2,h3,h4,h5,h6')].find(h => collapse(h.textContent).toLowerCase().includes(target));
      if (heading) { heading.classList.add('hit-heading'); return heading; }
      const line = locator.match(/^(?:line|dòng)?\s*:?\s*(\d+)$/i);
      const pre = container.querySelector('pre');
      if (line && pre) { const el = pre.querySelector(`[data-line="${line[1]}"]`); if (el) { el.classList.add('hit'); return el; } }
    }
    return null;
  }

  function renderFile(file, source) {
    const doc = $('vDoc');
    if (file.format === 'markdown') {
      const { html, headings } = markdown(file.content);
      doc.innerHTML = html;
      if (headings.length > 1) {
        $('vOutline').hidden = false;
        $('vOutlineList').innerHTML = headings.map(h => `<li class="l${h.level}"><a href="#${h.id}">${esc(h.text)}</a></li>`).join('');
      }
    } else if (file.format === 'json') {
      let pretty = file.content; try { pretty = JSON.stringify(JSON.parse(file.content), null, 2); } catch { /* keep */ }
      doc.innerHTML = `<pre class="code">${esc(pretty)}</pre>`;
    } else if (file.format === 'binary') {
      doc.innerHTML = '<p class="muted">File nhị phân, không hiển thị nội dung.</p>';
    } else {
      const lines = file.content.split('\n');
      doc.innerHTML = `<pre class="code lines">${lines.map((l, n) => `<span data-line="${n + 1}">${esc(l)}\n</span>`).join('')}</pre>`;
    }
    if (file.truncated) { $('vNote').hidden = false; $('vNote').textContent = `File dài hơn giới hạn hiển thị (${file.size} bytes); chỉ hiện phần đầu.`; }
    const hit = highlight(doc, source.excerpt, source.locator);
    if (hit) setTimeout(() => hit.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
    $('vJump').onclick = () => { const target = doc.querySelector('.hit, .hit-heading'); if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' }); else toast('Không tìm thấy đoạn trích trong nội dung'); };
  }

  function renderChunk(content, source) {
    const { chunk, file } = content;
    const doc = $('vDoc');
    const chunkHtml = `<section class="chunk"><div class="chunk-head">Đoạn KB #${chunk.id}${chunk.heading ? ` · ${esc(chunk.heading)}` : ''} · ${esc(chunk.source_path)}${chunk.app_slug ? ` · app ${esc(chunk.app_slug)}` : ''}</div>${markdown(chunk.content).html}</section>`;
    if (file) {
      doc.innerHTML = chunkHtml + '<h2 class="doc-sep">Toàn bộ tài liệu</h2>';
      const whole = document.createElement('div'); whole.className = 'whole';
      doc.appendChild(whole);
      const { html, headings } = markdown(file.content); whole.innerHTML = html;
      if (headings.length > 1) { $('vOutline').hidden = false; $('vOutlineList').innerHTML = headings.map(h => `<li class="l${h.level}"><a href="#${h.id}">${esc(h.text)}</a></li>`).join(''); }
      const hit = highlight(whole, source.excerpt || chunk.content, chunk.heading);
      $('vJump').onclick = () => (hit || whole).scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else {
      doc.innerHTML = chunkHtml + '<p class="muted">Không tìm thấy file gốc trong knowledge-base/, chỉ hiển thị đoạn đã lưu trong DB.</p>';
      $('vJump').onclick = () => doc.querySelector('.chunk').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  // Phone layout (same query as style.css): the document comes first, so only the excerpt card starts open.
  if (matchMedia('(max-width: 760px), (max-height: 500px) and (pointer: coarse)').matches) {
    for (const id of ['vMetaCard', 'vEventCard', 'vOutline']) $(id).open = false;
  }
  $('vOutlineList').addEventListener('click', event => { if (event.target.closest('a') && getComputedStyle($('vOutline').querySelector('summary')).pointerEvents !== 'none') $('vOutline').open = false; });

  async function load() {
    const id = location.pathname.match(/\/source\/(\d+)/)?.[1] || new URLSearchParams(location.search).get('id');
    if (!id) { $('vSub').textContent = 'Thiếu id nguồn.'; return; }
    let data;
    try {
      const response = await fetch(`/api/sources/${encodeURIComponent(id)}`);
      data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    } catch (error) { $('vSub').textContent = 'Không tải được nguồn: ' + error.message; return; }
    const { source, session, event, content } = data;
    document.title = `${source.label} · ${TYPE_LABEL[source.type] || source.type} · Hachimi Trace`;
    $('vTitle').textContent = source.label;
    $('vSub').innerHTML = `<span class="badge t-${esc(source.type)}">${esc(TYPE_LABEL[source.type] || source.type)}</span> ${esc(source.path || source.url || '')}`;
    $('vSession').hidden = false; $('vSession').href = `/#session/${session.id}`;
    if (session.ticket_reference) { $('vTicket').hidden = false; $('vTicket').href = HELPDESK + session.ticket_reference; }
    if (source.url) { $('vLink').hidden = false; $('vLink').href = source.url; }
    if (source.path) { $('vCopy').hidden = false; $('vCopy').onclick = () => copyText(source.path).then(() => toast('Đã sao chép đường dẫn')).catch(err => toast(err.message)); }
    const meta = [
      ['Loại', TYPE_LABEL[source.type] || source.type],
      ['Nhãn', source.label],
      source.path && ['Đường dẫn', source.path],
      source.url && ['Liên kết', source.url],
      source.locator && ['Vị trí', source.locator],
      source.metadata?.status && ['Trạng thái', { used: 'đã dùng', unavailable: 'không truy cập được', read: 'đã đọc' }[source.metadata.status] || source.metadata.status],
      source.metadata?.appSlug && ['App', source.metadata.appSlug],
      source.metadata?.score !== undefined && ['Điểm truy xuất', String(source.metadata.score)],
      ['Phiên', `${session.source}:${session.external_id}${session.ticket_reference ? ` · ${session.ticket_reference}` : ''}`],
      session.subject && ['Ticket', session.subject],
      ['Ghi nhận', fmtDate(source.created_at)],
    ].filter(Boolean);
    $('vMeta').innerHTML = meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    if (event) {
      $('vEventCard').hidden = false;
      $('vEvent').innerHTML = [['Thời điểm', fmtDate(event.at)], ['Loại', KIND_LABEL[event.kind] || event.kind], event.phase && ['Pha', event.phase], ['Nội dung', event.text || '—']].filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    }
    if (source.excerpt) { $('vExcerptCard').hidden = false; $('vExcerpt').textContent = source.excerpt; }
    if (content.kind === 'file') renderFile(content, source);
    else if (content.kind === 'chunk') renderChunk(content, source);
    else if (content.kind === 'link') {
      $('vDoc').innerHTML = `<div class="link-only"><p>Nguồn này là liên kết ngoài, không có nội dung lưu cục bộ.</p><a class="btn primary" href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">Mở ${esc(source.url)} ↗</a></div>`;
      $('vJump').hidden = true;
    } else if (content.kind === 'error') {
      $('vDoc').innerHTML = `<div class="link-only"><p>Không đọc được nội dung: ${esc(content.error)}</p>${content.url ? `<a class="btn primary" href="${esc(content.url)}" target="_blank" rel="noopener noreferrer">Mở liên kết ↗</a>` : ''}</div>`;
      $('vJump').hidden = true;
    } else {
      $('vDoc').innerHTML = '<p class="muted">Nguồn chỉ có nhãn (không có file hay liên kết đi kèm).</p>';
      $('vJump').hidden = true;
    }
  }
  load();
})();
