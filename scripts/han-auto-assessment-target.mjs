import {createHash} from 'node:crypto';
import {allControllerJobs,AUTO_TRIGGERS} from '../skills/check-ticket/scripts/han-reports.mjs';
import {canonicalReview} from '../skills/check-ticket/scripts/canonical-review.mjs';
import {renderHanReport,isHanCompactComment,HANDLING_COMMENT_VERSION} from '../skills/check-ticket/scripts/han-report.mjs';
import {redact,fail} from './han-auto-ticket-context.mjs';
export const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export const reportIdentity=b=>sha(['han-auto-evaluation-v1',b.ticketId,b.jobId,b.runId]);
export function assessmentTarget(job,jobs=[]){
 const binding={ticketId:job.ticketId||job.id,jobId:job.id,runId:job.runId||''};
 const c=canonicalReview(job,{jobs}),reportId=reportIdentity(binding);
 let reason='';let validReport=false;try{if(job.report){renderHanReport(job.report);validReport=true;}}catch{}
 const shape=job.commentFormatVersion===HANDLING_COMMENT_VERSION||String(c.comment||'').trimStart().startsWith('Sau khi TS check thì thấy như sau:')||isHanCompactComment(c.comment);
 if(!AUTO_TRIGGERS.has(job.trigger)||(job.mode&&job.mode!=='review')||job.command?.kind==='refused')reason='Không phải kết quả auto-event.';
 else if(!['ready','posting','uncertain','done'].includes(job.status))reason='Lượt này chưa có kết quả hoàn tất để đánh giá.';
 else if(c.canonical.provenance!=='bound'||!c.comment||!shape)reason='Kết quả thiếu binding/provenance hoặc không phải report đã xác minh.';
 else if(!validReport&&!c.delivery.confirmed)reason='Chưa xác minh được RESULT của lượt này.';
 const time=job.finishedAt||job.presentationBinding?.preparedAt||job.createdAt;
 if(!Number.isFinite(Date.parse(time)))reason='Thiếu thời điểm của kết quả.';
 const safe=redact(c.comment||'');
 return{reportId,binding,eligible:!reason,reason,resultHash:c.canonical.sha256,resultVersion:job.commentFormatVersion||null,
   ticket:job.reference||'',subject:redact(job.subject||'').text,category:job.category||'',reportAt:Number.isFinite(Date.parse(time))?new Date(time).toISOString():null,
   display:{text:safe.text,redacted:safe.redacted,sha256:sha(safe.text)},provenance:c.canonical,
   delivery:{...c.delivery,status:job.status,label:c.statusLabel},
   commentId:c.delivery.confirmed?c.delivery.commentId:null};
}
export async function liveAssessmentTargets(root){const jobs=await allControllerJobs(root);return jobs.filter(j=>AUTO_TRIGGERS.has(j.trigger)&&(!j.mode||j.mode==='review')).map(j=>assessmentTarget(j,jobs));}
export async function loadAssessmentTarget(root,input){const targets=await liveAssessmentTargets(root);const target=targets.find(t=>t.binding.ticketId===input.ticketId&&t.binding.jobId===input.jobId&&t.binding.runId===input.runId);if(!target)throw fail(409,'Lượt check đã thay đổi; tải lại danh sách.');return target;}
