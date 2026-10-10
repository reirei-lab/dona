import assert from "node:assert/strict";
import {createHash,createHmac} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {test} from "node:test";
import Database from "better-sqlite3";
import {DispatcherDatabase} from "../src/database.js";
import {DispatcherApi} from "../src/api.js";
import {DispatcherApiClient} from "../src/client.js";
import {AgentContextManager} from "../src/agent-context.js";
import {JobSupervisor} from "../src/job-supervisor.js";
import type {JobAgentRuntime} from "../src/job-runtime.js";
import {principalProofKeyId,verifySlackPrincipalProof} from "../src/principal-proof.js";
import {stableStringify} from "../src/validation.js";
import {taskRequestSchema} from "../src/task-execution.js";
import {eventEnvelope,tempConfig} from "./helpers.js";

const logger={debug(){},info(){},warn(){},error(){}};
async function fixture(){
 const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath),sql=new Database(config.databasePath);
 config.ghPath=path.join(root,"github-fixture");
 await fs.writeFile(config.ghPath,'#!/usr/bin/env node\nconst n=Number(process.argv.find(a=>a.startsWith("number=")).slice(7));console.log(JSON.stringify({data:{repository:{nameWithOwner:"org/repo",issue:{id:"I_"+n,number:n}}}}));\n',{mode:0o700});
 const contexts=new AgentContextManager(db,path.join(path.dirname(config.socketPath),"status-context.json"));
 const worker={isRunning:()=>true,wake(){},async steer(){throw Error("not used");},async cancel(){throw Error("not used");}};
 const api=new DispatcherApi(db,worker,worker,config,logger,undefined,undefined,undefined,undefined,undefined,undefined,undefined,contexts);
 await api.start();const client=new DispatcherApiClient(config.socketPath);
 function event(id:string,channel="C_TEST",actor="U_TEST",workspace="T_TEST",proof=true){
  const e=eventEnvelope(id);e.subject.channel_id=channel;e.reply_target!.channel_id=channel;e.subject.actor_id=actor;e.subject.workspace_id=workspace;e.reply_target!.workspace_id=workspace;e.trace={ingress_attempt:1};
  const now=new Date(Math.floor(Date.now()/1000)*1000),key="test-task-owner-principal-key-0000000000";
  const raw=stableStringify({attempt:1,event_id:id,expires_at:new Date(now.getTime()+60000).toISOString().replace(".000Z","Z"),issued_at:now.toISOString().replace(".000Z","Z"),key_id:principalProofKeyId(key),nonce:"task-proof-nonce-"+id,principal_id:actor,principal_kind:"human",tenant_id:workspace,version:2,envelope_sha256:createHash("sha256").update(stableStringify(e)).digest("hex"),workspace_id:workspace});
  const verified=proof?verifySlackPrincipalProof(e,Buffer.from(raw).toString("base64url"),createHmac("sha256",key).update(raw).digest("base64url"),key,now):undefined;
  return db.enqueue(e,now,verified).row;
 }
 const origin=event("origin");
 const request=taskRequestSchema.parse({source_event_id:origin.event_id,task_key:"issue",objective:"Issueを実装する",workspace:{kind:"github",repository:"org/repo"},issue_number:1});
 const issue={node_id:"I_1",repository:"org/repo",number:1};
 const task=db.tasks.create(request,config.jobsWorkspaceRoot,config.jobResultsDir,issue).task;
 async function current(id:string){await contexts.issue(db.beginDispatch(id,path.join(root,id+".json")));}
 return {root,config,db,sql,client,contexts,event,origin,request,issue,task,current,async close(){await api.stop();sql.close();db.close();await fs.rm(root,{recursive:true,force:true});}};
}

test("同じ検証済み依頼者は別channelでTaskを照会・操作し、Resultを取得できる",async()=>{
 const f=await fixture();try{
  const e=f.event("other-channel","C_OTHER");await f.current(e.event_id);
  const found=await f.client.findIssueTask(e.event_id,"org/repo",1);assert.equal(found.status,"found");assert.equal((found.task as any).task_id,f.task.task_id);
  // 下位のqueued steerも旧channel guardで拒否しない。
  f.db.appendQueuedJobInstruction(f.task.current_attempt_id,e.event_id,"追加条件");
  const paused=await f.client.controlTask(f.task.task_id,"pause",{source_event_id:e.event_id,revision:f.task.revision});assert.equal((paused.task as any).state,"paused");
  assert.deepEqual((paused.task as any).notification_target,JSON.parse(f.origin.reply_target_json!));
  const job=f.db.getJob(f.task.current_attempt_id)!;
  f.sql.prepare("UPDATE jobs SET result_json=? WHERE job_id=?").run(JSON.stringify({summary:"元channelの成果"}),job.job_id);
  assert.equal(((await f.client.getTask(f.task.task_id,e.event_id)).task as any).result.summary,"元channelの成果");
 }finally{await f.close();}
});

