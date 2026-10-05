import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {test} from "node:test";
import {fixture,scope,content,wrapping,notification,start} from "./approval/fixtures/broker.js";
import {executionKey} from "./approval/fixtures/execution.js";
import {installApprovalExecutionMarkerSchema} from "../src/approval/schema.js";
import {initializeLocalApprovalRoots,NativeLocalApprovalConnection,type LocalApprovalNativeConfig} from "../src/approval/local-native.js";
import {LocalExternalApprovalService} from "../src/approval/local-external-service.js";
import {LocalApprovalOperations} from "../src/approval/local-operations.js";
import {LocalApprovalBackup} from "../src/approval/local-backup.js";
import {parseLocalOperationsArguments} from "../src/approval/local-operations-cli.js";
const actor={instance_id:scope.instance_id,owner_id:"owner",device_id:"device",grant_revision:1};
function setup(t:{after(fn:()=>void):void}){const f=fixture(t,false);installApprovalExecutionMarkerSchema(f.db);initializeLocalApprovalRoots(f.db,f.providers,scope);
 const keys={content:()=>content,wrapping:()=>wrapping,notification:()=>notification,wrappingVersion:()=>wrapping,notificationVersion:()=>notification,execution:()=>executionKey};let allowed=true,sends=0,receipt:any={outcome:"unknown"};
 const operator={owner_id:actor.owner_id,authorize:()=>allowed},slack={observe:async(target:any)=>({target,observed_at:start,bot_user_id:"U1",bot_id:"B1",workspace_name:"W",channel_name:"C",revision:{complete:true as const,items:[{message_ts:target.thread_ts,edited_ts:null,content_hmac_sha256:"a".repeat(64)}]}}),send:async()=>{sends++;return {outcome:"unknown" as const};},reconcile:async()=>receipt};
 const service=new LocalExternalApprovalService(f.db,f.providers,scope,keys,{authorize:()=>allowed,verifyStepUp:()=>allowed},slack),ops=new LocalApprovalOperations(f.db,f.providers,scope,keys,operator,slack);
 const config:LocalApprovalNativeConfig={codec_version:1,scope,owner_id:"owner",ledger_id:"ledger",access_group:"TEAMID.dona",used_nodes_database:f.filename+"-nodes",slack_workspace_alias:"fixture",key_version:1};
 return {...f,keys,service,ops,config,backup:new LocalApprovalBackup(f.db,f.providers,config,operator),sends:()=>sends,setAllowed:(v:boolean)=>allowed=v,setReceipt:(v:any)=>receipt=v};}
async function create(f:ReturnType<typeof setup>,approve=false){const r=await f.service.request(actor,{idempotency_key:"one",workspace_id:scope.workspace_id,channel_id:"C1",thread_ts:"1791080198.497089",text:"private draft must not back up"});if(r.status==="denied")throw Error();if(approve){const p=await f.service.present(actor,r.request_handle);await f.service.decide(actor,{...actor,receipt_id:"one",request_id:r.request_handle,decision:"approve",presentation_digest:p.presentation_digest,expires_at:"2026-09-19T00:01:00.000Z"});}return r.request_handle;}

test("運用health/listは認可済みmetadataだけを返しexpiryはprovider不通でも掃除する",async t=>{const f=setup(t),request=await create(f);assert.equal(f.ops.list().items.length,1);assert.ok(!JSON.stringify(f.ops.health()).includes("private draft"));f.setNow("2026-09-19T00:16:00.000Z");assert.equal(f.ops.health().counts?.expiry_lag,1);assert.ok(f.ops.sweep().changed>=1);assert.equal(f.service.status(actor,request).state,"expired");assert.equal(f.db.prepare("SELECT COUNT(*) FROM approval_payload_secrets").pluck().get(),0);f.setAllowed(false);assert.throws(()=>f.ops.list());});

test("operator reconcileはexact確認と監査証拠を保持し一回だけ照合する",async t=>{const f=setup(t),request=await create(f,true);await f.service.executePending();assert.equal(f.sends(),1);f.setReceipt({outcome:"accepted",receipt_ref:"slack_exact"});const p=await f.ops.previewReconcile(request,"operator confirmed exact evidence");const result=f.ops.applyReconcile(p.confirmation);assert.equal(result.state,"succeeded");assert.equal(f.db.prepare("SELECT COUNT(*) FROM local_approval_operation_evidence").pluck().get(),1);assert.throws(()=>f.ops.applyReconcile(p.confirmation));assert.equal(f.sends(),1);});

