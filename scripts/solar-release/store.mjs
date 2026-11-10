import { readFile } from 'node:fs/promises';
import { query, withTransaction, getPool } from '../hachimi-db.mjs';
import { CHANNEL, NAMESPACE, hash, key, slackUrl, newerFact, validateFact, factContent, threadHash, splitNotice } from './core.mjs';

export async function migrateSolar() { await query(await readFile(new URL('../../db/migrations/solar-release.sql', import.meta.url), 'utf8')); }
export async function lockScan() {
  const c = await getPool().connect();
  const {rows:[r]}=await c.query('SELECT pg_try_advisory_lock(719204, 2) AS locked');
  if(!r.locked) {c.release();return null;}
  return async()=>{try{await c.query('SELECT pg_advisory_unlock(719204, 2)');}finally{c.release();}};
}
export async function state(keyName) {return (await query('SELECT value FROM solar_state WHERE key=$1',[keyName])).rows[0]?.value;}
export async function setState(keyName,value) {await query('INSERT INTO solar_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()',[keyName,JSON.stringify(value)]);}
export async function saveThread(thread, scanId) {
  return withTransaction(async c=>{
    for(const m of thread.messages) await c.query(`INSERT INTO solar_revisions(channel,ts,root_ts,hash,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[CHANNEL,m.ts,thread.rootTs,hash(m),JSON.stringify(m)]);
    const {rows}=await c.query(`INSERT INTO solar_batches(root_ts,hash,scan_id,source) VALUES($1,$2,$3,$4) ON CONFLICT(root_ts,hash) DO NOTHING RETURNING id`,[thread.rootTs,threadHash(thread.messages),scanId,JSON.stringify(thread)]);
    return rows[0]?.id || null;
  });
}
export async function ingestBatch(batch, extraction) {
  const facts=Array.isArray(extraction.facts)?extraction.facts:[];
  const problems=facts.map(f=>validateFact(f,batch.source)).filter(Boolean);
  if(problems.length || (extraction.isRelease && !facts.length)) {
    await query(`UPDATE solar_batches SET status='quarantined',extraction=$2,error=$3 WHERE id=$1`,[batch.id,JSON.stringify(extraction),problems.join('; ')||'Release had no grounded facts']);
    return {quarantined:true,active:0};
  }
  return withTransaction(async c=>{
    let active=0;
    for(const f of facts) {
      const source=batch.source.messages.find(m=>m.ts===f.sourceTs);
      const row={app_slug:f.appSlug,feature_key:key(f.featureKey),applicability:key(f.applicability),claim:f.claim,quote:f.quote,
        source_ts:f.kind==='correction'?source.ts:batch.root_ts,root_ts:batch.root_ts,
        revision_ts:source.edited||source.ts,source_url:slackUrl(source.ts),kind:f.kind};
      const {rows:[saved]}=await c.query(`INSERT INTO solar_facts(batch_id,app_slug,feature_key,applicability,claim,quote,source_ts,root_ts,revision_ts,source_url,kind)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(batch_id,app_slug,feature_key,applicability) DO NOTHING RETURNING id`,
      [batch.id,row.app_slug,row.feature_key,row.applicability,row.claim,row.quote,row.source_ts,row.root_ts,row.revision_ts,row.source_url,row.kind]);
      if(!saved) continue;
      const content=factContent(row);
      const {rows:[doc]}=await c.query(`INSERT INTO documents(source_path,app_slug,title,content_hash,chunk_count,metadata)
        VALUES($1,$2,$3,$4,1,$5) RETURNING id`,[`${NAMESPACE}${row.app_slug}/${saved.id}`,row.app_slug,row.feature_key,hash(content),JSON.stringify({collection:'solar-release',factId:saved.id,sourceUrl:row.source_url,batchId:batch.id})]);
      await c.query('INSERT INTO document_chunks(document_id,chunk_index,app_slug,heading,content) VALUES($1,0,$2,$3,$4)',[doc.id,row.app_slug,row.feature_key,content]);
      await c.query('UPDATE solar_facts SET document_id=$2 WHERE id=$1',[saved.id,doc.id]);
      const {rows:[old]}=await c.query(`SELECT f.* FROM solar_current p JOIN solar_facts f ON f.id=p.fact_id WHERE p.app_slug=$1 AND p.feature_key=$2 AND p.applicability=$3`,[row.app_slug,row.feature_key,row.applicability]);
      if(newerFact(row,old)) {
        await c.query(`INSERT INTO solar_current(app_slug,feature_key,applicability,fact_id) VALUES($1,$2,$3,$4)
          ON CONFLICT(app_slug,feature_key,applicability) DO UPDATE SET fact_id=EXCLUDED.fact_id`,[row.app_slug,row.feature_key,row.applicability,saved.id]); active++;
      }
    }
    await c.query(`UPDATE solar_batches SET status=$2,extraction=$3,error=NULL,completed_at=now() WHERE id=$1`,[batch.id,facts.length?'ingested':'ignored',JSON.stringify(extraction)]);
    return {active,quarantined:false};
  });
}
export async function queueNotice(dedupe,text) {
  for(const [i,body] of splitNotice(text).entries()) await query(`INSERT INTO solar_outbox(dedupe_key,body) VALUES($1,$2) ON CONFLICT DO NOTHING`,[`${dedupe}:${i}`,body]);
}
export async function deliverNotices(send) {
  // A crash after POST is uncertain. Never auto retry a previously started request.
  await query(`UPDATE solar_outbox SET status='uncertain',error='Process stopped during send; do not retry blindly' WHERE status='sending'`);
  const pending=(await query(`SELECT * FROM solar_outbox WHERE status='pending' ORDER BY id`)).rows;
  for(const n of pending) {
    await query(`UPDATE solar_outbox SET status='sending' WHERE id=$1`,[n.id]);
    try {
      const sent=await send(n.body);
      await query(`UPDATE solar_outbox SET status='sent',message_id=$2,sent_at=now() WHERE id=$1`,[n.id,String(sent.messageId)]);
    } catch(e) {
      await query(`UPDATE solar_outbox SET status='uncertain',error=$2 WHERE id=$1`,[n.id,String(e.message).slice(0,250)]);
      break;
    }
  }
  return (await query(`SELECT id,status,message_id FROM solar_outbox WHERE status<>'sent' ORDER BY id`)).rows;
}
