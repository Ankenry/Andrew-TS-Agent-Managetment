import test from 'node:test';
import assert from 'node:assert/strict';
import {formatCustomerMail,customerMailIdentity} from './customer-mail-format.mjs';
import {formatDraftComment} from '../skills/dev-fix-follow/scripts/core.mjs';
const OPEN='I am Andrew from the Loyalty technical support team, and I hope this email finds you well';
const CLOSE='Best regards,\nAndrew, Joy Technical Support Team';
const BODY='We updated your support address.\n\nKeep this link: https://capture.avada.io/i/ABC123\nUse `option = false` until you confirm.';
test('Joy exact opening/signature once, preserves subject and technical body',()=>{
 const mail=formatCustomerMail('Subject: Update\n\nHi JP,\n\n'+BODY+'\n\nBest regards,\nJOY Loyalty Support Team','JOY Loyalty');
 assert.equal(mail,'Subject: Update\n\n'+OPEN+'\n\n'+BODY+'\n\n'+CLOSE);
 assert.equal(formatCustomerMail(mail,'Joy Loyalty'),mail);
});
test('model greeting and signature already correct are not duplicated',()=>{
 const mail=OPEN+'\n\n'+BODY+'\n\n'+CLOSE;assert.equal(formatCustomerMail(mail,'JOY Loyalty'),mail);
 assert.equal(formatCustomerMail('Hi JP,\n\n'+mail,'JOY Loyalty'),mail);
});
test('wrong existing team is replaced using actual Air Reviews appName only',()=>{
 const mail=formatCustomerMail(OPEN+'\n\n'+BODY+'\n\n'+CLOSE,'Air Reviews');
 assert.equal(mail,'I am Andrew from the Air Reviews technical support team, and I hope this email finds you well\n\n'+BODY+'\n\nBest regards,\nAndrew, Air Reviews Technical Support Team');
 assert.doesNotMatch(mail,/Joy|Loyalty/);
});
test('same-line greeting keeps substantive body and signing without closing is normalized',()=>{
 assert.equal(formatCustomerMail('Hi Anna, '+BODY+'\n\nSupport team','Chatty'),'I am Andrew from the Chatty technical support team, and I hope this email finds you well\n\n'+BODY+'\n\nBest regards,\nAndrew, Chatty Technical Support Team');
});
test('unknown/missing app cannot guess team from prefix or model content',()=>{
 for(const app of ['',null,'unknown','JOY-123','Joy Random App'])assert.throws(()=>formatCustomerMail(OPEN+'\n\n'+BODY,app),/verified known ticket appName/);
});
test('shared Dev/Feature formatter requires actual appName and preserves draft header',()=>{
 assert.throws(()=>formatDraftComment('done','now',BODY),/appName/);
 const d=formatDraftComment('done','now',BODY,undefined,'Air Reviews');assert.match(d,/^\[DRAFT — dev báo done \| Slack update: now\]/);assert.match(d,/Andrew, Air Reviews Technical Support Team$/);
});
test('unknown signature shape fails rather than silently discarding body content',()=>{
 assert.throws(()=>formatCustomerMail(BODY+'\n\nBest regards,\nPlease keep this instruction.','JOY Loyalty'),/discarding body/);
});
test('repeated existing intro/signature collapse once while final support instruction is preserved',()=>{
 const extra='Contact the Air Reviews Support Team';
 const mail=formatCustomerMail(OPEN+'\n\n'+OPEN+'\n\n'+BODY+'\n\n'+extra+'\n\n'+CLOSE+'\n\n'+CLOSE,'JOY Loyalty');
 assert.equal(mail.split(OPEN).length-1,1);assert.equal(mail.split(CLOSE).length-1,1);assert.ok(mail.includes(extra));assert.ok(mail.includes(BODY));
 assert.ok(formatCustomerMail(BODY+'\n\n'+extra,'Air Reviews').includes(extra));
});
test('model punctuation on existing signature normalizes to exact required ending',()=>{
 const mail=formatCustomerMail('Hi JP,\n\n'+OPEN+'.\n\n'+BODY+'\n\n'+CLOSE+'.','JOY Loyalty');
 assert.equal(mail,OPEN+'\n\n'+BODY+'\n\n'+CLOSE);
});
