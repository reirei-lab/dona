#!/usr/bin/env node
// native codeの署名後、外側bundle署名前だけ実行する。署名操作は含まない。
import fs from 'node:fs';import path from 'node:path';import {sha256} from './dispatcher-host-artifact.mjs';
const [app]=process.argv.slice(2);
try{
 if(!app||!path.isAbsolute(app)||fs.existsSync(path.join(app,'Contents/_CodeSignature')))throw Error();
 const dir=path.join(app,'Contents/Resources/release/dispatcher/dist/native');
 for(const name of fs.readdirSync(dir).filter(x=>x.endsWith('.json'))){
  const file=path.join(dir,name),m=JSON.parse(fs.readFileSync(file,'utf8'));
  if(typeof m.binary!=='string')continue;
  const candidates=[name.replace(/\.json$/,'.dylib'),name.replace(/\.json$/,'')].filter(x=>fs.existsSync(path.join(dir,x)));
  if(candidates.length!==1)throw Error();m.binary=sha256(fs.readFileSync(path.join(dir,candidates[0])));fs.writeFileSync(file,JSON.stringify(m)+'\n');
 }
 console.log('dispatcher_host_native_manifests_refreshed');
}catch{console.error('dispatcher_host_native_manifest_failed');process.exitCode=1;}
