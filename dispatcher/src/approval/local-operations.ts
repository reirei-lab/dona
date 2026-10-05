import {createHash,randomUUID} from "node:crypto";
import type Database from "better-sqlite3";
import {z} from "zod";
import type {VerifiedAuditState} from "../audit/codec.js";
import type {ClockMark} from "./clock.js";
import {AuditRepository} from "../audit/repository.js";
import {stableStringify} from "../validation.js";
import {advanceClockMark} from "./clock.js";
import type {ApprovalTransactionProviders} from "./transaction.js";
import type {ApprovalRecordScope} from "./record-codec.js";
import {ApprovalRecordRepository} from "./record-repository.js";
import {ApprovalPayloadRepository} from "./payload-repository.js";
import {ApprovalPayloadMutation} from "./payload-mutation.js";
import {ApprovalHistoryTransaction} from "./history-transaction.js";
import {ApprovalDecisionBroker} from "./decision-broker.js";
import {ApprovalExecutionBroker} from "./execution-broker.js";
import {ApprovalExecutionMarkerStore} from "./execution-marker-store.js";
import {invalidateLocalApprovals} from "./local-invalidation.js";
import type {ExternalApprovalKeys} from "./local-external-service.js";
import type {ExternalSlackPort,ExternalSendResult} from "./local-external-types.js";
const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest=(value:unknown)=>createHash("sha256").update(stableStringify(value)).digest("hex");
const tx=()=>"ops_"+randomUUID().replaceAll("-","");
const denied={status:"denied" as const,reason:"unauthorized" as const};
const evidenceDDL="CREATE TABLE local_approval_operation_evidence(evidence_id TEXT PRIMARY KEY,proof_json TEXT NOT NULL)";
export function verifyLocalOperationsSchema(db:Database.Database){if(db.prepare("SELECT sql FROM sqlite_master WHERE name='local_approval_operation_evidence'").pluck().get()!==evidenceDDL)throw Error("local_operations_schema_unverified");}
/** 初回native provisionの明示経路だけから呼ぶ。read/doctor/CLI通常起動では作成しない。 */
export function installLocalOperationsSchema(db:Database.Database){if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='local_approval_operation_evidence'").get())db.exec(evidenceDDL);verifyLocalOperationsSchema(db);}
export interface LocalOperationsOperator {owner_id:string;/** OS本人性と現在owner/configを同期再読する。 */authorize():boolean}
/** PR #362の有界観測・本文だけのretentionをpersonal providerへ適応。
 * 旧二者binding/schema/policyをbootstrapせず、既存監査とone-shot stateを維持する。 */
export class LocalApprovalOperations {
 private readonly audit:AuditRepository;private readonly records:ApprovalRecordRepository;private readonly payloads:ApprovalPayloadRepository;private readonly markers:ApprovalExecutionMarkerStore;
 private requestCursor:string|null=null;private attemptCursor:string|null=null;private executionFirst=false;
 private previews=new Map<string,{requestId:string;attemptId:string;fence:number;receipt:ExternalSendResult;reasonDigest:string;markerDigest:string;expires:number}>();
 constructor(private readonly db:Database.Database,private readonly providers:ApprovalTransactionProviders,private readonly scope:ApprovalRecordScope,private readonly keys:ExternalApprovalKeys,private readonly operator:LocalOperationsOperator,private readonly slack:Pick<ExternalSlackPort,"reconcile">){
  id.parse(operator.owner_id);this.audit=new AuditRepository(db,providers.auditAnchors,providers.auditKeys);this.records=new ApprovalRecordRepository(db,providers.auditAnchors,providers.auditKeys,scope);this.payloads=new ApprovalPayloadRepository(db,providers.auditAnchors,providers.auditKeys,scope);this.markers=new ApprovalExecutionMarkerStore(db,providers,scope);
  verifyLocalOperationsSchema(db);
 }
 private checked(){if(this.operator.authorize()!==true)throw Error("local_operations_unauthorized");}
 private now(){return advanceClockMark(this.providers.clockMarks.read(),this.providers.clock.observe(),tx(),this.providers.maximumClockDriftMs);}
 list(after:string|null=null,limit=50){this.checked();if(after!==null)id.parse(after);z.number().int().min(1).max(100).parse(limit);
  return this.audit.readVerifiedState(state=>{this.checked();const page=this.records.readListPageInState(state,{record_kind:"request",membership:"all"},after,limit);
   return {items:page.records.flatMap(r=>r.kind==="request"&&r.row.model_version==="local_operator_v1"?[{request_id:r.row.request_id,state:r.row.state,revision:r.row.revision,expires_at:r.row.expires_at}]:[]),next:page.next_after,truncated:page.has_more};});
 }
 health(){this.checked();try{const mark=this.now();return this.audit.readVerifiedState(state=>{this.checked();let truncated=false;
  const counts={expiry_lag:0,stale_claim:0,unknown_attempt:0,unknown_delivery:0,needs_review:0,retention_overdue:0};
  for(const kind of ["request","execution"] as const){const page=this.records.readListPageInState(state,{record_kind:kind,membership:"all"},null,100);truncated||=page.has_more;
   for(const r of page.records){if(r.kind==="request"){if(r.row.model_version!=="local_operator_v1")continue;if(["requested","delivery_pending","delivery_unknown","sent","approved"].includes(r.row.state)&&(r.row.consume_expires_at??r.row.expires_at)<=mark.effective_utc)counts.expiry_lag++;if(r.row.state==="needs_review")counts.needs_review++;}
    else if(r.kind==="execution"){if(r.row.state==="claimed"&&r.row.execution_expires_at<=mark.effective_utc)counts.stale_claim++;if(["executing","acceptance_unknown"].includes(r.row.state))counts.unknown_attempt++;if(r.row.state==="needs_review")counts.needs_review++;}
    if(r.kind!=="request"&&r.kind!=="execution")throw Error("local_operations_unverified");const p=this.payloads.inspectInState(state,r.kind==="request"?"request":"attempt",r.kind==="request"?r.row.request_id:r.row.attempt_id);if(p?.metadata.state==="active"&&p.metadata.binding.expires_at<=mark.effective_utc)counts.retention_overdue++;
   }
  }
  for(const kind of ["notification","presentation"] as const){const page=this.records.readListPageInState(state,{record_kind:kind,membership:"all"},null,100);truncated||=page.has_more;for(const r of page.records){if(r.kind!=="notification"&&r.kind!=="presentation")throw Error("local_operations_unverified");if(["dispatching","acceptance_unknown"].includes(r.row.state))counts.unknown_delivery++;if(r.row.state==="needs_review")counts.needs_review++;}}
  return {live:true,safe_ready:false,verified:true,truncated,counts:truncated?null:counts,degraded:truncated?["observation_bound"]:["runtime_readiness_separate"]};});
 }catch{return {live:true,safe_ready:false,verified:false,truncated:false,counts:null,degraded:["protected_state_unverified"]};}}
 /** 常駐lane専用。Slack不通でも期限処理を止めず本文を保持期限から延長しない。 */
 sweep(deadline=performance.now()+1000){this.checked();const mark=this.now();let changed=0;
  let truncated=false;const requests=()=>{
  const requests=this.audit.readVerifiedState(state=>this.records.readListPageInState(state,{record_kind:"request",membership:"all"},this.requestCursor,20));
  const broker=new ApprovalDecisionBroker(this.db,this.providers,this.scope,()=>denied,v=>this.keys.content(v),v=>this.keys.wrappingVersion(v),v=>this.keys.notificationVersion(v));
  let processed=0;for(const r of requests.records){if(performance.now()>=deadline)break;processed++;if(r.kind!=="request")throw Error("local_operations_unverified");this.requestCursor=r.row.request_id;this.checked();
   if(r.row.model_version==="local_operator_v1"&&(["requested","delivery_pending","delivery_unknown","sent"].includes(r.row.state)&&r.row.expires_at<=mark.effective_utc||r.row.state==="approved"&&r.row.consume_expires_at!<=mark.effective_utc)){broker.expire(tx(),r.row.request_id);changed++;}
   else if(r.row.model_version==="local_operator_v1"&&["rejected","cancelled","expired","delivery_failed","execution_cancelled","consume_expired"].includes(r.row.state)){const retention=this.previewRetention("request",r.row.request_id);if(retention.eligible){this.retain("request",r.row.request_id,retention.confirmation);changed++;}}}
  if(processed===requests.records.length&&!requests.has_more)this.requestCursor=null;
truncated||=requests.has_more||processed<requests.records.length;};
  const attempts=()=>{
  const attempts=this.audit.readVerifiedState(state=>this.records.readListPageInState(state,{record_kind:"execution",membership:"all"},this.attemptCursor,20));let processed=0;
  for(const a of attempts.records){if(performance.now()>=deadline)break;processed++;if(a.kind!=="execution")throw Error("local_operations_unverified");this.attemptCursor=a.row.attempt_id;this.checked();const r=this.records.read("request",a.row.request_id);
   if(r?.row.model_version==="local_operator_v1"&&(["claimed","executing","acceptance_unknown"].includes(a.row.state))&&(a.row.payload_expires_at<=mark.effective_utc||a.row.state==="claimed"&&a.row.execution_expires_at<=mark.effective_utc)){invalidateLocalApprovals(this.db,this.providers,this.scope,this.operator.owner_id,r.row.request_id);changed++;}
   else if(r?.row.model_version==="local_operator_v1"&&["succeeded","failed"].includes(a.row.state)){const retention=this.previewRetention("attempt",a.row.attempt_id);if(retention.eligible){this.retain("attempt",a.row.attempt_id,retention.confirmation);changed++;}}}
  if(processed===attempts.records.length&&!attempts.has_more)this.attemptCursor=null;
truncated||=attempts.has_more||processed<attempts.records.length;};
  const phases=this.executionFirst?[attempts,requests]:[requests,attempts];this.executionFirst=!this.executionFirst;for(const phase of phases){if(performance.now()>=deadline){truncated=true;break;}phase();}
  return {changed,truncated};
 }
 private retentionInState(state:VerifiedAuditState,mark:Readonly<ClockMark>,kind:"request"|"attempt",handle:string){
  this.checked();const r=this.records.readInState(state,kind==="request"?"request":"execution",handle);if(!r)throw Error("local_operations_not_found");const request=r.kind==="request"?r:this.records.readInState(state,"request",r.row.request_id)!;if(request.row.model_version!=="local_operator_v1")throw Error("local_operations_scope");
  const p=this.payloads.inspectInState(state,kind,handle),e=r.kind==="execution"?r:this.records.readAliasInState(state,{name:"execution_request",request_id:request.row.request_id});
  let protectedState=["requested","delivery_pending","delivery_unknown","sent","approved","needs_review"].includes(request.row.state)||(e?.kind==="execution"&&!["succeeded","failed"].includes(e.row.state));
  for(const notification_kind of ["approval_card","pending_notice"] as const){const n=this.records.readAliasInState(state,{name:"notification_request_kind",request_id:request.row.request_id,notification_kind});protectedState||=n?.kind==="notification"&&["dispatching","acceptance_unknown","needs_review"].includes(n.row.state);}
  const eligible=!protectedState&&p?.metadata.state==="active"&&p.metadata.binding.expires_at<=mark.effective_utc;
  return {owner_kind:kind,owner_handle:handle,eligible,confirmation:digest([this.scope,this.operator.owner_id,kind,handle,r,p?.metadata,eligible])};}
 previewRetention(kind:"request"|"attempt",handle:string){this.checked();id.parse(handle);const mark=this.now();return this.audit.readVerifiedState(state=>this.retentionInState(state,mark,kind,handle));}

 retain(kind:"request"|"attempt",handle:string,confirmation:string){const before=this.previewRetention(kind,handle);if(before.confirmation!==confirmation||!before.eligible)throw Error("local_operations_confirmation_stale");
  const mutations=new ApprovalPayloadMutation(this.db,this.scope);return new ApprovalHistoryTransaction(this.db,this.providers,this.scope).runPrepared(tx(),(mark,state)=>{this.checked();const fresh=this.retentionInState(state,mark,kind,handle);if(!fresh.eligible||fresh.confirmation!==confirmation)throw Error("local_operations_confirmation_stale");const p=this.payloads.inspectInState(state,kind,handle);if(!p||p.metadata.state!=="active"||p.metadata.binding.expires_at>mark.effective_utc)throw Error("local_operations_confirmation_stale");
   // writer lock中のsame stateで全eligibilityとmetadata digestを再確認する。
   const plan=mutations.prepare(mark,state,[{previous:p.metadata,next:{...p.metadata,state:"deleted",deleted_at:mark.effective_utc},envelope:null}]);
   return {event:this.event(handle,"retention","audit.retain.v1","succeeded",null),resource_commitments:plan.resource_commitments,mutation:()=>{plan.mutation();return {status:"deleted"};}};});
 }
 private event(resource:string,action:"retention"|"approval_execution",operation:"audit.retain.v1"|"slack.post_thread_reply.v1",outcome:"succeeded"|"pending",ref:string|null){return {scope:{instance_id:this.scope.instance_id,tenant_id:this.scope.workspace_id},actor:{kind:"operator" as const,id:this.operator.owner_id},action,operation,resource_id:resource,outcome,reason:"none" as const,session_ref:ref,receipt_id:null,attempt_id:null,policy_revision:1,binding_revision:1,authz_revision:1};}
 async previewReconcile(requestId:string,reason:string){this.checked();id.parse(requestId);if(reason.trim().length<8||reason.length>512)throw Error("local_operations_reason_required");
  const r=this.records.read("request",requestId),a=this.records.readAlias({name:"execution_request",request_id:requestId});if(r?.row.model_version!=="local_operator_v1"||a?.kind!=="execution"||!["executing","acceptance_unknown","needs_review"].includes(a.row.state))throw Error("local_operations_reconcile_state");
  const marker=this.markers.read(a.row.attempt_id);if(!marker)throw Error("local_operations_evidence_missing");
  const snapshot=JSON.parse(r.row.snapshot_json),receipt=await this.slack.reconcile({workspace_id:this.scope.workspace_id,...snapshot.target},marker);this.checked();
  const proof={requestId,attemptId:a.row.attempt_id,fence:a.row.fence,receipt,reasonDigest:digest(reason),markerDigest:digest(marker),expires:Date.now()+120000};const confirmation=digest([this.scope,this.operator.owner_id,proof]);
  this.previews.clear();this.previews.set(confirmation,proof);return {request_id:requestId,attempt_id:a.row.attempt_id,outcome:receipt.outcome,confirmation};
 }
 applyReconcile(confirmation:string){this.checked();const proof=this.previews.get(confirmation);this.previews.delete(confirmation);if(!proof||proof.expires<=Date.now())throw Error("local_operations_confirmation_stale");
  const evidenceId="evidence_"+randomUUID().replaceAll("-",""),wire=stableStringify({scope:this.scope,owner:this.operator.owner_id,...proof});
  new ApprovalHistoryTransaction(this.db,this.providers,this.scope).runPrepared(tx(),(_mark,state)=>{this.checked();const a=this.records.readInState(state,"execution",proof.attemptId),marker=this.markers.readInState(state,proof.attemptId);if(!a||a.row.fence!==proof.fence||digest(marker)!==proof.markerDigest)throw Error("local_operations_confirmation_stale");
   return {event:this.event(evidenceId,"approval_execution","slack.post_thread_reply.v1","pending","proof_"+digest(JSON.parse(wire))),resource_digest:null,mutation:()=>{this.db.prepare("INSERT INTO local_approval_operation_evidence VALUES(?,?)").run(evidenceId,wire);return null;}};});
  const authorize=()=>{this.checked();const persisted=this.db.prepare("SELECT proof_json FROM local_approval_operation_evidence WHERE evidence_id=?").get(evidenceId) as {proof_json:string}|undefined;if(persisted?.proof_json!==wire||!this.db.prepare("SELECT 1 FROM security_audit_records WHERE json_extract(record_json,'$.event.resource_id')=? AND json_extract(record_json,'$.event.session_ref')=?").get(evidenceId,"proof_"+digest(JSON.parse(wire))))throw Error("local_operations_evidence_unverified");if(proof.expires<=Date.now())throw Error("local_operations_confirmation_stale");return {status:"verified" as const,scope:this.scope,attempt_id:proof.attemptId,consumer_id:this.operator.owner_id};};
  const broker=new ApprovalExecutionBroker(this.db,this.providers,this.scope,()=>denied,()=>authorize(),(_c,_r,a)=>({...authorize(),execution_fence:a.row.fence,proof_kind:"reconcile",receipt:proof.receipt}),v=>this.keys.content(v),v=>this.keys.wrappingVersion(v),v=>this.keys.execution(v));
  let a=this.records.read("execution",proof.attemptId)!;const command=()=>({attempt_handle:proof.attemptId,authority_ref:evidenceId,expected_fence:a.row.fence});
  if(a.row.state==="executing"){broker.recover(tx(),command());a=this.records.read("execution",proof.attemptId)!;}
  if(a.row.state==="acceptance_unknown")broker.resolve(tx(),command());
  return {status:"evidence_recorded",evidence_ref:evidenceId,state:this.records.read("execution",proof.attemptId)!.row.state,outcome:proof.receipt.outcome};
 }
}
