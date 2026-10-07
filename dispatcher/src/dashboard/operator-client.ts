import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
export interface OperatorSession {
  instance_id:string; owner_id:string; device_id:string; grant_revision:number;
  capabilities:string[]; csrf:string; expires_at:string;
}
export interface OperatorBackend { call<T>(route:string,body:Record<string,unknown>):Promise<T> }
/** Dedicated owner-only Dispatcher channel; never accepts a browser-controlled route. */
export class DashboardOperatorClient implements OperatorBackend {
 constructor(private readonly socket:string) {}
 async call<T>(route:string,body:Record<string,unknown>):Promise<T> {
  if(!/^(admin\/(reset|status|health|pair|revoke)|pair|session|logout|credential\/(status|options|register)|commands\/(create|cancel|question_reply|receipt)|questions|native\/(options|decide)|external\/(list|present|status|options|decide))$/.test(route))throw Error('dashboard_operator_route_invalid');
  const uid=process.getuid?.(),parent=path.dirname(this.socket);
  if(uid===undefined||!path.isAbsolute(this.socket)||Buffer.byteLength(this.socket)>100||fs.realpathSync(parent)!==parent)throw Error('dashboard_operator_socket_invalid');
  const dir=fs.lstatSync(parent),before=fs.lstatSync(this.socket);
  if(!dir.isDirectory()||dir.uid!==uid||(dir.mode&0o077)!==0||!before.isSocket()||before.uid!==uid||(before.mode&0o077)!==0)throw Error('dashboard_operator_socket_invalid');
  const encoded=JSON.stringify(body);
  if(Buffer.byteLength(encoded)>524288)throw Error('dashboard_operator_request_limit');
  return new Promise<T>((resolve,reject)=>{
   let timer:ReturnType<typeof setTimeout>|undefined;
   const fail=(error:Error)=>{clearTimeout(timer);reject(error);};
   const request=http.request({socketPath:this.socket,path:'/v1/dashboard/'+route,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(encoded)}},response=>{
    try{const after=fs.lstatSync(this.socket);if(after.dev!==before.dev||after.ino!==before.ino)throw Error();}catch{response.destroy();fail(Error('dashboard_operator_socket_changed'));return;}
    let raw='';response.setEncoding('utf8');response.on('data',(chunk:string)=>{raw+=chunk;if(Buffer.byteLength(raw)>262144)response.destroy(Error('dashboard_operator_response_limit'));});response.on('error',fail);
    response.on('end',()=>{clearTimeout(timer);try{if(response.statusCode!==200)throw Error('dashboard_operator_failed');resolve(JSON.parse(raw) as T);}catch{fail(Error('dashboard_operator_failed'));}});
   });timer=setTimeout(()=>request.destroy(Error('dashboard_operator_ambiguous')),5000);request.on('error',fail);request.end(encoded);
  });
 }
}
export function validateOperatorSession(value:unknown):OperatorSession {
 const s=value as OperatorSession;
 if(!s||typeof s!=='object'||!['instance_id','owner_id','device_id','csrf','expires_at'].every(key=>typeof (s as unknown as Record<string,unknown>)[key]==='string')||!Number.isSafeInteger(s.grant_revision)||s.grant_revision<0||!Array.isArray(s.capabilities)||s.capabilities.length>32||!s.capabilities.every(c=>typeof c==='string'&&c.length<=80)||!Number.isFinite(Date.parse(s.expires_at))||Date.parse(s.expires_at)<=Date.now())throw Error('dashboard_session_invalid');
 return {instance_id:s.instance_id,owner_id:s.owner_id,device_id:s.device_id,grant_revision:s.grant_revision,capabilities:[...s.capabilities],csrf:s.csrf,expires_at:s.expires_at};
}
