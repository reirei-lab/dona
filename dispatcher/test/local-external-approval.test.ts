import assert from "node:assert/strict";
import {test} from "node:test";
import {fixture,scope,content,wrapping,notification,start} from "./approval/fixtures/broker.js";
import {executionKey} from "./approval/fixtures/execution.js";
import {installApprovalExecutionMarkerSchema} from "../src/approval/schema.js";
import {emptyMetadataRoot} from "../src/approval/metadata-tree.js";
import {LocalExternalApprovalService,type ExternalApprovalStepUp} from "../src/approval/local-external-service.js";
import type {ExternalSlackPort,ExternalSendResult} from "../src/approval/local-external-types.js";
import {externalRichText,LocalSlackApprovalProvider} from "../src/approval/local-slack-provider.js";
const actor={instance_id:scope.instance_id,owner_id:"local_owner",device_id:"device",grant_revision:1};
const intent={idempotency_key:"one",workspace_id:scope.workspace_id,channel_id:"C123",thread_ts:"1791080198.497089",text:"確認済みの本文"};
function setup(t:{after(fn:()=>void):void}){
 const f=fixture(t);installApprovalExecutionMarkerSchema(f.db);
 f.transaction.runPrepared("local_marker_admission",()=>({event:{scope:{instance_id:scope.instance_id,tenant_id:scope.workspace_id},actor:{kind:"system",id:"fixture"},action:"approval_execution",operation:"slack.post_thread_reply.v1",resource_id:"fixture_root",outcome:"succeeded",reason:"none",session_ref:null,receipt_id:null,attempt_id:null,policy_revision:1,binding_revision:1,authz_revision:1},resource_commitments:[{scope:{instance_id:scope.instance_id,tenant_id:scope.workspace_id},resource_id:"approval_execution_markers",resource_digest:emptyMetadataRoot({...scope,collection:"approval_execution_markers_v1"})}],mutation:()=>null}));
 let allowed=true,verified=true,changed=false,sends=0,reconciles=0,sendResult:ExternalSendResult={outcome:"accepted",receipt_ref:"slack_receipt"};
 const slack:ExternalSlackPort={observe:async target=>({target,observed_at:start,bot_user_id:"U123",bot_id:"B123",workspace_name:"Workspace",channel_name:"Channel",revision:{complete:true,items:[{message_ts:target.thread_ts,edited_ts:null,content_hmac_sha256:(changed?"b":"a").repeat(64)}]}}),
 send:async(_target,_text,_marker,_observation,before)=>{before();sends++;return sendResult;},reconcile:async()=>{reconciles++;return {outcome:"accepted",receipt_ref:"slack_receipt"};}};
 const keys={content:()=>content,wrapping:()=>wrapping,notification:()=>notification,wrappingVersion:()=>wrapping,notificationVersion:()=>notification,execution:()=>executionKey};
 const auth={authorize:()=>allowed,verifyStepUp:()=>verified};
 const make=()=>new LocalExternalApprovalService(f.db,f.providers,scope,keys,auth,slack);
 return {...f,service:make(),make,setAllowed:(v:boolean)=>{allowed=v;},setVerified:(v:boolean)=>{verified=v;},setChanged:()=>{changed=true;},setSend:(v:ExternalSendResult)=>{sendResult=v;},counts:()=>({sends,reconciles})};
}
async function approved(f:ReturnType<typeof setup>){
 const created=await f.service.request(actor,intent);if(created.status==="denied")throw Error("unexpected_denial");
 const presentation=await f.service.present(actor,created.request_handle);
 const receipt:ExternalApprovalStepUp={...actor,receipt_id:"receipt",request_id:created.request_handle,decision:"approve",presentation_digest:presentation.presentation_digest,expires_at:"2026-09-19T00:01:00.000Z"};
 const result=await f.service.decide(actor,receipt);assert.equal(result.status,"decided");return {created,presentation,receipt};
}
test("既存coreでrequest→Web表示→decision→consume→実provider境界→terminalが一回だけ進む",async t=>{
 const f=setup(t),{created,receipt}=await approved(f);
 assert.equal((await f.service.decide(actor,receipt)).status,"reused");
 assert.equal(f.counts().sends,0);
 const execution=await f.service.executePending();assert.equal(execution.items[0]?.state,"succeeded");
 assert.equal(f.counts().sends,1);await f.make().executePending();assert.equal(f.counts().sends,1);
 const listed=f.service.list(actor);assert.equal(listed.items[0]?.request_id,created.request_handle);assert.equal(listed.items[0]?.execution?.state,"succeeded");
 assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM approval_consumes").get() as {n:number}).n,1);
});
test("送信応答喪失後はrestart・thread変化後も再送せずexact照合する",async t=>{
 const f=setup(t);await approved(f);f.setSend({outcome:"unknown"});
 assert.equal((await f.service.executePending()).items[0]?.state,"acceptance_unknown");f.setChanged();
 assert.equal((await f.make().executePending()).items[0]?.state,"succeeded");assert.deepEqual(f.counts(),{sends:1,reconciles:1});
});
test("step-up、snapshot、grant失効では外部callを開始しない",async t=>{
 const f=setup(t),{receipt}=await approved(f);f.setAllowed(false);await assert.rejects(f.service.decide(actor,receipt),/unauthorized/);
 await f.service.executePending();assert.equal(f.counts().sends,0);
 f.setAllowed(true);f.setChanged();await f.service.executePending();assert.equal(f.counts().sends,0);
});
test("実Slack providerは固定URL・literal rich text・再送なしを強制する",async()=>{
 const calls:Array<{url:string;body:any}>=[];
 const provider=new LocalSlackApprovalProvider("T123",async()=>"fixture_token",Buffer.alloc(32,7),(async(url,init)=>{
  calls.push({url:String(url),body:JSON.parse(String(init?.body))});throw Error("response_lost");
 }) as typeof fetch);
 const marker={marker:{codec_version:1 as const,scope:{instance_id:"instance",workspace_id:"T123"},request_id:"r",consume_id:"c",attempt_id:"a",operation:"slack.post_thread_reply.v1" as const,semantic_hash:"a".repeat(64),execution_fence:2,created_at:start,clock_transaction_id:"tx",key_version:1},mac:"b".repeat(64)};
 const target={workspace_id:"T123",channel_id:"C123",thread_ts:intent.thread_ts};let before=0;
 const result=await provider.send(target,"<@U123> <script>hello</script>",marker,{target,observed_at:start,bot_user_id:"U123",bot_id:"B123",workspace_name:"W",channel_name:"C",revision:{complete:true,items:[]}},()=>{before++;});
 assert.equal(result.outcome,"unknown");assert.equal(calls.length,1);assert.equal(before,1);assert.equal(calls[0]?.url,"https://slack.com/api/chat.postMessage");
 assert.equal(calls[0]?.body.reply_broadcast,false);assert.equal(calls[0]?.body.mrkdwn,false);assert.equal(calls[0]?.body.unfurl_links,false);
 assert.deepEqual(calls[0]?.body.blocks[0].elements[0].elements,[{type:"user",user_id:"U123"},{type:"text",text:" <script>hello</script>"}]);
 assert.throws(()=>externalRichText("<!channel> everyone"));
});

