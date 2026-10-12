import type {JobRow} from "../src/types.js";
import {envelopeFromRow,buildEventPrompt} from "../src/prompt.js";
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
import {RuntimeClient,RuntimeResponseError} from "../src/app-server/client.js";
import {AppServerWorkerReportBridge,AppServerWorkerInstructionController} from "../src/app-server/worker-report-bridge.js";
import {WorkerInstructionBridge} from "../src/worker-messaging.js";
import {eventEnvelope,tempConfig} from "./helpers.js";
async function until(check:()=>boolean){for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail("RPC state did not settle");}

for(const denyFirst of [false,true])for(const brokerOutage of [false,true])test(`RPC→現行Task ledger→指示→worker receiptを通し、各応答喪失後にwriteを再送しない（先行拒否=${denyFirst}, broker停止=${brokerOutage}）`,async()=>{
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
  override async workerReports(){return manager.workerReports.recoverable();}
  override async reconcileWorkerReport(name:string,id:string,result:unknown){return manager.reconcileWorkerReport(name,id,result);}
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
  if(brokerOutage){manager.workerReports.availability(false);await manager.recover();await until(()=>manager.workerReports.pending().length===0&&manager.status(job.agent_name)?.state==="working");
   const unknown=manager.workerReports.recoverable()[0]!;assert.deepEqual(JSON.parse(unknown.result_json!),{state:"unknown",diagnostic:"receipt_unavailable"});
   const original=database.acceptTaskWorkerReport.bind(database);database.acceptTaskWorkerReport=()=>{throw Error("unknown報告を再送してはいけない");};
   assert.equal(await bridge.runOnce(),1);database.acceptTaskWorkerReport=original;
  }else assert.equal(await bridge.runOnce(),1);await until(()=>manager.workerReports.pending().length===0&&manager.status(job.agent_name)?.state==="working");
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
  assert.equal(db.getJob(jobId)?.last_error_code,"worker_message_question_pending");assert.equal(db.tasks.mayNotify(db.getJob(jobId)!),false);assert.equal(db.workerMessages.hasUnansweredQuestion(jobId),true);
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
  const read=await client.getTaskReports(task.task_id,notification.event_id);assert.equal(read.attempt_id,jobId);assert.equal(read.next_producer_sequence,1);assert.equal((read.pending_question as {message_id:string}).message_id,question.message.message_id);
  const candidate=read.progress_decision_candidate as {decision_id:string;decision:{action:string};eligible_now:boolean;replayed:boolean};
  assert.equal(candidate.decision.action,"ask_user");assert.equal(candidate.eligible_now,true);assert.equal(candidate.replayed,false);
  const replay=(await client.getTaskReports(task.task_id,notification.event_id)).progress_decision_candidate as typeof candidate;
  assert.equal(replay.decision_id,candidate.decision_id);assert.equal(replay.replayed,true);
  const reopened=new DispatcherDatabase(config.databasePath);
  try{assert.equal(reopened.workerMessages.progressDecisionCandidate(jobId,notification.event_id)?.decision_id,candidate.decision_id);}finally{reopened.close();}
  const message={schema_version:1,source_event_id:notification.event_id,producer_sequence:1,idempotency_key:"answer.one",occurred_at:new Date().toISOString(),correlation_message_id:question.message.message_id,conversation_revision:1,payload:{operation:"answer",text:"既存の依頼範囲で継続してください"}};
  await assert.rejects(client.instructTask(task.task_id,read.revision as number,{...message,payload:{operation:"add_condition",text:"別の条件"}}));
  const accepted=await client.instructTask(task.task_id,read.revision as number,message);assert.equal(accepted.outcome,"created");assert.equal((await client.instructTask(task.task_id,read.revision as number,message)).outcome,"reused");
  const policy=await client.applyTaskProgressDecision(task.task_id,notification.event_id,candidate.decision_id);
  assert.equal(policy.state,"instruction_pending");assert.equal(policy.action,"instruct_worker");assert.equal(policy.artifact,undefined);
  const policyRead=await client.getTaskReports(task.task_id,notification.event_id);
  assert.equal(((policyRead.progress_decision_candidate as {application_receipt:{receipt_id:string}}).application_receipt).receipt_id,policy.receipt_id);
  assert.equal((await client.applyTaskProgressDecision(task.task_id,notification.event_id,candidate.decision_id)).replayed,true);
  await assert.rejects(client.applyTaskProgressDecision(task.task_id,notification.event_id,"f".repeat(64)));
  const receipts=await client.getTaskReports(task.task_id,notification.event_id);assert.equal((receipts.instructions as unknown[]).length,1);assert.equal((receipts.progress_decision_candidate as typeof candidate).eligible_now,false);
  await assert.rejects(client.createTask({source_event_id:notification.event_id,task_key:"new",objective:"別作業",workspace:{kind:"scratch"}}));
  assert.equal(db.tasks.get(task.task_id)?.state,"waiting");
  await new WorkerInstructionBridge(db.workerMessages,{async steer(){return {accepted:true};}}).runOnce();
  assert.equal(db.tasks.get(task.task_id)?.state,"active");assert.equal(db.tasks.get(task.task_id)?.wait_reason,null);assert.equal(db.tasks.canRun(db.getJob(jobId)!),true);
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

for(const failure of ["pre_dispatch","not_sent","unknown"] as const)test(`親への報告eventの${failure}失敗を照合し、未投入だけ再配信する`,async()=>{
 const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath);
 const Sqlite=(await import("better-sqlite3")).default,sql=new Sqlite(config.databasePath);
 try{
  const source=db.enqueue(eventEnvelope("rearm-"+failure)).row,task=db.tasks.create(taskRequestSchema.parse({source_event_id:source.event_id,task_key:"rearm",objective:"調査する",workspace:{kind:"scratch"}}),config.jobsWorkspaceRoot,config.jobResultsDir).task,job=task.current_attempt_id;
  db.beginJobPreparation(job);db.setJobRuntime(job,"workspace","pane","identity");db.beginJobDispatch(job);db.markJobRunning(job);
  const message=db.acceptTaskWorkerReport(job,"identity",{schema_version:1,source_event_id:source.event_id,producer_sequence:1,idempotency_key:"question",occurred_at:new Date().toISOString(),payload:{kind:"question",question:"継続できますか？"}});
  assert.equal(db.workerMessages.publishPendingReports(),1);
  const event=(sql.prepare("SELECT event_id FROM worker_message_deliveries WHERE message_id=?").get(message.message.message_id) as {event_id:string}).event_id;
  if(failure==="pre_dispatch")db.recordPreDispatchFailure(event,"result_path_unavailable","未投入",1);
  else {db.beginDispatch(event,path.join(root,"parent-result.json"));if(failure==="not_sent")db.recordSafePromptFailure(event,"runtime_not_ready","未投入",1);else db.markNeedsReview(event,"prompt_acceptance_unknown","受理不明");}
  const future=new Date(Date.now()+86400000);
  assert.equal(db.workerMessages.publishPendingReports(100,future),failure==="unknown"?0:1);
  const after=sql.prepare("SELECT event_id FROM worker_message_deliveries WHERE message_id=?").get(message.message.message_id) as {event_id:string};
  assert.equal(after.event_id===event,failure==="unknown");assert.equal(db.workerMessages.hasUnansweredQuestion(job),true);
 }finally{sql.close();db.close();await fs.rm(root,{recursive:true,force:true});}
});

for(const local of [false,true])test(`report/silenceの親contextをownerと現行世代へ限定する（local=${local}）`,async()=>{
 const {root,config}=await tempConfig();config.workerMessagingEnabled=true;
 const db=new DispatcherDatabase(config.databasePath),Sqlite=(await import("better-sqlite3")).default,sql=new Sqlite(config.databasePath);
 const contexts=new AgentContextManager(db,path.join(path.dirname(config.socketPath),"status-context.json")),worker={isRunning:()=>true,wake(){},async steer(){throw Error("not used");},async cancel(){throw Error("not used");}};
 const api=new DispatcherApi(db,worker,worker,config,{debug(){},info(){},warn(){},error(){}},undefined,undefined,undefined,undefined,undefined,undefined,undefined,contexts),client=new DispatcherApiClient(config.socketPath);
 try{
  await api.start();let task;
  if(local)task=db.createLocalDashboardTask({instance_id:"instance",owner_id:"owner",device_id:"device",grant_revision:1},{request_id:"report-task",objective:"調査する",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).task;
  else{
   const e=eventEnvelope("silence-source");e.trace={ingress_attempt:1};const now=new Date(Math.floor(Date.now()/1000)*1000),key="worker-report-silence-test-key-000000000";
   const raw=stableStringify({attempt:1,event_id:e.external_event_id,expires_at:new Date(now.getTime()+60000).toISOString().replace(".000Z","Z"),issued_at:now.toISOString().replace(".000Z","Z"),key_id:principalProofKeyId(key),nonce:"silence-proof-nonce",principal_id:e.subject.actor_id,principal_kind:"human",tenant_id:e.subject.workspace_id,version:2,envelope_sha256:createHash("sha256").update(stableStringify(e)).digest("hex"),workspace_id:e.subject.workspace_id});
   const source=db.enqueue(e,now,verifySlackPrincipalProof(e,Buffer.from(raw).toString("base64url"),createHmac("sha256",key).update(raw).digest("base64url"),key,now)).row;
   task=db.tasks.create(taskRequestSchema.parse({source_event_id:source.event_id,task_key:"silence",objective:"調査する",workspace:{kind:"scratch"}}),config.jobsWorkspaceRoot,config.jobResultsDir).task;
  }
  const job=task.current_attempt_id,source=task.source_event_id;
  // 起動待ちの指示を保存しても、旧job_steer_receipts依存を残さない。
  if(!local)db.workerMessages.appendInstruction(job,{schema_version:1,source_event_id:source,producer_sequence:1,idempotency_key:"queued-condition",occurred_at:new Date().toISOString(),payload:{operation:"add_condition",text:"既存scopeで確認する"}});
  db.beginJobPreparation(job);db.setJobRuntime(job,"workspace","pane","identity");db.beginJobDispatch(job);db.markJobRunning(job);
  const checkpoint=db.acceptTaskWorkerReport(job,"identity",{schema_version:1,source_event_id:source,producer_sequence:1,idempotency_key:"checkpoint",occurred_at:new Date().toISOString(),payload:{kind:"checkpoint",summary:"確認しました"}});
  assert.equal(db.workerMessages.publishPendingReports(),1);
  const report=(sql.prepare("SELECT event_id FROM worker_message_deliveries WHERE message_id=? AND consumer='dona-main'").get(checkpoint.message.message_id) as {event_id:string}).event_id;
  if(local)assert.ok(db.localDashboard.messagePrincipal(report));
  assert.equal(envelopeFromRow(db.get(report)!).source,"dona_message");
  await contexts.issue(db.beginDispatch(report,path.join(root,"report-result.json")));
  assert.equal((await client.getTaskReports(task.task_id,report)).attempt_id,job);
  if(local){assert.equal(db.get(report)?.reply_target_json,null);await assert.rejects(client.getTask(task.task_id,report));await assert.rejects(client.createTask({source_event_id:report,task_key:"other",objective:"別作業",workspace:{kind:"scratch"}}));}
  assert.equal(db.workerMessages.publishDueSilenceEvents(100,new Date(Date.now()+1000000)),1);
  const silence=(sql.prepare("SELECT event_id FROM events WHERE source='dona_message' AND event_type='worker_message_silence' AND json_extract(payload_json,'$.job_id')=?").get(job) as {event_id:string}).event_id;
  assert.equal(envelopeFromRow(db.get(silence)!).type,"worker_message_silence");
  const issued=await contexts.issue(db.beginDispatch(silence,path.join(root,"silence-result.json")));assert.equal(issued.purpose,local?"worker_report_local":"worker_report");
  assert.equal((await client.getTaskReports(task.task_id,silence)).attempt_id,job);
  await assert.rejects(client.instructTask(task.task_id,task.revision,{schema_version:1,source_event_id:silence,producer_sequence:2,idempotency_key:"unbound",occurred_at:new Date().toISOString(),payload:{operation:"add_condition",text:"scopeを変更"}}));
  // 新しいreportが来たら古いsilenceのcontextを再利用できない。
  db.acceptTaskWorkerReport(job,"identity",{schema_version:1,source_event_id:source,producer_sequence:2,idempotency_key:"newer",occurred_at:new Date().toISOString(),payload:{kind:"risk",summary:"確認が必要です",severity:"high"}});
  await assert.rejects(client.getTaskReports(task.task_id,silence));
  if(local){
   const question=db.acceptTaskWorkerReport(job,"identity",{schema_version:1,source_event_id:source,producer_sequence:3,idempotency_key:"question",occurred_at:new Date().toISOString(),payload:{kind:"question",question:"継続できますか？"}});
   assert.equal(db.workerMessages.publishPendingReports(),2);
   const event=(sql.prepare("SELECT event_id FROM worker_message_deliveries WHERE message_id=? AND consumer='dona-main'").get(question.message.message_id) as {event_id:string}).event_id;
   await contexts.issue(db.beginDispatch(event,path.join(root,"question-result.json")));const read=await client.getTaskReports(task.task_id,event);
   await client.instructTask(task.task_id,read.revision as number,{schema_version:1,source_event_id:event,producer_sequence:1,idempotency_key:"answer",occurred_at:new Date().toISOString(),correlation_message_id:question.message.message_id,conversation_revision:1,payload:{operation:"answer",text:"元scopeで継続してください"}});
  }
 }finally{await api.stop();sql.close();db.close();await fs.rm(root,{recursive:true,force:true});}
});

for(const action of ["pause","cancel"] as const)test(`queue後の${action}はattempt_unavailableを返し要求を残さない`,async()=>{
 const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath);try{
  const source=db.enqueue(eventEnvelope("invalidate-"+action)).row,task=db.tasks.create(taskRequestSchema.parse({source_event_id:source.event_id,task_key:"invalidate",objective:"調査する",workspace:{kind:"scratch"}}),config.jobsWorkspaceRoot,config.jobResultsDir).task,job=db.getJob(task.current_attempt_id)!;
  db.beginJobPreparation(job.job_id);db.setJobRuntime(job.job_id,"workspace","pane",JSON.stringify(["generation","thread"]));db.beginJobDispatch(job.job_id);db.markJobRunning(job.job_id);
  db.tasks.control(task.task_id,source.event_id,db.tasks.get(task.task_id)!.revision,action);
  let pending=true;const responses:unknown[]=[];
  class Port extends RuntimeClient{
   constructor(){super("unused");}
   override async workerReportAvailability(enabled:boolean){return {enabled,ttl_ms:30000};}
   override async workerReports(){return pending?[{request_id:"request",agent:job.agent_name,generation:"generation",thread_id:"thread",turn_id:"turn",call_id:"call",rpc_id_json:'"rpc"',attempt_id:job.job_id,report_key:"key",request_sequence:1,payload_json:stableStringify({report_key:"key",payload:{kind:"checkpoint",summary:"確認しました"}}),payload_sha256:"hash",created_at:new Date().toISOString(),state:"pending" as const,result_json:null}]:[];}
   override async resolveWorkerReport(_name:string,_id:string,result:unknown){responses.push(result);pending=false;return {};}
   override async status():Promise<never>{throw Error("無効Attemptのruntime観測をしてはいけない");}
  }
  const bridge=new AppServerWorkerReportBridge(db,new Port());assert.equal(await bridge.runOnce(),0);assert.equal(pending,false);assert.deepEqual(responses,[{state:"denied",diagnostic:"attempt_unavailable"}]);assert.equal(await bridge.runOnce(),0);assert.deepEqual(db.workerMessages.reports(job.job_id,source.event_id),[]);
 }finally{db.close();await fs.rm(root,{recursive:true,force:true});}
});


for(const pause of [false,true])test(`型付き質問待ちの停止操作と受理不明を区別する（pause=${pause}）`,async()=>{
 const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath);
 try{
  const envelope=eventEnvelope("typed-pause"),source=db.enqueue(envelope).row;
  const task=db.tasks.create(taskRequestSchema.parse({source_event_id:source.event_id,task_key:"pause",objective:"調査する",workspace:{kind:"scratch"}}),config.jobsWorkspaceRoot,config.jobResultsDir).task;
  const job=db.getJob(task.current_attempt_id)!;
  db.beginJobPreparation(job.job_id);db.setJobRuntime(job.job_id,"workspace","pane","runtime");db.beginJobDispatch(job.job_id);db.markJobRunning(job.job_id);
  db.workerMessages.appendWorkerReport(job.job_id,"runtime",{schema_version:1,source_event_id:source.event_id,producer_sequence:1,idempotency_key:"question",occurred_at:new Date().toISOString(),payload:{kind:"question",question:"継続できますか？"}});
  assert.equal(db.tasks.mayNotify(db.getJob(job.job_id)!),false);
  if(pause){db.tasks.control(task.task_id,source.event_id,db.tasks.get(task.task_id)!.revision,"pause");assert.equal(db.tasks.get(task.task_id)?.desired_state,"paused");return;}
  db.markWorkerInstructionUnknown(job.job_id,"instruction-test");
  assert.equal(db.tasks.get(task.task_id)?.wait_reason,"external_effect_unknown");assert.equal(db.tasks.mayNotify(db.getJob(job.job_id)!),true);
  const revision=db.tasks.get(task.task_id)!.revision;db.markWorkerInstructionUnknown(job.job_id,"instruction-test");assert.equal(db.tasks.get(task.task_id)!.revision,revision);
  const prompt=buildEventPrompt(source.event_id,path.join(root,"result.json"),envelope);assert.match(prompt,/get_task_reportsのpending_question/);assert.match(prompt,/instruct_taskのanswer/);
 }finally{db.close();await fs.rm(root,{recursive:true,force:true});}
});


