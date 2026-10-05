import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import type {ObservedTask} from './observer.js';
type Value=ObservedTask|ObservedTask['runtime'];
type Position={scope:string;binding:string;fingerprint:string;sequence:number;expires:number};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Snapshotと同じ投影から発行し、端末・権限・選択先を別streamへ転用させない。 */
export class OperatorStream {
 private readonly key=randomBytes(32);
 scope(authority:string,target:unknown):string{return hash([authority,target]);}
 private position(scope:string,value:Value):Position{
  const runtime='runtime'in value?value.runtime:value,c=runtime.status==='observed'?runtime.conversation:null;
  return {scope,binding:hash(['snapshot'in value?value.snapshot.selected_attempt_id:null,c?[c.name,c.generation,c.thread_id,c.attempt_id]:runtime.status]),
   // cursor本文は復号不要で読めるため、非公開本文の候補照合に使える通常hashを返さない。
   // requestはObserverが会話閲覧を許可した投影にだけ存在する。
   fingerprint:createHmac('sha256',this.key).update(JSON.stringify(['operator-stream-position-v1',scope,'snapshot'in value?[value.snapshot.fingerprint,value.snapshot.request??null]:null,c?[c.state,c.connected,c.cursor,c.items]:runtime.status])).digest('hex'),sequence:c?.cursor??0,expires:Date.now()+300_000};
 }
 private seal(position:Position):string{const body=Buffer.from(JSON.stringify(position)).toString('base64url');return body+'.'+createHmac('sha256',this.key).update(body).digest('base64url');}
 read(cursor:unknown,scope:string):Position|null{
  if(typeof cursor!=='string'||cursor.length>1024||!/^[-\w]+\.[-\w]+$/.test(cursor))return null;
  const [body,mac]=cursor.split('.'),expected=createHmac('sha256',this.key).update(body!).digest(),actual=Buffer.from(mac!,'base64url');
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return null;
  try{const p=JSON.parse(Buffer.from(body!,'base64url').toString()) as Position;return p.scope===scope&&p.expires>Date.now()&&Number.isSafeInteger(p.sequence)&&p.sequence>=0?p:null;}catch{return null;}
 }
 snapshot<T extends Value>(scope:string,value:T):T&{stream_cursor:string}{return {...value,stream_cursor:this.seal(this.position(scope,value))};}
 frame(scope:string,value:Value,previous:Position|null):string{
  const p=this.position(scope,value),runtime='runtime'in value?value.runtime:value;
  const reset=!previous||previous.binding!==p.binding||p.sequence<previous.sequence||(runtime.status==='observed'&&runtime.conversation.gap);
  const event=reset?'reset':p.fingerprint===previous.fingerprint?'heartbeat':'snapshot';
  // 一度の応答で通知は最大一件。本文をSSEへ複製せず認可付きsnapshot再取得を促す。
  return 'id: '+this.seal(p)+'\nevent: '+event+'\ndata: '+JSON.stringify({reason:reset?'snapshot_required':event==='snapshot'?'changed':'current'})+'\n\n';
 }
}
