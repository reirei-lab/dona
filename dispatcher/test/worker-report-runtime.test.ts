import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {test} from "node:test";
import {RuntimeStore,type AgentRecord} from "../src/app-server/store.js";
import {WorkerReportQueue,workerReportTool,workerReportStatusTool} from "../src/app-server/worker-reports.js";

const attempt="job_01h00000000000000000000000";
test("worker reportを現在のruntime identityへ固定し同key/異内容を拒否する",async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-worker-report-")),store=new RuntimeStore(path.join(root,"runtime.db"));
 t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});
 const queue=new WorkerReportQueue(store),agent={name:"worker-name",generation:"generation-secret",thread_id:"thread-id",turn_id:"turn-id",role:"worker",cwd:root,release:root,config_json:JSON.stringify({attemptId:attempt,workerMessaging:true,threadConfig:{}})} as AgentRecord;
 const call=(key="one",payload:unknown={kind:"checkpoint",summary:"確認しました"},id="call-one")=>({id,method:"item/tool/call",params:{tool:workerReportTool.name,threadId:agent.thread_id,turnId:agent.turn_id,callId:id,arguments:{report_key:key,payload}}});
 assert.throws(()=>queue.accept(agent,call()),/unavailable/);queue.availability(true);
 const first=queue.accept(agent,call());assert.deepEqual(queue.drainState(),{protocol:1,recoverable_count:1});assert.equal(first.attempt_id,attempt);assert.equal(first.request_sequence,1);
 assert.deepEqual(queue.accept(agent,call()),first);
 assert.throws(()=>queue.accept(agent,call("one",{kind:"checkpoint",summary:"変更しました"})),/conflict/);
 assert.throws(()=>queue.accept(agent,call("one",undefined,"another-call")),/already_pending/);
 for(const payload of [{kind:"risk",summary:"https://private.invalid/secret",severity:"high"},{kind:"checkpoint",summary:root},{kind:"checkpoint",summary:"Bearer private-secret"},{kind:"question",question:"curl test"}])assert.throws(()=>queue.accept(agent,call("denied",payload)),/payload_denied/);
 assert.throws(()=>queue.accept({...agent,role:"main"},call("wrong-role")),/unavailable/);
 const stale=call("stale");stale.params.turnId="old-turn";assert.throws(()=>queue.accept(agent,stale),/identity_invalid/);
 const accepted={message_id:"msg_01h00000000000000000000000",receipt_id:"rcpt_01h00000000000000000000000",outcome:"created"};
 assert.equal(queue.resolve(first.request_id,accepted).state,"answering");assert.equal(queue.pending().length,0);assert.equal(queue.drainState().recoverable_count,1);
 assert.throws(()=>queue.resolve(first.request_id,{...accepted,outcome:"reused"}),/conflict/);
 const statusCall={id:"status-call",method:"item/tool/call",params:{tool:workerReportStatusTool.name,threadId:agent.thread_id,turnId:agent.turn_id,arguments:{report_key:"one"}}};
 assert.deepEqual(queue.status(agent,statusCall),{state:"answering",receipt:accepted});
 assert.throws(()=>queue.status({...agent,role:"main"},statusCall),/not_current/);
 queue.resolved(agent.name,agent.generation,"call-one");assert.equal(queue.get(first.request_id)?.state,"resolved");assert.equal(queue.drainState().recoverable_count,0);
 assert.equal(queue.accept(agent,call("one",undefined,"retry-call")).result_json,queue.get(first.request_id)?.result_json);
 assert.equal(queue.retirePayloads(new Date(Date.now()+31*86400000)),1);assert.equal(queue.get(first.request_id)?.payload_json,"");
 assert.equal(queue.accept(agent,call("one",undefined,"after-retention")).result_json,queue.get(first.request_id)?.result_json);
 const second=queue.accept(agent,call("two",{kind:"risk",summary:"確認が必要です",severity:"high"}));assert.equal(second.request_sequence,2);
 queue.expireRestart();assert.equal(queue.get(second.request_id)?.state,"expired");assert.throws(()=>queue.accept(agent,call("two",{kind:"risk",summary:"確認が必要です",severity:"high"})),/conflict/);
});

