import assert from "node:assert/strict";
import {test} from "node:test";
import {fixture,scope,content,wrapping,notification,start} from "./approval/fixtures/broker.js";
import {executionKey} from "./approval/fixtures/execution.js";
import {installApprovalExecutionMarkerSchema} from "../src/approval/schema.js";
import {emptyMetadataRoot} from "../src/approval/metadata-tree.js";
import {LocalExternalApprovalService} from "../src/approval/local-external-service.js";
import type {ExternalSlackPort,ExternalSendResult} from "../src/approval/local-external-types.js";
const actor={instance_id:scope.instance_id,owner_id:"local_owner",device_id:"device",grant_revision:1};
const intent={idempotency_key:"one",workspace_id:scope.workspace_id,channel_id:"C123",thread_ts:"1791080198.497089",text:"確認済みの本文"};
function setup(t:{after(fn:()=>void):void}){
 const f=fixture(t);installApprovalExecutionMarkerSchema(f.db);
 f.transaction.runPrepared("local_marker_admission",()=>({event:{scope:{instance_id:scope.instance_id,tenant_id:scope.workspace_id},actor:{kind:"system",id:"fixture"},action:"approval_execution",operation:"slack.post_thread_reply.v1",resource_id:"fixture_root",outcome:"succeeded",reason:"none",session_ref:null,receipt_id:null,attempt_id:null,policy_revision:1,binding_revision:1,authz_revision:1},resource_commitments:[{scope:{instance_id:scope.instance_id,tenant_id:scope.workspace_id},resource_id:"approval_execution_markers",resource_digest:emptyMetadataRoot({...scope,collection:"approval_execution_markers_v1"})}],mutation:()=>null}));
 const revoked=new Set<string>();let sourceAuthorizer:((source:any)=>boolean)|undefined;let beforeAction=()=>{};
 let allowed=true,verified=true,changed=false,sends=0,reconciles=0,sendResult:ExternalSendResult={outcome:"accepted",receipt_ref:"slack_receipt"};
 const slack:ExternalSlackPort={observe:async (target,requesterId)=>({target,...(requesterId?{requester_id:requesterId,requester_authorized:true}:{}),observed_at:start,bot_user_id:"U123",bot_id:"B123",workspace_name:"Workspace",channel_name:"Channel",revision:{complete:true,items:[{message_ts:target.thread_ts,edited_ts:null,content_hmac_sha256:(changed?"b":"a").repeat(64)}]}}),
 send:async(_target,_text,_marker,_observation,before)=>{beforeAction();const assertCurrent=await before();assertCurrent?.();sends++;return sendResult;},reconcile:async()=>{reconciles++;return {outcome:"accepted",receipt_ref:"slack_receipt"};}};
 const keys={content:()=>content,wrapping:()=>wrapping,notification:()=>notification,wrappingVersion:()=>wrapping,notificationVersion:()=>notification,execution:()=>executionKey};
 const auth={authorize:(a:any)=>allowed&&!revoked.has(a.device_id),authorizeSource:(source:any)=>sourceAuthorizer?.(source)===true,refreshSource:async(source:any)=>sourceAuthorizer?.(source)===true,verifyStepUp:()=>verified};
 const make=()=>new LocalExternalApprovalService(f.db,f.providers,scope,keys,auth,slack);
 return {...f,service:make(),make,revoke:(device:string)=>revoked.add(device),beforeSend:(action:()=>void)=>{beforeAction=action;},setSourceAuthorizer:(fn:(source:any)=>boolean)=>{sourceAuthorizer=fn;},setAllowed:(v:boolean)=>{allowed=v;},setVerified:(v:boolean)=>{verified=v;},setChanged:()=>{changed=true;},setSend:(v:ExternalSendResult)=>{sendResult=v;},counts:()=>({sends,reconciles})};
}

