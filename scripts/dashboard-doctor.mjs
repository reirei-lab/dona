import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
/** Read-only preflight. Does not start services, issue pairing codes, or change Tailscale. */
export function inspectDashboardInstallation(config,logs,probeTailscale=defaultTailscaleProbe){
 const checks=[];const check=(name,fn)=>{try{fn();checks.push({name,status:'ok'});}catch{checks.push({name,status:'error'});}};
 const uid=process.getuid?.();
 const privateDir=dir=>{const stat=fs.lstatSync(dir);if(fs.realpathSync(dir)!==dir||!stat.isDirectory()||stat.uid!==uid||(stat.mode&0o777)!==0o700)throw Error();};
 for(const [name,file] of [['dispatcher_socket',config.dispatcher_socket],['runtime_socket',config.runtime_socket]])check(name,()=>{
  if(typeof file!=='string'||!path.isAbsolute(file))throw Error();privateDir(path.dirname(file));const stat=fs.lstatSync(file);if(!stat.isSocket()||stat.uid!==uid||(stat.mode&0o077)!==0)throw Error();
 });
 check('dispatcher_database',()=>{const stat=fs.lstatSync(config.dispatcher_database);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==uid||(stat.mode&0o077)!==0)throw Error();});
 check('control_directory',()=>privateDir(path.dirname(config.control_socket)));check('log_directory',()=>privateDir(logs));
 const tailscale=probeTailscale();checks.push({name:'tailscale',status:tailscale});
 return {ready:checks.every(item=>item.status==='ok'),checks,
  notes:['socketの存在は接続・認可の成功を証明しません。起動後にCLI statusを確認してください。','Tailscale未導入時は両端末へ導入し、ServeのHTTPS originを設定と照合してください。','HTTPSの実到達・端末pairing・会話表示は対象端末で別途確認してください。']};
}
function defaultTailscaleProbe(){
 const app='/Applications/Tailscale.app/Contents/MacOS/Tailscale';
 const result=spawnSync(fs.existsSync(app)?app:'tailscale',['status','--json'],{encoding:'utf8',timeout:5000,maxBuffer:262144});
 if(result.error?.code==='ENOENT')return 'not_installed';if(result.error||result.status!==0)return 'unavailable';
 try{return JSON.parse(result.stdout).BackendState==='Running'?'ok':'not_connected';}catch{return 'unavailable';}
}
