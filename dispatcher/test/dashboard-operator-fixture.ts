import {randomBytes} from 'node:crypto';
import type {OperatorBackend,OperatorSession} from '../src/dashboard/operator-client.js';
/** In-memory protocol fixture, never imported by service code. */
export class OperatorFixture implements OperatorBackend {
 readonly sessions=new Map<string,OperatorSession>();
 code:string|null=null;capabilities:string[]=[];
 async call<T>(route:string,body:Record<string,unknown>):Promise<T> {
  let result:unknown;
  if(route==='admin/reset'||route==='admin/revoke'){this.sessions.clear();this.code=null;result={ok:true};}
  else if(route==='admin/status')result={devices:[],sessions:this.sessions.size};
  else if(route==='admin/pair'){this.code=randomBytes(12).toString('base64url');this.capabilities=body.capabilities as string[];result={code:this.code,capabilities:this.capabilities,expires_at:new Date(Date.now()+300000).toISOString()};}
  else if(route==='pair'){
   if(!this.code||body.code!==this.code)throw Error('invalid');this.code=null;
   const token=randomBytes(32).toString('base64url'),session:OperatorSession={instance_id:'fixture',owner_id:'operator',device_id:randomBytes(8).toString('hex'),grant_revision:1,capabilities:this.capabilities,csrf:randomBytes(32).toString('base64url'),expires_at:new Date(Date.now()+43200000).toISOString()};this.sessions.set(token,session);result={token,session};
  }else if(route==='session'){const session=this.sessions.get(String(body.token));result=session?{...session,capabilities:[...session.capabilities]}:null;}
  else if(route==='logout'){this.sessions.delete(String(body.token));result={ok:true};}
  else throw Error('unsupported');
  return result as T;
 }
}
