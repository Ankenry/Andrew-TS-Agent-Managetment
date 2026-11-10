import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanMessage,threadHash,validateThread,retryAt,newerFact,validateFact,splitNotice } from './core.mjs';
import { SlackReader,Incomplete } from './slack.mjs';
import { validateQuestions } from './model.mjs';
import { scoreQuote } from '../../skills/check-ticket-v2/scripts/verify.mjs';

const root=cleanMessage({ts:'100.000001',user:'U1',text:'Cookie Bar: Google Consent Mode is now live for all plans.',reply_count:1,latest_reply:'101.000001'});
const reply=cleanMessage({ts:'101.000001',thread_ts:root.ts,user:'U1',text:'Demo added'});
const thread={rootTs:root.ts,messages:[root,reply]};
const fact={appSlug:'cookie-bar',featureKey:'google_consent_mode',applicability:'all plans',claim:'Consent Mode is live',quote:'Google Consent Mode is now live for all plans.',sourceTs:root.ts,kind:'release',confidence:'high',deployment:'released'};
test('thread completeness checks count, latest reply, parent and cursor',()=>{
  assert.equal(validateThread(root,[root,reply]),true);
  assert.equal(validateThread(root,[root]),false);
  assert.equal(validateThread(root,[root,reply],true),false);
  assert.equal(validateThread(root,[root,reply],false,'cursor'),false);
  assert.equal(validateThread({...root,latest_reply:'102.0'},[root,reply]),false);
});
test('content hashes detect edits, ignore reply counts, deduplicate identical content',()=>{
  assert.equal(threadHash([root]),threadHash([{...root,reply_count:22}]));
  assert.notEqual(threadHash([root]),threadHash([{...root,text:root.text+' Changed.'}]));
});
test('facts require real exact source, allowed app and released status',()=>{
  assert.equal(validateFact(fact,thread),'');
  assert.ok(validateFact({...fact,appSlug:'made-up'},thread));
  assert.ok(validateFact({...fact,quote:'not in the source at all'},thread));
  assert.ok(validateFact({...fact,deployment:'planned'},thread));
  assert.ok(validateFact({...fact,sourceTs:reply.ts,quote:'Demo added'},thread));
});
test('only explicit root-author corrections can override a root from replies',()=>{
  const correction={...reply,text:'Correction: Consent Mode is live only on Pro plans.'};
  const f={...fact,kind:'correction',sourceTs:reply.ts,quote:'Consent Mode is live only on Pro plans.'};
  assert.equal(validateFact(f,{...thread,messages:[root,correction]}),'');
  assert.ok(validateFact(f,{...thread,messages:[root,{...correction,user:'U2'}]}));
  assert.ok(validateFact(f,{...thread,messages:[root,{...correction,text:'Demo: Consent Mode is live only on Pro plans.'}]}));
});
test('later ingested or edited older release cannot replace newer release',()=>{
  assert.equal(newerFact({source_ts:100,revision_ts:300},{source_ts:200,revision_ts:200}),false);
  assert.equal(newerFact({source_ts:200,revision_ts:300},{source_ts:200,revision_ts:200}),true);
  assert.equal(newerFact({source_ts:200,revision_ts:200},{source_ts:200,revision_ts:200}),false);
});
test('429 waits at least Retry-After, persists cooldown and then resumes',async()=>{
  let now=100000,calls=0;const values=new Map(),waits=[];
  const r=new SlackReader({now:()=>now,getState:async k=>values.get(k),putState:async(k,v)=>values.set(k,v),
    sleep:async ms=>{waits.push(ms);now+=ms;},deadline:500000,
    fetchImpl:async()=>{calls++;return calls===1?{status:429,headers:new Headers({'retry-after':'65'})}:{status:200,ok:true,json:async()=>({ok:true,messages:[]})};}});
  r.token='test-token';
  await r.call('conversations.history',{channel:'test'});
  assert.equal(calls,2);assert.ok(waits.reduce((a,b)=>a+b,0)>=65000);assert.ok(waits.every(ms=>ms<=30000));
  assert.equal(retryAt('not-a-number',100),60100);
});
test('deadline holds work rather than overriding Retry-After',async()=>{
  const r=new SlackReader({now:()=>100000,getState:async()=>({at:400000}),putState:async()=>{},deadline:200000,fetchImpl:async()=>{throw new Error('must not call');}});
  r.token='x';await assert.rejects(r.call('conversations.replies',{}),Incomplete);
});
test('history pagination persists messages and rejects has_more without cursor',async()=>{
  const values=new Map();let calls=0;
  const r=new SlackReader({getState:async k=>values.get(k),putState:async(k,v)=>values.set(k,v)});
  r.call=async()=>++calls===1?{messages:[root],has_more:true,response_metadata:{next_cursor:'p2'}}:{messages:[{...root,ts:'90.0',thread_ts:'90.0'}],has_more:false};
  const result=await r.history();assert.equal(result.roots.length,2);assert.equal(values.get('history-progress'),null);
  r.call=async()=>({messages:[root],has_more:true});
  await assert.rejects(r.history(),/without cursor/);
});
test('exactly five source-grounded questions and app IDs required',()=>{
  const facts=[{id:1,app_slug:'cookie-bar',quote:fact.quote}];
  const q=Array.from({length:5},(_,i)=>({id:i+1,factId:1,appSlug:'cookie-bar',question:`q${i}`,expected:'answer',sourceQuote:fact.quote}));
  assert.doesNotThrow(()=>validateQuestions(q,facts));
  assert.throws(()=>validateQuestions(q.slice(1),facts));
  assert.throws(()=>validateQuestions([{...q[0],appSlug:'joy'},...q.slice(1)],facts));
});
test('release quotes are verified against the exact retrieved fact ID',()=>{
  const ctx={toolLog:[{tool:'release_knowledge',output:'[solar:2] Claim: expected answer from release.\n[solar:3] Claim: unrelated answer from other fact.'}]};
  assert.equal(scoreQuote({quote:'expected answer from release',source:{ref:'solar:2'}},ctx).score,0.9);
  assert.equal(scoreQuote({quote:'unrelated answer from other fact',source:{ref:'solar:2'}},ctx).score,0);
});
test('Telegram split preserves every character except line separators at chunk boundaries',()=>{
  const text=Array.from({length:100},(_,i)=>`Question ${i}: ${'x'.repeat(120)}`).join('\n');
  const parts=splitNotice(text);assert.ok(parts.length>1);assert.ok(parts.every(p=>p.length<=3600));assert.equal(parts.join('\n'),text);
});