const source={kind:"slack" as const,instance_id:scope.instance_id,owner_id:"local_owner",requester_id:"U123",source_event_id:"evt_source",source_job_id:"job_source",runtime_request_id:"call_source",agent:"worker",generation:"generation",thread_id:"thread",turn_id:"turn",workspace_id:scope.workspace_id,channel_id:"C123",thread_ts:"1791080198.497089"};
async function requested(f:ReturnType<typeof setup>){
 f.setSourceAuthorizer(()=>true);const r=await f.service.requestFromSource(source,{idempotency_key:"one",text:intent.text});
 if(r.status==="denied")throw Error("unexpected_denial");return r.request_handle;
}
async function approve(f:ReturnType<typeof setup>,id:string){
 const view=await f.service.present(actor,id);
 await f.service.decide(actor,{...actor,receipt_id:"receipt",request_id:id,decision:"approve",presentation_digest:view.presentation_digest,expires_at:"2026-09-19T00:01:00.000Z"});
}
test("未送信の判定は旧要求を無効化した後だけで再起動しても復元できる",async t=>{
 const f=setup(t),id=await requested(f);assert.equal(f.service.recoveryEvidence(source,id).effect,"unknown");
 await approve(f,id);assert.equal(f.service.recoveryEvidence(source,id).effect,"unknown");
 f.service.sourceUnavailable(source,id);f.setSourceAuthorizer(()=>false);
 const before=(f.db.prepare("SELECT total_changes() n").get() as {n:number}).n;
 assert.deepEqual(f.make().recoveryEvidence(source,id),{effect:"not_sent",request_id:id,attempt_id:null,receipt_ref:null});
 assert.equal((f.db.prepare("SELECT total_changes() n").get() as {n:number}).n,before);
 await f.service.executePending();assert.equal(f.counts().sends,0);
});
test("送信済み応答喪失は無効化を繰り返してもunknownを維持する",async t=>{
 const f=setup(t),id=await requested(f);await approve(f,id);f.setSend({outcome:"unknown"});
 await f.service.executePending();f.service.sourceUnavailable(source,id);f.service.sourceUnavailable(source,id);
 assert.equal(f.service.recoveryEvidence(source,id).effect,"unknown");assert.equal(f.counts().sends,1);
});
test("監査済み受理・拒否のreceiptを区別する",async t=>{
 for(const outcome of ["accepted","rejected"] as const){
  const f=setup(t),id=await requested(f);await approve(f,id);
  f.setSend(outcome==="accepted"?{outcome,receipt_ref:"receipt"}:{outcome,receipt_ref:"receipt",reason:"invalid_input"});
  await f.service.executePending();f.service.sourceUnavailable(source,id);
  const e=f.service.recoveryEvidence(source,id);assert.equal(e.effect,outcome==="accepted"?"accepted":"not_sent");assert.equal(e.receipt_ref,"receipt");assert.ok(e.attempt_id);
 }
});
test("source差替え・未存在・保存context改竄は回復許可にならない",async t=>{
 const f=setup(t),id=await requested(f);f.service.sourceUnavailable(source,id);
 assert.equal(f.service.recoveryEvidence({...source,turn_id:"another"},id).effect,"unknown");
 assert.equal(f.service.recoveryEvidence(source,"absent").effect,"unknown");
 f.db.prepare("UPDATE local_external_contexts SET authority_json=? WHERE request_id=?").run(JSON.stringify({...source,owner_id:"other"}),id);
 assert.equal(f.service.recoveryEvidence(source,id).effect,"unknown");
});
test("send fence後・provider呼出し直前のsource消失でもmarkerを未送信扱いしない",async t=>{
 const f=setup(t),id=await requested(f);await approve(f,id);
 f.beforeSend(()=>{f.service.sourceUnavailable(source,id);assert.equal(f.service.recoveryEvidence(source,id).effect,"unknown");});
 await f.service.executePending();assert.equal(f.counts().sends,1);assert.equal(f.service.recoveryEvidence(source,id).effect,"unknown");
});
test("consume後でmarker未作成の旧claimは無効化後だけ安全に回復する",async t=>{
 const f=setup(t),id=await requested(f);await approve(f,id);
 f.setSourceAuthorizer(()=>!f.db.prepare("SELECT 1 FROM approval_execution_attempts WHERE request_id=?").get(id));
 await f.service.executePending();assert.equal(f.counts().sends,0);
 f.service.sourceUnavailable(source,id);
 const evidence=f.service.recoveryEvidence(source,id);assert.equal(evidence.effect,"not_sent");assert.ok(evidence.attempt_id);
 await f.service.executePending();assert.equal(f.counts().sends,0);
});
async function manual(t:{after(fn:()=>void):void}){
 const f=setup(t),id=await requested(f);await approve(f,id);f.setSend({outcome:"unknown"});await f.service.executePending();f.service.sourceUnavailable(source,id);
 const {LocalApprovalOperations,installLocalOperationsSchema}=await import("../src/approval/local-operations.js");installLocalOperationsSchema(f.db);
 let receipt:ExternalSendResult={outcome:"accepted",receipt_ref:"slack_exact"};
 const keys={content:()=>content,wrapping:()=>wrapping,notification:()=>notification,wrappingVersion:()=>wrapping,notificationVersion:()=>notification,execution:()=>executionKey};
 const ops=new LocalApprovalOperations(f.db,f.providers,scope,keys,{owner_id:source.owner_id,authorize:()=>true},{reconcile:async()=>receipt});
 const apply=async()=>{const p=await ops.previewReconcile(id,"固定markerに一致する実provider照合結果");return ops.applyReconcile(p.confirmation);};
 return {...f,id,ops,apply,setReceipt:(v:ExternalSendResult)=>{receipt=v;}};
}
test("needs_reviewはoperatorがexact受理を照合・監査commitした時だけacceptedとなる",async t=>{
 const f=await manual(t);
 const preview=await f.ops.previewReconcile(f.id,"固定markerの受理をproviderで確認しました");
 assert.equal(f.service.recoveryEvidence(source,f.id).effect,"unknown");
 assert.equal(f.ops.applyReconcile(preview.confirmation).state,"needs_review");
 const evidence=f.make().recoveryEvidence(source,f.id);assert.equal(evidence.effect,"accepted");assert.equal(evidence.receipt_ref,"slack_exact");
 assert.equal(f.counts().sends,1);assert.equal(f.service.sourceUnavailable(source,f.id).execution?.state,"needs_review");
 assert.equal(f.make().recoveryEvidence(source,f.id).effect,"accepted");
});
test("raw proof差替え・削除は監査eventと一致せずunknownへ戻る",async t=>{
 const f=await manual(t);await f.apply();const row=f.db.prepare("SELECT evidence_id,proof_json FROM local_approval_operation_evidence").get() as {evidence_id:string;proof_json:string};
 const proof=JSON.parse(row.proof_json);proof.receipt.receipt_ref="forged";
 f.db.prepare("UPDATE local_approval_operation_evidence SET proof_json=? WHERE evidence_id=?").run(JSON.stringify(proof),row.evidence_id);
 assert.equal(f.service.recoveryEvidence(source,f.id).effect,"unknown");
 f.db.prepare("DELETE FROM local_approval_operation_evidence WHERE evidence_id=?").run(row.evidence_id);
 assert.equal(f.service.recoveryEvidence(source,f.id).effect,"unknown");
});
test("unknown照合は解除せず後続の確定受理は採用し矛盾receiptは拒否する",async t=>{
 const f=await manual(t);f.setReceipt({outcome:"unknown"});await f.apply();assert.equal(f.service.recoveryEvidence(source,f.id).effect,"unknown");
 f.setReceipt({outcome:"accepted",receipt_ref:"slack_exact"});await f.apply();assert.equal(f.service.recoveryEvidence(source,f.id).effect,"accepted");
 f.setReceipt({outcome:"accepted",receipt_ref:"different"});await f.apply();assert.equal(f.service.recoveryEvidence(source,f.id).effect,"unknown");
});
