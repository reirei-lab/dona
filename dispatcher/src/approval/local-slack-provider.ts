import {createHash,createHmac} from "node:crypto";
import type {ExternalSlackPort,ExternalTarget,ExternalSendResult,SlackTargetObservation} from "./local-external-types.js";
import type {SealedApprovalExecutionMarker} from "./execution-marker.js";
const object=(v:unknown):Record<string,any>=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,any>:{};
const timestamp=(v:unknown):v is string=>typeof v==="string"&&/^\d{10}\.\d{6}$/.test(v);
const canonical=(v:unknown):string=>Array.isArray(v)?`[${v.map(canonical).join(",")}]`:v&&typeof v==="object"?`{${Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+":"+canonical(x)).join(",")}}`:JSON.stringify(v);
export const executionBlockId=(m:SealedApprovalExecutionMarker)=>`dona_exec_v1:${m.marker.attempt_id}:${m.marker.execution_fence}:${m.mac}`;
export function externalRichText(text:string){
 if(!text||text.length>3000||Buffer.from(text).toString("utf8")!==text||text.includes("<!"))throw Error("external_approval_invalid_draft");
 const elements:Array<{type:"text";text:string}|{type:"user";user_id:string}>=[];let at=0;const users=new Set<string>();
 for(const match of text.matchAll(/<@([^>]*)>/g)){if(!/^[UW][A-Z0-9]+$/.test(match[1]!))throw Error("external_approval_invalid_mention");
  if(match.index!>at)elements.push({type:"text",text:text.slice(at,match.index)});elements.push({type:"user",user_id:match[1]!});users.add(match[1]!);at=match.index!+match[0].length;}
 if(text.split("<@").length-1!==[...text.matchAll(/<@([^>]*)>/g)].length||users.size>3)throw Error("external_approval_invalid_mention");
 if(at<text.length)elements.push({type:"text",text:text.slice(at)});return {elements,users:[...users].sort(),fallback:text.replace(/<@([UW][A-Z0-9]+)>/g,"@$1")};
}
/** 固定Slack APIだけを使う実provider。tokenはcredential resolverから読み、retryしない。
 * transport注入は隔離test用。通常compositionは標準fetchを使用する。 */