test("不明な指示は再送せず、現行runtimeの相関reportで配送を照合する",async()=>{
 const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath);
 try{
  const source=db.enqueue(eventEnvelope("unknown-recovery")).row;
  const task=db.tasks.create(taskRequestSchema.parse({source_event_id:source.event_id,task_key:"recovery",objective:"調査する",workspace:{kind:"scratch"}}),config.jobsWorkspaceRoot,config.jobResultsDir).task;
  const job=db.getJob(task.current_attempt_id)!,identity=JSON.stringify(["generation","thread"]);
  db.beginJobPreparation(job.job_id);db.setJobRuntime(job.job_id,"workspace","pane",identity);db.beginJobDispatch(job.job_id);db.markJobRunning(job.job_id);
  const question=db.workerMessages.appendWorkerReport(job.job_id,identity,{schema_version:1,source_event_id:source.event_id,producer_sequence:1,idempotency_key:"question",occurred_at:new Date().toISOString(),payload:{kind:"question",question:"継続できますか？"}});
  const instruction=db.workerMessages.appendInstruction(job.job_id,{schema_version:1,source_event_id:source.event_id,producer_sequence:1,idempotency_key:"answer",occurred_at:new Date().toISOString(),correlation_message_id:question.message.message_id,conversation_revision:1,payload:{operation:"answer",text:"元の範囲で継続してください"}});
  class UnknownRuntime extends RuntimeClient {
   constructor(){super("unused");}
   override async workerInstructionReceipt(){return {state:"unknown" as const};}
   override async workerInstruction():Promise<never>{throw Error("不明な指示を再送してはいけない");}
  }
  const bridge=new WorkerInstructionBridge(db.workerMessages,new AppServerWorkerInstructionController(db,new UnknownRuntime()));
  await assert.rejects(bridge.runOnce(),/acceptance_unknown/);assert.equal(db.tasks.get(task.task_id)?.wait_reason,"external_effect_unknown");
  assert.equal(db.workerMessages.instructionReceived(job.job_id,instruction.message.message_id,identity),false);
  db.acceptTaskWorkerReport(job.job_id,identity,{schema_version:1,source_event_id:source.event_id,producer_sequence:2,idempotency_key:"received",occurred_at:new Date().toISOString(),correlation_message_id:instruction.message.message_id,conversation_revision:1,payload:{kind:"checkpoint",summary:"回答を受け取りました"}});
  assert.equal(db.workerMessages.instructionReceived(job.job_id,instruction.message.message_id,JSON.stringify(["other-generation","thread"])),false);
  assert.equal(await bridge.runOnce(new Date(Date.now()+300001)),true);
  assert.equal(db.tasks.get(task.task_id)?.state,"active");assert.equal(db.tasks.get(task.task_id)?.wait_reason,null);assert.equal(db.getJob(job.job_id)?.status,"running");
 }finally{db.close();await fs.rm(root,{recursive:true,force:true});}
});


