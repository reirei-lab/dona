import {existsSync} from "node:fs";
import {readJobResultEnvelope} from "../src/job-result.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {test} from "node:test";
import {DispatcherDatabase} from "../src/database.js";
import {taskRequestSchema} from "../src/task-execution.js";
import {RuntimeStore} from "../src/app-server/store.js";
import {AppServerManager} from "../src/app-server/manager.js";
import {AppServerRpc} from "../src/app-server/rpc.js";
import {RuntimeClient} from "../src/app-server/client.js";
import {AppServerWorkerReportBridge,AppServerWorkerInstructionController} from "../src/app-server/worker-report-bridge.js";
import {WorkerInstructionBridge} from "../src/worker-messaging.js";
import {eventEnvelope,tempConfig} from "./helpers.js";
async function until(check:()=>boolean){for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail("RPC state did not settle");}

for(const denyFirst of [false,true])test(`RPC→現行Task ledger→指示→worker receiptを通し、各応答喪失後にwriteを再送しない（先行拒否=${denyFirst}）`,async()=>{
 const {root,config}=await tempConfig(),database=new DispatcherDatabase(config.databasePath),store=new RuntimeStore(path.join(root,"runtime.db"));
 const source=database.enqueue(eventEnvelope("worker-bridge")).row;
 const task=database.tasks.create(taskRequestSchema.parse({source_event_id:source.event_id,task_key:"bridge",objective:"調査する",workspace:{kind:"scratch"}}),config.jobsWorkspaceRoot,config.jobResultsDir).task;
 const job=database.getJob(task.current_attempt_id)!;
 const script=path.join(root,"fake.mjs");await fs.mkdir(path.dirname(job.result_path),{recursive:true});
 await fs.writeFile(script,`import readline from 'node:readline';import fs from 'node:fs';const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const report=()=>send({id:'rpc-report',method:'item/tool/call',params:{threadId:'worker-thread',turnId:'worker-turn',callId:'report-call',tool:'dona_worker_report',namespace:null,arguments:{report_key:'question.one',payload:{kind:'question',question:'調査を続けてよいですか？'}}}});
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);
if(r.method==='initialize')send({id:r.id,result:{userAgent:'test'}});
if(r.method==='thread/start')send({id:r.id,result:{thread:{id:'worker-thread'}}});
if(r.method==='turn/start'){send({method:'turn/started',params:{threadId:'worker-thread',turn:{id:'worker-turn'}}});send({id:r.id,result:{turn:{id:'worker-turn'}}});${denyFirst?"send({id:'denied-report',method:'item/tool/call',params:{threadId:'worker-thread',turnId:'worker-turn',callId:'denied-call',tool:'dona_worker_report',namespace:null,arguments:{report_key:'denied.one',payload:{kind:'checkpoint',summary:'調査する'}}}});":"report();"}}
if(r.id==='denied-report'&&r.result){fs.writeFileSync('denial.json',JSON.stringify(r.result));send({method:'serverRequest/resolved',params:{threadId:'worker-thread',requestId:'denied-report'}});report();}
if(r.id==='rpc-report'&&r.result)send({method:'serverRequest/resolved',params:{threadId:'worker-thread',requestId:'rpc-report'}});
if(r.method==='turn/steer'){fs.appendFileSync('steers.jsonl',JSON.stringify(r.params)+'\\n');send({id:r.id,result:{turnId:'worker-turn'}});const typed=JSON.parse(r.params.input[0].text.split('\\n').slice(1,-1).join('\\n'));send({id:'correlated-report',method:'item/tool/call',params:{threadId:'worker-thread',turnId:'worker-turn',callId:'correlated-call',tool:'dona_worker_report',namespace:null,arguments:{report_key:'checkpoint.after-answer',correlation_message_id:typed.message_id,conversation_revision:typed.conversation_revision,payload:{kind:'checkpoint',summary:'回答に対応しました'}}}});}
if(r.id==='correlated-report'&&r.result){send({method:'serverRequest/resolved',params:{threadId:'worker-thread',requestId:'correlated-report'}});const target=${JSON.stringify(job.result_path)};fs.writeFileSync(target+'.tmp',JSON.stringify({schema_version:1,job_id:${JSON.stringify(job.job_id)},status:'completed',summary:'確認が完了しました',completed_at:new Date().toISOString()}));fs.renameSync(target+'.tmp',target);}
});`);
 const manager=new AppServerManager(store,(_args,cwd)=>new AppServerRpc(process.execPath,[script],cwd));
 let dropReport=true,dropInstruction=true;
 class LocalRuntime extends RuntimeClient {
  constructor(){super("unused");}
  override async workerReportAvailability(enabled:boolean){return manager.workerReports.availability(enabled);}
  override async workerReports(){return manager.workerReports.pending();}
  override async status(name:string){return manager.status(name)??null;}
  override async resolveWorkerReport(name:string,id:string,result:unknown){if(dropReport){dropReport=false;throw Error("report response lost");}return manager.resolveWorkerReport(name,id,result);}
  override async workerInstructionReceipt(name:string,messageId:string,text:string,scope:{attempt_id:string;generation:string;thread_id:string}){return manager.workerInstructionReceipt(name,`worker-message:${messageId}`,text,scope);}
  override async workerInstruction(name:string,messageId:string,text:string,scope:{attempt_id:string;generation:string;thread_id:string}){const result=await manager.prompt(name,`worker-message:${messageId}`,text,scope) as {turnId:string};if(dropInstruction){dropInstruction=false;throw Error("instruction response lost");}return result;}
 }
 const runtime=new LocalRuntime();let generation:string|undefined;
 try{
  const agent=await manager.start({name:job.agent_name,attemptId:job.job_id,role:"worker",cwd:root,release:root,args:[],workerMessaging:true,threadConfig:{}});generation=agent.generation;
  database.beginJobPreparation(job.job_id);database.setJobRuntime(job.job_id,"workspace","pane",JSON.stringify([agent.generation,agent.thread_id]));database.beginJobDispatch(job.job_id);database.markJobRunning(job.job_id);
  manager.workerReports.availability(true);await manager.prompt(job.agent_name,"initial","報告してください");await until(()=>manager.workerReports.pending().length===1);
  const bridgeErrors:unknown[]=[];const bridge=new AppServerWorkerReportBridge(database,runtime,error=>bridgeErrors.push(error));
  if(denyFirst){dropReport=false;assert.equal(await bridge.runOnce(),0);await until(()=>manager.workerReports.pending().some(row=>row.report_key==="question.one"));dropReport=true;
   const denial=JSON.parse(await fs.readFile(path.join(root,"denial.json"),"utf8"));assert.equal(denial.success,false);assert.deepEqual(JSON.parse(denial.contentItems[0].text),{state:"denied",diagnostic:"payload_rejected"});
  }
  assert.equal(await bridge.runOnce(),0);assert.equal(bridgeErrors.length,1);assert.equal(manager.workerReports.pending().length,1);
  assert.equal(await bridge.runOnce(),1);await until(()=>manager.workerReports.pending().length===0&&manager.status(job.agent_name)?.state==="working");
  const report=manager.workerReports.get((store.db.prepare("SELECT request_id FROM runtime_worker_reports WHERE report_key='question.one'").get() as {request_id:string}).request_id)!;
  const accepted=JSON.parse(report.result_json!);assert.equal(accepted.outcome,"created");
  const reconciled=database.workerMessages.reconcileWorker(job.job_id,source.event_id,JSON.stringify([agent.generation,agent.thread_id]),report.report_key);assert.equal(reconciled.reconciliation,"matched");assert.equal(database.workerMessages.reports(job.job_id,source.event_id)[0]?.producer_sequence,1);
  const instruction=database.workerMessages.appendInstruction(job.job_id,{schema_version:1,source_event_id:source.event_id,producer_sequence:1,idempotency_key:"condition.one",occurred_at:new Date().toISOString(),correlation_message_id:accepted.message_id,conversation_revision:1,payload:{operation:"answer",text:"元の依頼範囲で継続してください"}});
  const instructions=new WorkerInstructionBridge(database.workerMessages,new AppServerWorkerInstructionController(database,runtime));
  await assert.rejects(instructions.runOnce(),/response lost/);
  assert.equal(await instructions.runOnce(new Date(Date.now()+300_001)),true);
  assert.equal(database.getJob(job.job_id)?.status,"running");assert.equal(database.workerMessages.hasUnansweredQuestion(job.job_id),false);
  const sends=(await fs.readFile(path.join(root,"steers.jsonl"),"utf8")).trim().split("\n");assert.equal(sends.length,1);assert.ok(sends[0]!.includes(instruction.message.message_id));
  const receipt=database.workerMessages.reconcile(job.job_id,source.event_id,"dona-main","condition.one") as {receipts:Array<{receipt_kind:string;consumer:string}>};assert.ok(receipt.receipts.some(row=>row.receipt_kind==="delivered"&&row.consumer==="worker"));
  await until(()=>manager.workerReports.pending().some(row=>row.report_key==="checkpoint.after-answer"));assert.equal(await bridge.runOnce(),1);
  await until(()=>existsSync(job.result_path));
  const correlated=database.workerMessages.reports(job.job_id,source.event_id)[0]!;assert.equal(correlated.producer_sequence,2);assert.equal(correlated.correlation_message_id,instruction.message.message_id);
  const final=await readJobResultEnvelope(job.result_path,job.job_id);database.saveJobResult(job.job_id,final,job.result_path);assert.equal(database.tasks.get(task.task_id)?.state,"completed");
  await assert.rejects(manager.prompt(job.agent_name,"worker-message:other","wrong",{attempt_id:"other-attempt",generation:agent.generation,thread_id:agent.thread_id!}),/not_current/);
 }finally{if(generation&&store.agent(job.agent_name)?.state!=="stopped")await manager.stop(job.agent_name,generation);store.close();database.close();await fs.rm(root,{recursive:true,force:true});}
});

