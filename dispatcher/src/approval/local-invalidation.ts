import {randomUUID} from "node:crypto";
import type Database from "better-sqlite3";
import type {ApprovalTransactionProviders} from "./transaction.js";
import {ApprovalHistoryTransaction} from "./history-transaction.js";
import {AuditRepository} from "../audit/repository.js";
import {ApprovalRecordRepository} from "./record-repository.js";
import {ApprovalRecordMutation} from "./record-mutation.js";
import type {ApprovalRecordSqlChange} from "./record-sql.js";
import type {ApprovalRecordScope} from "./record-codec.js";
import {ApprovalPayloadRepository} from "./payload-repository.js";
import {ApprovalPayloadMutation} from "./payload-mutation.js";
import type {ApprovalPayloadChange} from "./payload-sql.js";
/** protected maintenance phase中だけのoperator用内部処理。新しい実行許可を作らず、
 * 既存creation/expiry/decision/used-IDを保持してpayloadと未完了権限を無効化する。 */
export function invalidateLocalApprovals(db:Database.Database,providers:ApprovalTransactionProviders,scope:ApprovalRecordScope,owner:string):void{
 const audit=new AuditRepository(db,providers.auditAnchors,providers.auditKeys),records=new ApprovalRecordRepository(db,providers.auditAnchors,providers.auditKeys,scope),mutations=new ApprovalRecordMutation(db,scope),payloads=new ApprovalPayloadRepository(db,providers.auditAnchors,providers.auditKeys,scope),payloadMutation=new ApprovalPayloadMutation(db,scope),transaction=new ApprovalHistoryTransaction(db,providers,scope);
 let after:string|null=null;
 for(;;){const page=audit.readVerifiedState(state=>records.readListPageInState(state,{record_kind:"request",membership:"all"},after,20));
  for(const request of page.records){if(request.kind!=="request")throw Error("local_approval_invalidation_unverified");
   // executing→acceptance_unknown→needs_reviewはそれぞれ監査し再送しない。
   for(let pass=0;pass<2;pass++)transaction.runPrepared("invalidate_"+randomUUID().replaceAll("-",""),(mark,state)=>{
    const r=records.readInState(state,"request",request.row.request_id)!;const changes:ApprovalRecordSqlChange[]=[],removals:ApprovalPayloadChange[]=[];
    if(["requested","delivery_pending","delivery_unknown","sent","approved"].includes(r.row.state))changes.push({previous:r,next:{...r,row:{...r.row,state:"needs_review",revision:r.row.revision+1}}});
    const e=records.readAliasInState(state,{name:"execution_request",request_id:r.row.request_id});let unknown=false;
    if(e?.kind==="execution"&&["claimed","executing","acceptance_unknown"].includes(e.row.state)){
     unknown=e.row.state==="executing";changes.push({previous:e,next:{...e,row:{...e.row,state:unknown?"acceptance_unknown":"needs_review",failure_code:"clock_anomaly"}}});
    }
    for(const kind of ["approval_card","pending_notice"] as const){const n=records.readAliasInState(state,{name:"notification_request_kind",request_id:r.row.request_id,notification_kind:kind});
     if(n?.kind==="notification"&&["pending","dispatching","acceptance_unknown"].includes(n.row.state))changes.push({previous:n,next:{...n,row:{...n.row,state:"needs_review"}}});
    }
    const d=records.readInState(state,"decision",r.row.request_id),event=d?records.readAliasInState(state,{name:"event_decision",decision_id:d.row.decision_id}):null;
    if(event?.kind==="event"&&event.row.state==="pending")changes.push({previous:event,next:{...event,row:{...event.row,state:"delivered",delivered_at:mark.effective_utc}}});
    for(const [kind,id] of [["request",r.row.request_id],...(e?.kind==="execution"?[["attempt",e.row.attempt_id]]:[])] as Array<["request"|"attempt",string]>){const p=payloads.inspectInState(state,kind,id);if(p?.metadata.state==="active")removals.push({previous:p.metadata,next:{...p.metadata,state:"deleted",deleted_at:mark.effective_utc},envelope:null});}
    const recordPlan=changes.length?mutations.prepare(mark,state,changes):null,payloadPlan=removals.length?payloadMutation.prepare(mark,state,removals):null;
    const resources=[...(recordPlan?.resource_commitments??[]),...(payloadPlan?.resource_commitments??[])].sort((a,b)=>a.resource_id.localeCompare(b.resource_id));
    return {event:{scope:{instance_id:scope.instance_id,tenant_id:scope.workspace_id},actor:{kind:"operator",id:owner},action:"approval_execution",operation:"slack.post_thread_reply.v1",resource_id:r.row.request_id,outcome:unknown?"acceptance_unknown":"needs_review",reason:"clock_anomaly",session_ref:null,receipt_id:null,attempt_id:e?.kind==="execution"?e.row.attempt_id:null,policy_revision:r.row.policy_revision,binding_revision:r.row.binding_revision,authz_revision:1},...(resources.length?{resource_commitments:resources}:{resource_digest:null}),mutation:()=>{recordPlan?.mutation();payloadPlan?.mutation();return null;}};
   });
  }
  if(!page.has_more)break;after=page.next_after;
 }
}
