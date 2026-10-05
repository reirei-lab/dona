import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import {test} from "node:test";
import {DispatcherDatabase} from "../src/database.js";
import {JobSupervisor} from "../src/job-supervisor.js";
import {AppServerJobRuntime} from "../src/app-server/adapters.js";
import {codexAgentArguments,type JobAgentRuntime} from "../src/job-runtime.js";
import {envelopeFromRow,buildEventPrompt} from "../src/prompt.js";
import {tempConfig,eventEnvelope} from "./helpers.js";
const authority={instance_id:"instance",owner_id:"operator",device_id:"device",grant_revision:1};
const input={request_id:"request",objective:"調査する",workspace:{kind:"scratch" as const}};
const logger={debug(){},info(){},warn(){},error(){}};
async function fixture(){const {root,config}=await tempConfig();const db=new DispatcherDatabase(config.databasePath);const created=db.createLocalDashboardTask(authority,input,config.jobsWorkspaceRoot,config.jobResultsDir);return {root,config,db,created,async dispose(){db.close();await fs.rm(root,{recursive:true,force:true});}};}

test("local ownerの作成receiptは再起動・response loss後も一意、再pair後も同operatorへ復元し別ownerは拒否する",async()=>{
 const f=await fixture();try{
  assert.equal(f.created.task.state,"active");assert.equal(f.created.row.status,"queued");assert.equal(f.db.hasLocalDashboardJobOwner(f.created.row.job_id),true);
  assert.equal(f.created.row.channel_id,null);assert.equal(f.created.row.thread_ts,null);
  assert.equal(f.db.createLocalDashboardTask({...authority,grant_revision:2},input,f.config.jobsWorkspaceRoot,f.config.jobResultsDir).outcome,"reused");
  assert.throws(()=>f.db.createLocalDashboardTask(authority,{...input,objective:"異内容"},f.config.jobsWorkspaceRoot,f.config.jobResultsDir),/conflict/);
  assert.equal(f.db.getLocalDashboardReceipt({...authority,device_id:"elsewhere"},input.request_id)?.task_id,f.created.task.task_id);
  assert.equal(f.db.getLocalDashboardReceipt({...authority,owner_id:"other"},input.request_id),undefined);
  assert.equal(f.db.getLocalDashboardReceipt({...authority,instance_id:"other"},input.request_id),undefined);
  const recovered=f.db.createLocalDashboardTask({...authority,device_id:"repaired"},input,f.config.jobsWorkspaceRoot,f.config.jobResultsDir);
  assert.equal(recovered.outcome,"reused");assert.equal(recovered.receipt.device_id,authority.device_id);
  const reopened=new DispatcherDatabase(f.config.databasePath);try{assert.equal(reopened.getLocalDashboardReceipt(authority,input.request_id)?.task_id,f.created.task.task_id);assert.equal(reopened.createLocalDashboardTask(authority,input,f.config.jobsWorkspaceRoot,f.config.jobResultsDir).row.job_id,f.created.row.job_id);}finally{reopened.close();}
 }finally{await f.dispose();}
});
test("cancelはowner/currentAttempt/revisionを検証しterminal後も同じreceiptを再生する",async()=>{
 const f=await fixture();try{
  const cancel={request_id:"cancel",task_id:f.created.task.task_id,attempt_id:f.created.row.job_id,revision:f.created.task.revision};
  assert.throws(()=>f.db.cancelLocalDashboardTask({...authority,owner_id:"other"},cancel),/owner_mismatch/);
  assert.throws(()=>f.db.cancelLocalDashboardTask(authority,{...cancel,revision:99}),/revision_conflict/);
  assert.equal(f.db.getLocalDashboardReceipt(authority,"cancel"),undefined);
  const result=f.db.cancelLocalDashboardTask({...authority,device_id:"second-device"},cancel);assert.equal(result.task.state,"cancelled");
  assert.equal(f.db.cancelLocalDashboardTask({...authority,device_id:"second-device"},cancel).outcome,"reused");
  assert.throws(()=>f.db.cancelLocalDashboardTask({...authority,device_id:"second-device"},{...cancel,revision:2}),/conflict/);
 }finally{await f.dispose();}
});
test("旧Web受付はblockedのまま、durable local bindingがあるJobのみ通常profileを選べる",async()=>{
 const f=await fixture();try{
  const old=f.db.createWebTask({instance_id:"old",tenant_id:"tenant",principal_id:"principal",idempotency_key:"a".repeat(64),objective:"old",workspace:{kind:"scratch"}},f.config.jobsWorkspaceRoot,f.config.jobResultsDir);
  assert.equal(f.db.hasLocalDashboardJobOwner(old.row.job_id),false);assert.equal(old.task?.wait_reason,"runtime_profile_unavailable");
  const runtime=new AppServerJobRuntime(f.config,false,undefined,id=>!!f.db.tasks.forAttempt(id),id=>f.db.hasLocalDashboardJobOwner(id));
  await assert.rejects(runtime.prepare(old.row),/runtime_profile_unavailable/);
  assert.throws(()=>codexAgentArguments(f.created.row,f.config),/runtime_profile_unavailable/);
  assert.ok(codexAgentArguments(f.created.row,f.config,[],false,[],f.db.hasLocalDashboardJobOwner(f.created.row.job_id)).includes("--add-dir"));
 }finally{await f.dispose();}
});
test("停止確認後の後継Attemptはlocalownerを保持し、worker questionをmain内部eventへ配送",async()=>{
 const f=await fixture();try{
  const job=f.created.row;f.db.beginJobPreparation(job.job_id,new Date(job.available_at));f.db.setJobRuntime(job.job_id,"w","p",JSON.stringify(["g","t"]));f.db.beginJobDispatch(job.job_id);f.db.markJobRunning(job.job_id);f.db.markJobNeedsReview(job.job_id,"result_missing","interrupted");
  await fs.mkdir(job.workspace_path,{recursive:true});
  let stopped=false;
  const runtime:JobAgentRuntime={async prepare(){throw Error("unexpected");},async prompt(){throw Error("unexpected");},async get(){throw Error("unexpected");},async wait(){throw Error("unexpected");},async cancel(){throw Error("unexpected");},async observeWorker(){return {state:"inactive",reason:"agent_idle",observed_at:new Date().toISOString(),process_ids:[1],process_groups:[1]};},async retireWorker(){stopped=true;},async workerRetired(){return stopped;}};
  const supervisor=new JobSupervisor(f.db,runtime,f.config,logger,()=>{});await supervisor.reconcileTasks();
  const task=f.db.tasks.get(f.created.task.task_id)!;assert.equal(task.attempt_number,2);assert.notEqual(task.current_attempt_id,job.job_id);assert.equal(f.db.hasLocalDashboardJobOwner(task.current_attempt_id),true);
  const next=f.db.getJob(task.current_attempt_id)!;f.db.beginJobPreparation(next.job_id,new Date(next.available_at));f.db.setJobRuntime(next.job_id,"w2","p2",JSON.stringify(["g2","t2"]));f.db.beginJobDispatch(next.job_id);f.db.markJobRunning(next.job_id);
  const question={question_id:"q",agent:next.agent_name,generation:"g2",thread_id:"t2",turn_id:"turn",rpc_id_json:"1",kind:"question" as const,payload_json:"{}",state:"pending" as const,answer_hash:null,created_at:new Date().toISOString()};
  f.db.enqueueWorkerQuestion(next.job_id,question);f.db.enqueueWorkerQuestion(next.job_id,question);
  const events=f.db.list().filter(e=>e.event_type==="worker_question");assert.equal(events.length,1);const event=events[0]!;assert.equal(event.source,"web");assert.equal(event.reply_target_json,null);assert.equal(f.db.tasks.get(task.task_id)?.wait_reason,"human_input");
  assert.equal(f.db.tasks.assertOwner(task.task_id,event.event_id).task_id,task.task_id);
  const unrelated=f.db.enqueue(eventEnvelope("unrelated")).row;assert.throws(()=>f.db.tasks.assertOwner(task.task_id,unrelated.event_id),/owner_mismatch/);
  assert.match(buildEventPrompt(event.event_id,"/tmp/result",envelopeFromRow(event)),/get_task_questions/);
  let answered=0;runtime.questions=async()=>[question];runtime.answerQuestion=async()=>{answered++;return {...question,state:"resolved"};};
  await supervisor.answerTaskQuestion(task.task_id,event.event_id,f.db.tasks.get(task.task_id)!.revision,"q",{q:{answers:["調査を継続"]}});assert.equal(answered,1);
 }finally{await f.dispose();}
});

