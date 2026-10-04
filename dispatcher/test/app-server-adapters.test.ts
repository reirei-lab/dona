import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {test} from "node:test";
import {RuntimeResponseError} from "../src/app-server/client.js";
import {PreparedWorkspaceCleanupError} from "../src/job-runtime.js";
import {AppServerJobRuntime,AppServerAgentClient} from "../src/app-server/adapters.js";
import type {AgentRecord} from "../src/app-server/store.js";
import type {JobRow} from "../src/types.js";
import {DispatcherDatabase} from "../src/database.js";
import {JobSupervisor} from "../src/job-supervisor.js";
import {tempConfig,eventEnvelope} from "./helpers.js";

test("取消のtransport例外を分類しcancellingに取り残さない",async()=>{
 const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath),runtime=new AppServerJobRuntime(config);
 const supervisor=new JobSupervisor(db,runtime,config,{debug(){},info(){},warn(){},error(){}},()=>{});
 try{
  for(const afterSend of [false,true]) {
   const event=db.enqueue(eventEnvelope(`cancel-${afterSend}`)).row;
   const job=db.createJob({source_event_id:event.event_id,objective:"test",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
   db.beginJobPreparation(job.job_id);db.setJobRuntime(job.job_id,"worker","worker");db.beginJobDispatch(job.job_id);db.markJobRunning(job.job_id);
   let sends=0;
   runtime.client.status=async()=>{if(!afterSend)throw Error("socket unavailable");return {generation:"g"} as AgentRecord;};
   runtime.client.stop=async()=>{sends++;throw Error("response lost");};
   await assert.rejects(supervisor.cancel(job.job_id,event.event_id,"test cancel"),/cancellation requires review/);
   assert.equal(db.getJob(job.job_id)?.status,"needs_review");assert.equal(db.getJob(job.job_id)?.last_error_code,afterSend?"cancel_acceptance_unknown":"cancel_not_sent");assert.equal(sends,afterSend?1:0);
  }
 }finally{db.close();await fs.rm(root,{recursive:true,force:true});}
});

test("scratch continuationの作業ディレクトリ消失・symlinkを拒否する",async()=>{
 const {root,config}=await tempConfig(),runtime=new AppServerJobRuntime(config),origin="job_"+"0".repeat(26),workspace=path.join(config.jobsWorkspaceRoot,"scratch",origin);
 const row={job_id:"job_"+"1".repeat(26),workspace_path:workspace,workspace_json:JSON.stringify({kind:"scratch",_dona_handoff:{workspace_job_id:origin}})} as JobRow;
 try{
  await assert.rejects(runtime.prepare(row));await assert.rejects(fs.stat(workspace),{code:"ENOENT"});
  await fs.mkdir(path.dirname(workspace),{recursive:true});await fs.symlink(root,workspace);await assert.rejects(runtime.prepare(row),/continuation_workspace_missing/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

for(const phase of ["accepted","no_thread","status_lost","not_sent"] as const)test(`worker start応答喪失の${phase}を分類し再送しない`,async()=>{
 const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath),runtime=new AppServerJobRuntime(config,true,undefined,()=>phase==="accepted");
 try{
  config.jobCommandTimeoutMs=5000;config.codexPath=path.join(root,"codex-stub");await fs.writeFile(config.codexPath,"#!/bin/sh\ncat >/dev/null\necho '[]'\n",{mode:0o700});
  const event=db.enqueue(eventEnvelope(phase)).row;
  const job=db.createJob({source_event_id:event.event_id,objective:"test",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
  let starts=0,agent:AgentRecord|null=null;
  runtime.client.start=async input=>{assert.equal(input.threadConfig.approvalsReviewer,"user");assert.equal(input.threadConfig.approvalPolicy,phase==="accepted"?undefined:"never");starts++;agent={name:input.name,role:"worker",cwd:input.cwd,generation:"accepted",thread_id:phase==="no_thread"?null:"thread",config_json:JSON.stringify(input)} as AgentRecord;throw Object.assign(Error("lost"),phase==="not_sent"?{code:"ECONNREFUSED"}:{});};
  runtime.client.status=async()=>{if(phase==="status_lost")throw Error("lost");return agent;};
  await assert.rejects(runtime.prepare(job),error=>{
   if(phase==="not_sent"){assert.match(String(error),/runtime_start_not_sent/);assert.equal(error instanceof PreparedWorkspaceCleanupError,false);}
   else {assert.ok(error instanceof PreparedWorkspaceCleanupError,String(error));assert.equal(error.errorCode,"runtime_preparation_unknown");assert.equal(error.herdrAgentSessionId,phase==="status_lost"?undefined:JSON.stringify(["accepted",phase==="no_thread"?null:"thread"]));}
   return true;
  });
  assert.equal(starts,1);
  runtime.client.status=async()=>agent;
  assert.equal((await runtime.reconcilePreparation(job))?.herdrAgentSessionId,JSON.stringify(["accepted",phase==="no_thread"?null:"thread"]));
  agent!.config_json=JSON.stringify({attemptId:"another"});assert.equal(await runtime.reconcilePreparation(job),undefined);
 }finally{db.close();await fs.rm(root,{recursive:true,force:true});}
});

test("schedule scratchは同じgenerationの停止確認後だけ削除し、Taskや別pathを保持する",async()=>{
 const {root,config}=await tempConfig(),runtime=new AppServerJobRuntime(config,true,()=>JSON.stringify(["g","t"]));
 const jobId="job_"+"0".repeat(26),workspace=path.join(config.jobsWorkspaceRoot,"scratch",jobId);
 const row={job_id:jobId,source:"dona_schedule",status:"completed",agent_name:"worker",herdr_workspace_id:"worker",herdr_pane_id:"worker",workspace_path:workspace,workspace_json:JSON.stringify({kind:"scratch"})} as JobRow;
 let stopped=false,sends=0;
 const agent={name:"worker",generation:"g",thread_id:"t",config_json:"{}",state:"idle"} as AgentRecord;
 runtime.client.status=async()=>({...agent,state:stopped?"stopped":"idle"});
 runtime.client.stop=async()=>{sends++;throw Error("unknown");};
 try{
  await fs.mkdir(workspace,{recursive:true});await fs.writeFile(path.join(workspace,"private-input"),"test");
  await assert.rejects(runtime.cleanup({...row,source:"slack"}));await assert.rejects(runtime.cleanup({...row,workspace_path:root}));assert.equal(sends,0);
  await assert.rejects(runtime.cleanup(row),/unknown/);assert.equal(await fs.readFile(path.join(workspace,"private-input"),"utf8"),"test");
  runtime.client.stop=async()=>{sends++;stopped=true;return {...agent,state:"stopped"};};
  assert.equal((await runtime.cleanup(row)).ok,true);await assert.rejects(fs.stat(workspace),{code:"ENOENT"});
  assert.equal((await runtime.cleanup(row)).ok,true);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test("thread作成前の回収identityは同じgenerationだけを停止できる",async()=>{
 const {root,config}=await tempConfig(),runtime=new AppServerJobRuntime(config,true,()=>JSON.stringify(["g",null]));
 const row={job_id:"job",agent_name:"worker",herdr_pane_id:"worker"} as JobRow;
 let generation="g",sends=0;
 runtime.client.status=async()=>({name:"worker",generation,thread_id:"later-thread",config_json:"{}"} as AgentRecord);
 runtime.client.stop=async(name,g)=>{assert.equal(g,"g");sends++;return {} as AgentRecord;};
 try{await runtime.retireWorker(row);assert.equal(sends,1);generation="new";await assert.rejects(runtime.retireWorker(row),/identity_changed/);assert.equal(sends,1);}
 finally{await fs.rm(root,{recursive:true,force:true});}
});

test("interruptedをidle成功に変換せず、PIDなし停止receiptを停止済みとして観測する",async()=>{
 const {root,config}=await tempConfig(),client=new AppServerAgentClient("unused","worker",100),runtime=new AppServerJobRuntime(config,true,()=>JSON.stringify(["g",null]));
 const agent={name:"worker",generation:"g",thread_id:null,pid:null,state:"interrupted",config_json:"{}"} as AgentRecord;
 client.client.status=async()=>agent;
 runtime.client.status=async()=>({...agent,state:"stopped"});
 try{
  assert.equal((await client.get()).ok,false);assert.equal((await client.get()).errorCode,"runtime_turn_interrupted");
  const observation=await runtime.observeWorker({job_id:"job",agent_name:"worker",herdr_workspace_id:"worker",herdr_pane_id:"worker"} as JobRow);
  assert.equal(observation.state,"stopped");assert.deepEqual(observation.process_ids,[]);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test("hostの確定未送信と受付不明・応答喪失を分離する",async()=>{
 const client=new AppServerAgentClient("unused","main",100);
 for(const [error,expected] of [
  [new RuntimeResponseError("runtime_not_ready",409),"agent_not_running"],
  [Object.assign(Error("refused"),{code:"ECONNREFUSED"}),"agent_not_running"],
  [new RuntimeResponseError("runtime_acceptance_unknown",409),"steer_acceptance_unknown"],
  [Object.assign(Error("lost"),{code:"ECONNRESET"}),"steer_acceptance_unknown"]
 ] as const){client.client.prompt=async()=>{throw error;};assert.equal((await client.submit("作業","key")).errorCode,expected);}
});

for(const hasSession of [true,false])test(`移行済みscheduleの${hasSession?"保存session":"session不明の停止receipt"}を使いcleanup失敗から回復する`,async()=>{
 const {root,config}=await tempConfig(),runtime=new AppServerJobRuntime(config,true,()=>hasSession?"old-thread":undefined);
 const jobId="job_"+"0".repeat(26),workspace=path.join(config.jobsWorkspaceRoot,"scratch",jobId);
 const row={job_id:jobId,source:"dona_schedule",status:"needs_review",last_error_code:"workspace_cleanup_failed",agent_name:"worker",herdr_workspace_id:"old-workspace",herdr_pane_id:"old-pane",workspace_path:workspace,workspace_json:JSON.stringify({kind:"scratch"})} as JobRow;
 const agent={name:"worker",generation:"migrated",thread_id:hasSession?"old-thread":null,state:"stopped",request_hash:"legacy-stopped",config_json:JSON.stringify({legacyWorkspaceId:"old-workspace",legacyPaneId:"old-pane"})} as AgentRecord;
 runtime.client.status=async()=>agent;runtime.client.stop=async()=>{throw Error("stopped generation must not receive stop again");};
 try{
  await fs.mkdir(workspace,{recursive:true});await fs.writeFile(path.join(workspace,"input"),"test");
  await assert.rejects(runtime.cleanup({...row,last_error_code:"invalid_result"}),/scope_invalid/);
  await assert.rejects(runtime.cleanup({...row,herdr_pane_id:"wrong"}),/identity_changed/);assert.equal(await fs.readFile(path.join(workspace,"input"),"utf8"),"test");
  assert.equal((await runtime.cleanup(row)).ok,true);await assert.rejects(fs.stat(workspace),{code:"ENOENT"});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