for(const code of ["runtime_question_pending","runtime_external_approval_pending"])test(`型付きquestionは既存waitを置き換えない（${code}）`,async()=>{
 const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath);
 try{
  const source=db.enqueue(eventEnvelope("existing-wait")).row;
  const task=db.tasks.create(taskRequestSchema.parse({source_event_id:source.event_id,task_key:"wait",objective:"調査する",workspace:{kind:"scratch"}}),config.jobsWorkspaceRoot,config.jobResultsDir).task,job=db.getJob(task.current_attempt_id)!;
  db.beginJobPreparation(job.job_id);db.setJobRuntime(job.job_id,"workspace","pane","runtime");db.beginJobDispatch(job.job_id);db.markJobRunning(job.job_id);db.markJobBlocked(job.job_id,"既存の待機",["running"],code);
  assert.throws(()=>db.acceptTaskWorkerReport(job.job_id,"runtime",{schema_version:1,source_event_id:source.event_id,producer_sequence:1,idempotency_key:"question",occurred_at:new Date().toISOString(),payload:{kind:"question",question:"続行できますか？"}}),/existing worker wait/);
  assert.equal(db.getJob(job.job_id)?.last_error_code,code);assert.equal(db.workerMessages.hasUnansweredQuestion(job.job_id),false);
  assert.throws(()=>db.acceptTaskWorkerReport(job.job_id,"runtime",{schema_version:1,source_event_id:source.event_id,producer_sequence:1,idempotency_key:"secret",occurred_at:new Date().toISOString(),payload:{kind:"checkpoint",summary:"sk-proj-canary0123456789abcdef"}}),/credential-shaped/);
  assert.equal(db.workerMessages.reports(job.job_id,source.event_id).length,0);
 }finally{db.close();await fs.rm(root,{recursive:true,force:true});}
});