test("local native approvalは人間の保存済みexact decisionだけをmainから配送する",async()=>{
 const f=await fixture();try{
  const job=f.created.row;f.db.beginJobPreparation(job.job_id,new Date(job.available_at));f.db.setJobRuntime(job.job_id,"w","p",JSON.stringify(["g","t"]));f.db.beginJobDispatch(job.job_id);f.db.markJobRunning(job.job_id);
  const question={question_id:"approval",agent:job.agent_name,generation:"g",thread_id:"t",turn_id:"turn",rpc_id_json:"1",kind:"approval" as const,payload_json:"{}",state:"pending" as const,answer_hash:null,created_at:new Date().toISOString()};
  f.db.enqueueWorkerQuestion(job.job_id,question);const notice=f.db.list().find(e=>e.event_type==="worker_question")!;
  const revision=f.db.tasks.get(f.created.task.task_id)!.revision;let sent=0;
  const runtime:JobAgentRuntime={async prepare(){throw Error("unexpected");},async prompt(){throw Error("unexpected");},async get(){throw Error("unexpected");},async wait(){throw Error("unexpected");},async cancel(){throw Error("unexpected");},async questions(){return [question];},async approveRequest(){sent++;return {...question,state:"resolved"};}};
  const supervisor=new JobSupervisor(f.db,runtime,f.config,logger,()=>{});
  await assert.rejects(supervisor.approveTaskRequest(f.created.task.task_id,notice.event_id,revision,"approval",true),/requires_user_reply/);
  const reply={request_id:"approve",task_id:f.created.task.task_id,attempt_id:job.job_id,revision,question_id:"approval",kind:"approval" as const,accepted:false};
  assert.throws(()=>f.db.enqueueLocalDashboardQuestionReply(authority,{...reply,revision:999}),/not_current/);
  const created=f.db.enqueueLocalDashboardQuestionReply(authority,reply);
  assert.equal(f.db.enqueueLocalDashboardQuestionReply(authority,reply).outcome,"reused");
  assert.throws(()=>f.db.enqueueLocalDashboardQuestionReply(authority,{...reply,accepted:true}),/conflict/);
  assert.throws(()=>f.db.enqueueLocalDashboardQuestionReply(authority,{...reply,request_id:"second",accepted:true}),/already_answered/);
  const eventId=created.receipt.event_id;assert.equal(envelopeFromRow(f.db.get(eventId)!).type,"worker_question_reply");
  await assert.rejects(supervisor.approveTaskRequest(f.created.task.task_id,eventId,revision,"approval",true),/requires_user_reply/);
  await supervisor.approveTaskRequest(f.created.task.task_id,eventId,revision,"approval",false);assert.equal(sent,1);
 }finally{await f.dispose();}
});

