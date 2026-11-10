// Shared read-only report view for the extension and TS web. All data is rendered as text, never HTML.
globalThis.HanAutoView = (() => {
  const node = (tag, text = '', className = '') => { const n = document.createElement(tag); n.textContent = text; n.className = className; return n; };
  function inline(parent, text) {
    for (const part of text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)) {
      if (part.startsWith('`') && part.endsWith('`')) parent.append(node('code', part.slice(1, -1)));
      else if (part.startsWith('**') && part.endsWith('**')) parent.append(node('strong', part.slice(2, -2)));
      else parent.append(document.createTextNode(part));
    }
  }
  function markdown(parent, text) {
    let fence = null; let code = []; let list = null;
    for (const line of String(text || '').split('\n')) {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line);
      if (marker && (!fence || (marker[1][0] === fence[0] && marker[1].length >= fence.length))) {
        if (!fence) { fence = marker[1]; code = []; }
        else { const pre = node('pre'); pre.append(node('code', code.join('\n'))); parent.append(pre); fence = null; }
        list = null; continue;
      }
      if (fence) { code.push(line); continue; }
      if (!line.trim()) { list = null; continue; }
      const bullet = /^(?:(\d+)[.)]|[-*])\s+(.+)$/.exec(line);
      if (bullet) {
        const tag = bullet[1] ? 'OL' : 'UL';
        if (!list || list.tagName !== tag) { list = node(tag.toLowerCase()); if (bullet[1]) list.start = Number(bullet[1]); parent.append(list); }
        const item = node('li'); inline(item, bullet[2]); list.append(item);
      } else { list = null; const p = node('p'); inline(p, line); parent.append(p); }
    }
    if (fence) parent.append(node('pre', code.join('\n')));
  }
  function reportView(data) {
    const article = node('article', '', 'han-auto-report');
    // Only a canonical response may be presented as this run's result. No report/analysis fallback.
    if (data.canonical?.notice) article.append(node('p', data.canonical.notice, 'han-auto-notice'));
    if (data.canonical && data.canonical.provenance !== 'conflict' && typeof data.comment === 'string') markdown(article, data.comment);
    else if (!data.canonical?.notice) article.append(node('p', 'Chưa có bản comment đã xác minh của lượt này. Tải lại sau khi API được cập nhật.'));
    return article;
  }
  function tabs(selected, onChange) {
    const bar = node('div', '', 'han-checking-tabs'); bar.setAttribute('role', 'tablist'); bar.setAttribute('aria-label', 'Checking');
    const choices = [['cmt', 'Han cmt'], ['auto', 'Han auto']];
    const activate = id => {
      const root = bar.getRootNode();
      if (id !== selected) onChange(id);
      // Both hosts replace the tab bar on selection; restore focus in the same DOM/shadow root.
      root.querySelector(`.han-checking-tabs [data-han-tab="${id}"]`)?.focus({ preventScroll: true });
    };
    for (const [index, [id, label]] of choices.entries()) {
      const button = node('button', label); button.type = 'button'; button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(id === selected));
      button.dataset.hanTab = id; button.tabIndex = id === selected ? 0 : -1;
      button.addEventListener('click', () => activate(id));
      button.addEventListener('keydown', event => {
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
          : event.key === 'ArrowRight' ? (index + 1) % choices.length
          : event.key === 'ArrowLeft' ? (index + choices.length - 1) % choices.length : null;
        if (next === null) return;
        event.preventDefault(); activate(choices[next][0]);
      });
      bar.append(button);
    }
    return bar;
  }
  function mount(container, { load, detail }) {
    let generation = 0; let opened = null; let timer = null; let stopped = false;
    const active = token => !stopped && container.isConnected && token === generation;
    const schedule = token => { clearTimeout(timer); if (active(token)) timer = setTimeout(() => { if (active(token)) void showList(false); }, 5000); };
    async function showList(loading = true) {
      opened = null; const token = ++generation;
      if (loading) container.replaceChildren(node('p', 'Đang tải ticket…'));
      try {
        const data = await load(); if (!active(token)) return;
        const list = node('div', '', 'han-auto-list');
        if (!data.reports?.length) list.append(node('p', 'Chưa có lượt check tự động nào trong 10 ngày gần đây.'));
        for (const row of data.reports || []) {
          const button = node('button', '', 'han-auto-ticket'); button.type = 'button';
          button.append(node('strong', `${row.ticket} · ${row.subject}`), node('span', [row.category, row.statusLabel, row.finishedAt || row.createdAt].filter(Boolean).join(' · ')));
          button.addEventListener('click', () => void showDetail(row)); list.append(button);
        }
        container.replaceChildren(list);
      } catch (error) { if (active(token)) container.replaceChildren(node('p', `Không tải được report: ${error.message}`, 'error')); }
      schedule(token);
    }
    async function showDetail(row) {
      opened = row; clearTimeout(timer); const token = ++generation;
      const back = node('button', '‹ Danh sách ticket', 'checking-back'); back.type = 'button'; back.addEventListener('click', () => void showList());
      const refresh = node('button', 'Tải lại', 'checking-link'); refresh.type = 'button'; refresh.addEventListener('click', () => void showDetail(row));
      const bar = node('div', '', 'han-auto-bar'); bar.append(back, refresh);
      const body = node('div', 'Đang tải report…'); container.replaceChildren(bar, body);
      try {
        const data = await detail(row); if (!active(token) || opened !== row) return;
        if (!data || data.id !== row.id || data.runId !== row.runId || data.ticketId !== row.ticketId
          || (data.canonical && (data.canonical.jobId !== row.id || data.canonical.runId !== row.runId || data.canonical.ticketId !== row.ticketId))) throw new Error('Report không khớp lượt check đã chọn.');
        body.replaceChildren(node('h2', `${data.ticket} · ${data.subject}`), node('p', data.statusLabel), reportView(data));
      } catch (error) { if (active(token)) body.replaceChildren(node('p', `Không tải được report: ${error.message}`, 'error')); }
    }
    void showList();
    return () => { stopped = true; generation++; clearTimeout(timer); };
  }

  // New shared ticket reader. Existing reportView/renderComment remain unchanged for History.
  const ticketCss = `.han-auto-panel.ha-host{overflow:hidden;display:flex;flex-direction:column;padding-bottom:0}.ha-ticket-view{min-width:0;max-width:100%;display:flex;flex-direction:column;gap:10px;flex:1;min-height:0;overflow:auto;font-size:13px;color:var(--chat-text,inherit)}
.ha-ticket-view button,.ha-ticket-view input,.ha-ticket-view select,.ha-ticket-view textarea{font:inherit;color:inherit;border:1px solid var(--chat-line,#60526f);border-radius:9px;background:var(--chat-surface,#201d27);padding:9px;min-width:0}
.ha-ticket-view button{cursor:pointer}.ha-ticket-view button:disabled{opacity:.55;cursor:default}.ha-tools{display:flex;gap:6px;flex-wrap:wrap}.ha-tools input{flex:1}.ha-tools button:focus-visible,.ha-ticket-view a:focus-visible{outline:2px solid #ac8bff;outline-offset:2px}
.ha-header,.ha-comment,.ha-answer{min-width:0;border:1px solid var(--chat-line,#60526f);border-radius:12px;padding:12px;background:var(--chat-surface,#201d27);overflow-wrap:anywhere}
.ha-header h2{font-size:16px;margin:0 0 8px}.ha-header p{margin:5px 0}.ha-comment header{display:flex;gap:8px;flex-wrap:wrap;font-size:12px;opacity:.8}.ha-comments,.ha-discussion{display:grid;grid-template-columns:minmax(0,1fr);min-width:0;gap:10px}.ha-ticket-view pre{white-space:pre;overflow:auto;max-width:100%;padding:10px;background:var(--chat-soft,#17151d);border-radius:8px}.ha-ticket-view code{font-family:monospace}.ha-ticket-view p{white-space:pre-wrap;overflow-wrap:anywhere}.ha-ticket-view a{color:var(--chat-link,#c4b2ff);overflow-wrap:anywhere}.ha-media{max-width:100%;max-height:300px;object-fit:contain}.ha-notice{font-size:12px;color:var(--chat-muted,inherit);line-height:1.5}.ha-ticket-detail{overflow:hidden}.ha-ticket-detail>.ha-tools,.ha-ticket-detail>.ha-header,.ha-compose{flex-shrink:0}.ha-ticket-detail>.ha-header{flex-shrink:1;min-height:64px;max-height:150px;overflow:auto}.ha-timeline{min-height:80px;flex:1;overflow:auto}.ha-comment pre{max-height:320px}.ha-compose{display:grid;gap:7px;padding:10px 0;background:var(--chat-surface,#201d27)}.ha-compose p{margin:0}.ha-compose textarea{resize:vertical;height:56px;min-height:48px;max-height:160px;width:100%;box-sizing:border-box}.ha-ticket-view h3{font-size:14px;margin:8px 0}.ha-error{color:var(--error,#e7a5a5)}.ha-run{max-width:100%}.ha-rating-choice{display:flex;align-items:center;gap:5px}.ha-rating-choice input{width:auto}.ha-selected-report{border-color:#9470de}.ha-target{font-size:12px}.ha-target pre{max-height:280px;overflow:auto}`;
  function safeLink(value) {
    try { const u=new URL(String(value));return u.protocol==='https:'&&!u.username&&!u.password&&!/\[đã ẩn/.test(value)&&!/(?:token|password|secret|signature|authorization|api.?key|key)=/i.test(u.hash)&&![...u.searchParams.keys()].some(k=>/token|password|secret|signature|authorization|api.?key|^key$/i.test(k))?u.href:null; }catch{return null;}
  }
  function richComment(parent, text) {
    // Markdown is text-only, including embedded HTML. HTTPS links/media are separate DOM nodes.
    markdown(parent,text);
    const links=[...new Set(String(text).match(/https:\/\/[^\s<>"'`\])]+/g)||[])].slice(0,20);
    for(const value of links){const href=safeLink(value);if(!href)continue;const a=node('a','Mở liên kết');a.href=href;a.target='_blank';a.rel='noopener noreferrer';parent.append(a);
      const u=new URL(href);if(['d2798l25hiaz3h.cloudfront.net','capture.avada.io'].includes(u.hostname)&&/\.(?:png|jpe?g|webp|gif)$/i.test(u.pathname)){const img=node('img','','ha-media');img.src=href;img.alt='Ảnh trong comment';img.loading='lazy';img.referrerPolicy='no-referrer';parent.append(img);}
    }
  }
  function mountTickets(container,{request}) {
    let generation=0,controller=null,stopped=false,current=null,search='',scope='completed';
    const style=node('style',ticketCss),view=node('div','','ha-ticket-view');container.classList.add('ha-host');container.replaceChildren(style,view);
    const button=(label,fn)=>{const b=node('button',label);b.type='button';b.addEventListener('click',fn);return b;};
    const begin=()=>{controller?.abort();controller=new AbortController();return ++generation;};
    const valid=g=>!stopped&&view.isConnected&&g===generation;
    const req=(path,options={})=>request(path,{...options,signal:controller.signal});
    const error=(parent,e)=>parent.replaceChildren(node('p',e.message||'Chưa đọc được dữ liệu.','ha-error'));
    const when=value=>{const d=new Date(value);return value&&!Number.isNaN(+d)?d.toLocaleString('vi-VN'):'Không rõ thời gian';};
    const matches=(b,row)=>b?.ticketId===row.ticketId&&b.jobId===row.jobId&&b.runId===row.runId;
    async function list(){const g=begin();current=null;view.classList.remove('ha-ticket-detail');const form=node('form','','ha-tools');const input=node('input');input.placeholder='Tìm mã hoặc tiêu đề ticket';input.value=search;input.setAttribute('aria-label','Tìm ticket tự động');
      const select=node('select');select.setAttribute('aria-label','Phạm vi ticket');for(const [value,label]of [['completed','Có lượt hoàn tất'],['all','Tất cả trạng thái auto']]){const o=node('option',label);o.value=value;o.selected=value===scope;select.append(o);}
      const find=node('button','Tìm');find.type='submit';form.append(input,select,find);form.addEventListener('submit',e=>{e.preventDefault();search=input.value;scope=select.value;void list();});
      const copy=node('p','Ticket từ sự kiện tạo/gán tự động. Không gồm lệnh @han hoặc check thủ công.','ha-notice');const rows=node('div','','han-auto-list'),notice=node('p','Đang tải ticket…','ha-notice'),more=button('Tải thêm ticket',()=>void load(next));let next=null;more.hidden=true;view.replaceChildren(form,copy,notice,rows,more,button('Tải lại danh sách',()=>void list()));
      async function load(cursor=''){more.disabled=true;try{const data=await req('/checking/auto-tickets?'+new URLSearchParams({q:search,scope,...(cursor?{cursor}:{})}));if(!valid(g))return;
        for(const row of data.tickets||[]){const b=button('',()=>void detail(row));b.className='han-auto-ticket';b.append(node('strong',`${row.ticket||row.ticketId} · ${row.subject||'Không có tiêu đề'}`),node('span',`${row.appName||'App chưa rõ'} · ${row.statusLabel||row.status} · ${when(row.finishedAt||row.createdAt)}`));if(row.incompleteCount)b.append(node('span',`${row.incompleteCount} lượt chưa hoàn tất`));if(row.assessment)b.append(node('span',row.assessment.sourceConflict?'Chưa xác minh liên kết kết quả':`${row.assessment.source==='direct-assessment'?'Đánh giá trực tiếp':row.assessment.source==='legacy-reaction'?'Reaction lịch sử':'Chưa đánh giá'}${row.assessment.verdict==='pending'?'':row.assessment.verdict==='correct'?' · Đúng':' · Sai'}`));rows.append(b);}
        notice.textContent=(data.totalTickets?`${rows.children.length}/${data.totalTickets} ticket`:'Chưa có ticket tự động phù hợp.')+(data.assessmentsUnavailable?' Chưa đọc được đánh giá đã lưu.':'');next=data.nextCursor;more.hidden=!next;
      }catch(e){if(valid(g))notice.textContent=`Chưa tải được danh sách: ${e.message}`;}finally{if(valid(g))more.disabled=false;}}
      await load();
    }

    async function detail(row) {
      const g=begin();current=row;view.classList.add('ha-ticket-detail');
      const base='/checking/auto-tickets/'+encodeURIComponent(row.ticketId);
      const query={jobId:row.jobId,runId:row.runId};
      const path=(suffix='',extra={})=>base+suffix+'?'+new URLSearchParams({...query,...extra});
      const top=node('div','','ha-tools');top.append(button('‹ Danh sách ticket',()=>void list()),button('Tải lại ticket',()=>void detail(row)));
      const runs=node('select','','ha-run');runs.setAttribute('aria-label','Lượt check');
      for(const run of row.runs||[row]){const o=node('option',`${when(run.finishedAt||run.createdAt)} · ${run.statusLabel||run.status}`);o.value=run.jobId+'|'+run.runId;o.selected=run.jobId===row.jobId&&run.runId===row.runId;runs.append(o);}
      runs.hidden=(row.runs?.length||1)<2;runs.addEventListener('change',()=>{const run=row.runs.find(r=>r.jobId+'|'+r.runId===runs.value);if(run)void detail({...row,...run,runs:row.runs});});top.append(runs);
      const header=node('section','Đang tải thông tin ticket…','ha-header');
      const timeline=node('div','','ha-timeline'),notice=node('p','Đang tải comment…','ha-notice'),commentsBox=node('section','','ha-comments');
      const targetBox=node('section','','ha-target'),scoreSummary=node('p','Đang đọc đánh giá…','ha-notice');
      const comments=new Map(),seen=new Set();let snapshot=null,next=null,data=null,pending=null,needsReload=false,selected=null;
      const more=button('Tải thêm comment',()=>void loadComments(next));more.hidden=true;
      const form=node('form','','ha-compose'),choices=node('div','','ha-tools');choices.setAttribute('role','radiogroup');choices.setAttribute('aria-label','Đánh giá kết quả AI');
      const radios=[];for(const [value,label]of [['correct','Đúng'],['incorrect','Sai']]){const wrap=node('label','','ha-rating-choice'),input=node('input');input.type='radio';input.name='assessment-'+g;input.value=value;input.disabled=true;input.addEventListener('change',()=>{selected=value;status.textContent='Có thay đổi chưa lưu.';updateEnabled();});wrap.append(input,document.createTextNode(label));choices.append(wrap);radios.push(input);}
      const note=node('textarea');note.placeholder='Góp ý (không bắt buộc)';note.setAttribute('aria-label','Góp ý đánh giá');note.maxLength=6000;note.disabled=true;note.addEventListener('input',()=>{status.textContent='Có thay đổi chưa lưu.';updateEnabled();});
      const save=node('button','Lưu đánh giá');save.type='submit';save.disabled=true;
      const status=node('p','','ha-notice');choices.append(save);form.append(choices,note,status);
      const reload=button('Đọc lại đánh giá',()=>void loadEvaluation());
      timeline.append(targetBox,node('h3','Toàn bộ comment ticket'),notice,more,commentsBox,scoreSummary,reload);view.replaceChildren(top,header,timeline,form);
      function updateEnabled(){const allowed=data?.schemaReady&&data?.target?.eligible&&data?.authorization?.canWrite&&!pending&&!needsReload;
        for(const radio of radios)radio.disabled=!allowed;note.disabled=!allowed;
        const unchanged=data?.current&&selected===data.current.verdict&&note.value===(data.current.note||'');save.disabled=!allowed||!selected||Boolean(unchanged);
      }
      function renderTarget(){targetBox.replaceChildren();if(!data)return;
        const target=data.target,details=node('details');details.append(node('summary','Kết quả AI của lượt đang đánh giá'));
        const body=node('div');markdown(body,target.display?.text||'Chưa có kết quả đã xác minh.');details.append(body);if(target.display?.redacted)details.append(node('p','Một số dữ liệu nhạy cảm đã được ẩn.','ha-notice'));
        const match=[...comments.values()].some(c=>c.id===target.commentId&&c.contentSha256===target.resultHash);
        targetBox.append(node('p',match?'Comment được đánh dấu bên dưới khớp bản AI đang đánh giá.':'Đánh giá bản AI đã lưu của lượt này; comment hiện tại trên ticket có thể khác hoặc chưa được tải.','ha-notice'),details);
        const current=data.current,legacy=data.effective?.judgmentSource==='legacy-reaction'?data.effective:null;
        scoreSummary.textContent=current?`Đã lưu: ${current.verdict==='correct'?'Đúng':'Sai'} · lần ${current.revision} · ${current.evaluator.label}`:data.historicalCurrent?'Có đánh giá cũ, nhưng kết quả đã đổi; điểm cũ không áp dụng cho bản này.':legacy?`Reaction lịch sử: ${legacy.verdict==='correct'?'Đúng':legacy.verdict==='incorrect'?'Sai':'Chưa đánh giá'}. Chưa có đánh giá trực tiếp.`:'Chưa có đánh giá trực tiếp.';
      }
      function drawComments(){commentsBox.replaceChildren();for(const c of [...comments.values()].sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))||a.id.localeCompare(b.id))){const article=node('article','','ha-comment');article.dataset.commentId=c.id;const h=node('header');h.append(node('strong',c.author?.name||'Không rõ tác giả'),node('time',when(c.createdAt)));article.append(h);
        if(data?.target?.commentId===c.id&&c.contentSha256===data.target.resultHash){article.classList.add('ha-selected-report');article.append(node('strong','Kết quả đang đánh giá'));}
        const body=node('div');richComment(body,c.content);article.append(body);if(c.redacted)article.append(node('p','Một số dữ liệu nhạy cảm đã được ẩn.','ha-notice'));
        for(const attachment of c.attachments||[]){const href=safeLink(attachment.url);if(href){const a=node('a',attachment.name||'Tệp đính kèm');a.href=href;a.target='_blank';a.rel='noopener noreferrer';article.append(a);}else article.append(node('p',`${attachment.name||'Tệp đính kèm'} — liên kết chưa đủ an toàn để mở.`));}commentsBox.append(article);}}
      async function loadComments(cursor=''){if(cursor&&seen.has(cursor))return;more.disabled=true;const height=timeline.scrollHeight,scroll=timeline.scrollTop;
        try{const d=await req(path('/comments',cursor?{cursor}:{}));if(!valid(g))return;if(!matches(d.binding,row)||snapshot&&snapshot!==d.snapshotId)throw Error('Comment không khớp bản đọc ticket/lượt này.');snapshot=d.snapshotId;if(cursor)seen.add(cursor);
          for(const c of d.comments||[]){if(c.ticketId!==row.ticketId)throw Error('Comment sai ticket.');if(comments.has(c.id)&&comments.get(c.id).hash!==c.hash)throw Error('Comment đổi trong lúc đọc; tải lại.');comments.set(c.id,c);}next=d.nextCursor;drawComments();renderTarget();
          notice.textContent=d.complete?`Đã tải đủ ${d.loadedComments} comment · ${when(d.fetchedAt)}`:`Đã tải ${d.loadedComments} comment, chưa xác nhận đầy đủ${d.totalActions!==null?` (đã đọc ${d.scannedActions}/${d.totalActions} sự kiện)`:''}.${d.error?' Cần tải lại: '+d.error:''}`;more.hidden=!next;if(cursor)timeline.scrollTop=scroll+Math.max(0,timeline.scrollHeight-height);
        }catch(e){if(valid(g)){notice.textContent=`Chưa đọc đủ comment: ${e.message}`;more.hidden=true;}}finally{if(valid(g))more.disabled=false;}}
      async function loadEvaluation({preserve=false}={}){
        try{const d=await req(path('/assessment'));if(!valid(g))return;if(!matches(d.target?.binding,row))throw Error('Đánh giá không khớp ticket/lượt.');if(d.current&&(d.current.reportId!==d.target.reportId||d.current.resultHash!==d.target.resultHash))throw Error('Đánh giá không khớp hash/bản kết quả.');data=d;
          if(!preserve){selected=d.current?.verdict||null;note.value=d.current?.note||'';radios.forEach(r=>r.checked=r.value===selected);needsReload=false;}
          renderTarget();drawComments();
          status.textContent=!d.schemaReady?'Chức năng đánh giá chưa được kích hoạt trên máy chủ.':!d.target.eligible?d.target.reason:!d.authorization.canWrite?d.authorization.reason:'Chọn Đúng/Sai rồi Lưu. Góp ý chỉ là ghi chú, không tự Train AI.';updateEnabled();return d;
        }catch(e){if(valid(g)){data=null;status.textContent=`Chưa đọc được đánh giá: ${e.message}`;updateEnabled();}}
      }
      async function reconcile(){if(!pending)return;try{const d=await req(path('/assessment/requests/'+encodeURIComponent(pending.id)));if(!valid(g))return;
          if(!d.receipt){status.textContent='Chưa xác minh được lần lưu. Không tự gửi lại.';return;}
          if(d.receipt.reportId!==data?.target.reportId||d.receipt.resultHash!==pending.payload.expectedReportHash)throw Error('Receipt không khớp kết quả đã chọn.');
          const expected=d.receipt,savedPending=pending;pending=null;const fresh=await loadEvaluation();if(!valid(g))return;if(!fresh){pending=savedPending;status.textContent='Đã có receipt, chưa đọc lại được; kiểm tra lần lưu.';updateEnabled();return;}reconcileButton.hidden=true;
          status.textContent=fresh?.current?.revision===expected.revision&&fresh.current.verdict===expected.verdict&&fresh.current.note===expected.note&&fresh.current.resultHash===expected.resultHash&&fresh.current.evaluator?.id===expected.evaluator?.id?'Đã lưu và đọc lại xác nhận.':'Lần lưu đã có receipt; dữ liệu hiện tại đã thay đổi, hãy đọc lại.';updateEnabled();
        }catch(e){if(valid(g))status.textContent=`Chưa xác minh lần lưu: ${e.message}`;}}
      const reconcileButton=button('Kiểm tra lần lưu',()=>void reconcile());reconcileButton.hidden=true;form.append(reconcileButton);
      form.addEventListener('submit',async e=>{e.preventDefault();if(save.disabled||pending)return;const payload={requestId:crypto.randomUUID(),expectedRevision:data.current?.revision||0,expectedReportHash:data.target.resultHash,verdict:selected,note:note.value};pending={id:payload.requestId,payload};updateEnabled();status.textContent='Đang lưu đánh giá…';
        try{const saved=await req(path('/assessment'),{method:'POST',body:payload});if(!valid(g))return;if(saved.reportId!==data.target.reportId||saved.resultHash!==payload.expectedReportHash)throw Error('Receipt không đúng kết quả.');
          const draftNote=note.value;pending=null;const fresh=await loadEvaluation();if(!valid(g))return;if(!fresh){pending={id:payload.requestId,payload};reconcileButton.hidden=false;status.textContent='Đã có receipt, chưa đọc lại được; kiểm tra lần lưu.';return;}
          const confirmed=fresh?.current?.revision===saved.revision&&fresh.current.verdict===saved.verdict&&fresh.current.note===saved.note&&fresh.target.resultHash===saved.resultHash&&fresh.current.resultHash===saved.resultHash&&fresh.current.evaluator?.id===saved.evaluator?.id;
          status.textContent=confirmed?'Đã lưu và đọc lại xác nhận.'+(draftNote!==saved.note?' Nội dung nhạy cảm đã được ẩn.':''):'Lần lưu có receipt nhưng bản hiện tại đã đổi; đọc lại trước khi sửa.';reconcileButton.hidden=true;
        }catch(e){if(!valid(g))return;if([400,403,409].includes(e.status)){pending=null;needsReload=true;status.textContent=e.message+' Hãy đọc lại đánh giá; thay đổi chưa lưu vẫn được giữ.';}else{status.textContent='Chưa xác nhận được lần lưu. Chỉ kiểm tra trạng thái, không tự gửi lại.';reconcileButton.hidden=false;}}
        finally{if(valid(g))updateEnabled();}});
      try{const d=await req(path());if(!valid(g))return;if(!matches(d.binding,row))throw Error('Thông tin ticket không khớp.');const t=d.ticket;header.replaceChildren(node('h2','Thông tin ticket'),node('strong',`${t.reference} · ${t.title}`),node('p',`${t.app||'App chưa rõ'} · ${(t.shops||[]).join(', ')||'Shop chưa rõ'}`),node('p',`${t.status||'Trạng thái chưa rõ'} · ${t.tsStatus||''}${t.done?' · Done':''}`),node('p',d.historicalRun.statusLabel,'ha-notice'));
        const href=safeLink(t.url);if(href){const a=node('a','Mở ticket Helpdesk');a.href=href;a.target='_blank';a.rel='noopener noreferrer';header.append(a);}await Promise.all([loadComments(),loadEvaluation()]);
      }catch(e){if(valid(g)){error(header,e);notice.textContent='Chưa đọc comment do thông tin ticket chưa xác minh.';status.textContent='Chưa thể đánh giá.';}}
    }

    void list();return()=>{stopped=true;generation++;controller?.abort();};
  }
  return { tabs, mount, mountTickets, reportView, renderComment: markdown };

})();