export class LocalSlackApprovalProvider implements ExternalSlackPort {
 constructor(private readonly workspaceId:string,private readonly credential:()=>Promise<string>,private readonly revisionKey:Uint8Array,
  private readonly transport:typeof fetch=fetch){if(revisionKey.byteLength!==32)throw Error("external_approval_key_unavailable");}
 private async api(method:string,values:Record<string,unknown>,beforeSend?:()=>void|(()=>void)|Promise<void|(()=>void)>,signal:AbortSignal=AbortSignal.timeout(15000)){
  const token=await this.credential();if(!token)throw Error("external_approval_credentials_unavailable");
  signal.throwIfAborted();const assertCurrent=await beforeSend?.();signal.throwIfAborted();assertCurrent?.();
  const response=await this.transport(`https://slack.com/api/${method}`,{method:"POST",redirect:"error",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(values),signal});
  if(!response.ok)throw Error("external_approval_provider_unavailable");
  const reader=response.body?.getReader();if(!reader)throw Error("external_approval_provider_unavailable");
  const chunks:Uint8Array[]=[];let size=0;
  for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>2_097_152){await reader.cancel();throw Error("external_approval_provider_limit");}chunks.push(next.value);}
  return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
 }
 private async identity(signal:AbortSignal){const value=await this.api("auth.test",{},undefined,signal);
  if(value.ok!==true||value.team_id!==this.workspaceId||!/^U[A-Z0-9]+$/.test(value.user_id??"")||!/^B[A-Z0-9]+$/.test(value.bot_id??""))throw Error("external_approval_identity_unavailable");return value;}
 private async thread(target:ExternalTarget,signal:AbortSignal){
  if(target.workspace_id!==this.workspaceId||!/^C[A-Z0-9]+$|^G[A-Z0-9]+$/.test(target.channel_id)||!timestamp(target.thread_ts))throw Error("external_approval_target_invalid");
  const identity=await this.identity(signal),info=await this.api("conversations.info",{channel:target.channel_id},undefined,signal),channel=object(info.channel);
  if(info.ok!==true||channel.id!==target.channel_id||channel.is_archived!==false||channel.is_member!==true
   ||channel.is_shared!==false||channel.is_ext_shared!==false||channel.is_org_shared!==false)throw Error("external_approval_target_unavailable");
  const messages:Record<string,any>[]=[];let cursor="";const seen=new Set<string>();
  for(let page=0;page<20;page++){
   const value=await this.api("conversations.replies",{channel:target.channel_id,ts:target.thread_ts,limit:100,...(cursor?{cursor}:{})},undefined,signal);
   if(value.ok!==true||!Array.isArray(value.messages))throw Error("external_approval_thread_unavailable");
   for(const raw of value.messages){const m=object(raw);if(!timestamp(m.ts)||messages.some(x=>x.ts===m.ts))throw Error("external_approval_thread_unavailable");messages.push(m);}
   if(messages.length>1000)throw Error("external_approval_thread_limit");
   const next=object(value.response_metadata).next_cursor;
   if(typeof next!=="string"&&next!==undefined)throw Error("external_approval_thread_unavailable");
   if(!next){if(value.has_more===true)throw Error("external_approval_thread_incomplete");break;}
   if(seen.has(next)||page===19)throw Error("external_approval_thread_incomplete");seen.add(next);cursor=next;
  }
  messages.sort((a,b)=>a.ts.localeCompare(b.ts));if(messages[0]?.ts!==target.thread_ts)throw Error("external_approval_thread_unavailable");
  return {messages,identity,channel};
 }
 private async requester(target:ExternalTarget,userId:string,signal:AbortSignal){
  if(!/^[UW][A-Z0-9]+$/.test(userId))throw Error("external_approval_requester_invalid");
  const response=await this.api("users.info",{user:userId},undefined,signal),user=object(response.user);
  if(response.ok!==true||user.id!==userId||user.team_id!==this.workspaceId||user.deleted!==false||user.is_bot!==false)throw Error("external_approval_requester_unavailable");
  let cursor="";const seen=new Set<string>();
  for(let page=0;page<20;page++){
   const value=await this.api("conversations.members",{channel:target.channel_id,limit:200,...(cursor?{cursor}:{})},undefined,signal);
   if(value.ok!==true||!Array.isArray(value.members)||value.members.some((id:unknown)=>typeof id!=="string"))throw Error("external_approval_access_unavailable");
   if(value.members.includes(userId))return;
   const next=object(value.response_metadata).next_cursor;if(typeof next!=="string"&&next!==undefined)throw Error("external_approval_access_unavailable");
   if(!next||seen.has(next))throw Error("external_approval_requester_denied");seen.add(next);cursor=next;
  }
  throw Error("external_approval_access_limit");
 }
 async observe(target:ExternalTarget,requesterId?:string):Promise<SlackTargetObservation>{
  const signal=AbortSignal.timeout(15000),{messages,identity,channel}=await this.thread(target,signal);
  if(requesterId)await this.requester(target,requesterId,signal);
  return {target:{...target},...(requesterId?{requester_id:requesterId,requester_authorized:true}:{}),observed_at:new Date().toISOString(),bot_user_id:identity.user_id,bot_id:identity.bot_id,
   workspace_name:String(identity.team??this.workspaceId).slice(0,128),channel_name:String(channel.name??target.channel_id).slice(0,128),
   revision:{complete:true,items:messages.map(m=>({message_ts:m.ts,edited_ts:timestamp(object(m.edited).ts)?object(m.edited).ts:null,
    content_hmac_sha256:createHmac("sha256",this.revisionKey).update("dona.local-approval.thread.v1\0").update(canonical(m)).digest("hex")}))}};
 }
 async send(target:ExternalTarget,text:string,marker:SealedApprovalExecutionMarker,observation:SlackTargetObservation,beforeSend:()=>void|(()=>void)|Promise<void|(()=>void)>):Promise<ExternalSendResult>{
  const block=executionBlockId(marker),rich=externalRichText(text);
  if(marker.marker.scope.workspace_id!==target.workspace_id||canonical(observation.target)!==canonical(target))throw Error("external_approval_marker_mismatch");
  try{
   const value=await this.api("chat.postMessage",{channel:target.channel_id,thread_ts:target.thread_ts,text:rich.fallback,mrkdwn:false,parse:"none",reply_broadcast:false,
    unfurl_links:false,unfurl_media:false,blocks:[{type:"rich_text",block_id:block,elements:[{type:"rich_text_section",elements:rich.elements}]}]},beforeSend);
   if(value.ok!==true){const reason:Record<string,"unauthorized"|"resource_not_visible"|"invalid_input"|"scope_denied">={not_authed:"unauthorized",invalid_auth:"unauthorized",account_inactive:"unauthorized",channel_not_found:"resource_not_visible",not_in_channel:"resource_not_visible",invalid_blocks:"invalid_input",msg_too_long:"invalid_input",missing_scope:"scope_denied"};
    return reason[value.error]?{outcome:"rejected",receipt_ref:"slack_reject_"+createHash("sha256").update(marker.marker.attempt_id+":"+String(value.error)).digest("hex"),reason:reason[value.error]!}:{outcome:"unknown"};}
   const message=object(value.message);
   if(value.channel!==target.channel_id||!timestamp(value.ts)||message.thread_ts!==target.thread_ts||message.user!==observation.bot_user_id||message.bot_id!==observation.bot_id
    ||!Array.isArray(message.blocks)||!message.blocks.some((b:unknown)=>object(b).block_id===block))return {outcome:"unknown"};
   return {outcome:"accepted",receipt_ref:"slack_"+value.ts.replace(".","_")};
  }catch{return {outcome:"unknown"};}
 }
 async reconcile(target:ExternalTarget,marker:SealedApprovalExecutionMarker):Promise<ExternalSendResult>{
  try{const {messages,identity}=await this.thread(target,AbortSignal.timeout(15000)),block=executionBlockId(marker);
   const matches=messages.filter(m=>m.user===identity.user_id&&m.bot_id===identity.bot_id&&m.thread_ts===target.thread_ts&&Array.isArray(m.blocks)&&m.blocks.some((b:unknown)=>object(b).block_id===block));
   return matches.length===1?{outcome:"accepted",receipt_ref:"slack_"+matches[0]!.ts.replace(".","_")}:matches.length>1?{outcome:"ambiguous"}:{outcome:"unknown"};
  }catch{return {outcome:"unknown"};}
 }
}