test("active retentionと失効operatorを拒否し0件evidenceを成功推測しない",async t=>{const f=setup(t),request=await create(f,true);const r=f.ops.previewRetention("request",request);assert.equal(r.eligible,false);assert.throws(()=>f.ops.retain("request",request,r.confirmation));await f.service.executePending();const p=await f.ops.previewReconcile(request,"provider complete zero matches");assert.equal(f.ops.applyReconcile(p.confirmation).state,"acceptance_unknown");const second=await f.ops.previewReconcile(request,"operator revoked before apply");f.setAllowed(false);assert.throws(()=>f.ops.applyReconcile(second.confirmation));assert.equal(f.sends(),1);});

test("混在DBのbackupは明示metadataだけを新規公開しrestoreも常にsafe-off",async t=>{const f=setup(t);await create(f);f.db.exec("CREATE TABLE unrelated_events(secret TEXT); INSERT INTO unrelated_events VALUES('private unrelated input');");
 const destination=path.join(path.dirname(f.filename),"metadata.sqlite"),restored=path.join(path.dirname(f.filename),"restored.sqlite");
 const p=f.backup.preview(destination);assert.equal(f.backup.backup(destination,p.confirmation).status,"backed_up");const check=f.backup.check(destination);assert.equal(check.status,"continuity_verified");assert.equal(check.safe_ready,false);assert.equal(check.omitted_payloads,1);
 const db=new Database(destination,{readonly:true});try{assert.equal(db.prepare("SELECT COUNT(*) FROM approval_payload_secrets").pluck().get(),0);assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='unrelated_events'").get(),undefined);assert.throws(()=>new NativeLocalApprovalConnection(db,f.config),/metadata_only/);}finally{db.close();}
 const wire=fs.readFileSync(destination);assert.ok(!wire.includes(Buffer.from("private unrelated input")));assert.ok(!wire.includes(Buffer.from("private draft must not back up")));
 const preview=f.backup.restorePreview(destination,restored);assert.equal(f.backup.restore(destination,restored,preview.confirmation).safe_ready,false);assert.throws(()=>f.backup.restore(destination,restored,preview.confirmation));
 f.setNow("2026-09-19T00:16:00.000Z");f.ops.sweep();assert.equal(f.backup.check(destination).status,"needs_review");});

test("operations CLIは未知flag・write誤用・曖昧applyを拒否する",()=>{const args=["--operation","health","--config","/config","--database","/db"];assert.equal(parseLocalOperationsArguments(args).apply,false);for(const extra of [["--apply","yes"],["--token","secret"],["--operation","list"]])assert.throws(()=>parseLocalOperationsArguments([...args,...extra]));assert.throws(()=>parseLocalOperationsArguments(["--operation","backup","--config","/config","--database","/db","--destination","relative"]));});

test("Slack長期不通でもunknown本文TTLを延長せずfenceと監査を保持する",async t=>{const f=setup(t),request=await create(f,true);await f.service.executePending();const before=f.db.prepare("SELECT attempt_id,fence FROM approval_execution_attempts").get() as {attempt_id:string;fence:number};f.setNow("2026-09-20T01:00:00.000Z");assert.ok(f.ops.sweep(performance.now()+5000).changed>=1);const after=f.db.prepare("SELECT attempt_id,fence,state FROM approval_execution_attempts").get() as {attempt_id:string;fence:number;state:string};assert.equal(after.attempt_id,before.attempt_id);assert.ok(after.fence>=before.fence);assert.equal(after.state,"needs_review");assert.equal(f.db.prepare("SELECT COUNT(*) FROM approval_consumes").pluck().get(),1);assert.equal(f.db.prepare("SELECT COUNT(*) FROM approval_payload_secrets").pluck().get(),0);assert.equal(f.ops.sweep().changed,0);assert.equal(f.sends(),1);assert.equal(f.service.status(actor,request).execution?.state,"needs_review");});

test("backupのbinding不一致・payload混入・認可失効を復元可能にしない",async t=>{const f=setup(t);await create(f);const file=path.join(path.dirname(f.filename),"negative-backup.sqlite"),p=f.backup.preview(file);f.backup.backup(file,p.confirmation);
 const other=new LocalApprovalBackup(f.db,f.providers,{...f.config,owner_id:"other"},{owner_id:"other",authorize:()=>true});assert.equal(other.check(file).status,"needs_review");
 const payload=f.db.prepare("SELECT payload_ref,envelope_json FROM approval_payload_secrets").get() as {payload_ref:string;envelope_json:string};const candidate=new Database(file);candidate.prepare("INSERT INTO approval_payload_secrets VALUES(?,?)").run(payload.payload_ref,payload.envelope_json);candidate.close();assert.equal(f.backup.check(file).status,"needs_review");
 const dest=path.join(path.dirname(f.filename),"revoked.sqlite"),preview=f.backup.preview(dest);f.setAllowed(false);assert.throws(()=>f.backup.backup(dest,preview.confirmation));assert.equal(fs.existsSync(dest),false);
});

test("retentionは期限到達済みterminal本文だけを消しmetadataとconsumeを保持する",async t=>{const f=setup(t),request=await create(f,true);await f.service.executePending();
 const {ApprovalRecordMutation}=await import("../src/approval/record-mutation.js"),{ApprovalHistoryTransaction}=await import("../src/approval/history-transaction.js"),{ApprovalRecordRepository}=await import("../src/approval/record-repository.js");
 const records=new ApprovalRecordRepository(f.db,f.providers.auditAnchors,f.providers.auditKeys,scope),mutations=new ApprovalRecordMutation(f.db,scope),a=records.readAlias({name:"execution_request",request_id:request});assert.equal(a?.kind,"execution");if(a?.kind!=="execution")throw Error();
 // 旧運用のterminalだが本文収集前という正規監査済みfixture。retention自体は実production classを通す。
 new ApprovalHistoryTransaction(f.db,f.providers,scope).runPrepared("fixture_terminal_before_retention",(mark,state)=>{const current=records.readInState(state,"execution",a.row.attempt_id)!;const plan=mutations.prepare(mark,state,[{previous:current,next:{...current,row:{...current.row,state:"failed",fence:current.row.fence+1,receipt_ref:"fixture_rejection",failure_code:"invalid_input"}}}]);return {event:{scope:{instance_id:scope.instance_id,tenant_id:scope.workspace_id},actor:{kind:"system",id:"fixture"},action:"approval_execution",operation:"slack.post_thread_reply.v1",resource_id:request,outcome:"failed",reason:"invalid_input",session_ref:null,receipt_id:"fixture_rejection",attempt_id:a.row.attempt_id,policy_revision:1,binding_revision:1,authz_revision:1},resource_commitments:plan.resource_commitments,mutation:plan.mutation};});
 assert.equal(f.ops.previewRetention("attempt",a.row.attempt_id).eligible,false);f.setNow("2026-09-20T01:00:00.000Z");const preview=f.ops.previewRetention("attempt",a.row.attempt_id);assert.equal(preview.eligible,true);assert.equal(f.ops.retain("attempt",a.row.attempt_id,preview.confirmation).status,"deleted");assert.equal(f.db.prepare("SELECT COUNT(*) FROM approval_payload_secrets").pluck().get(),0);assert.equal(f.db.prepare("SELECT COUNT(*) FROM approval_consumes").pluck().get(),1);assert.equal(f.db.prepare("SELECT COUNT(*) FROM approval_payload_metadata").pluck().get(),2);assert.throws(()=>f.ops.retain("attempt",a.row.attempt_id,preview.confirmation));});

for(const outcome of ["accepted","rejected"] as const)test(`${outcome}後の本文はcoreで削除済みとなり常駐retentionはconsume/fenceを維持する`,async t=>{
 const f=setup(t),request=await create(f,true);await f.service.executePending();
 assert.deepEqual(f.db.prepare("SELECT owner_kind,state FROM approval_payload_metadata ORDER BY owner_kind").all(),[{owner_kind:"attempt",state:"active"},{owner_kind:"request",state:"deleted"}]);
 assert.equal(f.db.prepare("SELECT COUNT(*) FROM approval_payload_secrets").pluck().get(),1);
 f.setReceipt(outcome==="accepted"?{outcome,receipt_ref:"slack_exact"}:{outcome,receipt_ref:"slack_rejected",reason:"scope_denied"});
 const proof=await f.ops.previewReconcile(request,"operator verified exact terminal evidence");
 assert.equal(f.ops.applyReconcile(proof.confirmation).state,outcome==="accepted"?"succeeded":"failed");
 assert.equal(f.service.status(actor,request).state,"consumed");
 const before=f.db.prepare("SELECT attempt_id,fence,state FROM approval_execution_attempts").get();
 assert.equal(f.ops.previewRetention("request",request).eligible,false);
 const payloads=f.db.prepare("SELECT COUNT(*) FROM approval_payload_secrets").pluck().get();assert.equal(payloads,0);
 assert.equal(f.ops.sweep(performance.now()+5000).changed,0);assert.equal(f.db.prepare("SELECT COUNT(*) FROM approval_payload_secrets").pluck().get(),payloads);
 f.setNow("2026-09-20T01:00:00.000Z");assert.equal(f.ops.previewRetention("request",request).eligible,false);
 assert.equal(f.ops.sweep(performance.now()+5000).changed,0);assert.equal(f.db.prepare("SELECT COUNT(*) FROM approval_payload_secrets").pluck().get(),0);
 assert.deepEqual(f.db.prepare("SELECT attempt_id,fence,state FROM approval_execution_attempts").get(),before);assert.equal(f.db.prepare("SELECT COUNT(*) FROM approval_consumes").pluck().get(),1);assert.equal(f.sends(),1);assert.equal(f.ops.sweep().changed,0);
});
