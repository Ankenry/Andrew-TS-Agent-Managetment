#!/usr/bin/env node
// node skills/check-ticket/scripts/run.mjs <TICKET_URL_OR_ID> --preview [--follow-up "<chỉ thị>"] [--since <ISO>]
// Preview only: runs the configured analysis mode and prints the comment; never posts, uploads or notifies.
// --follow-up simulates a "@han" comment command (13/10/2026): the text is the instruction (data for the pipeline),
// --since the start of the "new comments" window (default: the end of the latest done job of this ticket in state.json).
// A chat ("hi", "cảm ơn") or a question ("ticket này sao rồi?") prints the natural reply instead (14/10/2026): a template
// for chat, one model turn without tools for a question; the pipeline runs only when the text asks for a check.
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { executeReview, ticketReference } from './core.mjs';
import { ROOT, STATE_PATH, settings, createIO, readEvidence } from './adapters.mjs';
import { parseBotCommand, followUpWindow, DEFAULT_KEYWORD, normalizeBotCommand, isReplyKind } from './bot-command.mjs';
import { chatReply, generateReply } from './bot-reply.mjs';
const args=process.argv.slice(2);
const valueOf=flag=>{const index=args.indexOf(flag);return index>=0?args[index+1]:undefined;};
const followUpText=valueOf('--follow-up');
const since=valueOf('--since');
const positional=args.filter((arg,index)=>!arg.startsWith('--') && args[index-1]!=='--follow-up' && args[index-1]!=='--since');
const reference=positional[0];
const knownFlags=new Set(['--preview','--follow-up','--since']);
if(!reference || args.some(arg=>arg.startsWith('--') && !knownFlags.has(arg)) || (args.includes('--follow-up') && followUpText===undefined)) {
  console.error('Usage: node skills/check-ticket/scripts/run.mjs <TICKET_URL_OR_ID> --preview [--follow-up "<chỉ thị>"] [--since <ISO>]');
  process.exitCode=1;
} else {
  try {
    const target=ticketReference(reference);
    const jobDir=resolve(ROOT,'runtime/check-ticket/previews',target.reference,randomUUID());
    let followUp=null; let replied=false;
    if(followUpText!==undefined) {
      const parsed=parseBotCommand(`${DEFAULT_KEYWORD} ${followUpText}`)||{kind:'follow_up',instruction:followUpText,defaultInstruction:false,reasons:[]};
      if(parsed.kind==='refused') throw new Error(`Chỉ thị bị từ chối (${parsed.reasons.join('; ')}): luồng @han chỉ đọc.`);
      if(parsed.kind==='draft') throw new Error('Draft cần comment ID của Andrew đã xác minh; --follow-up không chạy draft hoặc review thay thế. Dùng generateDraft với context command để preview.');
      const ticket=await readEvidence(target.reference);
      let jobs={}; try { jobs=JSON.parse(await readFile(STATE_PATH,'utf8')).jobs || {}; } catch { /* no state: window from the ticket creation */ }
      const window=followUpWindow({jobs,ticketId:ticket.id,commentAt:new Date().toISOString(),ticketCreatedAt:ticket.createdAt});
      followUp={keyword:DEFAULT_KEYWORD,instruction:parsed.instruction,defaultInstruction:parsed.defaultInstruction,kind:parsed.kind,commentId:null,commentAt:new Date().toISOString(),
        sinceAt:since || window.sinceAt,previousReport:window.previousReport,previousCategory:window.previousCategory,previousFinishedAt:null,preview:true};
      if(isReplyKind(parsed.kind)) {
        const bot=normalizeBotCommand((await settings()).botCommand);
        console.error(`[check-ticket preview] @han → ${parsed.kind}${parsed.chatGroup?`/${parsed.chatGroup}`:''}: trả lời tự nhiên, không chạy pipeline`);
        const result=bot.chatTemplates && parsed.kind==='chat'
          ? {kind:'chat',body:chatReply({group:parsed.chatGroup,reference:target.reference,keyword:bot.keyword}),source:'template'}
          : await generateReply({ticket,followUp,config:bot,jobDir,root:ROOT,jobs,log:text=>console.error(`[check-ticket preview] ${text}`)});
        if(result.kind!=='follow_up') {
          replied=true;
          console.log(result.body);
          console.error(`Preview saved: ${jobDir}. Reply (${result.kind}, ${result.source}) not posted; no Telegram.`);
        } else {
          console.error('[check-ticket preview] model đọc comment là yêu cầu check tiếp → chạy pipeline follow-up');
          followUp.kind='follow_up';
        }
      }
      if(!replied) console.error(`[check-ticket preview] follow-up: "${followUp.instruction}" · comment mới từ ${followUp.sinceAt || 'đầu ticket'}${window.previousJobId?` · báo cáo trước: job ${window.previousJobId}`:''}`);
    }
    if(!replied) {
      const io=await createIO(jobDir,phase=>console.error(`[check-ticket preview] ${phase}`));
      const review=await executeReview(reference,io,await settings(),{publishDemo:false,followUp});
      console.log(review.comment);
      console.error(`Preview saved: ${jobDir}. No comments or uploads performed.`);
    }
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