import {createHash,createHmac} from "node:crypto";
import {principalProofKeyId,verifySlackPrincipalProof} from "../src/principal-proof.js";
import {stableStringify} from "../src/validation.js";
import {AgentContextManager} from "../src/agent-context.js";
import {JobSupervisor} from "../src/job-supervisor.js";
import type {JobAgentRuntime} from "../src/job-runtime.js";
import {DispatcherApi} from "../src/api.js";
import {DispatcherApiClient} from "../src/client.js";
test("親APIは永続report receiptから元ownerだけを継承し、対応するanswerだけを許す",async()=>{
 const {root,config}=await tempConfig();config.workerMessagingEnabled=true;
 const db=new DispatcherDatabase(config.databasePath),contexts=new AgentContextManager(db,path.join(path.dirname(config.socketPath),"status-context.json"));
 const worker={isRunning:()=>true,wake(){},async steer(){throw Error("not used");},async cancel(){throw Error("not used");}};
 const api=new DispatcherApi(db,worker,worker,config,{debug(){},info(){},warn(){},error(){}},undefined,undefined,undefined,undefined,undefined,undefined,undefined,contexts),client=new DispatcherApiClient(config.socketPath);
 function signed(id:string,workspace="T_TEST",thread="1756722030.123456"){const e=eventEnvelope(id);e.subject.workspace_id=workspace;e.reply_target!.workspace_id=workspace;e.subject.thread_ts=thread;e.reply_target!.thread_ts=thread;e.trace={ingress_attempt:1};const now=new Date(Math.floor(Date.now()/1000)*1000),key="worker-report-parent-test-key-000000000";
 const raw=stableStringify({attempt:1,event_id:id,expires_at:new Date(now.getTime()+60000).toISOString().replace(".000Z","Z"),issued_at:now.toISOString().replace(".000Z","Z"),key_id:principalProofKeyId(key),nonce:"nonce-"+id.replaceAll(".","-"),principal_id:e.subject.actor_id,principal_kind:"human",tenant_id:e.subject.workspace_id,version:2,envelope_sha256:createHash("sha256").update(stableStringify(e)).digest("hex"),workspace_id:e.subject.workspace_id});
 return db.enqueue(e,now,verifySlackPrincipalProof(e,Buffer.from(raw).toString("base64url"),createHmac("sha256",key).update(raw).digest("base64url"),key,now)).row;}
 try{
  await api.start();const source=signed("parent-source");
  const task=db.tasks.create(taskRequestSchema.parse({source_event_id:source.event_id,task_key:"question",objective:"調査する",workspace:{kind:"scratch"}}),config.jobsWorkspaceRoot,config.jobResultsDir).task,jobId=task.current_attempt_id;
  db.beginJobPreparation(jobId);db.setJobRuntime(jobId,"workspace","pane","runtime-identity");db.beginJobDispatch(jobId);db.markJobRunning(jobId);
  const question=db.workerMessages.appendWorkerReport(jobId,"runtime-identity",{schema_version:1,source_event_id:source.event_id,producer_sequence:1,idempotency_key:"question.one",occurred_at:new Date().toISOString(),payload:{kind:"question",question:"調査を継続できますか？"}});
  assert.equal(db.getJob(jobId)?.last_error_code,"worker_message_question_pending");assert.equal(db.workerMessages.hasUnansweredQuestion(jobId),true);
  const never=async()=>{throw Error("pending question must not restart or retire a worker");};
  const runtime:JobAgentRuntime={prepare:never,prompt:never,get:never,wait:never,cancel:never,observeWorker:never,retireWorker:never};
  await new JobSupervisor(db,runtime,config,{debug(){},info(){},warn(){},error(){}},()=>{}).reconcileTasks();
  assert.equal(db.tasks.get(task.task_id)?.wait_reason,"human_input");assert.equal(db.tasks.get(task.task_id)?.current_attempt_id,jobId);
  assert.equal(db.workerMessages.publishPendingReports(),1);
  // 元eventはまだqueuedなので、reportの永続deliveryから取得する。
  const report=db.workerMessages.reconcileWorker(jobId,source.event_id,"runtime-identity","question.one") as {delivery:{delivery_id:string}};
  const rows=db.workerMessages.reports(jobId,source.event_id);assert.equal(rows[0]!.message_id,question.message.message_id);
  const sqlite=(await import("better-sqlite3")).default;const sql=new sqlite(config.databasePath);const record=sql.prepare("SELECT event_id FROM worker_message_deliveries WHERE delivery_id=?").get(report.delivery.delivery_id) as {event_id:string};sql.close();const notification=db.get(record.event_id)!;
  const dispatch=db.beginDispatch(notification.event_id,path.join(root,"parent-result.json"));assert.equal((await contexts.issue(dispatch)).purpose,"worker_report");
  const read=await client.getTaskReports(task.task_id,notification.event_id);assert.equal(read.attempt_id,jobId);assert.equal(read.next_producer_sequence,1);
  const message={schema_version:1,source_event_id:notification.event_id,producer_sequence:1,idempotency_key:"answer.one",occurred_at:new Date().toISOString(),correlation_message_id:question.message.message_id,conversation_revision:1,payload:{operation:"answer",text:"既存の依頼範囲で継続してください"}};
  await assert.rejects(client.instructTask(task.task_id,read.revision as number,{...message,payload:{operation:"add_condition",text:"別の条件"}}));
  const accepted=await client.instructTask(task.task_id,read.revision as number,message);assert.equal(accepted.outcome,"created");assert.equal((await client.instructTask(task.task_id,read.revision as number,message)).outcome,"reused");
  const receipts=await client.getTaskReports(task.task_id,notification.event_id);assert.equal((receipts.instructions as unknown[]).length,1);
  await assert.rejects(client.createTask({source_event_id:notification.event_id,task_key:"new",objective:"別作業",workspace:{kind:"scratch"}}));
  const other=signed("parent-other-task");const otherTask=db.tasks.create(taskRequestSchema.parse({source_event_id:other.event_id,task_key:"other",objective:"別の調査",workspace:{kind:"scratch"}}),config.jobsWorkspaceRoot,config.jobResultsDir).task;
  await assert.rejects(client.getTaskReports(otherTask.task_id,notification.event_id));
  for(const [workspace,thread] of [["T_OTHER","1756722030.123456"],["T_TEST","1756722030.999999"]]){
   const external=signed("other-"+workspace+"-"+thread,workspace,thread);await contexts.issue(db.beginDispatch(external.event_id,path.join(root,external.event_id+".json")));
   await assert.rejects(client.getTaskReports(task.task_id,external.event_id));
  }
  await contexts.issue(db.get(notification.event_id)!);
  config.workerMessagingEnabled=false;await assert.rejects(client.getTaskReports(task.task_id,notification.event_id));
 }finally{await api.stop();db.close();await fs.rm(root,{recursive:true,force:true});}
});

