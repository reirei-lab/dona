import assert from "node:assert/strict";
import {test} from "node:test";
import {fixture,scope,content,wrapping,notification,start} from "./approval/fixtures/broker.js";
import {executionKey} from "./approval/fixtures/execution.js";
import {installApprovalExecutionMarkerSchema} from "../src/approval/schema.js";
import {emptyMetadataRoot} from "../src/approval/metadata-tree.js";
import {LocalExternalApprovalService,ExternalApprovalPrecommitError,type ExternalApprovalStepUp} from "../src/approval/local-external-service.js";
import type {ExternalSlackPort,ExternalSendResult} from "../src/approval/local-external-types.js";
import {externalRichText,LocalSlackApprovalProvider} from "../src/approval/local-slack-provider.js";
const actor={instance_id:scope.instance_id,owner_id:"local_owner",device_id:"device",grant_revision:1};
const intent={idempotency_key:"one",workspace_id:scope.workspace_id,channel_id:"C123",thread_ts:"1791080198.497089",text:"確認済みの本文"};
function setup(t:{after(fn:()=>void):void}){
 const f=fixture(t);installApprovalExecutionMarkerSchema(f.db);
 f.transaction.runPrepared("local_marker_admission",()=>({event:{scope:{instance_id:scope.instance_id,tenant_id:scope.workspace_id},actor:{kind:"system",id:"fixture"},action:"approval_execution",operation:"slack.post_thread_reply.v1",resource_id:"fixture_root",outcome:"succeeded",reason:"none",session_ref:null,receipt_id:null,attempt_id:null,policy_revision:1,binding_revision:1,authz_revision:1},resource_commitments:[{scope:{instance_id:scope.instance_id,tenant_id:scope.workspace_id},resource_id:"approval_execution_markers",resource_digest:emptyMetadataRoot({...scope,collection:"approval_execution_markers_v1"})}],mutation:()=>null}));
 const revoked=new Set<string>();let sourceAuthorizer:((source:any)=>boolean)|undefined;let sourceRefresher:((source:any)=>Promise<boolean>)|undefined;let beforeAction=()=>{},beforeObservation=()=>{};
 let allowed=true,verified=true,changed=false,sends=0,reconciles=0,sendResult:ExternalSendResult={outcome:"accepted",receipt_ref:"slack_receipt"};
 const slack:ExternalSlackPort={observe:async (target,requesterId)=>(beforeObservation(),{target,...(requesterId?{requester_id:requesterId,requester_authorized:true}:{}),observed_at:start,bot_user_id:"U123",bot_id:"B123",workspace_name:"Workspace",channel_name:"Channel",revision:{complete:true,items:[{message_ts:target.thread_ts,edited_ts:null,content_hmac_sha256:(changed?"b":"a").repeat(64)}]}}),
 send:async(_target,_text,_marker,_observation,before)=>{beforeAction();const assertCurrent=await before();assertCurrent?.();sends++;return sendResult;},reconcile:async()=>{reconciles++;return {outcome:"accepted",receipt_ref:"slack_receipt"};}};
 const keys={content:()=>content,wrapping:()=>wrapping,notification:()=>notification,wrappingVersion:()=>wrapping,notificationVersion:()=>notification,execution:()=>executionKey};
 const auth={authorize:(a:any)=>allowed&&!revoked.has(a.device_id),authorizeSource:(source:any)=>sourceAuthorizer?.(source)===true,refreshSource:async(source:any)=>sourceRefresher?.(source)??false,verifyStepUp:()=>verified};
 const make=()=>new LocalExternalApprovalService(f.db,f.providers,scope,keys,auth,slack);
 return {...f,service:make(),make,revoke:(device:string)=>revoked.add(device),beforeSend:(action:()=>void)=>{beforeAction=action;},beforeObserve:(action:()=>void)=>{beforeObservation=action;},setSourceAuthorizer:(fn:(source:any)=>boolean,refresh?:(source:any)=>Promise<boolean>)=>{sourceAuthorizer=fn;sourceRefresher=refresh;},setAllowed:(v:boolean)=>{allowed=v;},setVerified:(v:boolean)=>{verified=v;},setChanged:()=>{changed=true;},setSend:(v:ExternalSendResult)=>{sendResult=v;},counts:()=>({sends,reconciles})};
}
async function approved(f:ReturnType<typeof setup>){
 const created=await f.service.request(actor,intent);if(created.status==="denied")throw Error("unexpected_denial");
 const presentation=await f.service.present(actor,created.request_handle);
 assert.deepEqual(presentation.requester,{kind:"local_operator",label:"このMacのoperator"});
 assert.equal(presentation.risk,"external_message");assert.match(presentation.display_fingerprint,/^[A-F0-9]{16}$/);
 assert.ok(Number.isFinite(Date.parse(presentation.created_at)));assert.ok(presentation.operation_summary.length>0);
 assert.doesNotMatch(JSON.stringify(presentation),/semantic_hash|binding_id|source_event_id|source_job_id/);
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
 const f=setup(t),{receipt}=await approved(f);f.setAllowed(false);await assert.rejects(f.service.decide(actor,receipt),ExternalApprovalPrecommitError);
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
 await assert.rejects(f.service.decide(actor,{...receipt,device_id:"different"}),ExternalApprovalPrecommitError);
 f.setVerified(false);await assert.rejects(f.service.decide(actor,receipt),ExternalApprovalPrecommitError);f.setVerified(true);
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

test("別端末approverの失効をconsume/送信直前で拒否する",async t=>{
 for(const beforeSend of [false,true]){
  const f=setup(t),created=await f.service.request(actor,intent);if(created.status==="denied")throw Error();
  const approver={...actor,device_id:"approver"},view=await f.service.present(approver,created.request_handle);
  await f.service.decide(approver,{...approver,receipt_id:"different_approver",request_id:created.request_handle,decision:"approve",presentation_digest:view.presentation_digest,expires_at:"2026-09-19T00:01:00.000Z"});
  if(beforeSend)f.beforeSend(()=>f.revoke("approver"));else f.revoke("approver");
  await f.service.executePending();assert.equal(f.counts().sends,0);
 }
});

test("main要求はpending受付で解放しterminalを新しい固定threadイベントへ一回通知する",async t=>{
 const {DispatcherDatabase}=await import("../src/database.js");
 const f=setup(t),dispatcher=new DispatcherDatabase(f.filename);t.after(()=>dispatcher.close());
 const event=dispatcher.enqueue({schema_version:1,source:"slack",external_event_id:"external_source",type:"app_mention",occurred_at:start,subject:{workspace_id:scope.workspace_id,channel_id:intent.channel_id,thread_ts:intent.thread_ts,actor_id:"U123"},payload:{},reply_target:{kind:"slack_thread",workspace_id:scope.workspace_id,channel_id:intent.channel_id,thread_ts:intent.thread_ts}}).row;
 const {DispatcherWorker}=await import("../src/worker.js"),{tempConfig,waitFor}=await import("./helpers.js"),fs=await import("node:fs/promises");
 const temporary=await tempConfig();t.after(()=>fs.rm(temporary.root,{recursive:true,force:true}));await fs.mkdir(temporary.config.resultsDir,{recursive:true});
 let prompts=0,sourceResultPath="";const ok=(agentStatus:"idle"|"done"|"working")=>({ok:true,stdout:"",stderr:"",exitCode:0,timedOut:false,aborted:false,agentStatus});
 const publish=async(resultPath:string,eventId:string)=>fs.writeFile(resultPath,JSON.stringify({schema_version:1,event_id:eventId,status:"completed",summary:"外部承認の状態を確認",actions:[],memory_candidates:[],completed_at:new Date().toISOString()}));
 const worker=new DispatcherWorker(dispatcher,{get:async()=>ok("idle"),wait:async()=>ok("working"),prompt:async(prompt)=>{
  prompts++;const resultPath=/^result_path: (.+)$/m.exec(prompt)![1]!,currentId=/^event_id: (.+)$/m.exec(prompt)![1]!;
  if(currentId===event.event_id){sourceResultPath=resultPath;return ok("working");}
  assert.ok(prompt.includes('"source":"dona_approval"'));assert.ok(prompt.includes("同じ本文を再投稿しない"));assert.ok(!prompt.includes(intent.text));
  await publish(resultPath,currentId);return ok("done");
 }},temporary.config,{debug(){},info(){},warn(){},error(){}});
 worker.start();t.after(()=>worker.stop());await waitFor(()=>dispatcher.get(event.event_id)?.status==="waiting_agent");

 const row:import("../src/app-server/external-tools.js").ExternalToolRequest={request_id:"ext_source",agent:"main",generation:"generation",thread_id:"thread",turn_id:"turn",call_id:"call",rpc_id_json:'"call"',role:"main",attempt_id:null,source_event_id:event.event_id,operation_slot:"reply",text:intent.text,state:"pending",result_json:null,created_at:start};
 const results:any[]=[];
 const runtime={externalRequests:async()=>row.state==="pending"?[{...row}]:[],externalRequest:async()=>({...row}),status:async()=>({name:"main",role:"main",state:"working",generation:"generation",thread_id:"thread",turn_id:"turn"} as any),resolveExternal:async(_name:string,_id:string,result:any)=>{results.push(result);row.state="resolved";row.result_json=JSON.stringify(result);row.text="";return {};}};
 const ingress=dispatcher.createExternalApprovalIngress(runtime,f.service,{...scope,owner_id:actor.owner_id,main_agent:"main"});f.setSourceAuthorizer(source=>ingress.authorizeSource(source),source=>ingress.refreshSource(source));
 await ingress.tick();assert.equal(results[0]?.state,"pending");assert.equal(f.counts().sends,0);assert.equal(row.state,"resolved");
 const requestId=results[0].request_id,presentation=await f.service.present(actor,requestId);
 await f.service.decide(actor,{...actor,receipt_id:"external_decision",request_id:requestId,decision:"approve",presentation_digest:presentation.presentation_digest,expires_at:"2026-09-19T00:01:00.000Z"});
 await publish(sourceResultPath,event.event_id);await waitFor(()=>dispatcher.get(event.event_id)?.status==="completed");
 await ingress.tick();assert.equal(f.counts().sends,1);
 const notification=dispatcher.getByExternalId("dona_approval",`external:${requestId}:terminal`);assert.ok(notification);assert.deepEqual(JSON.parse(notification.reply_target_json!),{kind:"slack_thread",workspace_id:scope.workspace_id,channel_id:intent.channel_id,thread_ts:intent.thread_ts});assert.equal(JSON.parse(notification.payload_json).state,"succeeded");
 await ingress.tick();assert.equal(f.counts().sends,1);assert.equal(results.length,1);
 // 同じ実DispatcherWorkerがterminal通知も処理し、draftをmainへ渡さない。
 await waitFor(()=>dispatcher.get(notification.event_id)?.status==="completed");assert.equal(prompts,2);await worker.stop();

 f.setSourceAuthorizer(()=>false);
 assert.equal(f.service.status(actor,requestId).execution?.state,"succeeded");
 assert.ok(f.service.list(actor).items.some(item=>item.request_id===requestId));
 await assert.rejects(f.service.present(actor,requestId),/unauthorized/);
});

test("workerの外部承認checkpointは同じAttempt/callに保持し応答喪失後も再送しない",async t=>{
 const {DispatcherDatabase}=await import("../src/database.js"),{taskRequestSchema}=await import("../src/task-execution.js");
 const f=setup(t),dispatcher=new DispatcherDatabase(f.filename);t.after(()=>dispatcher.close());
 const event=dispatcher.enqueue({schema_version:1,source:"slack",external_event_id:"worker_source",type:"app_mention",occurred_at:start,subject:{workspace_id:scope.workspace_id,channel_id:intent.channel_id,thread_ts:intent.thread_ts,actor_id:"U123"},payload:{},reply_target:{kind:"slack_thread",workspace_id:scope.workspace_id,channel_id:intent.channel_id,thread_ts:intent.thread_ts}}).row;
 const task=dispatcher.tasks.create(taskRequestSchema.parse({source_event_id:event.event_id,task_key:"external",objective:"承認された投稿を行う",workspace:{kind:"scratch"}}),f.filename+"-work",f.filename+"-results").task;
 const job=dispatcher.getJob(task.current_attempt_id)!;dispatcher.beginJobPreparation(job.job_id);dispatcher.setJobRuntime(job.job_id,job.agent_name,job.agent_name,JSON.stringify(["generation","thread"]));dispatcher.beginJobDispatch(job.job_id);dispatcher.markJobRunning(job.job_id);
 const row:import("../src/app-server/external-tools.js").ExternalToolRequest={request_id:"ext_worker",operation_key:`attempt:${job.job_id}`,agent:job.agent_name,generation:"generation",thread_id:"thread",turn_id:"turn",call_id:"call",rpc_id_json:'"call"',role:"worker",attempt_id:job.job_id,source_event_id:null,operation_slot:"reply",text:intent.text,state:"pending",result_json:null,created_at:start};
 let lost=true;
 const runtime={externalRequests:async()=>row.state==="pending"?[{...row}]:[],externalRequest:async()=>({...row}),status:async()=>({name:job.agent_name,role:"worker",state:"waiting",generation:"generation",thread_id:"thread",turn_id:"turn"} as any),resolveExternal:async(_name:string,_id:string,result:any)=>{row.state="resolved";row.result_json=JSON.stringify(result);row.text="";if(lost){lost=false;throw Error("response lost");}return {state:"resolved"};}};
 const ingress=dispatcher.createExternalApprovalIngress(runtime,f.service,{...scope,owner_id:actor.owner_id,main_agent:"main"});f.setSourceAuthorizer(source=>ingress.authorizeSource(source),source=>ingress.refreshSource(source));
 await ingress.tick();assert.equal(dispatcher.tasks.get(task.task_id)?.wait_reason,"external_approval");assert.equal(row.state,"pending");
 const requestId=(f.db.prepare("SELECT request_id FROM local_external_ingress").get() as {request_id:string}).request_id,presentation=await f.service.present(actor,requestId);
 await f.service.decide(actor,{...actor,receipt_id:"worker_decision",request_id:requestId,decision:"approve",presentation_digest:presentation.presentation_digest,expires_at:"2026-09-19T00:01:00.000Z"});
 await ingress.tick();assert.equal(f.counts().sends,1);assert.equal(dispatcher.tasks.get(task.task_id)?.wait_reason,"external_approval");
 await ingress.tick();assert.equal(f.counts().sends,1);assert.equal(dispatcher.tasks.get(task.task_id)?.state,"active");assert.equal(dispatcher.getJob(job.job_id)?.status,"running");
 assert.equal((f.db.prepare("SELECT state FROM task_external_approval_checkpoints").get() as {state:string}).state,"succeeded");
});

test("先頭20件が解決不能でも21件目のdecisionを次のbounded scanで実行する",async t=>{
 const f=setup(t);await approved(f);
 const records=Reflect.get(f.service,"records") as import("../src/approval/record-repository.js").ApprovalRecordRepository;
 const original=records.readListPageInState.bind(records);let scans=0;
 // scheduler境界のfixture。最終1件のbroker/one-shot/送信は実coreを使う。
 records.readListPageInState=(state,list,after,limit)=>{
  if(list.record_kind!=="event")return original(state,list,after,limit);
  scans++;assert.equal(limit,20);
  if(after===null)return {records:Array.from({length:20},(_,i)=>({codec_version:1 as const,scope,kind:"event" as const,row:{event_id:`unavailable_${i}`,decision_id:`missing_${i}`,kind:"dona_approval.decision.v1" as const,state:"pending" as const,delivered_at:null}})),count:21,next_after:"unavailable_19",has_more:true};
  assert.equal(after,"unavailable_19");return original(state,list,null,limit);
 };
 await f.service.executePending();assert.equal(f.counts().sends,0);
 await f.service.executePending();assert.equal(f.counts().sends,1);assert.equal(scans,2);
});

test("operator復旧は旧承認と不明実行をneeds_reviewへ固定しpayloadを削除する",async t=>{
 const {invalidateLocalApprovals}=await import("../src/approval/local-invalidation.js");
 for(const unknown of [false,true]){
  const f=setup(t),{created}=await approved(f);if(unknown){f.setSend({outcome:"unknown"});await f.service.executePending();}
  const beforeSends=f.counts().sends;
  invalidateLocalApprovals(f.db,f.providers,scope,actor.owner_id);
  const status=f.service.status(actor,created.request_handle);assert.equal(unknown?status.execution?.state:status.state,"needs_review");
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM approval_payload_secrets").get() as {n:number}).n,0);
  await f.service.executePending();assert.equal(f.counts().sends,beforeSends);
 }
});

test("Runtime再起動で失われた外部callは監査付きneeds_reviewとなりTaskを偽再開しない",async t=>{
 const {DispatcherDatabase}=await import("../src/database.js"),{taskRequestSchema}=await import("../src/task-execution.js");
 const f=setup(t),dispatcher=new DispatcherDatabase(f.filename);t.after(()=>dispatcher.close());
 const event=dispatcher.enqueue({schema_version:1,source:"slack",external_event_id:"worker_source",type:"app_mention",occurred_at:start,subject:{workspace_id:scope.workspace_id,channel_id:intent.channel_id,thread_ts:intent.thread_ts,actor_id:"U123"},payload:{},reply_target:{kind:"slack_thread",workspace_id:scope.workspace_id,channel_id:intent.channel_id,thread_ts:intent.thread_ts}}).row;
 const task=dispatcher.tasks.create(taskRequestSchema.parse({source_event_id:event.event_id,task_key:"external",objective:"承認された投稿を行う",workspace:{kind:"scratch"}}),f.filename+"-work",f.filename+"-results").task;
 const job=dispatcher.getJob(task.current_attempt_id)!;dispatcher.beginJobPreparation(job.job_id);dispatcher.setJobRuntime(job.job_id,job.agent_name,job.agent_name,JSON.stringify(["generation","thread"]));dispatcher.beginJobDispatch(job.job_id);dispatcher.markJobRunning(job.job_id);
 const row:import("../src/app-server/external-tools.js").ExternalToolRequest={request_id:"ext_worker",operation_key:`attempt:${job.job_id}`,agent:job.agent_name,generation:"generation",thread_id:"thread",turn_id:"turn",call_id:"call",rpc_id_json:'"call"',role:"worker",attempt_id:job.job_id,source_event_id:null,operation_slot:"reply",text:intent.text,state:"pending",result_json:null,created_at:start};
 let lost=true;
 const runtime={externalRequests:async()=>row.state==="pending"?[{...row}]:[],externalRequest:async()=>({...row}),status:async()=>({name:job.agent_name,role:"worker",state:"waiting",generation:"generation",thread_id:"thread",turn_id:"turn"} as any),resolveExternal:async(_name:string,_id:string,result:any)=>{row.state="resolved";row.result_json=JSON.stringify(result);row.text="";if(lost){lost=false;throw Error("response lost");}return {state:"resolved"};}};
 const ingress=dispatcher.createExternalApprovalIngress(runtime,f.service,{...scope,owner_id:actor.owner_id,main_agent:"main"});f.setSourceAuthorizer(source=>ingress.authorizeSource(source),source=>ingress.refreshSource(source));
 await ingress.tick();assert.equal(dispatcher.tasks.get(task.task_id)?.wait_reason,"external_approval");assert.equal(row.state,"pending");
 const requestId=(f.db.prepare("SELECT request_id FROM local_external_ingress").get() as {request_id:string}).request_id;
 row.state="expired";row.text="";await ingress.tick();
 assert.equal(f.service.status(actor,requestId).state,"needs_review");assert.equal(f.counts().sends,0);
 assert.equal((f.db.prepare("SELECT state FROM task_external_approval_checkpoints").get() as {state:string}).state,"needs_review");
 assert.equal(dispatcher.getJob(job.job_id)?.last_error_code,"runtime_external_approval_pending");
 assert.equal(dispatcher.tasks.get(task.task_id)?.attempt_number,1);
 assert.equal((f.db.prepare("SELECT state FROM local_external_ingress").get() as {state:string}).state,"source_lost");
 await ingress.tick();assert.equal(f.counts().sends,0);
});

test("executor時間budgetで未開始の後続を次回へ公平に残す",async t=>{
 const f=setup(t);await approved(f);
 const created=await f.service.request(actor,{...intent,idempotency_key:"second"});if(created.status==="denied")throw Error();
 const view=await f.service.present(actor,created.request_handle);await f.service.decide(actor,{...actor,receipt_id:"second",request_id:created.request_handle,decision:"approve",presentation_digest:view.presentation_digest,expires_at:"2026-09-19T00:01:00.000Z"});
 const slack=(f.service as any).slack,observe=slack.observe.bind(slack);let now=100,calls=0;
 const clock=t.mock.method(performance,"now",()=>now);
 slack.observe=async(...args:any[])=>{calls++;if(calls===1){now+=6000;throw Error("unavailable");}return observe(...args);};
 try{const first=await f.service.executePending();assert.equal(first.truncated,true);assert.equal(calls,1);assert.equal(f.counts().sends,0);
  await f.service.executePending();assert.equal(calls,2);assert.equal(f.counts().sends,1);
 }finally{clock.mock.restore();}
});

test("遅い新規要求が連続しても巡回phaseはexecutorを永久に飛ばさない",async t=>{
 const {DispatcherDatabase}=await import("../src/database.js");
 const f=setup(t),dispatcher=new DispatcherDatabase(f.filename);t.after(()=>dispatcher.close());
 const event=dispatcher.enqueue({schema_version:1,source:"slack",external_event_id:"external_source",type:"app_mention",occurred_at:start,subject:{workspace_id:scope.workspace_id,channel_id:intent.channel_id,thread_ts:intent.thread_ts,actor_id:"U123"},payload:{},reply_target:{kind:"slack_thread",workspace_id:scope.workspace_id,channel_id:intent.channel_id,thread_ts:intent.thread_ts}}).row;
 f.db.prepare("UPDATE events SET status='dispatching' WHERE event_id=?").run(event.event_id);
 const row:import("../src/app-server/external-tools.js").ExternalToolRequest={request_id:"ext_source",agent:"main",generation:"generation",thread_id:"thread",turn_id:"turn",call_id:"call",rpc_id_json:'"call"',role:"main",attempt_id:null,source_event_id:event.event_id,operation_slot:"reply",text:intent.text,state:"pending",result_json:null,created_at:start};
 const results:any[]=[];
 const runtime={externalRequests:async()=>row.state==="pending"?[{...row}]:[],externalRequest:async()=>({...row}),status:async()=>({name:"main",role:"main",state:"working",generation:"generation",thread_id:"thread",turn_id:"turn"} as any),resolveExternal:async(_name:string,_id:string,result:any)=>{results.push(result);row.state="resolved";row.result_json=JSON.stringify(result);row.text="";return {};}};
 let now=100,executions=0,requests=0;const clock=t.mock.method(performance,"now",()=>now);
 const service={requestFromSource:async()=>{requests++;now+=6000;throw Error("observe timeout");},executePending:async()=>{executions++;}} as any;
 const ingress=dispatcher.createExternalApprovalIngress(runtime,service,{...scope,owner_id:actor.owner_id,main_agent:"main"});
 try{await ingress.tick();assert.equal(requests,1);assert.equal(executions,0);await ingress.tick();assert.equal(requests,2);assert.equal(executions,1);}finally{clock.mock.restore();}
});

test("期限切れ署名はdecision前の確定拒否となり台帳を変更しない",async t=>{
 const f=setup(t),created=await f.service.request(actor,intent);if(created.status==="denied")throw Error();
 const view=await f.service.present(actor,created.request_handle);
 const before=(f.db.prepare("SELECT total_changes() n").get() as {n:number}).n;
 await assert.rejects(f.service.decide(actor,{...actor,receipt_id:"expired",request_id:created.request_handle,decision:"approve",presentation_digest:view.presentation_digest,expires_at:start}),ExternalApprovalPrecommitError);
 assert.equal(f.service.status(actor,created.request_handle).decision,null);
 assert.equal((f.db.prepare("SELECT total_changes() n").get() as {n:number}).n,before);
});

async function workerApprovalFixture(t:{after(fn:()=>void):void},queuedSteer=false){
 const {DispatcherDatabase}=await import("../src/database.js"),{taskRequestSchema}=await import("../src/task-execution.js");
 const f=setup(t),dispatcher=new DispatcherDatabase(f.filename);t.after(()=>dispatcher.close());
 const enqueue=(id:string)=>dispatcher.enqueue({schema_version:1,source:"slack",external_event_id:id,type:"app_mention",occurred_at:start,subject:{workspace_id:scope.workspace_id,channel_id:intent.channel_id,thread_ts:intent.thread_ts,actor_id:"U123"},payload:{},reply_target:{kind:"slack_thread",workspace_id:scope.workspace_id,channel_id:intent.channel_id,thread_ts:intent.thread_ts}}).row;
 const event=enqueue("checkpoint_source"),task=dispatcher.tasks.create(taskRequestSchema.parse({source_event_id:event.event_id,task_key:"external",objective:"承認された投稿を行う",workspace:{kind:"scratch"}}),f.filename+"-work",f.filename+"-results").task;
 const job=dispatcher.getJob(task.current_attempt_id)!;
 if(queuedSteer){const follow=enqueue("queued_follow");dispatcher.tasks.prepareSteer(task.task_id,follow.event_id,task.revision,"起動前の追加指示");dispatcher.appendQueuedJobInstruction(job.job_id,follow.event_id,"起動前の追加指示");dispatcher.tasks.finishSteer(task.task_id,follow.event_id);}
 dispatcher.beginJobPreparation(job.job_id);dispatcher.setJobRuntime(job.job_id,job.agent_name,job.agent_name,JSON.stringify(["generation","thread"]));dispatcher.beginJobDispatch(job.job_id);dispatcher.markJobRunning(job.job_id);
 let row:import("../src/app-server/external-tools.js").ExternalToolRequest={request_id:"ext_checkpoint",operation_key:`attempt:${job.job_id}`,agent:job.agent_name,generation:"generation",thread_id:"thread",turn_id:"turn",call_id:"call",rpc_id_json:'"call"',role:"worker",attempt_id:job.job_id,source_event_id:null,operation_slot:"reply",text:intent.text,state:"pending",result_json:null,created_at:start};
 let beforeResolve=()=>{};
 const runtime={externalRequests:async()=>row.state==="pending"?[{...row}]:[],externalRequest:async(id:string)=>id===row.request_id?{...row}:null,status:async()=>({name:job.agent_name,role:"worker",state:"waiting",generation:"generation",thread_id:"thread",turn_id:"turn"} as any),resolveExternal:async(_name:string,_id:string,result:any)=>{beforeResolve();row.state="resolved";row.result_json=JSON.stringify(result);row.text="";return {state:"resolved"};}};
 const ingress=dispatcher.createExternalApprovalIngress(runtime,f.service,{...scope,owner_id:actor.owner_id,main_agent:"main"});f.setSourceAuthorizer(source=>ingress.authorizeSource(source),source=>ingress.refreshSource(source));
 const requestId=()=> (f.db.prepare("SELECT request_id FROM local_external_ingress WHERE runtime_request_id=?").get(row.request_id) as {request_id:string}).request_id;
 const approve=async()=>{const id=requestId(),p=await f.service.present(actor,id);await f.service.decide(actor,{...actor,receipt_id:"decision_"+row.request_id,request_id:id,decision:"approve",presentation_digest:p.presentation_digest,expires_at:"2026-09-19T00:01:00.000Z"});return id;};
 return {...f,dispatcher,enqueue,event,task,job,ingress,runtime,requestId,approve,row:()=>row,beforeResolve:(fn:()=>void)=>{beforeResolve=fn;},newCall:(operation:string)=>{row={...row,request_id:"ext_after",call_id:"after",operation_slot:"after",operation_key:operation,state:"pending",result_json:null,text:"新しい目的の本文"};}};
}

for(const timing of ["before_ingress","during_request"] as const)test(`steer競合(${timing})は旧draftを失効させ正常steer後の新要求だけ許可する`,async t=>{
 const f=await workerApprovalFixture(t),follow=f.enqueue("steer_followup");
 const begin=()=>{const task=f.dispatcher.tasks.get(f.task.task_id)!;assert.ok(f.dispatcher.tasks.prepareSteer(task.task_id,follow.event_id,task.revision,"投稿内容を変更する"));f.dispatcher.beginJobSteer(f.job.job_id,follow.event_id);};
 const complete=()=>{f.dispatcher.markJobSteerAccepted(f.job.job_id,follow.event_id);f.dispatcher.tasks.finishSteer(f.task.task_id,follow.event_id);};
 if(timing==="before_ingress"){begin();complete();await f.ingress.tick();assert.equal(f.row().state,"resolved");assert.equal(f.db.prepare("SELECT COUNT(*) FROM local_external_ingress").pluck().get(),0);}
 else {
  const original=f.service.requestFromSource.bind(f.service);f.service.requestFromSource=async(...args)=>{const result=await original(...args);begin();return result;};
  await f.ingress.tick();assert.equal(f.dispatcher.tasks.get(f.task.task_id)?.wait_reason,"steer_acceptance_unknown");assert.equal(f.dispatcher.tasks.pendingSteer(f.job.job_id,follow.event_id),true);
  const old=f.requestId();await f.ingress.tick();assert.equal(f.service.status(actor,old).state,"needs_review");assert.equal(f.dispatcher.tasks.get(f.task.task_id)?.wait_reason,"steer_acceptance_unknown");
  f.db.prepare("UPDATE jobs SET status='blocked',last_error_code='runtime_external_approval_pending' WHERE job_id=?").run(f.job.job_id);
  f.dispatcher.tasks.wait(f.dispatcher.tasks.get(f.task.task_id)!,"steer_acceptance_unknown",-1);
  const {JobSupervisor}=await import("../src/job-supervisor.js");const supervisor=new JobSupervisor(f.dispatcher,{observeWorker:async()=>{throw Error("must preserve steer gate");}} as never,{} as never,{debug(){},info(){},warn(){},error(){}},()=>{});
  await supervisor.reconcileTasks();assert.equal(f.dispatcher.tasks.get(f.task.task_id)?.wait_reason,"steer_acceptance_unknown");
  complete();f.service.requestFromSource=original;
 }
 assert.equal(f.counts().sends,0);f.newCall(`steer:${follow.event_id}`);await f.ingress.tick();assert.equal(f.dispatcher.tasks.get(f.task.task_id)?.wait_reason,"external_approval");
 await f.approve();await f.ingress.tick();assert.equal(f.counts().sends,1);assert.equal(f.dispatcher.tasks.get(f.task.task_id)?.state,"active");assert.equal(f.dispatcher.tasks.get(f.task.task_id)?.steer_pending_event_id,null);
});

for(const action of ["cancel","replace","legacy_provenance"] as const)test(`外部承認後の${action}は旧call送信とTaskの偽復帰を拒否する`,async t=>{
 const f=await workerApprovalFixture(t);await f.ingress.tick();const id=await f.approve();
 if(action==="cancel"){const control=f.enqueue(action);const task=f.dispatcher.tasks.get(f.task.task_id)!;f.dispatcher.tasks.control(task.task_id,control.event_id,task.revision,action);}
 else if(action==="legacy_provenance"){delete f.row().operation_key;}
 else {const old=f.dispatcher.tasks.get(f.task.task_id)!;assert.throws(()=>f.dispatcher.tasks.replaceStopped(old.task_id,f.filename+"-results"),/task_stop_required/);
  const evidence={state:"stopped" as const,reason:"verified_fixture_stop",observed_at:new Date().toISOString(),process_ids:[],process_groups:[]};const stopping=f.dispatcher.tasks.claimStop(old,evidence);f.dispatcher.tasks.stopped(stopping,evidence);assert.throws(()=>f.dispatcher.tasks.replaceStopped(old.task_id,f.filename+"-results"),/external_effect_reconciliation/);await f.ingress.tick();f.dispatcher.tasks.replaceStopped(old.task_id,f.filename+"-results");}
 const before=f.dispatcher.tasks.get(f.task.task_id)!;await f.ingress.tick();await f.ingress.tick();const after=f.dispatcher.tasks.get(f.task.task_id)!;
 assert.equal(f.counts().sends,0);assert.equal(after.current_attempt_id,before.current_attempt_id);assert.equal(after.desired_state,before.desired_state);assert.equal(after.attempt_number,action==="replace"?2:1);assert.equal(f.service.status(actor,id).state,"needs_review");
 assert.equal(f.db.prepare("SELECT state FROM task_external_approval_checkpoints WHERE attempt_id=?").pluck().get(f.job.job_id),"needs_review");
});

test("外部要求expiryは同一callへexpiredを返し新Attemptや送信を作らない",async t=>{
 const f=await workerApprovalFixture(t);await f.ingress.tick();const id=f.requestId();f.setNow("2026-09-19T00:16:00.000Z");await f.ingress.tick();
 assert.equal(f.service.status(actor,id).state,"expired");assert.equal(JSON.parse(f.row().result_json!).state,"expired");assert.equal(f.counts().sends,0);assert.equal(f.dispatcher.tasks.get(f.task.task_id)?.attempt_number,1);assert.equal(f.dispatcher.tasks.get(f.task.task_id)?.state,"active");
});

for(const held of [false,true])test(`pause(${held?"承認待ち後":"hold前"})は既存Task制御契約を保ち外部投稿しない`,async t=>{
 const f=await workerApprovalFixture(t),control=f.enqueue("pause");if(held)await f.ingress.tick();const task=f.dispatcher.tasks.get(f.task.task_id)!;
 if(held){assert.throws(()=>f.dispatcher.tasks.control(task.task_id,control.event_id,task.revision,"pause"),/task_human_input_pending/);assert.deepEqual(f.dispatcher.tasks.get(task.task_id),task);}
 else {f.dispatcher.tasks.control(task.task_id,control.event_id,task.revision,"pause");await f.ingress.tick();assert.equal(f.dispatcher.tasks.get(task.task_id)?.desired_state,"paused");assert.equal(f.db.prepare("SELECT COUNT(*) FROM local_external_ingress").pluck().get(),0);}
 assert.equal(f.counts().sends,0);
});

for(const action of ["pause","cancel"] as const)test(`hold直前の${action}競合で作成済み要求を失効し復帰しない`,async t=>{
 const f=await workerApprovalFixture(t),control=f.enqueue(action),original=f.service.requestFromSource.bind(f.service);
 f.service.requestFromSource=async(...args)=>{const created=await original(...args),task=f.dispatcher.tasks.get(f.task.task_id)!;f.dispatcher.tasks.control(task.task_id,control.event_id,task.revision,action);return created;};
 await f.ingress.tick();const id=f.requestId();await f.ingress.tick();assert.equal(f.counts().sends,0);assert.equal(f.service.status(actor,id).state,"needs_review");assert.equal(f.dispatcher.tasks.get(f.task.task_id)?.desired_state,action==="pause"?"paused":"cancelled");
});

// 実providerの送信直前callbackを通す。cancel受付と外部POST開始の間を曖昧にしない。
test("外部送信直前のTask cancelはprovider callを止めpending承認を後継へ渡さない",async t=>{
 const f=await workerApprovalFixture(t);await f.ingress.tick();const id=await f.approve(),control=f.enqueue("cancel_before_send");
 f.beforeSend(()=>{const task=f.dispatcher.tasks.get(f.task.task_id)!;f.dispatcher.tasks.control(task.task_id,control.event_id,task.revision,"cancel");});
 await f.ingress.tick();await f.ingress.tick();assert.equal(f.counts().sends,0);assert.equal(f.dispatcher.tasks.get(f.task.task_id)?.desired_state,"cancelled");assert.equal(f.dispatcher.tasks.get(f.task.task_id)?.attempt_number,1);assert.equal(f.service.status(actor,id).execution?.state,"needs_review");
});

test("tool受領待ちにTask cancelされてもfinishは取消をactiveへ戻さない",async t=>{
 const f=await workerApprovalFixture(t);await f.ingress.tick();await f.approve();const control=f.enqueue("cancel_during_resolve");
 f.beforeResolve(()=>{const task=f.dispatcher.tasks.get(f.task.task_id)!;f.dispatcher.tasks.control(task.task_id,control.event_id,task.revision,"cancel");});
 await f.ingress.tick();assert.equal(f.counts().sends,1);assert.equal(f.dispatcher.tasks.get(f.task.task_id)?.desired_state,"cancelled");assert.equal(f.dispatcher.tasks.get(f.task.task_id)?.wait_reason,"cancel_requested");assert.equal(f.db.prepare("SELECT state FROM task_external_approval_checkpoints").pluck().get(),"succeeded");
 await f.ingress.tick();assert.equal(f.counts().sends,1);
});

test("外部承認待ちのTask groupはsibling完了で最終化せずcall解決後のResultで終端になる",async t=>{
 const f=await workerApprovalFixture(t),{taskRequestSchema}=await import("../src/task-execution.js");
 const sibling=f.dispatcher.tasks.create(taskRequestSchema.parse({source_event_id:f.event.event_id,task_key:"sibling",objective:"別の調査",workspace:{kind:"scratch"}}),f.filename+"-work",f.filename+"-results").task;
 const second=f.dispatcher.getJob(sibling.current_attempt_id)!;f.dispatcher.beginJobPreparation(second.job_id);f.dispatcher.setJobRuntime(second.job_id,"sibling","sibling");f.dispatcher.beginJobDispatch(second.job_id);f.dispatcher.markJobRunning(second.job_id);
 f.dispatcher.beginDispatch(f.event.event_id,f.filename+"-source-result");f.dispatcher.markWaiting(f.event.event_id);
 f.dispatcher.saveCompleted(f.event.event_id,{schema_version:1,event_id:f.event.event_id,status:"completed",summary:"delegated",completed_at:start},f.filename+"-source-result");
 await f.ingress.tick();assert.equal(f.dispatcher.tasks.mayNotify(f.dispatcher.getJob(f.job.job_id)!),false);assert.equal(f.dispatcher.getJobGroup(f.event.event_id)?.all_terminal_event_id,null);
 f.dispatcher.saveJobResult(second.job_id,{schema_version:1,job_id:second.job_id,status:"completed",summary:"sibling done",completed_at:start},second.result_path);
 const progress=f.dispatcher.enqueueJobNotification(second.job_id).row;assert.equal(JSON.parse(progress.payload_json).group.transition,"progress");assert.equal(f.dispatcher.getJobGroup(f.event.event_id)?.all_terminal_event_id,null);
 f.setNow("2026-09-19T00:16:00.000Z");await f.ingress.tick();assert.equal(JSON.parse(f.row().result_json!).state,"expired");assert.equal(f.dispatcher.getJobGroup(f.event.event_id)?.all_terminal_event_id,null);
 f.dispatcher.saveJobResult(f.job.job_id,{schema_version:1,job_id:f.job.job_id,status:"completed",summary:"期限切れを報告、投稿なし",completed_at:"2026-09-19T00:16:00.000Z"},f.job.result_path);
 const terminal=f.dispatcher.enqueueJobNotification(f.job.job_id).row;assert.equal(JSON.parse(terminal.payload_json).group.transition,"all_terminal");assert.equal(JSON.parse(terminal.payload_json).group.attention_resolution_state,"not_required");assert.deepEqual(JSON.parse(terminal.reply_target_json!),JSON.parse(f.event.reply_target_json!));assert.equal(f.counts().sends,0);
 const {buildEventPrompt,envelopeFromRow}=await import("../src/prompt.js");const prompt=buildEventPrompt(terminal.event_id,f.filename+"-final",envelopeFromRow(terminal));assert.match(prompt,/progress.*Slackへ投稿せず/);assert.match(prompt,/unresolved.*active遷移を行わず/);
});


test("起動前queued steerを含む初回attemptの新しい外部要求は許可する",async t=>{
 const f=await workerApprovalFixture(t,true);await f.ingress.tick();await f.approve();await f.ingress.tick();assert.equal(f.counts().sends,1);assert.equal(f.dispatcher.tasks.get(f.task.task_id)?.state,"active");
});

for(const effect of ["not_sent","accepted","unknown"] as const)test(`Runtime消失の${effect}を監査coreから分類し停止確認後のTask復旧を分ける`,async t=>{
 const f=await workerApprovalFixture(t);await f.ingress.tick();const id=f.requestId();
 if(effect!=="not_sent"){await f.approve();f.setSend(effect==="accepted"?{outcome:"accepted",receipt_ref:"known_external_receipt"}:{outcome:"unknown"});f.beforeResolve(()=>{throw Error("tool response lost");});await f.ingress.tick();assert.equal(f.counts().sends,1);}
 f.row().state="expired";f.row().text="";
 // ingressが消失を分類する前にsupervisorが先行しても停止・後継作成へ進めない。
 let observes=0;const {JobSupervisor}=await import("../src/job-supervisor.js"),supervisor=new JobSupervisor(f.dispatcher,{observeWorker:async()=>{observes++;return {state:"stopped",reason:"fixture",observed_at:new Date().toISOString(),process_ids:[],process_groups:[]};}} as never,{} as never,{debug(){},info(){},warn(){},error(){}},()=>{});
 f.dispatcher.tasks.wait(f.dispatcher.tasks.get(f.task.task_id)!,"external_approval",-1);await supervisor.reconcileTasks();assert.equal(observes,0);assert.equal(f.dispatcher.tasks.get(f.task.task_id)?.attempt_number,1);
 await f.ingress.tick();const classified=f.dispatcher.tasks.externalApprovalRecovery(f.job.job_id);assert.equal(classified.state,effect==="unknown"?"unknown":"ready");assert.equal(classified.accepted.length,effect==="accepted"?1:0);
 const task=f.dispatcher.tasks.get(f.task.task_id)!,evidence={state:"stopped" as const,reason:"verified_fixture_stop",observed_at:new Date().toISOString(),process_ids:[],process_groups:[]};const stopping=f.dispatcher.tasks.claimStop(task,evidence);f.dispatcher.tasks.stopped(stopping,evidence);
 if(effect==="unknown"){
  f.db.prepare("UPDATE task_external_approval_checkpoints SET state='failed',recovery_json=? WHERE attempt_id=?").run(JSON.stringify({effect:"not_sent",request_id:id,attempt_id:null,receipt_ref:null}),f.job.job_id);
  assert.equal(f.dispatcher.tasks.externalApprovalRecovery(f.job.job_id).state,"unknown");assert.throws(()=>f.dispatcher.tasks.replaceStopped(task.task_id,f.filename+"-results"),/external_effect_reconciliation/);assert.equal(f.dispatcher.tasks.get(task.task_id)?.attempt_number,1);
 }else {const next=f.dispatcher.tasks.replaceStopped(task.task_id,f.filename+"-results")!;assert.notEqual(next.job_id,f.job.job_id);assert.equal(f.dispatcher.tasks.get(task.task_id)?.attempt_number,2);
  if(effect==="accepted"){assert.match(next.objective,/既に実行済み/);assert.ok(next.objective.includes(id));assert.ok(next.objective.includes("known_external_receipt"));assert.ok(f.dispatcher.tasks.get(task.task_id)?.objective.includes("known_external_receipt"));}else assert.doesNotMatch(next.objective,/既に実行済み/);
 }
 assert.equal(f.counts().sends,effect==="not_sent"?0:1);
});


test("unknownのTaskはMacで監査済み受理を確定してから同じ投稿を再送せず回復する",async t=>{
 const f=await workerApprovalFixture(t);await f.ingress.tick();const id=await f.approve();f.setSend({outcome:"unknown"});f.beforeResolve(()=>{throw Error("response lost");});await f.ingress.tick();
 f.row().state="expired";await f.ingress.tick();assert.equal(f.dispatcher.tasks.externalApprovalRecovery(f.job.job_id).state,"unknown");
 const task=f.dispatcher.tasks.get(f.task.task_id)!,evidence={state:"stopped" as const,reason:"verified_fixture_stop",observed_at:new Date().toISOString(),process_ids:[],process_groups:[]};f.dispatcher.tasks.stopped(f.dispatcher.tasks.claimStop(task,evidence),evidence);
 assert.throws(()=>f.dispatcher.tasks.replaceStopped(task.task_id,f.filename+"-results"),/external_effect_reconciliation/);
 const {LocalApprovalOperations,installLocalOperationsSchema}=await import("../src/approval/local-operations.js");installLocalOperationsSchema(f.db);
 const keys={content:()=>content,wrapping:()=>wrapping,notification:()=>notification,wrappingVersion:()=>wrapping,notificationVersion:()=>notification,execution:()=>executionKey};
 const ops=new LocalApprovalOperations(f.db,f.providers,scope,keys,{owner_id:actor.owner_id,authorize:()=>true},{reconcile:async()=>({outcome:"accepted",receipt_ref:"manual_verified_receipt"})});
 const preview=await ops.previewReconcile(id,"固定markerの実投稿を照合しました");assert.equal(f.dispatcher.tasks.externalApprovalRecovery(f.job.job_id).state,"unknown");ops.applyReconcile(preview.confirmation);
 // raw cacheを更新していなくても、後継作成transactionの現在のcore検証で解除される。
 const next=f.dispatcher.tasks.replaceStopped(task.task_id,f.filename+"-results")!;assert.ok(next.objective.includes(id));assert.ok(next.objective.includes("manual_verified_receipt"));assert.equal(f.dispatcher.tasks.get(task.task_id)?.attempt_number,2);assert.equal(f.counts().sends,1);
});

for(const scenario of ["main_with_attempt","worker_without_attempt","worker_as_main","live_worker","other_main","live_name","live_generation","live_unknown","live_stopped","live_starting","live_interrupted"]){
 test(`typed投稿はruntime/source不一致を拒否する: ${scenario}`,async t=>{
  const {DispatcherDatabase}=await import("../src/database.js");
  const f=setup(t),dispatcher=new DispatcherDatabase(f.filename);t.after(()=>dispatcher.close());
  const event=dispatcher.enqueue({schema_version:1,source:"slack",external_event_id:"policy_source",type:"app_mention",occurred_at:start,subject:{workspace_id:scope.workspace_id,channel_id:intent.channel_id,thread_ts:intent.thread_ts,actor_id:"U123"},payload:{},reply_target:{kind:"slack_thread",workspace_id:scope.workspace_id,channel_id:intent.channel_id,thread_ts:intent.thread_ts}}).row;
  f.db.prepare("UPDATE events SET status='completed' WHERE event_id=?").run(event.event_id);
  const row:import("../src/app-server/external-tools.js").ExternalToolRequest={request_id:"ext_policy",agent:"main",generation:"generation",thread_id:"thread",turn_id:"turn",call_id:"call",rpc_id_json:'"call"',role:"main",attempt_id:null,source_event_id:event.event_id,operation_slot:"reply",text:intent.text,state:"pending",result_json:null,created_at:start};
  const live={name:"main",role:"main",state:"working",generation:"generation",thread_id:"thread",turn_id:"turn"};
  if(scenario==="main_with_attempt")row.attempt_id="job_forged";
  if(scenario==="worker_without_attempt")row.role="worker";
  if(scenario==="worker_as_main"){row.role="worker";row.attempt_id="job_forged";}
  if(scenario==="live_worker")live.role="worker";
  if(scenario==="other_main")row.agent=live.name="other_main";
  if(scenario==="live_name")live.name="other_main";
  if(scenario==="live_generation")live.generation="other_generation";
  if(scenario.startsWith("live_")&&["unknown","stopped","starting","interrupted"].includes(scenario.slice(5)))live.state=scenario.slice(5);
  const results:any[]=[];
  const runtime={externalRequests:async()=>[row],externalRequest:async()=>row,status:async()=>live as any,resolveExternal:async(_name:string,_id:string,result:any)=>{results.push(result);return {};}};
  const ingress=dispatcher.createExternalApprovalIngress(runtime,f.service,{...scope,owner_id:actor.owner_id,main_agent:"main"});f.setSourceAuthorizer(source=>ingress.authorizeSource(source),source=>ingress.refreshSource(source));
  await ingress.tick();assert.equal(results[0]?.state,"source_denied");assert.equal(f.counts().sends,0);
  assert.equal((f.db.prepare("SELECT count(*) n FROM approval_requests").get() as {n:number}).n,0);
 });
}

for(const stage of ["phase","observe","send"] as const)for(const role of ["main","worker","unknown"] as const)test(`executor開始phase持越しと${stage}時のlive identity=${role}を照合する`,async t=>{
 const {DispatcherDatabase}=await import("../src/database.js");
 const f=setup(t),dispatcher=new DispatcherDatabase(f.filename);t.after(()=>dispatcher.close());
 const event=dispatcher.enqueue({schema_version:1,source:"slack",external_event_id:"role_drift",type:"app_mention",occurred_at:start,subject:{workspace_id:scope.workspace_id,channel_id:intent.channel_id,thread_ts:intent.thread_ts,actor_id:"U123"},payload:{},reply_target:{kind:"slack_thread",workspace_id:scope.workspace_id,channel_id:intent.channel_id,thread_ts:intent.thread_ts}}).row;
 f.db.prepare("UPDATE events SET status='completed' WHERE event_id=?").run(event.event_id);
 const row:import("../src/app-server/external-tools.js").ExternalToolRequest={request_id:"ext_drift",agent:"main",generation:"generation",thread_id:"thread",turn_id:"turn",call_id:"call",rpc_id_json:'"call"',role:"main",attempt_id:null,source_event_id:event.event_id,operation_slot:"reply",text:intent.text,state:"pending",result_json:null,created_at:start};
 const live={name:"main",role:"main",state:"working",generation:"generation",thread_id:"thread",turn_id:"turn"};
 let requestId="",now=100;const clock=t.mock.method(performance,"now",()=>now);t.after(()=>clock.mock.restore());
 const runtime={externalRequests:async()=>row.state==="pending"?[row]:[],externalRequest:async()=>row,status:async()=>live as any,resolveExternal:async(_name:string,_id:string,result:any)=>{requestId=result.request_id;row.state="resolved";now+=6000;return {};}};
 const ingress=dispatcher.createExternalApprovalIngress(runtime,f.service,{...scope,owner_id:actor.owner_id,main_agent:"main"});f.setSourceAuthorizer(source=>ingress.authorizeSource(source),source=>ingress.refreshSource(source));
 await ingress.tick();assert.ok(requestId);assert.equal(f.counts().sends,0);
 const presentation=await f.service.present(actor,requestId);
 await f.service.decide(actor,{...actor,receipt_id:"role_decision",request_id:requestId,decision:"approve",presentation_digest:presentation.presentation_digest,expires_at:"2026-09-19T00:01:00.000Z"});
 live.turn_id="next_main_turn";
 const drift=()=>{if(role==="unknown")live.state="unknown";else live.role=role;};
 if(stage==="phase")drift();else if(stage==="observe")f.beforeObserve(drift);else f.beforeSend(drift);
 await ingress.tick();assert.equal(f.counts().sends,role==="main"?1:0);
 assert.equal((f.db.prepare("SELECT state FROM local_external_ingress WHERE runtime_request_id=?").get(row.request_id) as {state:string}).state,"terminal");
});

test("遅いRuntime再照合でもdecision cursorは後続の承認済みsourceへ進む",async t=>{
 const f=setup(t);f.setSourceAuthorizer(()=>true,async()=>true);
 for(const name of ["slow","ready"]){
  const source={kind:"slack" as const,...scope,owner_id:actor.owner_id,requester_id:"U123",source_event_id:"evt_source",source_job_id:null,runtime_request_id:"ext_"+name,agent:"main",generation:"generation",thread_id:"thread",turn_id:"turn",channel_id:intent.channel_id,thread_ts:intent.thread_ts};
  const created=await f.service.requestFromSource(source,{idempotency_key:name,text:intent.text});if(created.status==="denied")throw Error();
  const view=await f.service.present(actor,created.request_handle);
  await f.service.decide(actor,{...actor,receipt_id:"receipt_"+name,request_id:created.request_handle,decision:"approve",presentation_digest:view.presentation_digest,expires_at:"2026-09-19T00:01:00.000Z"});
 }
 let now=100;const clock=t.mock.method(performance,"now",()=>now);t.after(()=>clock.mock.restore());
 const visited:string[]=[];
 f.setSourceAuthorizer(()=>true,async source=>{visited.push(source.runtime_request_id);if(source.runtime_request_id==="ext_slow"){now+=6000;return false;}return true;});
 const first=await f.service.executePending();assert.equal(first.truncated,true);assert.deepEqual(visited,["ext_slow"]);assert.equal(f.counts().sends,0);
 await f.service.executePending();assert.ok(visited.includes("ext_ready"));assert.equal(f.counts().sends,1);
});

for(const timing of ["async","sync"] as const)test(`Slack providerはcredential取得後の${timing} authority拒否でtransportを呼ばない`,async()=>{
 let calls=0,checked=false;
 const provider=new LocalSlackApprovalProvider("T123",async()=>"fixture_token",Buffer.alloc(32,7),(async()=>{calls++;throw Error("unexpected_send");}) as typeof fetch);
 const marker={marker:{codec_version:1 as const,scope:{instance_id:"instance",workspace_id:"T123"},request_id:"r",consume_id:"c",attempt_id:"a",operation:"slack.post_thread_reply.v1" as const,semantic_hash:"a".repeat(64),execution_fence:2,created_at:start,clock_transaction_id:"tx",key_version:1},mac:"b".repeat(64)};
 const target={workspace_id:"T123",channel_id:"C123",thread_ts:intent.thread_ts};
 await provider.send(target,intent.text,marker,{target,observed_at:start,bot_user_id:"U123",bot_id:"B123",workspace_name:"W",channel_name:"C",revision:{complete:true,items:[]}},async()=>{await Promise.resolve();if(timing==="async"){checked=true;throw Error("source_changed");}return ()=>{checked=true;throw Error("source_changed");};});
 assert.equal(checked,true);assert.equal(calls,0);
});

test("provider deadlineはauthority待ちを中断し遅い結果でも送信guardを実行しない",async t=>{
 const controller=new AbortController();t.mock.method(AbortSignal,"timeout",()=>controller.signal);
 let calls=0,guards=0,release!:()=>void,entered!:()=>void;
 const waiting=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 const provider=new LocalSlackApprovalProvider("T123",async()=>"fixture_token",Buffer.alloc(32,7),(async()=>{calls++;throw Error("unexpected_send");}) as typeof fetch);
 const marker={marker:{codec_version:1 as const,scope:{instance_id:"instance",workspace_id:"T123"},request_id:"r",consume_id:"c",attempt_id:"a",operation:"slack.post_thread_reply.v1" as const,semantic_hash:"a".repeat(64),execution_fence:2,created_at:start,clock_transaction_id:"tx",key_version:1},mac:"b".repeat(64)};
 const target={workspace_id:"T123",channel_id:"C123",thread_ts:intent.thread_ts};
 const pending=provider.send(target,intent.text,marker,{target,observed_at:start,bot_user_id:"U123",bot_id:"B123",workspace_name:"W",channel_name:"C",revision:{complete:true,items:[]}},async signal=>{assert.equal(signal,controller.signal);entered();await waiting;return ()=>{guards++;};});
 await started;controller.abort(Error("fixture_deadline"));assert.deepEqual(await pending,{outcome:"unknown"});assert.equal(calls,0);
 release();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(guards,0);assert.equal(calls,0);
});