import {AppServerManager,hash} from "../src/app-server/manager.js";
import {AppServerRpc} from "../src/app-server/rpc.js";
async function until(check:()=>boolean){for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail("RPC state did not settle");}
for(const completeBeforeReply of [false,true])for(const outage of [false,true])test(`実RPCでworker reportを受理しreceiptを一度だけ返す（turn先行完了=${completeBeforeReply}, broker停止=${outage}）`,async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-worker-report-rpc-")),script=path.join(root,"fake.mjs");
 await fs.writeFile(script,`import readline from 'node:readline';import fs from 'node:fs';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);
if(r.method==='initialize')send({id:r.id,result:{userAgent:'test'}});
if(r.method==='thread/start'){fs.writeFileSync('tools.json',JSON.stringify(r.params.dynamicTools??[]));send({id:r.id,result:{thread:{id:'thread-report'}}});}
if(r.method==='turn/start'){send({method:'turn/started',params:{threadId:'thread-report',turn:{id:'turn-report'}}});send({id:r.id,result:{turn:{id:'turn-report'}}});send({id:'rpc-report',method:'item/tool/call',params:{threadId:'thread-report',turnId:'turn-report',callId:'report-call',tool:'dona_worker_report',namespace:null,arguments:{report_key:'checkpoint.one',correlation_message_id:'msg_01h00000000000000000000001',payload:{kind:'checkpoint',summary:'検証を進めました'}}}});${completeBeforeReply?"send({method:'turn/completed',params:{threadId:'thread-report',turn:{id:'turn-report',status:'completed'}}});":""}}
if(r.id==='rpc-report'&&r.result){fs.appendFileSync('responses.jsonl',JSON.stringify(r.result)+'\\n');send({method:'serverRequest/resolved',params:{threadId:'thread-report',requestId:'rpc-report'}});${completeBeforeReply?"":"send({method:'turn/completed',params:{threadId:'thread-report',turn:{id:'turn-report',status:'completed'}}});"}}
});`);
 const store=new RuntimeStore(path.join(root,"runtime.db")),manager=new AppServerManager(store,(_args,cwd)=>new AppServerRpc(process.execPath,[script],cwd));let agent:AgentRecord|undefined;
 try{
  agent=await manager.start({name:"worker-report-test",attemptId:attempt,role:"worker",cwd:root,release:root,args:[],workerMessaging:true,threadConfig:{}});manager.workerReports.availability(true);
  const tools=JSON.parse(await fs.readFile(path.join(root,"tools.json"),"utf8"));assert.deepEqual(tools.map((x:{name:string})=>x.name),["dona_request_thread_reply",workerReportTool.name,workerReportStatusTool.name]);
  const savedConfig=store.agent(agent.name)!.config_json;
  for(const legacyConfig of [
   {...JSON.parse(savedConfig),workerMessaging:undefined},
   {...JSON.parse(savedConfig),workerMessaging:false},
   {...JSON.parse(savedConfig),threadConfig:{config:{"features.default_mode_request_user_input":false}}},
  ]){
   store.db.prepare("UPDATE agents SET config_json=? WHERE name=?").run(JSON.stringify(legacyConfig),agent.name);
   await assert.rejects(manager.prompt(agent.name,"worker-message:unsupported","追加指示",{attempt_id:attempt,generation:agent.generation,thread_id:agent.thread_id!}),{message:"runtime_worker_messaging_unsupported",acceptance:"not_sent"});
   assert.equal(store.db.prepare("SELECT 1 FROM operations WHERE agent=? AND operation_key=?").get(agent.name,"worker-message:unsupported"),undefined);
  }
  store.db.prepare("UPDATE agents SET config_json=? WHERE name=?").run(savedConfig,agent.name);
  await manager.prompt(agent.name,"start-report","進捗を報告してください");await until(()=>manager.workerReports.pending().length===1&&(!completeBeforeReply||store.agent(agent!.name)?.turn_id===null));
  const report=manager.workerReports.pending()[0]!;assert.equal(report.generation,agent.generation);assert.equal(report.thread_id,agent.thread_id);assert.equal(manager.status(agent.name)?.state,"waiting");
  const result={message_id:"msg_01h00000000000000000000000",receipt_id:"rcpt_01h00000000000000000000000",outcome:"created"};
  assert.throws(()=>manager.resolveWorkerReport("other-worker",report.request_id,result),/not_current/);
  if(outage){manager.workerReports.availability(false);await manager.recover();await until(()=>manager.workerReports.get(report.request_id)?.state==="resolved"&&manager.status(agent!.name)?.state==="idle");
   assert.deepEqual(JSON.parse(manager.workerReports.get(report.request_id)!.result_json!),{state:"unknown",diagnostic:"receipt_unavailable"});assert.equal(manager.workerReports.drainState().recoverable_count,1);
   assert.equal((await fs.readFile(path.join(root,"responses.jsonl"),"utf8")).trim().split("\n").length,1);return;
  }
  manager.external.availability(true);
  const external=manager.external.accept({...store.agent(agent.name)!,turn_id:report.turn_id},{id:"rpc-external",method:"item/tool/call",params:{threadId:report.thread_id,turnId:report.turn_id,callId:"external-overlap",tool:"dona_request_thread_reply",arguments:{operation_slot:"overlap",text:"確認しました"}}});
  manager.resolveExternal(agent.name,external.request_id,{request_id:"approval-overlap",state:"pending"});
  manager.external.resolved(agent.name,agent.generation,"rpc-external");
  // 解消済みreceiptの再照合でも、同じturnの未応答reportを追い越さない。
  manager.resolveExternal(agent.name,external.request_id,{request_id:"approval-overlap",state:"pending"});
  assert.equal(manager.status(agent.name)?.state,"waiting");
  assert.equal(manager.workerReports.get(report.request_id)?.state,"pending");
  assert.notEqual(manager.workerReports.get(report.request_id)?.payload_json,"");
  manager.resolveWorkerReport(agent.name,report.request_id,result);await until(()=>manager.workerReports.get(report.request_id)?.state==="resolved"&&manager.status(agent!.name)?.state==="idle");
  manager.resolveWorkerReport(agent.name,report.request_id,result);
  const responses=(await fs.readFile(path.join(root,"responses.jsonl"),"utf8")).trim().split("\n");assert.equal(responses.length,1);assert.deepEqual(JSON.parse(JSON.parse(responses[0]!).contentItems[0].text),result);
  assert.throws(()=>manager.resolveWorkerReport(agent!.name,report.request_id,{...result,outcome:"reused"}),/conflict/);
  const key="worker-message:msg_01h00000000000000000000001",text="指示を処理してください";
  const scope={attempt_id:attempt,generation:agent.generation,thread_id:agent.thread_id!};
  const sent={generation:agent.generation,threadId:agent.thread_id,turnId:report.turn_id,sentAt:report.created_at};
  const journal=(snapshot:unknown)=>store.db.prepare("INSERT OR REPLACE INTO operations VALUES(?,?,?,'unknown',?)").run(agent!.name,key,hash({text}),snapshot===null?null:JSON.stringify(snapshot));
  for(const snapshot of [null,{...sent,generation:"old-generation"},{...sent,turnId:"other-turn"},{...sent,sentAt:"2999-01-01T00:00:00.000Z"}]){
   journal(snapshot);assert.equal(manager.workerInstructionReceipt(agent.name,key,text,scope).state,"unknown");
  }
  journal(sent);
  const caller={...store.agent(agent.name)!,turn_id:report.turn_id};
  const call={id:"after-reconcile",method:"item/tool/call",params:{threadId:report.thread_id,turnId:report.turn_id,callId:"after-reconcile",tool:"dona_request_thread_reply",arguments:{operation_slot:"after_reconcile",text:"確認しました"}}};
  assert.throws(()=>manager.external.accept(caller,call),/source_unavailable/);
  assert.deepEqual(manager.workerInstructionReceipt(agent.name,key,text,scope),{state:"accepted",turnId:report.turn_id});
  assert.equal((store.db.prepare("SELECT state FROM operations WHERE agent=? AND operation_key=?").get(agent.name,key) as {state:string}).state,"accepted");
  assert.equal(manager.external.accept(caller,call).operation_key,key);
  const resultMessage="msg_01h00000000000000000000002",resultKey=`worker-message:${resultMessage}`;
  store.db.prepare("INSERT INTO operations VALUES(?,?,?,'unknown',?)").run(agent.name,resultKey,hash({text}),JSON.stringify(sent));
  const evidence={message_id:resultMessage,result_sha256:"b".repeat(64)};
  assert.throws(()=>manager.reconcileWorkerInstructionResult(agent!.name,resultKey,text,{...scope,generation:"other"},evidence),/not_current/);
  assert.throws(()=>manager.reconcileWorkerInstructionResult(agent!.name,resultKey,"別の指示",scope,evidence),/conflict/);
  assert.throws(()=>manager.reconcileWorkerInstructionResult(agent!.name,resultKey,text,scope,{...evidence,message_id:"msg_01h00000000000000000000003"}),/evidence_invalid/);
  assert.equal(manager.reconcileWorkerInstructionResult(agent.name,resultKey,text,scope,evidence).state,"accepted");
  assert.equal(JSON.parse((store.db.prepare("SELECT result_json FROM operations WHERE agent=? AND operation_key=?").get(agent.name,resultKey) as {result_json:string}).result_json).result_sha256,evidence.result_sha256);

  await manager.stop(agent.name,agent.generation);assert.throws(()=>manager.resolveWorkerReport(agent!.name,report.request_id,result),/not_current/);
 }finally{if(agent&&store.agent(agent.name)?.state!=="stopped")await manager.stop(agent.name,agent.generation);store.close();await fs.rm(root,{recursive:true,force:true});}
});

