// Keep the instruction out of process argv, shell expansion and environment.
import fs from 'node:fs';
import {createRequire} from 'node:module';
const payload=JSON.parse(fs.readFileSync(0,'utf8'));
if(typeof payload.root!=='string'||!/^term_[a-zA-Z0-9-]+$/.test(payload.terminal))process.exit(2);
const {main}=createRequire(import.meta.url)(process.argv[2]);
if(payload.operation==='rename'){
 if(typeof payload.title!=='string'||!payload.title.trim()||payload.title.length>80||/[\x00-\x1f\x7f]/.test(payload.title))process.exit(2);
 await main(['terminal','rename','--environment','local','--terminal',payload.terminal,'--title',payload.title,'--json'],payload.root);
}else{
 if(typeof payload.message!=='string'||payload.message.length>8000)process.exit(2);
 await main(['terminal','send','--environment','local','--terminal',payload.terminal,'--text',payload.message,'--enter','--wait-submit','1','--json'],payload.root);
}
