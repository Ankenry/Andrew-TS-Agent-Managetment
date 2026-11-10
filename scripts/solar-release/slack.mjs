import { loadEnv } from '../hachimi-db.mjs';
import { state,setState,saveThread } from './store.mjs';
import { CHANNEL,cleanMessage,validateThread,retryAt } from './core.mjs';

export class Incomplete extends Error {}
export class SlackReader {
  constructor({fetchImpl=fetch,getState=state,putState=setState,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),deadline=Date.now()+80*60000}={}) {
    Object.assign(this,{fetchImpl,getState,putState,now,sleep,deadline});
    this.token=loadEnv().SLACK_TOKEN;
  }
  async call(method,args) {
    if(!this.token) throw new Error('Missing SLACK_TOKEN');
    for(let attempt=0;attempt<8;attempt++) {
      const due=Number((await this.getState(`slack-rate:${method}`))?.at||0);
      while(this.now()<due) {
        if(due>this.deadline-30000) throw new Incomplete(`Slack ${method} delayed until ${new Date(due).toISOString()}`);
        await this.sleep(Math.min(30000,due-this.now()));
      }
      if(this.now()>this.deadline-30000) throw new Incomplete('Slack scan deadline; checkpoints retained');
      const url=new URL(`https://slack.com/api/${method}`);url.search=new URLSearchParams(Object.entries(args).filter(([,v])=>v!==''&&v!==undefined));
      let response;
      try {response=await this.fetchImpl(url,{headers:{Authorization:`Bearer ${this.token}`},signal:AbortSignal.timeout(30000)});}
      catch {throw new Incomplete(`Slack ${method} transport failure`);}
      if(response.status===429) {await this.putState(`slack-rate:${method}`,{at:retryAt(response.headers.get('retry-after'),this.now())});continue;}
      const d=await response.json().catch(()=>({}));
      if(!response.ok||!d.ok) throw new Incomplete(`Slack ${method}: ${d.error||response.status}`);
      // Calls are sequential; a restricted installation supplies its actual window via Retry-After.
      if(method.startsWith('conversations.')) await this.putState(`slack-rate:${method}`,{at:this.now()+1200});
      return d;
    }
    throw new Incomplete(`Slack ${method} rate limited; deferred`);
  }
  async search() {
    const found=new Map();let total=null;
    for(let page=1;page<=100;page++) {
      const d=await this.call('search.messages',{query:'in:solar-release',count:100,page,sort:'timestamp',sort_dir:'asc',highlight:false});
      const result=d.messages;
      if(!result||!Array.isArray(result.matches)) throw new Incomplete('Search missing result data');
      if(total!==null && total!==result.total) throw new Incomplete('Search changed while paginating; retry next scan');
      total=result.total;
      for(const m of result.matches) {
        if(m.channel?.id!==CHANNEL) throw new Incomplete('Search channel does not match configured channel ID');
        found.set(String(m.ts),m);
      }
      const pages=result.pagination?.page_count||result.paging?.pages||1;
      if(page>=pages) {
        if(found.size!==total) throw new Incomplete(`Search incomplete: ${found.size}/${total}`);
        return [...found.values()];
      }
    }
    throw new Incomplete('Search exceeds page budget');
  }
  async history() {
    let progress=await this.getState('history-progress');
    if(!progress) progress={cursor:'',roots:[],startedAt:new Date().toISOString(),latest:String(this.now()/1000)};
    const seen=new Map(progress.roots.map(m=>[m.ts,m]));
    const cursors=new Set();
    for(let page=0;page<1000;page++) {
      const d=await this.call('conversations.history',{channel:CHANNEL,limit:15,cursor:progress.cursor,latest:progress.latest,inclusive:true});
      if(!Array.isArray(d.messages)) throw new Incomplete('History missing messages');
      for(const m of d.messages) if(!m.thread_ts||m.thread_ts===m.ts) seen.set(String(m.ts),cleanMessage(m));
      const cursor=String(d.response_metadata?.next_cursor||'');
      progress={...progress,cursor,roots:[...seen.values()]};
      if(d.has_more&&!cursor) throw new Incomplete('History has_more without cursor');
      await this.putState('history-progress',progress);
      if(!cursor) {
        await this.putState('history-progress',null);
        return progress;
      }
      if(cursors.has(cursor)) throw new Incomplete('Repeated history cursor');
      cursors.add(cursor);
    }
    throw new Incomplete('History exceeds page budget');
  }
  async thread(root) {
    const stateKey=`thread-progress:${root.ts}`;
    const prior=await this.getState(stateKey);
    let cursor=prior?.cursor||'';
    const byTs=new Map((prior?.messages||[]).map(m=>[m.ts,m]));
    const cursors=new Set();
    for(let page=0;page<1000;page++) {
      const d=await this.call('conversations.replies',{channel:CHANNEL,ts:root.ts,limit:15,cursor});
      if(!Array.isArray(d.messages)) throw new Incomplete(`Thread ${root.ts} missing messages`);
      for(const m of d.messages) byTs.set(String(m.ts),cleanMessage(m));
      cursor=String(d.response_metadata?.next_cursor||'');
      if(d.has_more&&!cursor) throw new Incomplete(`Thread ${root.ts} has_more without cursor`);
      const messages=[...byTs.values()].sort((a,b)=>Number(a.ts)-Number(b.ts));
      await this.putState(stateKey,{cursor,messages});
      if(!cursor) {
        // Exact count/last-reply checks catch partial responses even when pagination claims completion.
        if(!validateThread(root,messages,d.has_more,cursor)) {
          await this.putState(stateKey,null);
          throw new Incomplete(`Thread ${root.ts} reply count/latest reply mismatch`);
        }
        await this.putState(stateKey,null);
        return {rootTs:root.ts,messages};
      }
      if(cursors.has(cursor)) throw new Incomplete('Repeated thread cursor');
      cursors.add(cursor);
    }
    throw new Incomplete('Thread exceeds page budget');
  }
}
export async function collectSlack(scanId,reader=new SlackReader()) {
  const search=await reader.search();
  let pass=await state('scan-progress');
  if(!pass) {
    const history=await reader.history();
    pass={...history,done:[],messageIds:[],newBatches:[]};
    await setState('scan-progress',pass);
  }
  const done=new Set(pass.done), ids=new Set(pass.messageIds);
  for(const root of pass.roots) {
    if(done.has(root.ts))continue;
    // Even roots without replies are re-read in history each pass; no replies request is required.
    const thread=root.reply_count?await reader.thread(root):{rootTs:root.ts,messages:[root]};
    const batchId=await saveThread(thread,scanId);
    if(batchId)pass.newBatches.push(batchId);
    thread.messages.forEach(m=>ids.add(m.ts));done.add(root.ts);
    pass={...pass,done:[...done],messageIds:[...ids]};
    await setState('scan-progress',pass);
  }
  const missing=search.filter(m=>!ids.has(String(m.ts)));
  // Never use search as a silent substitute for missing history/thread content.
  if(missing.length) {
    await setState('scan-progress',null);
    throw new Incomplete(`Search/history mismatch: ${missing.length} messages missing from complete thread pass`);
  }
  await setState('scan-progress',null);
  return {complete:true,channel:CHANNEL,roots:pass.roots.length,messages:ids.size,searchMatches:search.length,startedAt:pass.startedAt,finishedAt:new Date().toISOString(),newBatches:pass.newBatches};
}