test("検証済み完了通知から既存Issue Taskを読み取る経路を保持する",async()=>{
 const f=await fixture();try{
  const job=f.db.getJob(f.task.current_attempt_id)!;
  f.db.beginJobPreparation(job.job_id,new Date(job.available_at));f.db.setJobRuntime(job.job_id,"w","p");f.db.beginJobDispatch(job.job_id);f.db.markJobRunning(job.job_id);f.db.sealJobGroup(f.origin.event_id);
  f.db.saveJobResult(job.job_id,{schema_version:1,job_id:job.job_id,status:"completed",summary:"完了",actions:[],completed_at:new Date().toISOString()},job.result_path);
  const notice=f.db.enqueueJobNotification(job.job_id).row;await f.current(notice.event_id);
  const found=await f.client.findIssueTask(notice.event_id,"org/repo",1);
  assert.equal(found.status,"found");assert.equal((found.task as any).result.summary,"完了");
  // 完了通知を新しい人間のIssue着手依頼に読み替えない。
  await assert.rejects(f.client.findIssueTask(notice.event_id,"org/repo",2),/task_owner_mismatch/);
  await assert.rejects(f.client.controlTask(f.task.task_id,"pause",{source_event_id:notice.event_id,revision:f.db.tasks.get(f.task.task_id)!.revision}),/task_owner_mismatch/);
 }finally{await f.close();}
});

test("Taskなしは明示し、照会後に他依頼者がclaimしたIssueへ重複作成しない",async()=>{
 const f=await fixture();try{
  const e=f.event("lookup","C_OTHER");await f.current(e.event_id);
  assert.deepEqual(await f.client.findIssueTask(e.event_id,"org/repo",2),{schema_version:1,status:"not_found",task:null});
  const other=f.event("claim","C_THIRD","U_OTHER"),issue={...f.issue,node_id:"I_2",number:2};
  f.db.tasks.create({...f.request,source_event_id:other.event_id,issue_number:2},f.config.jobsWorkspaceRoot,f.config.jobResultsDir,issue);
  await assert.rejects(f.client.findIssueTask(e.event_id,"org/repo",2),/task_owner_mismatch/);
  await assert.rejects(f.client.createTask({...f.request,source_event_id:e.event_id,issue_number:2}),/task_owner_mismatch/);
  assert.equal(f.db.listEventJobs(e.event_id).length,0);
  assert.equal((await f.client.findIssueTask(e.event_id,"org/repo",3)).status,"not_found");
  const created=await f.client.createTask({...f.request,source_event_id:e.event_id,issue_number:3});
  assert.equal(created.outcome,"created");
  assert.equal((await f.client.findIssueTask(e.event_id,"org/repo",3)).status,"found");
  assert.equal(f.db.listEventJobs(e.event_id).length,1);
 }finally{await f.close();}
});

test("別user・別workspace・未検証・失効・自由入力event IDは拒否する",async()=>{
 const f=await fixture();try{
  for(const [id,channel,actor,workspace] of [["actor","C_OTHER","U_OTHER","T_TEST"],["workspace","C_OTHER","U_TEST","T_OTHER"]] as const){
   const e=f.event(id,channel,actor,workspace);await f.current(e.event_id);
   await assert.rejects(f.client.getTask(f.task.task_id,e.event_id),/task_owner_mismatch/);
  }
  const unverified=f.event("no-proof","C_OTHER","U_TEST","T_TEST",false);
  assert.throws(()=>f.db.tasks.assertOwner(f.task.task_id,unverified.event_id),/task_owner_mismatch/);
  const e=f.event("verified","C_OTHER");await f.current(e.event_id);
  await assert.rejects(f.client.getTask(f.task.task_id,f.origin.event_id),/task_owner_mismatch/);
  await assert.rejects(f.client.findIssueTask(f.origin.event_id,"org/repo",99),/task_owner_mismatch/);
  await assert.rejects(f.client.controlTask(f.task.task_id,"pause",{source_event_id:f.origin.event_id,revision:1}),/task_owner_mismatch/);
  assert.equal(f.db.tasks.get(f.task.task_id)!.revision,1);
  f.sql.prepare("UPDATE verified_principal_bindings SET revoked_at=? WHERE event_id=?").run(new Date().toISOString(),e.event_id);
  await assert.rejects(f.client.getTask(f.task.task_id,e.event_id),/task_owner_mismatch/);
  await f.contexts.revoke();
  await assert.rejects(f.client.findIssueTask(e.event_id,"org/repo",99),/task_owner_mismatch/);
 }finally{await f.close();}
});

test("別channelの実行承認も要求通知後の依頼者返信だけを受理する",async()=>{
 const f=await fixture();try{
  const job=f.db.getJob(f.task.current_attempt_id)!;
  f.db.beginJobPreparation(job.job_id,new Date(job.available_at));f.db.setJobRuntime(job.job_id,"w","p",JSON.stringify(["g","t"]));f.db.beginJobDispatch(job.job_id);f.db.markJobRunning(job.job_id);
  const request={question_id:"approval",agent:job.agent_name,generation:"g",thread_id:"t",turn_id:"turn",rpc_id_json:"1",kind:"approval" as const,payload_json:"{}",state:"pending" as const,answer_hash:null,created_at:new Date().toISOString()};
  let sends=0;
  const runtime={async questions(){return [request];},async approveRequest(){sends++;return {...request,state:"resolved"};}} as unknown as JobAgentRuntime;
  const supervisor=new JobSupervisor(f.db,runtime,f.config,logger,()=>{}),before=f.event("before-approval","C_OTHER");
  await assert.rejects(supervisor.approveTaskRequest(f.task.task_id,before.event_id,f.task.revision,request.question_id,true),/requires_user_reply/);
  f.db.enqueueWorkerQuestion(job.job_id,request);
  const after=f.event("after-approval","C_OTHER"),revision=f.db.tasks.get(f.task.task_id)!.revision;
  await assert.rejects(supervisor.approveTaskRequest(f.task.task_id,before.event_id,revision,request.question_id,true),/requires_user_reply/);
  await supervisor.approveTaskRequest(f.task.task_id,after.event_id,revision,request.question_id,true);
  assert.equal(sends,1);
 }finally{await f.close();}
});