test("全report kindのstrict・byte上限・canary・受付上限を守る",async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-report-contract-")),store=new RuntimeStore(path.join(root,"runtime.db"));t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});
 const queue=new WorkerReportQueue(store);queue.availability(true);
 const agent={name:"worker-contract",generation:"generation-contract",thread_id:"thread-contract",turn_id:"turn-contract",role:"worker",cwd:root,release:root,config_json:JSON.stringify({attemptId:attempt,workerMessaging:true,threadConfig:{}})} as AgentRecord;
 let n=0;const call=(payload:unknown,extra:Record<string,unknown>={})=>({id:"rpc-"+n,method:"item/tool/call",params:{tool:workerReportTool.name,threadId:agent.thread_id,turnId:agent.turn_id,callId:"call-"+n++,arguments:{report_key:"report-"+n,payload,...extra}}});
 const accepted={message_id:"msg_01h00000000000000000000000",receipt_id:"rcpt_01h00000000000000000000000",outcome:"created"};
 for(const payload of [{kind:"checkpoint",summary:"確認しました"},{kind:"question",question:"続行できますか？"},{kind:"risk",summary:"確認が必要です",severity:"high"},{kind:"decision_request",question:"方式を選んでください",options:["方式A","方式B"]}]){const row=queue.accept(agent,call(payload));queue.resolve(row.request_id,accepted);queue.resolved(agent.name,agent.generation,JSON.parse(row.rpc_id_json));}
 for(const summary of ["/etc/private-token","relative/private.json","npm test","stdout: private-data","xoxb-canary-secret","-----BEGIN PRIVATE KEY-----","https://private.invalid/token","AKIA0123456789ABCDEF","sk-proj-canary-0123456789abcdef","sk-canary0123456789abcdef","hf_canary0123456789abcdef"]){assert.throws(()=>queue.accept(agent,call({kind:"checkpoint",summary})));}
 assert.throws(()=>queue.accept(agent,call({kind:"checkpoint",summary:"x".repeat(4001)})));
 assert.throws(()=>queue.accept(agent,call({kind:"decision_request",question:"界".repeat(3000),options:Array(8).fill("a".repeat(1000))})));
 assert.throws(()=>queue.accept(agent,call({kind:"checkpoint",summary:"確認",stdout:"raw"})));
 assert.throws(()=>queue.accept(agent,call({kind:"checkpoint",summary:"確認"},{job_id:"other-job"})));
 const before=queue.pending().length;assert.equal(before,0);
 // 拒否した入力はRuntimeの連番も消費しない。
 const row=queue.accept(agent,call({kind:"checkpoint",summary:"確認を続けます"}));assert.equal(row.request_sequence,5);
 const denied={state:"denied",diagnostic:"report_rejected"};queue.resolve(row.request_id,denied);queue.resolved(agent.name,agent.generation,JSON.parse(row.rpc_id_json));
 assert.equal(queue.waiting(agent.name),false);
 for(let i=6;i<=256;i++){const item=queue.accept(agent,call({kind:"checkpoint",summary:"確認を継続"}));queue.resolve(item.request_id,accepted);queue.resolved(agent.name,agent.generation,JSON.parse(item.rpc_id_json));}
 assert.throws(()=>queue.accept(agent,call({kind:"checkpoint",summary:"上限を超えます"})),/limit/);
});

