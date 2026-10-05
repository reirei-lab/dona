import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {test} from "node:test";
import {RuntimeResponseError} from "../src/app-server/client.js";
import {jobProgressPath} from "../src/job-prompt.js";
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


test("既存workspace・成果・進捗directoryの権限を再正規化して引継ぎ内容を保持する",async()=>{
 const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath),runtime=new AppServerJobRuntime(config);
 try{
  config.jobCommandTimeoutMs=5000;config.codexPath=path.join(root,"codex-stub");await fs.writeFile(config.codexPath,"#!/bin/sh\ncat >/dev/null\necho '[]'\n",{mode:0o700});
  const event=db.enqueue(eventEnvelope("private-continuation")).row;
  const original=db.createJob({source_event_id:event.event_id,objective:"test",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
  const job={...original,job_id:"job_"+"1".repeat(26),workspace_json:JSON.stringify({kind:"scratch",_dona_handoff:{workspace_job_id:original.job_id}})};
  job.result_path=path.join(config.jobResultsDir,job.job_id,"result.json");
  const directories=[config.jobsWorkspaceRoot,job.workspace_path,path.dirname(job.result_path),path.dirname(jobProgressPath(job))];
  for(const directory of directories){await fs.mkdir(directory,{recursive:true});await fs.chmod(directory,0o777);}
  await fs.writeFile(path.join(job.workspace_path,"kept"),"uncommitted work");
  runtime.client.start=async input=>{
   for(const directory of directories)assert.equal((await fs.stat(directory)).mode&0o777,0o700);
   return {name:input.name,generation:"g",thread_id:"t"} as AgentRecord;
  };
  await runtime.prepare(job);
  assert.equal(await fs.readFile(path.join(job.workspace_path,"kept"),"utf8"),"uncommitted work");
 }finally{db.close();await fs.rm(root,{recursive:true,force:true});}
});

test("mainの失敗turnはwaitで中断を返し、次eventは上限解除後に受け付ける",async()=>{
 const client=new AppServerAgentClient("unused","main",100);
 let agent={name:"main",role:"main",state:"interrupted",generation:"g",thread_id:"t",recovery_hint:{reason:"capacity_wait",retry_after:new Date(Date.now()+60000).toISOString()}} as AgentRecord;
 client.client.status=async()=>agent;
 assert.equal((await client.get()).errorCode,"runtime_capacity_wait");assert.equal((await client.wait()).errorCode,"runtime_turn_interrupted");
 agent={...agent,recovery_hint:{reason:"capacity_wait",retry_after:new Date(0).toISOString()}};
 assert.equal((await client.get()).ok,true);assert.equal((await client.get()).agentStatus,"idle");assert.equal((await client.wait()).errorCode,"runtime_turn_interrupted");
 for(const reason of ["authorization_required","configuration_error"] as const){agent={...agent,recovery_hint:{reason}};assert.equal((await client.get()).ok,true);}
});

for(const detached of [false,true])test(`GitHub継続は${detached?"detached HEAD":"作業用branch"}を保持してApp Serverの起動まで進む`,async()=>{
 const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath),runtime=new AppServerJobRuntime(config);
 try{
  config.jobCommandTimeoutMs=5000;config.codexPath=path.join(root,"codex-stub");await fs.writeFile(config.codexPath,"#!/bin/sh\ncat >/dev/null\necho '[]'\n",{mode:0o700});
  const source=db.enqueue(eventEnvelope(`continuation-${detached}`)).row;
  const old=db.createJob({source_event_id:source.event_id,objective:"実装",workspace:{kind:"github",repository:"owner/repo"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
  const repo=path.join(config.jobsWorkspaceRoot,"github","owner","repo","repository");await fs.mkdir(repo,{recursive:true});
  const git=(cwd:string,...args:string[])=>execFileSync(config.gitPath,["-C",cwd,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  git(repo,"init");git(repo,"-c","user.name=Test","-c","user.email=test@example.invalid","commit","--allow-empty","-m","base");git(repo,"remote","add","origin","https://github.com/owner/repo.git");git(repo,"worktree","add","-b","approval-operations",old.workspace_path);
  if(detached)git(old.workspace_path,"checkout","--detach");
  await fs.writeFile(path.join(old.workspace_path,"keep"),"unfinished work");
  const before=git(old.workspace_path,"status","--porcelain"),head=git(old.workspace_path,"rev-parse","HEAD"),branch=git(old.workspace_path,"rev-parse","--abbrev-ref","HEAD");
  const follow=db.enqueue(eventEnvelope(`continuation-follow-${detached}`)).row;
  const raw=db.createJob({source_event_id:follow.event_id,job_key:"continuation",objective:"続行",workspace:{kind:"github",repository:"owner/repo"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
  const next={...raw,workspace_path:old.workspace_path,workspace_json:JSON.stringify({...JSON.parse(raw.workspace_json),_dona_handoff:{predecessor_job_id:old.job_id,workspace_job_id:old.job_id}})};
  let starts=0;
  runtime.client.start=async input=>{starts++;assert.equal(input.cwd,old.workspace_path);assert.equal(input.attemptId,next.job_id);return {name:input.name,generation:"next",thread_id:"thread",config_json:JSON.stringify(input)} as AgentRecord;};
  const prepared=await runtime.prepare(next);assert.equal(starts,1);assert.equal(prepared.herdrAgentSessionId,JSON.stringify(["next","thread"]));
  assert.equal(git(old.workspace_path,"status","--porcelain"),before);assert.equal(git(old.workspace_path,"rev-parse","HEAD"),head);assert.equal(git(old.workspace_path,"rev-parse","--abbrev-ref","HEAD"),branch);assert.equal(await fs.readFile(path.join(old.workspace_path,"keep"),"utf8"),"unfinished work");
 }finally{db.close();await fs.rm(root,{recursive:true,force:true});}
});

test("launchdの最小PATHでもnpm版CodexのMCP inventoryを取得する",async()=>{
 const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath),runtime=new AppServerJobRuntime(config),saved=process.env.PATH;
 try{
  config.jobCommandTimeoutMs=5000;config.codexPath=path.join(root,"codex-node");
  await fs.writeFile(config.codexPath,"#!/usr/bin/env node\nprocess.stdout.write('[]');\n",{mode:0o700});
  const event=db.enqueue(eventEnvelope("minimal-path")).row;
  const job=db.createJob({source_event_id:event.event_id,objective:"test",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
  let starts=0;runtime.client.start=async input=>{starts++;return {name:input.name,generation:"g",thread_id:"t",state:"idle"} as AgentRecord;};
  process.env.PATH="/usr/bin:/bin:/usr/sbin:/sbin";
  await runtime.prepare(job);assert.equal(starts,1);assert.equal(process.env.PATH,"/usr/bin:/bin:/usr/sbin:/sbin");
 }finally{if(saved===undefined)delete process.env.PATH;else process.env.PATH=saved;db.close();await fs.rm(root,{recursive:true,force:true});}
});