test("最新20件から外れたevent対象riskの本文を必ず返す",async()=>{
 const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath);
 try{
  const authority={instance_id:"instance",owner_id:"owner",device_id:"device",grant_revision:1};
  const created=db.createLocalDashboardTask(authority,{request_id:"old-report",objective:"調査する",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir),job=created.row;
  db.beginJobPreparation(job.job_id);db.setJobRuntime(job.job_id,"w","p","runtime");db.beginJobDispatch(job.job_id);db.markJobRunning(job.job_id);
  for(let i=1;i<=21;i++)db.workerMessages.appendWorkerReport(job.job_id,"runtime",{schema_version:1,source_event_id:job.source_event_id,producer_sequence:i,idempotency_key:"risk-"+i,occurred_at:new Date().toISOString(),payload:{kind:"risk",severity:"high",summary:"確認事項 "+i}});
  assert.equal(db.workerMessages.publishPendingReports(),21);
  const receipt=db.workerMessages.reconcileWorker(job.job_id,job.source_event_id,"runtime","risk-1") as {delivery:{delivery_id:string}};
  const Sqlite=(await import("better-sqlite3")).default,sql=new Sqlite(config.databasePath);
  const eventId=(sql.prepare("SELECT event_id FROM worker_message_deliveries WHERE delivery_id=?").get(receipt.delivery.delivery_id) as {event_id:string}).event_id;sql.close();
  const reports=db.taskReports(created.task.task_id,eventId);assert.equal(reports.reports.length,20);assert.equal(reports.event_report?.payload.summary,"確認事項 1");
 }finally{db.close();await fs.rm(root,{recursive:true,force:true});}
});