test("durable local TaskからApp Serverの開始まで接続しworkerの対話はmain仲介に限定",async()=>{
 const f=await fixture();try{
  f.config.codexPath=f.root+"/codex-stub";f.config.jobCommandTimeoutMs=5000;
  await fs.writeFile(f.config.codexPath,"#!/bin/sh\ncat >/dev/null\necho '[]'\n",{mode:0o700});
  const runtime=new AppServerJobRuntime(f.config,false,undefined,id=>!!f.db.tasks.forAttempt(id),id=>f.db.hasLocalDashboardJobOwner(id));let starts=0;
  runtime.client.start=async input=>{starts++;assert.equal(input.attemptId,f.created.row.job_id);assert.equal((input.threadConfig.config as Record<string,unknown>)["features.default_mode_request_user_input"],true);assert.equal(input.threadConfig.approvalPolicy,undefined);assert.match(String(input.threadConfig.developerInstructions),/親Dona/);return {name:input.name,role:"worker",cwd:input.cwd,generation:"g",thread_id:"t",config_json:JSON.stringify(input)} as import("../src/app-server/store.js").AgentRecord;};
  const prepared=await runtime.prepare(f.created.row);assert.equal(prepared.herdrAgentSessionId,JSON.stringify(["g","t"]));assert.equal(starts,1);
 }finally{await f.dispose();}
});

