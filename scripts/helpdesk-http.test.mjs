import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { helpdeskFetch, safeHelpdeskDiagnostics } from './helpdesk-http.mjs';

test('Helpdesk transport uses IPv4 and preserves the deadline, credentials and body',async()=>{
  const signal=AbortSignal.timeout(1000);
  let sent;
  const response=await helpdeskFetch('https://helpdesk.avada.net/api/external/tickets',{method:'POST',signal,headers:{'X-API-Key':'fixture'},body:'{}'},(url,options,callback)=>{
    assert.equal(options.agent.options.family,4);assert.equal(options.signal,signal);
    assert.equal(options.headers['X-API-Key'],'fixture');assert.equal(options.method,'POST');
    const req=new EventEmitter();req.end=body=>{
      sent=body;const res=new EventEmitter();res.statusCode=200;callback(res);
      res.emit('data',Buffer.from('{"success":true}'));res.emit('end');
    };return req;
  });
  assert.equal(sent,'{}');assert.equal(response.ok,true);assert.deepEqual(await response.json(),{success:true});
});

test('A failed POST is never automatically retried',async()=>{
  let calls=0;
  await assert.rejects(helpdeskFetch('https://helpdesk.avada.net',{method:'POST'},()=>{
    calls++;const req=new EventEmitter();req.end=()=>req.emit('error',Object.assign(Error('connection reset'),{code:'ECONNRESET'}));return req;
  }),error=>error.message==='Helpdesk transport failed.'&&error.detail.errorCode==='ECONNRESET'&&error.detail.httpStatus===null);
  assert.equal(calls,1);
});

test('transport diagnostics retain code and socket reuse without raw credentials or invented HTTP status',async()=>{
 const secret='private-fixture-secret';let calls=0;
 await assert.rejects(helpdeskFetch('https://helpdesk.avada.net/api/external/tickets/secret-ticket/comments?token='+secret,
  {method:'POST',headers:{'X-API-Key':secret},body:secret},()=>{
   calls++;const req=new EventEmitter();req.reusedSocket=true;
   req.end=()=>req.emit('error',Object.assign(new Error('socket '+secret),{code:'ECONNRESET',cause:{token:secret},config:{headers:{key:secret}}}));return req;
  }),error=>{
   assert.equal(error.detail.errorCode,'ECONNRESET');assert.equal(error.detail.method,'POST');
   assert.equal(error.detail.endpoint,'/api/external/tickets/:id/comments');assert.equal(error.detail.httpStatus,null);
   assert.equal(error.detail.reusedSocket,true);assert(error.detail.elapsedMs>=0);
   assert(!JSON.stringify(error).includes(secret));assert(!error.message.includes(secret));return true;
  });assert.equal(calls,1);
 const safe=safeHelpdeskDiagnostics({method:secret,endpoint:'/private/'+secret,errorCode:secret,message:secret,headers:{key:secret},httpStatus:'403',elapsedMs:secret});
 assert.equal(safe.errorCode,'UNKNOWN');assert.equal(safe.httpStatus,null);assert(!JSON.stringify(safe).includes(secret));
});

test('interrupted response retains an observed HTTP status and synchronous or aborted requests remain one attempt',async()=>{
 await assert.rejects(helpdeskFetch('https://helpdesk.avada.net/api/external/tickets/x/comments',{method:'POST'},(_url,_options,callback)=>{
  const req=new EventEmitter();req.end=()=>{const res=new EventEmitter();res.statusCode=502;callback(res);res.emit('aborted');};return req;
 }),error=>error.detail.errorCode==='RESPONSE_INTERRUPTED'&&error.detail.httpStatus===502&&error.detail.phase==='response');
 for(const code of ['ABORT_ERR','ENOTFOUND']){
  let calls=0;await assert.rejects(helpdeskFetch('https://helpdesk.avada.net',{method:'POST'},()=>{calls++;throw Object.assign(Error('private'),{code});}),
   error=>error.detail.errorCode===code&&error.detail.httpStatus===null&&error.detail.phase==='request');assert.equal(calls,1);
 }
});

test('HTTP access denials remain failures and interrupted responses reject',async()=>{
  const denied=await helpdeskFetch('https://helpdesk.avada.net',{},(_url,_options,callback)=>{
    const req=new EventEmitter();req.end=()=>{const res=new EventEmitter();res.statusCode=403;callback(res);res.emit('data',Buffer.from('{}'));res.emit('end');};return req;
  });
  assert.equal(denied.ok,false);assert.equal(denied.status,403);
  await assert.rejects(helpdeskFetch('https://helpdesk.avada.net',{},(_url,_options,callback)=>{
    const req=new EventEmitter();req.end=()=>{const res=new EventEmitter();callback(res);res.emit('aborted');};return req;
  }),/interrupted/);
});
