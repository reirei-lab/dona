import {z} from "zod";
import {invalidateLocalApprovals} from "./local-invalidation.js";
import type {VerifiedAuditState} from "../audit/codec.js";
import {stableStringify} from "../validation.js";
import {createHash,randomUUID} from "node:crypto";
import type Database from "better-sqlite3";
import {AuditRepository} from "../audit/repository.js";
import type {ApprovalTransactionProviders} from "./transaction.js";
import {ApprovalCreateBroker,type ApprovalCreateKeyLookup} from "./create-broker.js";
import {ApprovalDecisionBroker} from "./decision-broker.js";
import {ApprovalNotificationBroker} from "./notification-broker.js";
import {ApprovalConsumeBroker} from "./consume-broker.js";
import {ApprovalExecutionBroker} from "./execution-broker.js";
import {ApprovalExecutionMarkerStore} from "./execution-marker-store.js";
import {verifyApprovalExecutionMarker,type ApprovalExecutionMarkerKey} from "./execution-marker.js";
import {ApprovalRecordRepository} from "./record-repository.js";
import {ApprovalRecordMutation} from "./record-mutation.js";
import {ApprovalHistoryTransaction} from "./history-transaction.js";
import {ApprovalPayloadRepository} from "./payload-repository.js";
import {openApprovalPayload,type ApprovalPayloadKey} from "./payload-protection.js";
import type {ApprovalNotificationKey} from "./notification-marker.js";
import type {ApprovalRecord,ApprovalRecordScope} from "./record-codec.js";
import type {ApprovalSnapshot} from "./snapshot.js";
import {advanceClockMark,type ClockMark} from "./clock.js";
import {externalSourceSchema,type ExternalApprovalSource,externalAuthoritySchema,externalIntentSchema,externalStepUpSchema,type ExternalApprovalAuthority,type ExternalApprovalIntent,type ExternalApprovalStepUp,
 type ExternalApprovalAuthPort,type ExternalSlackPort,type SlackTargetObservation,type ExternalSendResult} from "./local-external-types.js";
import {externalRichText} from "./local-slack-provider.js";
export type {ExternalApprovalAuthority,ExternalApprovalIntent,ExternalApprovalStepUp,ExternalApprovalAuthPort} from "./local-external-types.js";
const recoveryProofSchema=z.strictObject({scope:z.strictObject({instance_id:z.string(),workspace_id:z.string()}),owner:z.string(),requestId:z.string(),attemptId:z.string(),fence:z.number().int(),
 receipt:z.discriminatedUnion("outcome",[z.strictObject({outcome:z.literal("accepted"),receipt_ref:z.string().min(1)}),z.strictObject({outcome:z.literal("unknown")}),z.strictObject({outcome:z.literal("rejected"),receipt_ref:z.string().min(1),reason:z.string()})]),
 reasonDigest:z.string().regex(/^[a-f0-9]{64}$/),markerDigest:z.string().regex(/^[a-f0-9]{64}$/),expires:z.number().finite()});
type Request=Extract<ApprovalRecord,{kind:"request"}>;
const hash=(value:unknown)=>createHash("sha256").update(stableStringify(value)).digest("hex");
const tx=()=>"local_"+randomUUID().replaceAll("-","");
const denied={status:"denied",reason:"unauthorized"} as const;
export class ExternalApprovalPrecommitError extends Error {
 constructor(){super("external_approval_precommit_rejected");this.name="ExternalApprovalPrecommitError";}
}
export interface ExternalApprovalKeys extends ApprovalCreateKeyLookup {
 wrappingVersion(version:number|null):ApprovalPayloadKey;
 notificationVersion(version:number):ApprovalNotificationKey;
 execution(version:number|null):ApprovalExecutionMarkerKey;
}
export interface ExternalApprovalRecoveryEvidence {
 effect:"not_sent"|"accepted"|"unknown";request_id:string;attempt_id:string|null;receipt_ref:string|null;
}
export interface ExternalApprovalPresentation {request_id:string;operation:"slack.post_thread_reply.v1";workspace_id:string;channel_id:string;thread_ts:string;workspace_name:string;channel_name:string;
 requester:{kind:"slack"|"local_operator";label:string};risk:"external_message";operation_summary:string;display_fingerprint:string;created_at:string;exact_draft:string;notified_user_ids:string[];expires_at:string;request_revision:number;presentation_revision:number;presentation_digest:string}
/** Mac grantの追加transport。既存coreの暗号化payload、監査root、clock、decision、
 * consume、execution markerをそのまま使い、別の承認ledgerを作らない。 */
