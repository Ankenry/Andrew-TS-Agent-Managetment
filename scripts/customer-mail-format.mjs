export const CUSTOMER_MAIL_FORMAT_VERSION = 'andrew-app-team-v1';
// Exact ticket appName allowlist from the Helpdesk app catalog. Never infer from
// a ticket prefix, subject, model text or another ticket's app.
const APP_NAMES = ['JOY Loyalty','JOY Subscription','JOY Subscriptions','Wishlist','Chatty','Chatty AI',
  'Air Reviews','Email Marketing','AEM','Shopvid','LUNA Booking','Avada Order Limit','Cookie Bar','PDF Invoice',
  'SEA Survey','SEA Accessibility','SUN Age Verification','Air Estimated Delivery Date','SUN Order Tracking',
  'Avada Affiliate Marketing','Affily','SEA Fraud Filter','SEA Online Course','Shipping Labels',
  'Backups & Restore','Backups and Restore','Withdrawal Forms','withdrawalForms','Order Editing'];
export function customerMailIdentity(appName) {
  const name=String(appName || '').trim();
  const known=APP_NAMES.find(x=>x.toLowerCase()===name.toLowerCase());
  if(!known) throw new Error('Customer mail requires a verified known ticket appName; no team name guessed.');
  const joy=known==='JOY Loyalty';
  return {appName:known,opening:`I am Andrew from the ${joy?'Loyalty':known} technical support team, and I hope this email finds you well`,
    signature:`Best regards,\nAndrew, ${joy?'Joy':known} Technical Support Team`};
}

const INTRO=/^(?:I am|I'm|I’m) Andrew from (?:the )?[^\n.!?]{1,100}?technical support team(?:,? and I hope this email finds you well)?[.!]?(?:[ \t]*\n|[ \t]+|$)/i;
const WELL=/^I hope this email finds you well[.!]?(?:[ \t]*\n|[ \t]+|$)/i;
const CLOSING=/^(?:Best regards|Kind regards|Regards|Sincerely|Best|Warm regards),?$/i;
const SIGNERS=new Set(['Andrew','Support team',...APP_NAMES.concat(['Joy','Loyalty']).flatMap(name=>[`${name} Support Team`,`${name} Technical Support Team`])].map(x=>x.toLowerCase()));
const isSigner=value=>{const line=value.replace(/[.,]$/, '').trim();return SIGNERS.has(line.toLowerCase()) || (/^Andrew, /i.test(line) && SIGNERS.has(line.replace(/^Andrew, /i,'').toLowerCase()));};

export function formatCustomerMail(mail, appName) {
  const identity=customerMailIdentity(appName);
  let body=String(mail || '').replace(/\r\n/g,'\n').trim();
  if(!body) throw new Error('Customer mail body is empty.');
  let subject='';
  if(/^Subject:/i.test(body)) {const index=body.indexOf('\n');if(index<0)throw new Error('Customer mail body is empty.');subject=body.slice(0,index);body=body.slice(index+1).trim();}
  // Only remove a recognizable opening at the start. Keep same-line technical
  // prose following the comma, and all paragraphs/URLs/code in the body.
  const greeting=/^(?:Hi|Hello|Dear)\s+[^,\n.!?]{1,60},[ \t]*/i.exec(body);
  if(greeting) body=body.slice(greeting[0].length).trim();
  else body=body.replace(/^(?:Hi|Hello|Dear)(?: [\p{L}'-]+){1,4}[!]?\n+/u,'').trim();
  for(let i=0;i<10;i++) {
    const match=INTRO.exec(body)||WELL.exec(body);
    if(!match)break;
    body=body.slice(match[0].length).trim();
  }
  // Remove repeated terminal signatures only when each line is a known team
  // identity. A body sentence such as "Contact the Air Reviews Support Team"
  // must survive, even when it is the final line.
  for(let pass=0;pass<10;pass++) {
    const lines=body.split('\n');let changed=false;
    for(let i=lines.length-1;i>=Math.max(0,lines.length-6);i--) {
      if(!CLOSING.test(lines[i].trim()))continue;
      const tail=lines.slice(i+1).map(x=>x.trim()).filter(Boolean);
      if(tail.length>3 || tail.some(x=>!isSigner(x))) throw new Error('Cannot normalize customer signature without discarding body text.');
      body=lines.slice(0,i).join('\n').trim();changed=true;break;
    }
    if(!changed && lines.length>1 && isSigner(lines.at(-1).trim())) {body=lines.slice(0,-1).join('\n').trim();changed=true;}
    if(!changed)break;
  }
  if(!body) throw new Error('Customer mail has no substantive body.');
  return [subject,identity.opening,body,identity.signature].filter(Boolean).join('\n\n');
}