test("running Taskのcancel受理は停止完了と区別し、不明な停止を再送しない",async()=>{
 const f=await fixture();try{
  const job=f.created.row;f.db.beginJobPreparation(job.job_id,new Date(job.available_at));f.db.setJobRuntime(job.job_id,"w","p");f.db.beginJobDispatch(job.job_id);f.db.markJobRunning(job.job_id);
  const reply=f.db.cancelLocalDashboardTask(authority,{request_id:"running-cancel",task_id:f.created.task.task_id,attempt_id:job.job_id,revision:f.db.tasks.get(f.created.task.task_id)!.revision});
  assert.equal(reply.task.desired_state,"cancelled");assert.equal(reply.task.state,"waiting");assert.equal(f.db.getJob(job.job_id)!.status,"running");
  let stops=0,confirmed=false;
  const runtime:JobAgentRuntime={async prepare(){throw Error("unexpected");},async prompt(){throw Error("unexpected");},async get(){throw Error("unexpected");},async wait(){throw Error("unexpected");},async cancel(){throw Error("unexpected");},async observeWorker(){return {state:"working",reason:"agent_working",observed_at:new Date().toISOString(),process_ids:[1],process_groups:[1]};},async retireWorker(){stops++;throw Error("response lost");},async workerRetired(){return confirmed;}};
  await new JobSupervisor(f.db,runtime,f.config,logger,()=>{}).reconcileTasks();assert.equal(stops,1);assert.notEqual(f.db.tasks.get(reply.task.task_id)!.state,"cancelled");
  confirmed=true;const current=f.db.tasks.get(reply.task.task_id)!;f.db.tasks.wait(current,current.wait_reason!,-1);
  await new JobSupervisor(f.db,runtime,f.config,logger,()=>{}).reconcileTasks();assert.equal(stops,1);assert.equal(f.db.tasks.get(reply.task.task_id)!.state,"cancelled");
 }finally{await f.dispose();}
});


test("receipt保存に失敗したcreateはevent・Job・Taskを一緒にrollbackする",async()=>{
 const f=await fixture();const sql=new Database(f.config.databasePath);try{
  sql.exec("CREATE TRIGGER test_receipt_failure BEFORE INSERT ON local_dashboard_command_receipts BEGIN SELECT RAISE(ABORT,'simulated_receipt_failure'); END");
  const before={events:f.db.list().length,tasks:f.db.tasks.scanSnapshot().length};
  assert.throws(()=>f.db.createLocalDashboardTask(authority,{...input,request_id:"second"},f.config.jobsWorkspaceRoot,f.config.jobResultsDir),/simulated_receipt_failure/);
  assert.equal(f.db.list().length,before.events);assert.equal(f.db.tasks.scanSnapshot().length,before.tasks);assert.equal(f.db.getLocalDashboardReceipt(authority,"second"),undefined);
 }finally{sql.close();await f.dispose();}
});

test("旧device別receiptが同じrequest IDで重複する場合は推測せず停止する",async()=>{
 const f=await fixture(),sql=new Database(f.config.databasePath);try{
  sql.prepare(`INSERT INTO local_dashboard_command_receipts SELECT 'legacy-duplicate',instance_id,owner_id,'legacy-device',grant_revision,request_id,operation,canonical_sha256,task_id,attempt_id,task_revision,event_id,created_at FROM local_dashboard_command_receipts LIMIT 1`).run();
  assert.throws(()=>f.db.getLocalDashboardReceipt(authority,input.request_id),/receipt_ambiguous/);
  assert.throws(()=>f.db.createLocalDashboardTask(authority,input,f.config.jobsWorkspaceRoot,f.config.jobResultsDir),/receipt_ambiguous/);
  assert.equal(f.db.tasks.scanSnapshot().length,1);
 }finally{sql.close();await f.dispose();}
});
