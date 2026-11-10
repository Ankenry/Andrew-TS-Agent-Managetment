// Actual web and extension UI scripts in disposable Chromium; every request is fulfilled by fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { playwrightModule } from '../skills/check-ticket-v2/scripts/storefront.mjs';
import { hanFixture } from './fixtures/han-report.mjs';
import { canonicalReview } from '../skills/check-ticket/scripts/canonical-review.mjs';
import { conversationFromJob } from '../skills/check-ticket/scripts/history.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
// Optional same-run saved source fixture; live Helpdesk GET is validated separately, never by UI tests.
const verifiedFixture=process.env.HAN_CANONICAL_FIXTURE?JSON.parse(await readFile(process.env.HAN_CANONICAL_FIXTURE,'utf8')):null;
const realDetail=verifiedFixture?.api || null;
const realMeta=realDetail?Object.fromEntries(['id','runId','ticketId','ticket','subject','category','status','statusLabel','createdAt','finishedAt'].map(key=>[key,realDetail[key]])):null;
const css='.app-parent .card {\n  color: red;\n}\n/* <img src=x onerror=alert(1)> */';
const saved=hanFixture(`1. Han đề xuất dùng CSS tại \`Custom CSS\`; Han chưa lưu thay đổi.\n\n\`\`\`css\n${css}\n\`\`\`\n\nHan chưa thử được trên storefront vì trang bị khóa.`, 'Customize');
const meta={id:'job1',runId:'run1',ticketId:'ticket1',ticket:'APPT-261024-bNhP4R',subject:'Setup duration for booking',category:'Customize',status:'uncertain',statusLabel:'Chưa xác nhận comment',hasReport:true,createdAt:'2026-10-25T06:00:00Z'};
const fixtureJob={...meta,reference:meta.ticket,...saved,artifactDir:'/tmp/runtime/check-ticket/jobs/job1/run1'};
const detail={...meta,...saved,...canonicalReview(fixtureJob)};
const legacy={...meta,id:'old',runId:'oldrun',hasReport:false,legacy:true};
const legacyDetail={...legacy,report:null,fullReport:null,...canonicalReview({...legacy,comment:'Báo cáo cũ đã lưu.'})};
const longCode=Array.from({length:1200},(_,i)=>`const code${i} = "<img src=x>";`).join('\n');
const longComment=saved.comment+'\n\n```js\n'+longCode+'\n```\n\nCaveat cuối: chưa áp dụng.';
const longDetail={...detail,...canonicalReview({...fixtureJob,comment:longComment})};
const sessions=[{id:1,source:'automatic',sourceLabel:'Auto check',externalId:'ticket1',ticket:meta.ticket,subject:meta.subject,chatId:'auto-ticket1',status:'done',statusLabel:'Đã check xong',startedAt:meta.createdAt}];
const history=conversationFromJob({...fixtureJob,comment:longComment},{analysis:'DO NOT DISPLAY OLD ANALYSIS'});
const defaults={ok:true,settings:{},groups:{},notifications:[],conversations:[history],schedules:[],tickets:[],sessions,connected:false};