import {workerEnvironment} from "../src/app-server/worker-environment.js";
test("worker起動環境にSlack credentialと汎用Dispatcher endpointを継承しない",()=>{
 const input={PATH:"path",HOME:"home",OPENAI_API_KEY:"model-key",GH_TOKEN:"github-key",SLACK_BOT_TOKEN:"xoxb-canary",SLACK_SIGNING_SECRET:"signing-canary",DONA_SOCKET_PATH:"management-socket",DONA_UPDATE_INTERNAL_TOKEN:"management-secret",HERDR_SOCKET:"legacy-socket",CUSTOM_SECRET:"xoxp-canary"};
 assert.deepEqual(workerEnvironment(input),{PATH:"path",HOME:"home",OPENAI_API_KEY:"model-key",GH_TOKEN:"github-key"});assert.equal(input.SLACK_BOT_TOKEN,"xoxb-canary");
});

import {disableWorkerReportsAfterDrain} from "../src/app-server/client.js";
test("無効化は受付閉鎖後にRuntime残件を確認し、不明・非空なら起動を拒否する",async()=>{
 const calls:string[]=[];
 const runtime={workerReportAvailability:async(enabled:boolean)=>{calls.push("close");assert.equal(enabled,false);return {enabled:false,ttl_ms:0};},workerReportDrainState:async()=>{calls.push("inventory");return {protocol:1 as const,recoverable_count:0};}};
 await disableWorkerReportsAfterDrain(runtime);assert.deepEqual(calls,["close","inventory"]);
 await assert.rejects(disableWorkerReportsAfterDrain({...runtime,workerReportDrainState:async()=>({protocol:1,recoverable_count:1})}),/requires_runtime_drain/);
 await assert.rejects(disableWorkerReportsAfterDrain({...runtime,workerReportDrainState:async()=>{throw Error("unavailable");}}),/disable_unavailable/);
 await assert.rejects(disableWorkerReportsAfterDrain({...runtime,workerReportDrainState:async()=>({protocol:1,recoverable_count:-1})}),/disable_unavailable/);
 calls.length=0;await assert.rejects(disableWorkerReportsAfterDrain({...runtime,workerReportAvailability:async()=>{throw Error("closed_unknown");}}),/disable_unavailable/);assert.deepEqual(calls,[]);
});

