// Pure effective read model. Legacy rows are never modified. No Helpdesk calls.
import {liveAssessmentTargets} from './han-auto-assessment-target.mjs';
import {createAssessmentStore} from './han-auto-assessment-store.mjs';
const epoch=v=>Number.isFinite(Date.parse(v))?Date.parse(v):0;
export function effectiveAssessmentRows({legacy=[],live=[],reports=[],assessments=[],links=[]}){
 const targets=new Map(live.filter(t=>t.eligible).map(t=>[t.reportId,t]));const liveMap=new Map(live.map(t=>[t.reportId,t]));
 for(const r of reports){const current=liveMap.get(r.report_id);const same=current?.resultHash===r.result_sha256;
  targets.set(r.report_id,{reportId:r.report_id,binding:{ticketId:r.ticket_id,jobId:r.job_id,runId:r.run_id},resultHash:r.result_sha256,ticket:r.ticket_reference,subject:r.subject,category:r.category,reportAt:r.report_at,
    display:r.display_snapshot.display,delivery:same?current.delivery:r.display_snapshot.delivery,sourceConflict:Boolean(current&&!same),commentId:same?current.commentId:null,eligible:true});}
 const score=new Map(assessments.map(a=>[a.report_id,a]));const aliases=new Map(),byReport=new Map(),excludedReports=new Set(),conflictComments=new Set(),warnings=new Set();
 const candidates=[...links.map(l=>({commentId:l.comment_id,reportId:l.report_id,ticketId:l.ticket_id,hash:l.result_sha256,delivery:l.receipt_proof,persisted:true})),...live.filter(t=>t.eligible&&t.delivery.confirmed&&t.commentId).map(t=>({commentId:t.commentId,reportId:t.reportId,ticketId:t.binding.ticketId,hash:t.resultHash,delivery:t.delivery,persisted:false}))];
 for(const l of candidates){const t=targets.get(l.reportId);if(!t||t.binding.ticketId!==l.ticketId||t.resultHash!==l.hash)continue;
  const byComment=aliases.get(l.commentId),previous=byReport.get(l.reportId);
  if(byComment&&byComment.reportId!==l.reportId){if(l.persisted&&byComment.persisted)throw Error('Conflicting immutable receipt links');excludedReports.add(l.reportId);warnings.add(l.reportId);if(!byComment.persisted){excludedReports.add(byComment.reportId);warnings.add(byComment.reportId);aliases.delete(l.commentId);conflictComments.add(l.commentId);}continue;}
  if(previous&&previous.commentId!==l.commentId){warnings.add(l.reportId);conflictComments.add(l.commentId);continue;}
  aliases.set(l.commentId,l);byReport.set(l.reportId,l);
 }
 const legacyByReport=new Map(),consumed=new Set();for(const row of legacy){const l=aliases.get(row.comment_id);if(l&&row.ticket_id===l.ticketId){legacyByReport.set(l.reportId,row);consumed.add(row.comment_id);}else if(l){conflictComments.add(row.comment_id);}}
 const rows=[];for(const [id,t]of targets){const a=score.get(id),old=legacyByReport.get(id),alias=[...aliases.values()].find(l=>l.reportId===id);
  rows.push({effectiveId:'report:'+id,reportId:id,id:old?.id??null,commentId:alias?.commentId||null,ticketId:t.binding.ticketId,ticket:t.ticket,subject:t.subject,category:t.category,source:old?.source||'automatic',
    binding:t.binding,resultHash:t.resultHash,excerpt:(t.display?.text||'').slice(0,400),commentAt:t.reportAt,reportAt:t.reportAt,verdict:a?.verdict||old?.verdict||'pending',
    judgmentSource:a?'direct-assessment':old?'legacy-reaction':'auto-unassessed',assessmentRevision:Number(a?.revision||0),note:a?.note||'',evaluatorLabel:a?.evaluator_label||'',
    emoji:a?'':old?.reaction_emoji||'',judgedAt:a?.updated_at||old?.judged_at||null,feedbackCount:Number(old?.feedback_count||0),delivery:liveMap.get(id)?.resultHash===t.resultHash?liveMap.get(id).delivery:alias?.delivery||t.delivery,sourceConflict:t.sourceConflict||warnings.has(id),excludedFromTotals:excludedReports.has(id),
    url:`https://helpdesk.avada.net/t/${encodeURIComponent(t.ticket||t.binding.ticketId)}`});}
 for(const old of legacy)if(!consumed.has(old.comment_id))rows.push({effectiveId:'legacy:'+old.comment_id,reportId:null,id:old.id,commentId:old.comment_id,ticketId:old.ticket_id,ticket:old.ticket_reference,subject:old.subject,category:old.category,source:old.source,
  excerpt:old.comment_excerpt,commentAt:old.comment_at,verdict:old.verdict,emoji:old.reaction_emoji,judgedAt:old.judged_at,feedbackCount:Number(old.feedback_count||0),judgmentSource:'legacy-reaction',assessmentRevision:0,note:'',delivery:{confirmed:false,label:'Dữ liệu reaction lịch sử'},sourceConflict:conflictComments.has(old.comment_id),excludedFromTotals:conflictComments.has(old.comment_id),url:`https://helpdesk.avada.net/t/${encodeURIComponent(old.ticket_reference||old.ticket_id)}`});
 return rows.sort((a,b)=>epoch(b.commentAt)-epoch(a.commentAt)||a.effectiveId.localeCompare(b.effectiveId));
}
export async function loadEffectiveAssessmentRows({root,pool}){const legacy=(await pool.query(`SELECT r.*, (SELECT count(*) FROM ai_check_feedback f WHERE f.review_id=r.id)::int feedback_count FROM ai_check_reviews r`)).rows;const store=createAssessmentStore({pool});const data=await store.data();let live=[];if(data.schemaReady)live=await liveAssessmentTargets(root);return{rows:effectiveAssessmentRows({legacy,live,...data}),schemaReady:data.schemaReady};}
export function assessmentTotals(rows){const t={correct:0,incorrect:0,pending:0};for(const r of rows)if(!r.excludedFromTotals)t[r.verdict in t?r.verdict:'pending']++;const judged=t.correct+t.incorrect;return{...t,total:t.correct+t.incorrect+t.pending,judged,rate:judged?Math.round(t.correct/judged*1000)/10:null};}
export async function reconcileEvaluationReceipts({root,pool}){const store=createAssessmentStore({pool});if(!await store.ready())return{schemaReady:false,linked:0,conflicts:0};return store.reconcile(await liveAssessmentTargets(root));}