test("未配送の追加指示と、その受理より古いResultではTaskを完了しない",async()=>{
 const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath);
 try{
  const source=db.enqueue(eventEnvelope("result-fence")).row,task=db.tasks.create(taskRequestSchema.parse({source_event_id:source.event_id,task_key:"result-fence",objective:"調査する",workspace:{kind:"scratch"}}),config.jobsWorkspaceRoot,config.jobResultsDir).task,job=db.getJob(task.current_attempt_id)!;
  db.beginJobPreparation(job.job_id);db.setJobRuntime(job.job_id,"w","p","runtime");db.beginJobDispatch(job.job_id);db.markJobRunning(job.job_id);
  const old={schema_version:1 as const,job_id:job.job_id,status:"completed" as const,summary:"以前の調査が完了しました",completed_at:"2026-01-01T00:00:00Z"};
  db.workerMessages.appendInstruction(job.job_id,{schema_version:1,source_event_id:source.event_id,producer_sequence:1,idempotency_key:"condition",occurred_at:new Date().toISOString(),payload:{operation:"add_condition",text:"追加の検証も実施してください"}});
  assert.throws(()=>db.saveJobResult(job.job_id,old,job.result_path),/delivery_pending/);assert.equal(db.tasks.get(task.task_id)?.state,"active");
  await fs.mkdir(path.dirname(job.result_path),{recursive:true});await fs.writeFile(job.result_path,JSON.stringify(old));
  const never=async()=>{throw Error("保留Resultがworkerを停止・再起動してはいけない");};
  const runtime:JobAgentRuntime={prepare:never,prompt:never,get:never,wait:never,cancel:never,observeWorker:never,retireWorker:never};
  const supervisor=new JobSupervisor(db,runtime,config,{debug(){},info(){},warn(){},error(){}},()=>{});
  // Exercise the same idle-worker completion path as monitor, before typed delivery.
  assert.equal(await (supervisor as unknown as {tryComplete(row:JobRow,terminal:boolean):Promise<boolean>}).tryComplete(job,true),false);
  assert.equal(db.getJob(job.job_id)?.status,"running");assert.equal(db.tasks.get(task.task_id)?.wait_reason,"worker_instruction_delivery_pending");
  await new WorkerInstructionBridge(db.workerMessages,{async steer(){return {};}}).runOnce();
  assert.throws(()=>db.saveJobResult(job.job_id,old,job.result_path),/result_stale/);
  assert.equal(await (supervisor as unknown as {tryComplete(row:JobRow,terminal:boolean):Promise<boolean>}).tryComplete(db.getJob(job.job_id)!,true),false);
  assert.equal(db.tasks.get(task.task_id)?.wait_reason,"worker_instruction_result_pending");
  await new Promise(resolve=>setTimeout(resolve,5));await fs.writeFile(job.result_path,JSON.stringify({...old,completed_at:new Date().toISOString()}));
  db.tasks.wait(db.tasks.get(task.task_id)!,"worker_instruction_result_pending",-1);await supervisor.reconcileTasks();assert.equal(db.tasks.get(task.task_id)?.state,"completed");
 }finally{db.close();await fs.rm(root,{recursive:true,force:true});}
});