test("Job state matrixで受理・保留・拒否を分け、terminal報告を外向き処理しない",async()=>{
 const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath);
 try{
  for(const phase of ["queued","preparing","dispatching","running","blocked","cancelling","completed","failed","cancelled"]){
   const source=db.enqueue(eventEnvelope("state-"+phase)).row;
   const task=db.tasks.create(taskRequestSchema.parse({source_event_id:source.event_id,task_key:"state",objective:"調査する",workspace:{kind:"scratch"}}),config.jobsWorkspaceRoot,config.jobResultsDir).task,job=task.current_attempt_id;
   if(phase!=="queued"){db.beginJobPreparation(job);db.setJobRuntime(job,"workspace","pane","identity");}
   if(!["queued","preparing"].includes(phase))db.beginJobDispatch(job);
   if(!["queued","preparing","dispatching"].includes(phase))db.markJobRunning(job);
   if(phase==="blocked")db.markJobBlocked(job,"入力待ち");
   if(phase==="cancelling")db.beginJobCancellation(job,source.event_id);
   if(phase==="cancelled"){db.beginJobCancellation(job,source.event_id);db.markJobCancelled(job,"取消しました");}
   if(["completed","failed"].includes(phase))db.saveJobResult(job,{schema_version:1,job_id:job,status:phase as "completed"|"failed",summary:"終了しました",completed_at:new Date().toISOString()},db.getJob(job)!.result_path);
   const report={schema_version:1,source_event_id:source.event_id,producer_sequence:1,idempotency_key:"matrix",occurred_at:new Date().toISOString(),payload:{kind:"checkpoint",summary:"確認しました"}};
   if(["running","blocked"].includes(phase)){assert.equal(db.acceptTaskWorkerReport(job,"identity",report).outcome,"created");}
   else assert.throws(()=>db.acceptTaskWorkerReport(job,"identity",report),/current Attempt/);
  }
  const source=db.enqueue(eventEnvelope("terminal-report")).row;
  const task=db.tasks.create(taskRequestSchema.parse({source_event_id:source.event_id,task_key:"terminal-report",objective:"調査する",workspace:{kind:"scratch"}}),config.jobsWorkspaceRoot,config.jobResultsDir).task,job=task.current_attempt_id;
  db.beginJobPreparation(job);db.setJobRuntime(job,"workspace","pane","identity");db.beginJobDispatch(job);db.markJobRunning(job);
  db.acceptTaskWorkerReport(job,"identity",{schema_version:1,source_event_id:source.event_id,producer_sequence:1,idempotency_key:"last",occurred_at:new Date().toISOString(),payload:{kind:"risk",summary:"確認が必要です",severity:"high"}});
  db.workerMessages.publishPendingReports();
  db.saveJobResult(job,{schema_version:1,job_id:job,status:"completed",summary:"終了しました",completed_at:new Date().toISOString()},db.getJob(job)!.result_path);
  assert.deepEqual(db.taskReports(task.task_id,source.event_id).reports,[]);
  db.nextAvailable();
  const Sqlite=(await import("better-sqlite3")).default,sql=new Sqlite(config.databasePath);try{assert.equal((sql.prepare("SELECT status FROM events WHERE source='dona_message' AND json_extract(payload_json,'$.job_id')=?").get(job) as {status:string}).status,"completed");}finally{sql.close();}
 }finally{db.close();await fs.rm(root,{recursive:true,force:true});}
});