test("並行executorと再decisionでもexternal callは最大一回",async t=>{
 const f=setup(t);await approved(f);await Promise.all([f.service.executePending(),f.make().executePending()]);
 assert.equal(f.counts().sends,1);await f.service.executePending();assert.equal(f.counts().sends,1);
});
test("異なるdevice claim・偽step-up・同一key別本文・rejectを分離する",async t=>{
 const f=setup(t),created=await f.service.request(actor,intent);if(created.status==="denied")throw Error();
 const duplicate=await f.service.request(actor,intent);assert.equal(duplicate.status,"reused");
 assert.equal((await f.service.request(actor,{...intent,text:"差替え"})).status,"denied");
 const view=await f.service.present(actor,created.request_handle),receipt:ExternalApprovalStepUp={...actor,receipt_id:"reject",request_id:created.request_handle,decision:"reject",presentation_digest:view.presentation_digest,expires_at:"2026-09-19T00:01:00.000Z"};
 await assert.rejects(f.service.decide(actor,{...receipt,device_id:"different"}),/step_up/);
 f.setVerified(false);await assert.rejects(f.service.decide(actor,receipt),/step_up/);f.setVerified(true);
 const rejected=await f.service.decide(actor,receipt);assert.equal(rejected.status,"decided");
 assert.equal((await f.service.executePending()).items[0]?.state,"rejected");assert.equal(f.counts().sends,0);
});

test("exact statusは表示配送・execution writeなしで応答喪失を照合する",async t=>{
 const f=setup(t),{created}=await approved(f),before=(f.db.prepare("SELECT total_changes() n").get() as {n:number}).n;
 const status=f.service.status(actor,created.request_handle);
 assert.equal(status.decision?.kind,"approve");assert.equal(status.execution,null);assert.equal((f.db.prepare("SELECT total_changes() n").get() as {n:number}).n,before);
 await f.service.executePending();assert.equal(f.service.status(actor,created.request_handle).execution?.state,"succeeded");
 assert.throws(()=>f.service.status(actor,"absent"));f.setAllowed(false);assert.throws(()=>f.service.status(actor,created.request_handle),/unauthorized/);
});