test("Runtime受付でDispatcher envelope分を予約し、多byte報告を後段で容量拒否しない",async t=>{
 const {parseWorkerReport}=await import("../src/worker-messaging.js");
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-report-envelope-")),store=new RuntimeStore(path.join(root,"runtime.db"));
 t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});
 const queue=new WorkerReportQueue(store);queue.availability(true);
 const agent={name:"worker-envelope",generation:"generation-envelope",thread_id:"thread-envelope",turn_id:"turn-envelope",role:"worker",cwd:root,release:root,config_json:JSON.stringify({attemptId:attempt,workerMessaging:true,threadConfig:{}})} as AgentRecord;
 const call=(length:number)=>({id:"rpc-envelope",method:"item/tool/call",params:{tool:workerReportTool.name,threadId:agent.thread_id,turnId:agent.turn_id,callId:"envelope",arguments:{report_key:"envelope",payload:{kind:"decision_request",question:"界".repeat(length),options:["選".repeat(1000),"択".repeat(1000)]}}}});
 const oversized=call(3400);assert.ok(Buffer.byteLength(JSON.stringify(oversized.params.arguments))<16384);
 assert.throws(()=>queue.accept(agent,oversized),/payload_denied/);assert.equal(queue.pending().length,0);
 const accepted=queue.accept(agent,call(3300));assert.equal(accepted.request_sequence,1);
 const value=JSON.parse(accepted.payload_json);
 assert.doesNotThrow(()=>parseWorkerReport({schema_version:1,source_event_id:"evt_01h00000000000000000000000",producer_sequence:accepted.request_sequence,idempotency_key:accepted.report_key,occurred_at:accepted.created_at,payload:value.payload}));
});