for (const surface of ['web','extension']) test(`${surface}: legacy canonical renderer and History compatibility; new Han auto covered separately`, {timeout:45000}, async () => {
  const {chromium}=await import(pathToFileURL(playwrightModule()).href);
  const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--disable-extensions','--no-first-run']});
  try {
    const context=await browser.newContext({viewport:{width:1280,height:900}}); const page=await context.newPage();
    const errors=[];const calls=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(({detail,meta,legacy,legacyDetail,longDetail,realDetail,realMeta,sessions,defaults})=>{
      window.fixture={detail,meta,legacy,sessions,defaults};window.testCalls=[];window.failReport=false;
      window.detailMode='normal';
      window.resolveDetail=()=>window.detailMode==='long'?longDetail
        :window.detailMode==='wrong-run'?{...detail,runId:'other-run'}
        :window.detailMode==='wrong-ticket'?{...detail,ticketId:'other-ticket'}
        :window.detailMode==='missing'?{...detail,comment:null,canonical:{...detail.canonical,notice:'Chưa có bản comment lưu của lượt này.'}}
        :window.detailMode==='conflict'?{...detail,comment:null,canonical:{...detail.canonical,provenance:'conflict',notice:'Chưa xác minh được comment của lượt này: artifact lệch run.'}}
        :window.detailMode==='old-api'?{...detail,canonical:undefined}
        :detail;
      window.EventSource=class { addEventListener(){} close(){} };
      const store={ticketAiConversationHistory:defaults.conversations};window.chrome={runtime:{getURL:path=>'https://fixture.test/'+path,onMessage:{addListener(){}},sendMessage:(msg,cb)=>{
        window.testCalls.push(msg); let response={...defaults};
        if(msg.type==='checking-reports')response={ok:true,reports:[meta,legacy,...(realMeta?[realMeta]:[])]};
        if(msg.type==='checking-report')response=window.failReport?{ok:false,error:'fixture offline'}:msg.id==='old'?{ok:true,...legacyDetail}:msg.id===realMeta?.id?{ok:true,...realDetail}:{ok:true,...window.resolveDetail()};
        cb(response);
      }},storage:{onChanged:{addListener(){}},local:{get:async keys=>typeof keys==='object'?{...keys,...store}:{...store},set:async data=>Object.assign(store,data)}}};
    },{detail,meta,legacy,legacyDetail,longDetail,realDetail,realMeta,sessions,defaults});
    await page.route('**/*',async route=>{
      const req=route.request();const url=new URL(req.url());calls.push({method:req.method(),path:url.pathname});
      if(req.method()!=='GET' || /queue|retry|review|follow-scan/.test(url.pathname)) return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'Fixture blocks writes/queue'})});
      if(url.pathname.startsWith('/api/')) {
        let data=defaults;let status=200;
        if(url.pathname==='/api/checking/reports')data={reports:[meta,legacy,...(realMeta?[realMeta]:[])]};
        else if(url.pathname==='/api/checking/reports/job1') { if(await page.evaluate(()=>window.failReport)){status=503;data={error:'fixture offline'};}else data=await page.evaluate(()=>window.resolveDetail()); }
        else if(url.pathname==='/api/checking/reports/old')data=legacyDetail;
        else if(realMeta&&url.pathname===`/api/checking/reports/${realMeta.id}`)data=realDetail;
        return route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
      }
      if(surface==='web') {
        const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
        const base=['han-auto-view.js','analytics-view.js','speech-player.js','news-view.js'].includes(name)?'chrome-extension':'web/app';
        if(!name.includes('..'))try{return await route.fulfill({contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html',body:await readFile(resolve(root,base,name),'utf8')});}catch{}
      }
      return route.fulfill({contentType:'text/html',body:'<!doctype html><body></body>'});
    });
    await page.goto('https://fixture.test/');
    if(surface==='extension') {
      const manifest=JSON.parse(await readFile(resolve(root,'chrome-extension/manifest.json'),'utf8'));
      for(const name of manifest.content_scripts[0].js)await page.addScriptTag({content:await readFile(resolve(root,'chrome-extension',name),'utf8')});
      // Panel mode is already open after injection; the toggle event would remove it.
    }
    await page.waitForTimeout(100);
    assert.deepEqual(errors,[], 'boot errors');
    await page.locator('[data-screen="checking"]').click();
    await page.getByRole('tab',{name:'Han cmt',exact:true}).waitFor();
    await page.locator('.checking-item').first().waitFor();
    const cmt = page.getByRole('tab',{name:'Han cmt',exact:true});
    const auto = page.getByRole('tab',{name:'Han auto',exact:true});
    const checkTabLayout = async () => {
      const dimensions = await page.locator('.han-checking-tabs').evaluate(bar => {
        const [first, second] = bar.querySelectorAll('button');
        const a = first.getBoundingClientRect(), b = second.getBoundingClientRect();
        const active = bar.querySelector('[aria-selected="true"]');
        return {equal:Math.abs(a.width-b.width)<1, adjacent:Math.abs(a.right-b.left)<1,
          fits:bar.scrollWidth<=bar.clientWidth+1, background:getComputedStyle(bar).backgroundColor,
          underline:getComputedStyle(active,'::after').height,
          focus:getComputedStyle(active).outlineStyle, focused:active.matches(':focus-visible'),
          tabbable:[...bar.querySelectorAll('button')].filter(el=>el.tabIndex===0).length};
      });
      assert.equal(dimensions.equal,true); assert.equal(dimensions.adjacent,true);
      assert.equal(dimensions.fits,true); assert.equal(dimensions.background,'rgb(46, 28, 73)');
      assert.equal(dimensions.underline,'3px'); assert.equal(dimensions.tabbable,1);
      assert.equal(dimensions.focused,true); assert.equal(dimensions.focus,'solid');
    };
    await cmt.focus();
    for (const [key,selected] of [['ArrowRight',auto],['ArrowRight',cmt],['ArrowLeft',auto],['Home',cmt],['End',auto]]) {
      await page.keyboard.press(key);
      assert.equal(await selected.getAttribute('aria-selected'),'true');
      assert.equal(await selected.evaluate(el=>el===el.getRootNode().activeElement),true);
    }
    await checkTabLayout();
    await page.keyboard.press('Home');
    await page.keyboard.press('Tab');
    assert.equal(await cmt.evaluate(el=>el===el.getRootNode().activeElement),false);
    await cmt.focus(); await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    assert.equal(await auto.getAttribute('aria-selected'),'true');
    await cmt.click();
    const before=calls.length;const beforeMessages=await page.evaluate(()=>window.testCalls.length);
    await page.getByRole('tab',{name:'Han auto',exact:true}).click();
    // Han auto now reads ticket comments. Preserve separate coverage of the canonical renderer
    // used by legacy History, without pretending the old report detail remains the auto screen.
    await page.evaluate(data=>{const probe=document.createElement('div');probe.id='canonical-probe';probe.append(HanAutoView.reportView(data));document.body.append(probe);},detail);
    assert.equal(await page.locator('#canonical-probe pre code').innerText(),css);
    assert.equal(await page.locator('#canonical-probe img').count(),0);
    assert.match(await page.locator('#canonical-probe').innerText(),/Sau khi TS check/);
    assert.doesNotMatch(await page.locator('#canonical-probe').innerText(),/Han Support/);
    await page.evaluate(data=>document.getElementById('canonical-probe').replaceChildren(HanAutoView.reportView(data)),longDetail);
    assert.equal(await page.locator('#canonical-probe pre code').last().textContent(),longCode);
    for(const data of [legacyDetail,{...detail,canonical:{...detail.canonical,provenance:'conflict',notice:'Chưa xác minh binding.'}}]) {
      await page.evaluate(d=>document.getElementById('canonical-probe').replaceChildren(HanAutoView.reportView(d)),data);
      assert.equal(await page.locator('#canonical-probe img').count(),0);
      assert.match(await page.locator('#canonical-probe').innerText(),/Báo cáo cũ|Chưa xác minh/);
    }
    await page.evaluate(()=>document.getElementById('canonical-probe').remove());
    await page.getByRole('tab',{name:'Han cmt',exact:true}).click();await page.locator('.checking-item').first().waitFor();
    assert.equal(calls.slice(before).filter(c=>c.method!=='GET').length,0);
    const messages=await page.evaluate(n=>window.testCalls.slice(n),beforeMessages);
    assert.ok(messages.every(m=>['checking-reports','checking-report','checking-sessions','han-auto-request','han-auto-cancel'].includes(m.type)),JSON.stringify(messages));
    await page.locator('[data-screen="chat"]').click();
    await page.getByRole('button',{name:'More chat actions',exact:true}).click();
    await page.getByRole('button',{name:'History',exact:true}).click();
    await page.locator('.chat-history-item').first().click();
    await page.locator('.chat-messages .han-auto-report pre code').first().waitFor();
    assert.equal(await page.locator('.chat-messages .han-auto-report').count(),1);
    assert.equal(await page.locator('.chat-messages .han-auto-report pre code').last().textContent(),longCode);
    const chatText=await page.locator('.chat-messages').innerText();
    assert.ok(chatText.includes('Caveat cuối: chưa áp dụng.'));
    assert.ok(chatText.includes('Chưa xác nhận comment'));
    assert.doesNotMatch(chatText,/DO NOT DISPLAY OLD ANALYSIS|Han Support/);
    assert.equal(await page.locator('.chat-messages .han-auto-report img').count(),0);
    assert.equal(await page.getByRole('button',{name:/copy|sao chép/i}).count(),0,'No existing result-copy action on either host');
    await page.screenshot({path:resolve(root,`runtime/screenshots/han-revert-canonical-${surface}-history.png`),fullPage:true});
    assert.equal(calls.slice(before).filter(c=>c.method!=='GET').length,0);
    assert.ok((await page.evaluate(n=>window.testCalls.slice(n),beforeMessages)).every(m=>['checking-reports','checking-report','checking-sessions','sync-automatic-history','han-auto-request','han-auto-cancel'].includes(m.type)));
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