for(const code of ["runtime_question_pending","runtime_external_approval_pending"])test(`native待機中の指示をclaimせず、確定未送信を受理不明にしない（${code}）`,async()=>{
 const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath);
 try{
  const source=db.enqueue(eventEnvelope("native-instruction-wait")).row,task=db.tasks.create(taskRequestSchema.parse({source_event_id:source.event_id,task_key:"native-wait",objective:"調査する",workspace:{kind:"scratch"}}),config.jobsWorkspaceRoot,config.jobResultsDir).task,job=db.getJob(task.current_attempt_id)!,identity=JSON.stringify(["generation","thread"]);
  db.beginJobPreparation(job.job_id);db.setJobRuntime(job.job_id,"w","p",identity);db.beginJobDispatch(job.job_id);db.markJobRunning(job.job_id);
  const instruction=db.workerMessages.appendInstruction(job.job_id,{schema_version:1,source_event_id:source.event_id,producer_sequence:1,idempotency_key:"condition",occurred_at:new Date().toISOString(),payload:{operation:"add_condition",text:"検証結果も残してください"}});
  db.markJobBlocked(job.job_id,"native待機",["running"],code);db.tasks.wait(db.tasks.get(task.task_id)!,"human_input");
  assert.equal(db.workerMessages.claimNextWorkerInstruction("test-owner",300000),undefined);
  class WaitingRuntime extends RuntimeClient {constructor(){super("unused");}override async workerInstructionReceipt(){return {state:"not_found" as const};}override async workerInstruction():Promise<never>{throw new RuntimeResponseError("runtime_not_ready",409);}}
  const controller=new AppServerWorkerInstructionController(db,new WaitingRuntime());
  await assert.rejects(controller.steer(job.job_id,source.event_id,db.workerMessages.instructionForDelivery(job.job_id,source.event_id,instruction.message.message_id),instruction.message.message_id),/runtime_not_ready/);
  assert.equal(db.getJob(job.job_id)?.last_error_code,code);assert.equal(db.tasks.get(task.task_id)?.wait_reason,"human_input");
 }finally{db.close();await fs.rm(root,{recursive:true,force:true});}
});