export class LocalExternalApprovalService {
 private executionCursor:string|null=null;
 private expiryCursor:string|null=null;
 private readonly records:ApprovalRecordRepository;
 private readonly payloads:ApprovalPayloadRepository;
 private readonly markers:ApprovalExecutionMarkerStore;
 private readonly audit:AuditRepository;
 constructor(private readonly db:Database.Database,private readonly providers:ApprovalTransactionProviders,private readonly scope:ApprovalRecordScope,
  private readonly keys:ExternalApprovalKeys,private readonly auth:ExternalApprovalAuthPort,private readonly slack:ExternalSlackPort){
  this.records=new ApprovalRecordRepository(db,providers.auditAnchors,providers.auditKeys,scope);
  this.payloads=new ApprovalPayloadRepository(db,providers.auditAnchors,providers.auditKeys,scope);
  this.markers=new ApprovalExecutionMarkerStore(db,providers,scope);this.audit=new AuditRepository(db,providers.auditAnchors,providers.auditKeys);
  // これは検索用contextだけ。正本のbinding_idが全fieldのdigestを認証する。
  db.exec("CREATE TABLE IF NOT EXISTS local_external_contexts(request_id TEXT PRIMARY KEY,authority_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS local_external_approvers(authority_hash TEXT PRIMARY KEY,authority_json TEXT NOT NULL)");
 }
 private checked(authority:ExternalApprovalAuthority){const value=externalAuthoritySchema.parse(authority);
  if(value.instance_id!==this.scope.instance_id||this.auth.authorize(value)!==true)throw Error("external_approval_unauthorized");return value;}
 private binding(a:ExternalApprovalAuthority|ExternalApprovalSource){return "local_"+hash("kind" in a?a:[a.instance_id,a.owner_id,a.device_id,a.grant_revision]);}
 private context(request:Request){const row=this.db.prepare("SELECT authority_json FROM local_external_contexts WHERE request_id=?").get(request.row.request_id) as {authority_json:string}|undefined;
  if(!row)throw Error("external_approval_context_unavailable");const raw=JSON.parse(row.authority_json),a=raw.kind==="slack"?externalSourceSchema.parse(raw):externalAuthoritySchema.parse(raw);
  if(this.binding(a)!==request.row.binding_id||("kind" in a?a.requester_id:a.owner_id)!==this.snapshot(request).request_source.owner_id)throw Error("external_approval_context_unverified");return a;}
 private readable(request:Request,actor:ExternalApprovalAuthority){const source=this.context(request);return source.instance_id===actor.instance_id&&source.owner_id===actor.owner_id&&this.auth.authorize(actor)===true;}
 private permitted(request:Request,actor:ExternalApprovalAuthority){return this.readable(request,actor)&&this.sourceAllowed(this.context(request));}
 private async refresh(request:Request,signal?:AbortSignal):Promise<boolean>{return this.refreshAuthority(this.context(request),signal);}
 private async refreshAuthority(source:ExternalApprovalAuthority|ExternalApprovalSource,signal?:AbortSignal):Promise<boolean>{
  try{return "kind" in source?await this.auth.refreshSource?.(source,signal)===true&&this.sourceAllowed(source):this.sourceAllowed(source);}catch{return false;}
 }
 private sourceAllowed(source:ExternalApprovalAuthority|ExternalApprovalSource){return "kind" in source?this.auth.authorizeSource?.(source)===true:this.auth.authorize(source)===true;}
 private observe(request:Request){const source=this.context(request);return this.slack.observe({workspace_id:this.scope.workspace_id,...this.snapshot(request).target},"kind" in source?source.requester_id:undefined);}
 private approverCurrent(request:Request,state?:VerifiedAuditState){
  const decision=state?this.records.readInState(state,"decision",request.row.request_id):this.records.read("decision",request.row.request_id);if(!decision||decision.row.kind!=="approve")return true;
  const row=this.db.prepare("SELECT authority_json FROM local_external_approvers WHERE authority_hash=?").get(decision.row.actor_id) as {authority_json:string}|undefined;
  if(!row)return false;
  try{const authority=externalAuthoritySchema.parse(JSON.parse(row.authority_json));return decision.row.actor_id==="operator_"+hash(authority)&&this.auth.authorize(authority)===true;}catch{return false;}
 }
 private snapshot(request:Request){return JSON.parse(request.row.snapshot_json) as ApprovalSnapshot;}
 private now(){return advanceClockMark(this.providers.clockMarks.read(),this.providers.clock.observe(),tx(),this.providers.maximumClockDriftMs);}
 private observationValid(o:SlackTargetObservation,mark:Readonly<ClockMark>){const age=Date.parse(mark.effective_utc)-Date.parse(o.observed_at);return Number.isFinite(age)&&age>=0&&age<=15000;}
 private grant(request:Request,observation:SlackTargetObservation,mark:Readonly<ClockMark>,state?:VerifiedAuditState){const source=this.context(request),snapshot=this.snapshot(request);
  if(!this.sourceAllowed(source)||!this.approverCurrent(request,state)||("kind" in source&&(observation.requester_id!==source.requester_id||observation.requester_authorized!==true))||!this.observationValid(observation,mark))return null;
  if(stableStringify(observation.target)!==stableStringify({workspace_id:this.scope.workspace_id,...snapshot.target}))return null;
  return {binding_id:request.row.binding_id,binding_revision:request.row.binding_revision,policy_revision:request.row.policy_revision,semantic_hash:request.row.semantic_hash,
   requester_authorization_revision:snapshot.preconditions.requester_authorization_revision,
   stale_reason:stableStringify(observation.revision)===stableStringify(snapshot.preconditions.ordered_thread_revision)?null:"snapshot_mismatch" as const};
 }
 private requestRecord(id:string){const request=this.records.read("request",id);if(!request||request.row.model_version!=="local_operator_v1")throw Error("external_approval_not_found");return request;}
 async request(authority:ExternalApprovalAuthority,input:ExternalApprovalIntent){return this.create(this.checked(authority),input);}
 async requestFromSource(sourceInput:ExternalApprovalSource,input:Pick<ExternalApprovalIntent,"idempotency_key"|"text">){
  const source=externalSourceSchema.parse(sourceInput);if(!this.sourceAllowed(source)||source.instance_id!==this.scope.instance_id)throw Error("external_approval_unauthorized");
  return this.create(source,{...input,workspace_id:source.workspace_id,channel_id:source.channel_id,thread_ts:source.thread_ts});
 }
 private async create(actor:ExternalApprovalAuthority|ExternalApprovalSource,input:ExternalApprovalIntent){
  const intent=externalIntentSchema.parse(input);if(intent.workspace_id!==this.scope.workspace_id)throw Error("external_approval_scope_mismatch");
  const rich=externalRichText(intent.text),target={workspace_id:intent.workspace_id,channel_id:intent.channel_id,thread_ts:intent.thread_ts},observation=await this.slack.observe(target,"kind" in actor?actor.requester_id:undefined);
  if(!await this.refreshAuthority(actor))throw Error("external_approval_unauthorized");const sourceId="kind" in actor?actor.source_event_id:"loe_"+hash([actor,intent.idempotency_key]),binding=this.binding(actor);
  const broker=new ApprovalCreateBroker(this.db,this.providers,this.scope,(_input,mark)=>{
   if(!this.sourceAllowed(actor)||("kind" in actor&&(observation.requester_authorized!==true||observation.requester_id!==actor.requester_id))||!this.observationValid(observation,mark))return denied;
   return {status:"authorized",binding_id:binding,model_version:"local_operator_v1",snapshot:{codec_version:1,operation_kind:"slack.post_thread_reply.v1",...this.scope,
    request_source:{source_event_id:sourceId,source_job_id:"kind" in actor?actor.source_job_id:null,owner_kind:"kind" in actor&&actor.source_job_id?"durable_job_owner":"authenticated_event_actor",owner_id:"kind" in actor?actor.requester_id:actor.owner_id,operation_slot:intent.idempotency_key},
    target:{channel_id:intent.channel_id,thread_ts:intent.thread_ts},policy_revision:1,
    policy:{reply_broadcast:false,special_mentions:"deny_all",allowed_user_mentions:rich.users,max_user_mentions:3,shared_channel:"deny",reconcile_marker:"block_id_attempt_id_mac_v1"},
    preconditions:{thread_exists:true,channel_is_shared:false,root_message_revision:{edited_ts:observation.revision.items[0]!.edited_ts,content_hmac_sha256:observation.revision.items[0]!.content_hmac_sha256},ordered_thread_revision:observation.revision,workspace_binding_revision:"kind" in actor?1:actor.grant_revision,requester_authorization_revision:"kind" in actor?1:actor.grant_revision}},
    display:{workspace_name:observation.workspace_name,channel_name:observation.channel_name,supervisor_name:"Local operator",mentioned_users:rich.users.map(id=>({id,display_name:id}))}};
  },{content:v=>this.keys.content(v),wrapping:()=>this.keys.wrapping(),notification:()=>this.keys.notification()});
  const result=broker.create(tx(),{source_ref:sourceId,operation_slot:intent.idempotency_key,target:{channel_id:intent.channel_id,thread_ts:intent.thread_ts},text:intent.text});
  if(result.status!=="denied"){
   this.db.prepare("INSERT OR IGNORE INTO local_external_contexts VALUES(?,?)").run(result.request_handle,stableStringify(actor));
   if(this.binding(this.context(this.requestRecord(result.request_handle)))!==binding)throw Error("external_approval_context_unverified");
  }
  return result;
 }
 private text(request:Request,owner:"request"|"attempt"="request",ownerId=request.row.request_id){
  const found=this.payloads.inspect(owner,ownerId);if(!found||found.metadata.state!=="active"||found.secret.status!=="present")throw Error("external_approval_payload_unavailable");
  if(found.metadata.binding.request_id!==request.row.request_id||found.metadata.binding.semantic_hash!==request.row.semantic_hash)throw Error("external_approval_payload_unverified");
  return openApprovalPayload(found.secret.envelope,found.metadata.binding,this.keys.wrappingVersion(found.secret.envelope.key_version),this.keys.content(found.metadata.binding.content.key_version),this.now());
 }
 private card(request:Request){const card=this.records.readAlias({name:"notification_request_kind",request_id:request.row.request_id,notification_kind:"approval_card"});
  if(card?.kind!=="notification")throw Error("external_approval_presentation_unavailable");return card;}
 async present(authority:ExternalApprovalAuthority,requestId:string):Promise<ExternalApprovalPresentation>{
  const actor=this.checked(authority),request=this.requestRecord(requestId);if(!this.permitted(request,actor))throw Error("external_approval_unauthorized");
  const snapshot=this.snapshot(request),observation=await this.observe(request);
  if(!await this.refresh(request)||!this.permitted(request,actor)||this.grant(request,observation,this.now())?.stale_reason!==null)throw Error("external_approval_snapshot_changed");
  const source=this.context(request);
  const exact=this.text(request),card=this.card(request),base={request_id:requestId,operation:"slack.post_thread_reply.v1" as const,workspace_id:this.scope.workspace_id,...snapshot.target,
   workspace_name:observation.workspace_name,channel_name:observation.channel_name,
   requester:{kind:"kind" in source?"slack" as const:"local_operator" as const,label:"kind" in source?source.requester_id:"このMacのoperator"},
   risk:"external_message" as const,operation_summary:"指定されたSlackスレッドに表示中の本文を1回投稿する",
   display_fingerprint:hash(["public-approval-reference-v1",requestId]).slice(0,16).toUpperCase(),created_at:request.row.created_at,exact_draft:exact,notified_user_ids:[...snapshot.policy.allowed_user_mentions],expires_at:request.row.expires_at,request_revision:card.row.request_revision,presentation_revision:card.row.presentation_revision};
  if(Date.parse(base.expires_at)<=Date.parse(this.now().effective_utc))throw Error("external_approval_expired");
  const presentation={...base,presentation_digest:hash(base)},reference="web_"+presentation.presentation_digest;
  // Webへの配送証拠は、同じcanonical表示を再構成できるdurable opaque ref。
  // HTTP応答成功を承認として扱わず、decisionには別のWebAuthn receiptを要求する。
  const notification=new ApprovalNotificationBroker(this.db,this.providers,this.scope,(_cmd,r,n,mark,state)=>{
   const g=this.grant(r,observation,mark,state);return g&&this.permitted(r,actor)?{status:"verified",scope:this.scope,notification_id:n.row.notification_attempt_id,consumer_id:"local_web",...g}:denied;
  },(_cmd,r,n)=>this.permitted(r,actor)?{status:"verified",scope:this.scope,notification_id:n.row.notification_attempt_id,consumer_id:"local_web"}:denied,
  (_cmd,r,n)=>this.permitted(r,actor)?{status:"verified",scope:this.scope,notification_id:n.row.notification_attempt_id,consumer_id:"local_web",delivery_fence:n.row.fence,
   proof_kind:n.row.state==="acceptance_unknown"?"reconcile":"callback",receipt:{outcome:"sent",presentation_ref:reference}}:denied,
  v=>this.keys.content(v),v=>this.keys.wrappingVersion(v),v=>this.keys.notificationVersion(v));
  const command=()=>({notification_handle:card.row.notification_attempt_id,authority_ref:reference,expected_fence:this.card(request).row.fence});
  if(card.row.state==="pending")notification.claim(tx(),command());
  const current=this.card(request);
  if(current.row.state==="dispatching"||current.row.state==="acceptance_unknown")notification.resolve(tx(),command());
  const confirmed=this.card(request);if(confirmed.row.state!=="sent"||confirmed.row.message_ref!==reference||!this.permitted(request,actor))throw Error("external_approval_presentation_unavailable");
  return presentation;
 }
 async decide(authority:ExternalApprovalAuthority,input:ExternalApprovalStepUp){
  const {actor,receipt,observation,card}=await (async()=>{
   try{
  const actor=this.checked(authority),receipt=externalStepUpSchema.parse(input);
  if(stableStringify({instance_id:receipt.instance_id,owner_id:receipt.owner_id,device_id:receipt.device_id,grant_revision:receipt.grant_revision})!==stableStringify(actor))throw Error("external_approval_step_up_invalid");
  const request=this.requestRecord(receipt.request_id);
  const observation=await this.observe(request);
  if(!await this.refresh(request))throw Error("external_approval_unauthorized");
  const card=this.card(request),now=this.now();
  if(receipt.expires_at>request.row.expires_at||Date.parse(receipt.expires_at)>Date.parse(now.effective_utc)+120000||Date.parse(receipt.expires_at)<=Date.parse(now.effective_utc)
   ||card.row.message_ref!=="web_"+receipt.presentation_digest||this.auth.verifyStepUp(receipt)!==true)throw Error("external_approval_step_up_invalid");
  return {actor,receipt,observation,card};
   }catch{throw new ExternalApprovalPrecommitError();}
  })();
  const approverId="operator_"+hash(actor);
  this.db.prepare("INSERT OR IGNORE INTO local_external_approvers VALUES(?,?)").run(approverId,stableStringify(actor));
  if((this.db.prepare("SELECT authority_json FROM local_external_approvers WHERE authority_hash=?").get(approverId) as {authority_json:string}).authority_json!==stableStringify(actor))throw Error("external_approval_approver_unverified");
  const broker=new ApprovalDecisionBroker(this.db,this.providers,this.scope,(_command,r,mark,state)=>{
   const g=this.grant(r,observation,mark,state);return g&&this.permitted(r,actor)&&this.auth.verifyStepUp(receipt)===true&&receipt.expires_at>mark.effective_utc?{status:"verified",scope:this.scope,request_id:r.row.request_id,
    actor_kind:"supervisor",actor_id:approverId,presentation_ref:card.row.message_ref,presentation_revision:card.row.presentation_revision,...g}:denied;
  },v=>this.keys.content(v),v=>this.keys.wrappingVersion(v),v=>this.keys.notificationVersion(v));
  return broker.decide(tx(),{request_handle:receipt.request_id,authority_ref:receipt.receipt_id,action:receipt.decision,expected_revision:card.row.request_revision,presentation_revision:card.row.presentation_revision});
 }
 sourceUnavailable(source:ExternalApprovalSource,requestId:string){
  const r=this.requestRecord(requestId);if(this.binding(source)!==r.row.binding_id||this.binding(this.context(r))!==r.row.binding_id)throw Error("external_approval_scope_mismatch");
  invalidateLocalApprovals(this.db,this.providers,this.scope,source.owner_id,requestId);
  return {state:this.requestRecord(requestId).row.state,execution:this.executionSummary(requestId)};
 }
 /** sourceUnavailableで旧要求をfenceした後の内部照合。live runtime認可には依存せず、
  * 同じ監査snapshot内で保存source・consume・execution・不可逆markerを検証する。
  * active要求や検証不能はunknownであり、後継Attemptの許可証にはならない。 */
 recoveryEvidence(source:ExternalApprovalSource,requestId:string):ExternalApprovalRecoveryEvidence{
  const unknown:ExternalApprovalRecoveryEvidence={effect:"unknown",request_id:requestId,attempt_id:null,receipt_ref:null};
  try{return this.audit.readVerifiedState((state):ExternalApprovalRecoveryEvidence=>{
   const r=this.records.readInState(state,"request",requestId);
   if(!r||r.row.model_version!=="local_operator_v1"||this.binding(externalSourceSchema.parse(source))!==r.row.binding_id||this.binding(this.context(r))!==r.row.binding_id)return unknown;
   const consume=this.records.readInState(state,"consume",requestId),execution=this.records.readAliasInState(state,{name:"execution_request",request_id:requestId});
   if(!execution)return !consume&&["needs_review","rejected","cancelled","expired","delivery_failed","consume_expired","execution_cancelled"].includes(r.row.state)?{...unknown,effect:"not_sent"}:unknown;
   if(execution.kind!=="execution"||!consume||consume.row.consume_id!==execution.row.consume_id||consume.row.attempt_id!==execution.row.attempt_id||execution.row.request_id!==requestId)return unknown;
   const evidence={...unknown,attempt_id:execution.row.attempt_id};
   const marker=this.markers.readInState(state,execution.row.attempt_id);
   if(!marker)return execution.row.state==="needs_review"?{...evidence,effect:"not_sent"}:evidence;
   verifyApprovalExecutionMarker(marker,this.keys.execution(marker.marker.key_version));
   if(execution.row.receipt_ref&&["succeeded","failed"].includes(execution.row.state))return {...evidence,effect:execution.row.state==="succeeded"?"accepted":"not_sent",receipt_ref:execution.row.receipt_ref};
   const receipt=execution.row.state==="needs_review"?this.manualRecoveryReceipt(state,source,requestId,execution.row.attempt_id,execution.row.fence,hash(marker)):null;
   return receipt?{...evidence,effect:"accepted",receipt_ref:receipt}:evidence;
  });}catch{return unknown;}
 }
 /** 既存operator照合のcommitを監査eventから辿る。台帳自体を書換えたり、
  * unknown/rejectedの人間判断を新しい送信許可へ変換したりしない。 */
 private manualRecoveryReceipt(state:VerifiedAuditState,source:ExternalApprovalSource,requestId:string,attemptId:string,fence:number,markerDigest:string):string|null{
  const checkpoint=this.db.prepare("SELECT checkpoint_json FROM security_audit_checkpoint WHERE singleton=1").pluck().get() as string;
  // 過去の矛盾証拠まで検証できないretention後は自動解除しない。
  if(JSON.parse(checkpoint).sequence!==0)return null;
  const rows=this.db.prepare("SELECT record_json FROM security_audit_records WHERE sequence<=? AND json_extract(record_json,'$.event.action')='approval_execution' AND json_extract(record_json,'$.event.session_ref') LIKE 'proof_%' ORDER BY sequence LIMIT 101").all(state.anchor.sequence) as Array<{record_json:string}>;
  if(rows.length>100)return null;
  let accepted:string|null=null;
  for(const row of rows){
   const event=JSON.parse(row.record_json).event;
   const stored=this.db.prepare("SELECT proof_json FROM local_approval_operation_evidence WHERE evidence_id=?").get(event.resource_id) as {proof_json:string}|undefined;
   if(!stored)return null;
   const raw=JSON.parse(stored.proof_json);if(event.session_ref!=="proof_"+hash(raw))return null;
   const proof=recoveryProofSchema.parse(raw);
   if(proof.requestId!==requestId)continue;
   if(event.scope.instance_id!==this.scope.instance_id||event.scope.tenant_id!==this.scope.workspace_id||event.actor.kind!=="operator"||event.actor.id!==source.owner_id||event.operation!=="slack.post_thread_reply.v1"||event.outcome!=="pending"||event.reason!=="none"||
    proof.scope.instance_id!==this.scope.instance_id||proof.scope.workspace_id!==this.scope.workspace_id||proof.owner!==source.owner_id||proof.attemptId!==attemptId||proof.fence!==fence||proof.markerDigest!==markerDigest||Date.parse(event.occurred_at)>proof.expires)return null;
   if(proof.receipt.outcome==="rejected")return null;
   if(proof.receipt.outcome==="accepted"){
    if(accepted!==null&&accepted!==proof.receipt.receipt_ref)return null;
    accepted=proof.receipt.receipt_ref;
   }
  }
  return accepted;
 }
 sourceStatus(source:ExternalApprovalSource,requestId:string){
  if(!this.sourceAllowed(source))throw Error("external_approval_unauthorized");
  const r=this.requestRecord(requestId);if(this.binding(source)!==r.row.binding_id)throw Error("external_approval_scope_mismatch");
  return {request_id:requestId,state:r.row.state,execution:this.executionSummary(requestId)};
 }
 status(authority:ExternalApprovalAuthority,requestId:string){
  const actor=this.checked(authority);
  return this.audit.readVerifiedState(state=>{
   const r=this.records.readInState(state,"request",requestId);
   if(!r||r.row.model_version!=="local_operator_v1"||!this.readable(r,actor))throw Error("external_approval_not_found");
   const d=this.records.readInState(state,"decision",requestId),e=this.records.readAliasInState(state,{name:"execution_request",request_id:requestId});
   this.checked(actor);
   return {request_id:requestId,operation:"slack.post_thread_reply.v1" as const,state:r.row.state,created_at:r.row.created_at,expires_at:r.row.expires_at,
    decision:d?{kind:d.row.kind,decided_at:d.row.decided_at}:null,
    execution:e?.kind==="execution"?{state:e.row.state,receipt_ref:e.row.receipt_ref}:null};
  });
 }
 list(authority:ExternalApprovalAuthority,after:string|null=null){
  const actor=this.checked(authority);
  return this.audit.readVerifiedState(state=>{
   const page=this.records.readListPageInState(state,{record_kind:"request",membership:"all"},after,50);
   const items=page.records.filter((r):r is Request=>r.kind==="request"&&r.row.model_version==="local_operator_v1").filter(r=>this.readable(r,actor))
    .map(r=>({request_id:r.row.request_id,operation:"slack.post_thread_reply.v1" as const,state:r.row.state,created_at:r.row.created_at,expires_at:r.row.expires_at,
     execution:(()=>{const e=this.records.readAliasInState(state,{name:"execution_request",request_id:r.row.request_id});return e?.kind==="execution"?{attempt_id:e.row.attempt_id,state:e.row.state,receipt_ref:e.row.receipt_ref}:null;})()}));
   this.checked(actor);return {items,next:page.next_after};
  });
 }
 private executionSummary(requestId:string){const execution=this.records.readAlias({name:"execution_request",request_id:requestId});
  return execution?.kind==="execution"?{attempt_id:execution.row.attempt_id,state:execution.row.state,receipt_ref:execution.row.receipt_ref}:null;}
 private settleEvent(eventId:string){
  const mutations=new ApprovalRecordMutation(this.db,this.scope),transaction=new ApprovalHistoryTransaction(this.db,this.providers,this.scope);
  transaction.runPrepared(tx(),(mark,state)=>{
   const event=this.records.readInState(state,"event",eventId);if(!event)throw Error("external_approval_event_missing");
   const decision=this.records.readAliasInState(state,{name:"decision_id",decision_id:event.row.decision_id});
   if(decision?.kind!=="decision")throw Error("external_approval_event_missing");
   const request=this.records.readInState(state,"request",decision.row.request_id);if(!request||request.row.model_version!=="local_operator_v1")throw Error("external_approval_event_scope");
   const plan=event.row.state==="delivered"?null:mutations.prepare(mark,state,[{previous:event,next:{...event,row:{...event.row,state:"delivered",delivered_at:mark.effective_utc}}}]);
   return {event:{scope:{instance_id:this.scope.instance_id,tenant_id:this.scope.workspace_id},actor:{kind:"system",id:"local_external_executor"},action:"approval_execution",operation:"slack.post_thread_reply.v1",
    resource_id:request.row.request_id,outcome:"succeeded",reason:"none",session_ref:null,receipt_id:null,attempt_id:null,policy_revision:request.row.policy_revision,binding_revision:request.row.binding_revision,
    authz_revision:this.snapshot(request).preconditions.requester_authorization_revision},...(plan?{resource_commitments:plan.resource_commitments}:{resource_digest:null}),mutation:()=>{plan?.mutation();return null;}};
  });
 }
 private expirePending(deadline:number){
  const page=this.audit.readVerifiedState(state=>this.records.readListPageInState(state,{record_kind:"request",membership:"all"},this.expiryCursor,20));
  const now=this.now();const broker=new ApprovalDecisionBroker(this.db,this.providers,this.scope,()=>denied,v=>this.keys.content(v),v=>this.keys.wrappingVersion(v),v=>this.keys.notificationVersion(v));
  let processed=0;for(const r of page.records){if(performance.now()>=deadline)break;processed++;if(r.kind==="request")this.expiryCursor=r.row.request_id;if(r.kind==="request"&&r.row.model_version==="local_operator_v1"&&(["requested","delivery_pending","delivery_unknown","sent"].includes(r.row.state)&&r.row.expires_at<=now.effective_utc||r.row.state==="approved"&&r.row.consume_expires_at!<=now.effective_utc))broker.expire(tx(),r.row.request_id);}
  if(processed===page.records.length&&!page.has_more)this.expiryCursor=null;
 }
 /** 保存済みdecision eventだけをconsume。開始fence後の復旧はread-only照合に限定する。 */
 async executePending(deadline=performance.now()+5000){
  this.expirePending(Math.min(deadline,performance.now()+1000));
  const pending=this.audit.readVerifiedState(state=>this.records.readListPageInState(state,{record_kind:"event",membership:"all"},this.executionCursor,20));

  const results:Array<{request_id:string;state:string}>=[];
  let processed=0;
  for(const event of pending.records){
   if(performance.now()>=deadline)break;
   processed++;if(event.kind=== "event")this.executionCursor=event.row.event_id;
   if(event.kind!=="event"||event.row.state!=="pending")continue;
   const decision=this.records.readAlias({name:"decision_id",decision_id:event.row.decision_id});if(decision?.kind!=="decision")continue;
   let request:Request;try{request=this.requestRecord(decision.row.request_id);}catch{continue;}
   if(["rejected","cancelled","expired","execution_cancelled","consume_expired","delivery_failed"].includes(request.row.state)){this.settleEvent(event.row.event_id);results.push({request_id:request.row.request_id,state:request.row.state});continue;}
   if(decision.row.kind!=="approve"){this.settleEvent(event.row.event_id);results.push({request_id:request.row.request_id,state:request.row.state});continue;}
   const snapshot=this.snapshot(request),target={workspace_id:this.scope.workspace_id,...snapshot.target};
   let observation:SlackTargetObservation;try{observation=await this.observe(request);}catch{results.push({request_id:request.row.request_id,state:"unavailable"});continue;}
   const prior=this.records.readAlias({name:"execution_request",request_id:request.row.request_id});
   // 未開始writeだけにlive authorityを要求し、開始済みunknownのread-only照合は妨げない。
   if((prior?.kind!=="execution"||prior.row.state==="claimed")&&!await this.refresh(request)){results.push({request_id:request.row.request_id,state:"unavailable"});continue;}
   const consume=new ApprovalConsumeBroker(this.db,this.providers,this.scope,(_command,r,mark,state)=>{
    const g=this.grant(r,observation,mark,state);return g?{status:"verified",scope:this.scope,request_id:r.row.request_id,decision_id:decision.row.decision_id,event_id:event.row.event_id,consumer_id:"local_external_executor",...g}:denied;
   },v=>this.keys.content(v),v=>this.keys.wrappingVersion(v),v=>this.keys.notificationVersion(v));
   const claimed=prior?.kind==="execution"?{status:"reused" as const,attempt_handle:prior.row.attempt_id}:consume.consume(tx(),{request_handle:request.row.request_id,authority_ref:event.row.event_id,expected_revision:request.row.revision});
   if(claimed.status!=="claimed"&&claimed.status!=="reused"){results.push({request_id:request.row.request_id,state:claimed.status});continue;}
   const execution=this.records.read("execution",claimed.attempt_handle);if(!execution)throw Error("external_approval_execution_missing");
   let receipt:ExternalSendResult={outcome:"unknown"},proofKind:"callback"|"reconcile"="callback";
   const broker=new ApprovalExecutionBroker(this.db,this.providers,this.scope,(_command,r,a,mark,state)=>{
    const g=this.grant(r,observation,mark,state);return g?{status:"verified",scope:this.scope,attempt_id:a.row.attempt_id,consumer_id:"local_external_executor",...g}:denied;
   },(_command,_r,a)=>({status:"verified",scope:this.scope,attempt_id:a.row.attempt_id,consumer_id:"local_external_executor"}),
   (_command,_r,a,_marker)=>({status:"verified",scope:this.scope,attempt_id:a.row.attempt_id,consumer_id:"local_external_executor",execution_fence:a.row.fence,proof_kind:proofKind,receipt}),
   v=>this.keys.content(v),v=>this.keys.wrappingVersion(v),v=>this.keys.execution(v));
   const command=()=>({attempt_handle:execution.row.attempt_id,authority_ref:event.row.event_id,expected_fence:this.records.read("execution",execution.row.attempt_id)!.row.fence});
   if(execution.row.state==="claimed"){
    // 復号はstart前。送信権限はstartが新しく成功したこのcallだけにある。
    const text=this.text(request,"attempt",execution.row.attempt_id),started=broker.start(tx(),command());
    if(started.status==="started"){
     const marker=this.markers.read(execution.row.attempt_id);if(!marker)throw Error("external_approval_marker_missing");
     try{receipt=await this.slack.send(target,text,marker,observation,async(signal)=>{
      if(!await this.refresh(this.requestRecord(request.row.request_id),signal))throw Error("external_approval_authority_changed");
      return ()=>{const mark=this.now(),current=this.requestRecord(request.row.request_id),g=this.grant(current,observation,mark);
      if(!g||g.stale_reason!==null||Date.parse(mark.effective_utc)>=Date.parse(execution.row.execution_expires_at))throw Error("external_approval_authority_changed");};
     });}catch{receipt={outcome:"unknown"};}
     broker.resolve(tx(),command());
    }
   }else if(execution.row.state==="executing"||execution.row.state==="acceptance_unknown"){
    if(execution.row.state==="executing")broker.recover(tx(),command());
    if(this.records.read("execution",execution.row.attempt_id)?.row.state==="acceptance_unknown"){
     const marker=this.markers.read(execution.row.attempt_id);if(marker){proofKind="reconcile";receipt=await this.slack.reconcile(target,marker);broker.resolve(tx(),command());}
    }
   }
   const final=this.records.read("execution",execution.row.attempt_id)!;
   if(["succeeded","failed","needs_review"].includes(final.row.state))this.settleEvent(event.row.event_id);
   results.push({request_id:request.row.request_id,state:final.row.state});
  }
  if(processed===pending.records.length&&!pending.has_more)this.executionCursor=null;
  return {items:results,truncated:pending.has_more||processed<pending.records.length};
 }

}
