import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReader, ReaderError } from './brain-reader.mjs';
import {createWorkspaceApi} from './workspace-api.mjs';
const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function createApp({root='/home/avada/avada-brain',fixture=false,uiPort=5191,workspaceRoot=path.resolve(appRoot,'../..'),workspaceStateFile,orca=null,worktreeId=null}={}) {
 const reader=createReader(root);
 const workspace=createWorkspaceApi({root:workspaceRoot,stateFile:workspaceStateFile,orca,fixture,worktreeId});
 const server=http.createServer(async(req,res)=>{
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
  const allowed=[`127.0.0.1:${req.socket.localPort}`,`localhost:${req.socket.localPort}`,`127.0.0.1:${uiPort}`,`localhost:${uiPort}`];
  if(!allowed.includes(req.headers.host||''))return send(403,{error:{code:'HOST_DENIED',message:'Host không được phép.'}});
  if(req.headers.origin&&!allowed.some(h=>req.headers.origin===`http://${h}`))return send(403,{error:{code:'ORIGIN_DENIED',message:'Origin không được phép.'}});
  try {
   const url=new URL(req.url,'http://localhost');
   if(await workspace(req,url,send,res))return;
   if(req.method!=='GET')return send(405,{error:{code:'READ_ONLY',message:'Kho ghi chú chỉ đọc; không có endpoint sửa note hoặc gọi AI.'}});
   if(url.pathname==='/api/health')return send(200,{ok:true,readOnly:true,dataset:fixture?'fixture':'local',providerConfigured:false});
   if(url.pathname==='/api/provider')return send(200,{configured:false,code:'PROVIDER_NOT_CONFIGURED',message:'Provider, model và quyền truy cập chưa được chọn. Chưa gửi ghi chú ra ngoài máy.',requirements:['Chọn provider có API chat không dùng action tools.','Cấu hình credential chỉ ở server, không gửi qua hội thoại.','Xác minh kết nối bằng một lượt thử được duyệt.']});
   if(url.pathname==='/api/notes'||url.pathname==='/api/search') {
    const result=await reader.list({q:url.searchParams.get('q')||'',folder:url.searchParams.get('folder')||'',category:url.searchParams.get('category')||'',limit:Number(url.searchParams.get('limit')||30),cursor:url.searchParams.get('cursor')||'',revision:url.searchParams.get('revision')||''});return send(200,{...result,dataset:fixture?'fixture':'local'});
   }
   if(url.pathname.startsWith('/api/notes/')) {const result=await reader.detail(url.pathname.slice(11),url.searchParams.get('sourceHash')||'');res.setHeader('ETag',`"${result.sourceHash}"`);return send(200,result);}
   if(url.pathname.startsWith('/api/'))return send(404,{error:{code:'NOT_FOUND',message:'Endpoint không tồn tại.'}});
   const relative=url.pathname==='/'?'index.html':url.pathname.replace(/^\//,'');
   if(relative!=='index.html'&&!/^assets\/[a-zA-Z0-9_.-]+$/.test(relative))return send(404,{error:{code:'NOT_FOUND',message:'Không tìm thấy trang.'}});
   const file=await fs.readFile(path.join(appRoot,'dist',relative));const mime=relative.endsWith('.css')?'text/css':relative.endsWith('.js')?'text/javascript':'text/html';
   res.writeHead(200,{'Content-Type':mime+'; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});res.end(file);
  }catch(e){if(e instanceof ReaderError)return send(e.status,{error:{code:e.code,message:e.message}});return send(503,{error:{code:'READ_FAILED',message:'Chưa đọc được nguồn. Kiểm tra thư mục brain rồi thử lại.'}});}
 });
 const close=server.close.bind(server);server.close=(...args)=>{workspace.close();return close(...args);};return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const port=Number(process.env.PORT||5190);const server=createApp({root:process.env.BRAIN_ROOT||'/home/avada/avada-brain',fixture:process.env.BRAIN_FIXTURE==='1',uiPort:Number(process.env.UI_PORT||5191)});
 process.once('SIGTERM',()=>server.close(()=>process.exit(0)));
 server.listen(port,'127.0.0.1',()=>console.log(`Andrew Brain read-only: http://127.0.0.1:${port}`));
}
