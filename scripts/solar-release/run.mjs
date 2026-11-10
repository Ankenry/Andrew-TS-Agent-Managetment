#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query,closePool } from '../hachimi-db.mjs';
import { sendTelegramText,telegramConfig } from '../telegram-send.mjs';
import { migrateSolar,lockScan,queueNotice,deliverNotices,state,setState } from './store.mjs';
import { collectSlack } from './slack.mjs';
import { trainPending,evaluate,evaluationNotice } from './model.mjs';

export async function runSolar({collectOnly=false,trainOnly=false}={}) {
  const unlock=await lockScan();
  if(!unlock)return {status:'already_running'};
  let id;
  try {
    id=(await query(`INSERT INTO solar_scans DEFAULT VALUES RETURNING id`)).rows[0].id;
    const coverage=trainOnly?await state('last-complete-coverage'):await collectSlack(id);
    if(!coverage?.complete)throw new Error('No complete source coverage; ingestion held');
    await setState('last-complete-coverage',coverage);
    await query('UPDATE solar_scans SET coverage=$2 WHERE id=$1',[id,JSON.stringify(coverage)]);
    if(collectOnly) {
      await query(`UPDATE solar_scans SET status='collected',finished_at=now() WHERE id=$1`,[id]);return {id,status:'collected',coverage};
    }
    const stats=await trainPending(id);
    const quarantine=Number((await query(`SELECT count(*) FROM solar_batches WHERE status IN ('quarantined','failed','pending')`)).rows[0].count);
    const lastEval=Number((await state('last-evaluated-fact'))?.id||0);
    const maxFact=Number((await query('SELECT coalesce(max(fact_id),0) AS id FROM solar_current')).rows[0].id);
    let result=null;
    if(maxFact>lastEval) {
      result=await evaluate(id);
      await setState('last-evaluated-fact',{id:maxFact});
      await queueNotice(`qa:${maxFact}`,evaluationNotice(result,id,stats,coverage));
    }
    if(quarantine)await queueNotice(`quarantine:${quarantine}:${maxFact}`,`⚠️ Solar release: ${quarantine} batch chưa đủ bằng chứng hoặc bị lỗi/cách ly. Không xác nhận toàn bộ đã học thành công. Scan #${id}.`);
    const unresolved=await deliverNotices(text=>sendTelegramText(text,telegramConfig()));
    const status=quarantine||unresolved.length||result?.passed<5?'incomplete':result?'trained':'unchanged';
    await query(`UPDATE solar_scans SET status=$2,finished_at=now(),evaluation=$3 WHERE id=$1`,[id,status,JSON.stringify({stats,qa:result?{passed:result.passed,total:5}:null,unresolved})]);
    return {id,status,coverage,stats,qa:result?{passed:result.passed,total:5}:null,unresolved};
  } catch(e) {
    const error=String(e.message).slice(0,500);
    if(id) {
      await query(`UPDATE solar_scans SET status='failed',error=$2,finished_at=now() WHERE id=$1`,[id,error]);
      await queueNotice(`failure:${error}`,`⚠️ Solar release scan #${id} chưa hoàn tất: ${error}\nGiữ checkpoint để thử tiếp; chưa xác nhận đã học thành công.`);
      await deliverNotices(text=>sendTelegramText(text,telegramConfig()));
    }
    return {id,status:'failed',error};
  } finally {await unlock();}
}
export async function statusSolar() {
  return {
    counts:(await query(`SELECT (SELECT count(*)::int FROM solar_revisions) revisions,(SELECT count(*)::int FROM solar_batches) batches,
      (SELECT count(*)::int FROM solar_facts) facts,(SELECT count(*)::int FROM solar_current) current_facts`)).rows[0],
    batches:(await query('SELECT status,count(*)::int FROM solar_batches GROUP BY status')).rows,
    scans:(await query('SELECT * FROM solar_scans ORDER BY id DESC LIMIT 3')).rows,
    notices:(await query('SELECT id,status,message_id FROM solar_outbox ORDER BY id DESC LIMIT 20')).rows
  };
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2);
    if(args.includes('--migrate')) {await migrateSolar();console.log('solar-release schema applied');}
    else if(args.includes('--status'))console.log(JSON.stringify(await statusSolar(),null,2));
    else {
      const result=await runSolar({collectOnly:args.includes('--collect'),trainOnly:args.includes('--train')});
      console.log(JSON.stringify(result,null,2)); if(result.status==='failed'||result.status==='incomplete')process.exitCode=1;
    }
  } catch(e){console.error(`Solar release failed (${e.code||e.name}): ${String(e.message).replace(/postgres(?:ql)?:\/\/\S+/g,'[database]').slice(0,400)}`);process.exitCode=1;}
  finally{await closePool();}
}
