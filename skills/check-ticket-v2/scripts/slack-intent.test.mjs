import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {slackRequirement,readSlackEvidence} from './slack-evidence.mjs';
import {runPipeline} from './pipeline.mjs';
const ticket={id:'scope-fixture',ticketId:'CHAT-scope-fixture',appName:'Chatty',subject:'Does Chatty integrate with Slack?',description:'Merchant asks whether notifications can be sent to Slack.',tsStatus:'open',slackLink:'',comments:[],storeDomains:[],commentEvidence:{complete:true}};
const link='https://avadaio.slack.com/archives/C083Z2KTZQS/p1792602394612479';

test('P2 audit: Chatty Slack integration is a product question, not a thread-read request',()=>{
 assert.equal(slackRequirement(ticket).required,false);
});
test('P2 audit: multithreading and app threads do not require Slack',()=>{
 assert.equal(slackRequirement({...ticket,subject:'Question about multithreading',description:'How many threads run in the app?'}).required,false);
});
test('product mentions do not become mandatory via subject, description, comment or followUp',()=>{
 const negatives=['Does Chatty integrate with Slack?','Check Slack integration settings','Kiểm tra tích hợp Slack giúp tôi','Review Slack notification settings','Review multithreading performance','Check worker thread count','Check Slack thread notification settings','Review Slack thread support','How does the developer API send Slack notifications?','Slack thread notifications are not delivered','Can Chatty send replies to Slack?'];
 for(const value of negatives)for(const where of ['subject','description','comment','followUp']){
  const t={...ticket,subject:'Product question',description:'',comments:[]};
  if(where==='comment')t.comments=[{content:value}];else if(where!=='followUp')t[where]=value;
  assert.equal(slackRequirement(t,where==='followUp'?{instruction:value}:null).required,false,where+': '+value);
 }
});
test('clear dev reply or conversation read requests keep missing-link guard in every input location',()=>{
 const positives=['Kiểm tra phản hồi dev','Xem phản hồi dev trên Slack giúp tôi','Đối chiếu phản hồi dev giúp mình','Xem dev đã trả lời gì','Read the developer reply','Review replies from the developer','Check the Slack thread','Xem nội dung thread','Đọc thread này giúp tôi','Review this thread','Đọc thread giúp tôi','Read the thread','Đối chiếu tin nhắn trên Slack','Dev đã phản hồi chưa?','Has the developer replied?','check Slack giúp tôi'];
 for(const value of positives)for(const where of ['subject','description','comment','followUp']){
  const t={...ticket,subject:'Product question',description:'',comments:[]};
  if(where==='comment')t.comments=[{content:value}];else if(where!=='followUp')t[where]=value;
  const rule=slackRequirement(t,where==='followUp'?{instruction:value}:null);
  assert.equal(rule.required,true,where+': '+value);assert.equal(rule.error,'missing_thread_link');
 }
});
test('real thread links stay mandatory even on integration tickets; incomplete comments still fail closed',()=>{
 for(const fields of [{slackLink:link},{description:link},{comments:[{content:link}]}]){
  const rule=slackRequirement({...ticket,...fields});assert.equal(rule.required,true);assert.equal(rule.error,null);assert.equal(rule.threads[0].url,link);
 }
 assert.equal(slackRequirement({...ticket,commentEvidence:{complete:false,error:'deadline'}}).error,'helpdesk_comments_incomplete:deadline');
});
test('unrelated fields cannot synthesize request and generated report is not a new instruction',()=>{
 assert.equal(slackRequirement({...ticket,subject:'Review settings',description:'Slack thread notifications feature'}).required,false);
 assert.equal(slackRequirement({...ticket,comments:[{content:'Sau khi TS check thì thấy như sau:\nXem phản hồi dev'}]}).required,false);
});
test('negative integration ticket crosses real pipeline Slack gate without Slack/model calls',async()=>{
 let network=0,reached=false;
 const slack=await readSlackEvidence(ticket,{token:'fixture',fetchImpl:()=>{network++;throw Error('Unexpected network');}});
 assert.equal(slack.status,'not_required');assert.deepEqual(slack.errors,[]);
 const stop=Error('fixture stop before model');
 await assert.rejects(runPipeline(ticket.ticketId,{settings:{sourceApi:{enabled:false},preSearch:{enabled:false}},jobDir:await mkdtemp(join(tmpdir(),'hancal-r3-intent-negative-')),mode:'automatic',preview:true,
  prepareTicket:async()=>({ticket,slack,app:{slug:'chatty',kbRoots:[]},oldCases:[],lessons:[]}),log:phase=>{if(phase==='investigate'){reached=true;throw stop;}}}),error=>error===stop);
 assert.equal(reached,true);assert.equal(network,0);
});
test('positive missing-link request still stops real pipeline before model',async()=>{
 const t={...ticket,subject:'Kiểm tra phản hồi dev'};
 const slack=await readSlackEvidence(t,{token:'fixture',fetchImpl:()=>{throw Error('Unexpected network');}});
 let reached=false;
 const result=await runPipeline(t.ticketId,{settings:{},jobDir:await mkdtemp(join(tmpdir(),'hancal-r3-intent-positive-')),mode:'automatic',preview:true,prepareTicket:async()=>({ticket:t,slack,app:{slug:'chatty'}}),log:p=>{if(p==='investigate')reached=true;}});
 assert.equal(result.status,'incomplete');assert.equal(reached,false);assert.equal(result.writer,undefined);
});