test("照合不能な64件が残っても全reportのreceipt照合を巡回する",async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-report-fairness-")),store=new RuntimeStore(path.join(root,"runtime.db"));
 t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});
 const queue=new WorkerReportQueue(store),agent={name:"worker-name",generation:"generation-secret",thread_id:"thread-id",turn_id:"turn-id",role:"worker",cwd:root,release:root,config_json:JSON.stringify({attemptId:attempt,workerMessaging:true,threadConfig:{}})} as AgentRecord;
 queue.availability(true);const ids=new Set<string>();
 for(let i=0;i<130;i++){
  const id=`call-${i}`,row=queue.accept(agent,{id,method:"item/tool/call",params:{tool:workerReportTool.name,threadId:agent.thread_id,turnId:agent.turn_id,callId:id,arguments:{report_key:`report-${i}`,payload:{kind:"checkpoint",summary:"確認しました"}}}});
  queue.resolve(row.request_id,{state:"unknown",diagnostic:"receipt_unavailable"});queue.resolved(agent.name,agent.generation,id);ids.add(row.request_id);
 }
 const seen=new Set<string>();
 for(let i=0;i<3;i++){const batch=queue.recoverable();assert.equal(batch.length,64);for(const row of batch)seen.add(row.request_id);}
 assert.deepEqual(seen,ids);
 const recovered=queue.recoverable()[0]!;
 queue.reconcileReceipt(recovered.request_id,{message_id:"msg_01h00000000000000000000000",receipt_id:"rcpt_01h00000000000000000000000",outcome:"created"});
 for(let i=0;i<3;i++)assert.ok(queue.recoverable().every(row=>row.request_id!==recovered.request_id));
 assert.equal(queue.drainState().recoverable_count,129);
});


for(const steer of [false,true])test(`明示拒否した指示を同一operationで再送する（steer=${steer}）`,async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-instruction-rejected-")),script=path.join(root,"fake.mjs");
 await fs.writeFile(script,`import readline from 'node:readline';let rejected=false;const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method==='initialize')send({id:r.id,result:{}});if(r.method==='thread/start')send({id:r.id,result:{thread:{id:'thread-retry'}}});if(r.method==='turn/start'||r.method==='turn/steer'){if(r.params.input[0].text==='追加条件'&&!rejected){rejected=true;send({id:r.id,error:{code:-32602,message:'rejected'}});}else send({id:r.id,result:r.method==='turn/steer'?{turnId:'turn-retry'}:{turn:{id:'turn-retry'}}});}});`);
 const store=new RuntimeStore(path.join(root,"runtime.db")),manager=new AppServerManager(store,(_args,cwd)=>new AppServerRpc(process.execPath,[script],cwd));
 const agent=await manager.start({name:"retry-worker",attemptId:attempt,role:"worker",cwd:root,release:root,args:[],workerMessaging:true,threadConfig:{}});
 t.after(async()=>{await manager.stop(agent.name,agent.generation);store.close();await fs.rm(root,{recursive:true,force:true});});
 if(steer)await manager.prompt(agent.name,"initial","開始");
 const scope={attempt_id:attempt,generation:agent.generation,thread_id:agent.thread_id!},key="worker-message:retry";
 await assert.rejects(manager.prompt(agent.name,key,"追加条件",scope),{acceptance:"rejected"});
 assert.deepEqual(manager.workerInstructionReceipt(agent.name,key,"追加条件",scope),{state:"not_found"});
 assert.throws(()=>manager.workerInstructionReceipt(agent.name,key,"別条件",scope),/conflict/);
 assert.deepEqual(await manager.prompt(agent.name,key,"追加条件",scope),{turnId:"turn-retry"});
 assert.deepEqual(manager.workerInstructionReceipt(agent.name,key,"追加条件",scope),{state:"accepted",turnId:"turn-retry"});
});
