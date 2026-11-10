import {assessmentSchemaReady} from './han-auto-assessment-migrate.mjs';
import {reportIdentity,sha} from './han-auto-assessment-target.mjs';
import {redact,fail} from './han-auto-ticket-context.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const current=r=>r?{reportId:r.report_id,revision:Number(r.revision),resultHash:r.result_sha256,verdict:r.verdict,note:r.note,evaluator:{id:r.evaluator_id,label:r.evaluator_label,authMethod:r.auth_method,channel:r.channel},updatedAt:r.updated_at}:null;
const receipt=r=>r?{requestId:r.request_id,reportId:r.report_id,resultHash:r.result_sha256,revision:Number(r.revision),verdict:r.verdict,note:r.note,evaluator:{id:r.evaluator_id,label:r.evaluator_label,authMethod:r.auth_method,channel:r.channel},savedAt:r.created_at,status:'confirmed'}:null;
export function createAssessmentStore({pool}){
 const query=(...a)=>pool.query(...a);
 async function ready(){return assessmentSchemaReady(query);}
 async function get(reportId){if(!await ready())return{schemaReady:false,current:null};const {rows:[row]}=await query('SELECT c.*,r.result_sha256 FROM ai_check_evaluation_current c JOIN ai_check_evaluation_reports r USING(report_id) WHERE c.report_id=$1',[reportId]);return{schemaReady:true,current:current(row)};}
 async function request(reportId,id){if(!UUID.test(id||''))throw fail(400,'Mã lần lưu không hợp lệ.');if(!await ready())return null;const {rows:[r]}=await query('SELECT * FROM ai_check_evaluation_events WHERE request_id=$1',[id]);if(r&&r.report_id!==reportId)throw fail(409,'Lần lưu không thuộc kết quả này.');return receipt(r);}
 async function addLink(client,target){if(!target.eligible||!target.delivery?.confirmed||!target.commentId)return false;
   const b=target.binding;const inserted=await client.query(`INSERT INTO ai_check_evaluation_comment_links(comment_id,report_id,ticket_id,job_id,run_id,result_sha256,receipt_proof) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING RETURNING comment_id`,[target.commentId,target.reportId,b.ticketId,b.jobId,b.runId,target.resultHash,JSON.stringify(target.delivery)]);
   const {rows:[link]}=await client.query('SELECT * FROM ai_check_evaluation_comment_links WHERE comment_id=$1 OR report_id=$2',[target.commentId,target.reportId]);
   if(!link||link.report_id!==target.reportId||link.comment_id!==target.commentId||link.result_sha256!==target.resultHash)throw fail(409,'Receipt liên kết xung đột; không ghi đè đánh giá.');return Boolean(inserted.rowCount);
 }
 async function save(target,actor,body){
  if(!actor?.id||!actor.authMethod||!['web','extension'].includes(actor.channel))throw fail(403,'Chưa xác minh quyền thao tác từ ứng dụng.');
  if(!body||Array.isArray(body)||Object.keys(body).some(k=>!['requestId','expectedRevision','expectedReportHash','verdict','note'].includes(k)))throw fail(400,'Payload đánh giá không hợp lệ.');
  if(!UUID.test(body.requestId||'')||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||!['correct','incorrect'].includes(body.verdict)||typeof(body.note??'')!=='string'||(body.note||'').length>6000)throw fail(400,'Chọn Đúng/Sai và góp ý tối đa 6.000 ký tự.');
  if(!await ready())throw fail(503,'Chức năng đánh giá chưa được kích hoạt trên máy chủ.');
  const note=redact(body.note||'').text;
  const requestHash=sha([target.reportId,actor.id,body.expectedRevision,body.expectedReportHash,body.verdict,sha(body.note||'')]);
  const c=await pool.connect();try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['evaluation-request:'+body.requestId]);
   const old=(await c.query('SELECT * FROM ai_check_evaluation_events WHERE request_id=$1',[body.requestId])).rows[0];if(old){if(old.request_sha256!==requestHash)throw fail(409,'Mã lần lưu đã dùng cho dữ liệu/người thao tác khác.');await c.query('COMMIT');return receipt(old);}
   if(!target.eligible)throw fail(409,target.reason||'Kết quả chưa đủ điều kiện đánh giá.');
   if(target.reportId!==reportIdentity(target.binding)||!target.resultHash||body.expectedReportHash!==target.resultHash)throw fail(409,'Kết quả đã đổi; tải lại trước khi đánh giá.');
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['evaluation-report:'+target.reportId]);
   const b=target.binding;
   await c.query(`INSERT INTO ai_check_evaluation_reports(report_id,ticket_id,job_id,run_id,result_kind,result_version,result_sha256,ticket_reference,subject,category,report_at,display_snapshot,provenance_snapshot) VALUES($1,$2,$3,$4,'canonical-comment',$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb) ON CONFLICT(report_id) DO NOTHING`,[target.reportId,b.ticketId,b.jobId,b.runId,target.resultVersion,target.resultHash,target.ticket,target.subject,target.category,target.reportAt,JSON.stringify({display:target.display,delivery:target.delivery}),JSON.stringify(target.provenance)]);
   const stored=(await c.query('SELECT * FROM ai_check_evaluation_reports WHERE report_id=$1',[target.reportId])).rows[0];if(stored.result_sha256!==target.resultHash||stored.ticket_id!==b.ticketId||stored.job_id!==b.jobId||stored.run_id!==b.runId)throw fail(409,'Hash/binding đã lưu khác kết quả hiện tại; không kế thừa đánh giá.');
   const previous=(await c.query('SELECT * FROM ai_check_evaluation_current WHERE report_id=$1 FOR UPDATE',[target.reportId])).rows[0];if(Number(previous?.revision||0)!==body.expectedRevision)throw fail(409,'Đánh giá đã đổi ở phiên khác. Đọc lại trước khi Lưu.');
   const revision=body.expectedRevision+1;
   const {rows:[event]}=await c.query(`INSERT INTO ai_check_evaluation_events(request_id,request_sha256,report_id,revision,expected_revision,result_sha256,verdict,note,evaluator_id,evaluator_label,auth_method,channel) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[body.requestId,requestHash,target.reportId,revision,body.expectedRevision,target.resultHash,body.verdict,note,actor.id,actor.label,actor.authMethod,actor.channel]);
   await c.query(`INSERT INTO ai_check_evaluation_current(report_id,revision,verdict,note,evaluator_id,evaluator_label,auth_method,channel) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(report_id) DO UPDATE SET revision=EXCLUDED.revision,verdict=EXCLUDED.verdict,note=EXCLUDED.note,evaluator_id=EXCLUDED.evaluator_id,evaluator_label=EXCLUDED.evaluator_label,auth_method=EXCLUDED.auth_method,channel=EXCLUDED.channel,updated_at=now()`,[target.reportId,revision,body.verdict,note,actor.id,actor.label,actor.authMethod,actor.channel]);
   await addLink(c,target);await c.query('COMMIT');return receipt(event);
  }catch(e){await c.query('ROLLBACK');if(e.status)throw e;throw fail(503,'Chưa xác minh được lần lưu. Chỉ đọc lại trạng thái, không tự gửi lại.');}finally{c.release();}
 }
 async function data(){if(!await ready())return{schemaReady:false,reports:[],assessments:[],links:[]};const c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const reports=(await c.query('SELECT * FROM ai_check_evaluation_reports')).rows,assessments=(await c.query('SELECT * FROM ai_check_evaluation_current')).rows,links=(await c.query('SELECT * FROM ai_check_evaluation_comment_links')).rows;await c.query('COMMIT');return{schemaReady:true,reports,assessments,links};}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 async function reconcile(targets){if(!await ready())return{linked:0,conflicts:0,schemaReady:false};const known=(await query('SELECT report_id,result_sha256 FROM ai_check_evaluation_reports')).rows;const keys=new Map(known.map(r=>[r.report_id,r.result_sha256]));let linked=0,conflicts=0;for(const t of targets){if(!t.eligible||!t.delivery?.confirmed||keys.get(t.reportId)!==t.resultHash)continue;try{if(await addLink({query},t))linked++;}catch(e){if(e.status===409)conflicts++;else throw e;}}return{linked,conflicts,schemaReady:true};}
 return{ready,get,request,save,data,reconcile};
}
