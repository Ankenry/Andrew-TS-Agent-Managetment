// Narrow assessment authorization, layered AFTER existing web access/tailnet policy.
// No new credential/account. This identifies an application channel, not a human.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {homedir,hostname,userInfo} from 'node:os';
import {createHash} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
export const loopback=ip=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(String(ip||''));
export async function installedAssessmentOrigins(root){
  try{const d=JSON.parse(await readFile(resolve(homedir(),'.config/google-chrome/NativeMessagingHosts/com.avada.andrew_telegram.json'),'utf8'));
    if(d.name!=='com.avada.andrew_telegram'||resolve(d.path)!==resolve(root,'scripts/telegram-notifier-native-host.mjs'))return[];
    return(d.allowed_origins||[]).filter(x=>/^chrome-extension:\/\/[a-p]{32}\/$/.test(x)).map(x=>x.slice(0,-1));
  }catch{return[];}
}
export function assessmentActor(req,{root,allowedOrigins=[],localOrigins=[],extensionOrigins=[],accessAllowed=false,writesEnabled=true,pinConfigured=false,pinVerified=false,verifiedPrincipal=null}={}){
  const reject=reason=>({canWrite:false,reason,actor:null});
  if(!accessAllowed)return reject('Quyền truy cập hiện tại chưa cho phép đánh giá.');
  if(!writesEnabled)return reject('Tạm khóa lưu đánh giá; dữ liệu đã lưu vẫn được giữ.');
  const h=req.headers||{},host=String(h.host||'').toLowerCase();
  const origins=allowedOrigins.filter(x=>{try{return new URL(x).host.toLowerCase()===host;}catch{return false;}});
  if(!origins.length)return reject('Địa chỉ ứng dụng chưa được xác minh.');
  if(h['x-han-assessment-request']!=='1')return reject('Thiếu xác nhận thao tác từ ứng dụng.');
  if(req.method==='POST'&&!/^application\/json(?:;|$)/i.test(h['content-type']||''))return reject('Định dạng yêu cầu không hợp lệ.');
  let origin=String(h.origin||'');
  const peer=String(req.socket?.remoteAddress||'');
  const proxied=Boolean(h['x-forwarded-for']||h.forwarded||h['x-real-ip']);
  let channel;
  if(origin.startsWith('chrome-extension://')){
    if(!extensionOrigins.includes(origin)||!loopback(peer)||proxied)return reject('Extension chưa thuộc integration local được xác minh.');
    channel='extension';
  }else{
    // Same-origin GET often has no Origin; use browser Fetch Metadata + a matching Referer.
    if(!origin&&req.method==='GET'&&h['sec-fetch-site']==='same-origin'){
      try{origin=new URL(h.referer).origin;}catch{}
    }
    if(!origins.includes(origin))return reject('Nguồn thao tác không đúng ứng dụng.');
    if(h['sec-fetch-site']&&h['sec-fetch-site']!=='same-origin'&&h['sec-fetch-site']!=='none')return reject('Không chấp nhận thao tác cross-site.');
    channel='web';
    if(!pinVerified&&!verifiedPrincipal&&(!loopback(peer)||proxied||!localOrigins.includes(origin)))return reject('Transport từ xa chưa có principal được xác minh; chỉ xem dữ liệu.');
  }
  if(pinConfigured&&!pinVerified)return reject('Cần quyền truy cập web hiện có.');
  const installation=hash(`${resolve(root)}\0${hostname()}\0${userInfo().uid}`);
  const personal=Boolean(verifiedPrincipal);
  const authMethod=personal?'existing-verified-principal':pinVerified?'existing-shared-web-pin':channel==='extension'?'registered-local-extension':'local-same-origin-application';
  return{canWrite:true,reason:'',actor:{id:personal?'principal:'+hash(String(verifiedPrincipal)):'installation:'+hash(installation+'\0'+channel+'\0'+origin),channel,authMethod,
    label:personal?'TS Management — principal truy cập đã xác minh':'TS Management — chưa xác minh danh tính cá nhân',humanVerified:false,principalVerified:personal}};
}
