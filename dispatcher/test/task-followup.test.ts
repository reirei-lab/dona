import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import {test} from "node:test";
import {DispatcherApi} from "../src/api.js";
import {DispatcherApiClient} from "../src/client.js";
import {JobSupervisor} from "../src/job-supervisor.js";
import {DispatcherDatabase} from "../src/database.js";
import {taskRequestSchema} from "../src/task-execution.js";
import {buildJobPrompt} from "../src/job-prompt.js";
import {TaskProjector,type GitHubQuery} from "../src/task-github.js";
import {eventEnvelope,tempConfig} from "./helpers.js";

async function fixture(project=false,ambiguousResult=false){
  const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath),sql=new Database(config.databasePath);
  const event=db.enqueue(eventEnvelope("initial")).row;
  const projectRequest={owner:"org",number:4,completion_status:"In Progress" as const};
  const issue={node_id:"I_1",repository:"org/repo",number:1,...(project?{project:{item_id:"item",project_id:"project",issue_id:"I_1",task_field_id:"task",status_field_id:"status",options:{Todo:"todo","In Progress":"working","Merge Ready":"ready"},completion_status:"In Progress"}}:{})};
  const request=taskRequestSchema.parse({source_event_id:event.event_id,task_key:"initial",objective:"既存PRを提出",workspace:{kind:"github",repository:"org/repo"},issue_number:1,...(project?{project:projectRequest}:{})});
  const task=db.tasks.create(request,config.jobsWorkspaceRoot,config.jobResultsDir,issue).task;
  const job=db.getJob(task.current_attempt_id)!;
  db.beginJobPreparation(job.job_id);db.setJobRuntime(job.job_id,"w","p");db.beginJobDispatch(job.job_id);db.markJobRunning(job.job_id);
  const pendingEnvelope=eventEnvelope("during-task");pendingEnvelope.occurred_at=new Date(Date.now()+2000).toISOString();
  const pendingMessage=db.enqueue(pendingEnvelope).row;
  db.sealJobGroup(event.event_id);
  db.saveJobResult(job.job_id,{schema_version:1,job_id:job.job_id,status:"completed",summary:"PR提出済み",actions:ambiguousResult?[{tool:"github.push",ambiguous:true}]:[],completed_at:new Date().toISOString()},job.result_path);
  const notification=db.enqueueJobNotification(job.job_id).row;
  sql.prepare("UPDATE events SET status='completed',completed_at=?,result_json=? WHERE event_id=?").run(new Date().toISOString(),JSON.stringify({schema_version:1,event_id:notification.event_id,status:"completed",summary:"通知済み",actions:[],completed_at:new Date().toISOString()}),notification.event_id);
  db.markTerminalWorkerStopProof(job.job_id);
  if(project)sql.prepare("UPDATE tasks SET project_state='synced' WHERE task_id=?").run(task.task_id);
  const followEnvelope=eventEnvelope("followup");followEnvelope.occurred_at=new Date(Date.now()+1000).toISOString();
  const follow=db.enqueue(followEnvelope).row,current=db.tasks.get(task.task_id)!;
  const input=taskRequestSchema.parse({...request,source_event_id:follow.event_id,task_key:"resolve-conflict",objective:"既存PRの競合解消とreview/CI",workspace:{kind:"github",repository:"org/repo",base_ref:"existing/pr-branch"},followup:{task_id:task.task_id,revision:current.revision,attempt_id:job.job_id}});
  const create=(value=input,identity=issue)=>db.tasks.create(value,config.jobsWorkspaceRoot,config.jobResultsDir,identity);
  return {root,config,db,sql,task,current,job,notification,follow,pendingMessage,input,issue,create,async dispose(){sql.close();db.close();await fs.rm(root,{recursive:true,force:true});}};
}

test("明示followupがclaimを原子的に引継ぎ、旧成果と予算履歴を保全し、応答喪失後も同じ後続を返す",async()=>{
  const f=await fixture();try{
    const savedResult=f.db.getJob(f.job.job_id)!.result_json;
    const next=f.create().task;
    assert.notEqual(next.task_id,f.task.task_id);
    const old=f.db.tasks.get(f.task.task_id)!;
    assert.equal(old.state,"completed");assert.equal(old.resource_id,null);assert.equal(old.attempt_number,1);
    assert.equal(f.db.getJob(f.job.job_id)!.result_json,savedResult);
    assert.equal(next.resource_id,"github:I_1");assert.equal(next.max_attempts,f.input.policy.max_attempts);
    assert.equal(f.db.tasks.findIssue(f.follow.event_id,f.issue).task_id,next.task_id);
    assert.equal(f.create().outcome,"reused");assert.equal(f.create().task.task_id,next.task_id);
    assert.throws(()=>f.create({...f.input,objective:"違う作業"}),/idempotency_conflict/);
    assert.throws(()=>f.create({...f.input,task_key:"duplicate"}),/revision_conflict/);
    assert.equal(f.db.listEventJobs(f.follow.event_id).length,1);
    const job=f.db.getJob(next.current_attempt_id)!;
    assert.notEqual(job.workspace_path,f.job.workspace_path);assert.match(buildJobPrompt(job),/旧Result/);assert.equal(JSON.parse(job.workspace_json)._dona_followup.predecessor_attempt_id,f.job.job_id);
    assert.equal(JSON.parse(job.workspace_json).base_ref,"existing/pr-branch");
    assert.equal((f.db.tasks.projection(next).followup as any).predecessor_task_id,old.task_id);
    f.db.close();const reopened=new DispatcherDatabase(f.config.databasePath);
    try{assert.equal(reopened.tasks.lookupRequest(f.input)!.task_id,next.task_id);assert.equal(reopened.tasks.findIssue(f.follow.event_id,f.issue).task_id,next.task_id);assert.equal(reopened.tasks.projection(reopened.tasks.get(old.task_id)!,true).result!==undefined,true);}finally{reopened.close();}
  }finally{await f.dispose();}
});

for(const scenario of ["actor","channel","thread","revision","attempt","resource","running","stop","notification","external","project","result-ambiguous","result-ambiguous-clean-checkpoint"] as const)test(`followupは${scenario}の不一致・未確定を拒否しclaimを残す`,async()=>{
  const f=await fixture(scenario==="project",scenario.startsWith("result-ambiguous"));try{
    let input=f.input,issue=f.issue;
    if(["actor","channel","thread"].includes(scenario)){
      const envelope=eventEnvelope("unauthorized");
      if(scenario==="actor")envelope.subject.actor_id="U_OTHER";
      else {const key=scenario==="channel"?"channel_id":"thread_ts";envelope.subject[key]="other";(envelope.reply_target as any)[key]="other";}
      input={...input,source_event_id:f.db.enqueue(envelope).row.event_id};
    }
    if(scenario==="revision")input={...input,followup:{...input.followup!,revision:1}};
    if(scenario==="attempt")input={...input,followup:{...input.followup!,attempt_id:"job_01k00000000000000000000000"}};
    if(scenario==="resource")issue={...issue,node_id:"I_2"};
    if(scenario==="running")f.sql.prepare("UPDATE tasks SET state='active' WHERE task_id=?").run(f.task.task_id);
    if(scenario==="stop")f.sql.prepare("DELETE FROM job_terminal_worker_stop_proofs WHERE job_id=?").run(f.job.job_id);
    if(scenario==="notification")f.sql.prepare("UPDATE events SET status='dispatching' WHERE event_id=?").run(f.notification.event_id);
    if(scenario==="external"){
      await fs.mkdir(f.job.result_path.substring(0,f.job.result_path.lastIndexOf("/")),{recursive:true});
      await fs.writeFile(f.job.result_path.replace("result.json","checkpoint.json"),JSON.stringify({schema_version:1,task_id:f.task.task_id,attempt_id:f.job.job_id,sequence:1,summary:"応答不明",remaining:[],artifacts:[],unresolved_operations:["push unknown"],waiting:"external_effect_unknown"}));
    }
    if(scenario==="result-ambiguous-clean-checkpoint"){
      await fs.mkdir(f.job.result_path.substring(0,f.job.result_path.lastIndexOf("/")),{recursive:true});
      await fs.writeFile(f.job.result_path.replace("result.json","checkpoint.json"),JSON.stringify({schema_version:1,task_id:f.task.task_id,attempt_id:f.job.job_id,sequence:1,summary:"checkpointでは未確定なし",remaining:[],artifacts:[],unresolved_operations:[],waiting:"none"}));
    }
    if(scenario==="project")f.sql.prepare("UPDATE tasks SET project_state='unknown' WHERE task_id=?").run(f.task.task_id);
    if(scenario.startsWith("result-ambiguous"))assert.throws(()=>f.create(input,issue),/task_external_effect_reconciliation_required/);
    else assert.throws(()=>f.create(input,issue));
    assert.equal(f.db.tasks.get(f.task.task_id)!.resource_id,"github:I_1");assert.equal(f.db.listEventJobs(input.source_event_id).length,0);
  }finally{await f.dispose();}
});

test("Projectの旧Task IDだけを後続へ同期し、旧Taskの遅い応答・成否不明writeを再送しない",async()=>{
  const f=await fixture(true);try{
    let id=f.task.task_id,status="working",writes=0,release:(value:any)=>void=()=>{};
    const query:GitHubQuery=async(q,vars)=>{
      if(q.startsWith("query"))return {node:{project:{id:"project"},content:{id:"I_1"},task:{text:id},progress:{optionId:status}}};
      writes++;if(vars.field==="task")id=String(vars.value);else status=String(vars.value);throw Error("response lost");
    };
    // A stale projector read starts before ownership transfer.
    const stale=new TaskProjector(f.db,async()=>await new Promise(resolve=>{release=resolve;}));
    f.sql.prepare("UPDATE tasks SET project_state='pending' WHERE task_id=?").run(f.task.task_id);
    const pending=stale.sync(f.db.tasks.get(f.task.task_id)!);
    f.sql.prepare("UPDATE tasks SET project_state='synced' WHERE task_id=?").run(f.task.task_id);
    const next=f.create().task;
    release({node:{project:{id:"project"},content:{id:"I_1"},task:{text:f.task.task_id},progress:{optionId:"working"}}});await pending;
    assert.equal(f.db.tasks.get(f.task.task_id)!.project_state,"superseded");
    const projector=new TaskProjector(f.db,query);
    await assert.rejects(projector.sync(next),/response lost/);await projector.sync(next);
    await assert.rejects(projector.sync(next),/response lost/);await projector.sync(next);await projector.sync(next);
    assert.equal(status,"todo");assert.equal(writes,2);assert.equal(id,next.task_id);assert.equal(f.db.tasks.get(next.task_id)!.project_state,"synced");
    await projector.sync(f.current);assert.equal(writes,2);
  }finally{await f.dispose();}
});

test("followupの無指定・自動continuationとの併用は完了claimを解放しない",async()=>{
  const f=await fixture();try{
    const {followup,...ordinary}=f.input;assert.throws(()=>f.create(ordinary),/resource_already_claimed/);
    assert.equal(taskRequestSchema.safeParse({...f.input,issue_number:undefined}).success,false);
    assert.equal(taskRequestSchema.safeParse({...f.input,continuation:{parent_task_id:f.task.task_id,parent_revision:1,scope_revision:1,operation:"submit_pr"}}).success,false);
  }finally{await f.dispose();}
});

test("followupの100000文字objectiveを保持し、受付失敗時はclaim移転をrollbackする",async()=>{
  const f=await fixture();try{
    assert.throws(()=>f.create({...f.input,objective:"x".repeat(100001)}));
    assert.equal(f.db.tasks.get(f.task.task_id)!.resource_id,"github:I_1");
    assert.equal(f.db.listEventJobs(f.follow.event_id).length,0);
    const next=f.create({...f.input,objective:"x".repeat(100000)}).task;
    assert.equal(f.db.getJob(next.current_attempt_id)!.objective.length,100000);
    assert.match(buildJobPrompt(f.db.getJob(next.current_attempt_id)!),/predecessor_task_id/);
  }finally{await f.dispose();}
});

test("後続Jobの受付失敗はclaimとProject同期状態をtransactionで戻す",async()=>{
  const f=await fixture(true);try{
    f.sql.prepare("UPDATE events SET status='completed' WHERE event_id=?").run(f.follow.event_id);
    assert.throws(()=>f.create(),(error:any)=>error.code==="job_group_closed");
    assert.equal(f.db.tasks.get(f.task.task_id)!.resource_id,"github:I_1");
    assert.equal(f.db.tasks.get(f.task.task_id)!.project_state,"synced");
    assert.equal(f.db.tasks.get(f.task.task_id)!.revision,f.current.revision);
    assert.equal((f.sql.prepare("SELECT count(*) AS n FROM task_followups").get() as {n:number}).n,0);
  }finally{await f.dispose();}
});


test("UDS APIのGitHub照合からfollowupを作成し、再送では照合を再writeしない",async()=>{
  const f=await fixture();
  const executable=f.root+"/fake-gh";
  await fs.writeFile(executable,`#!/bin/sh
printf '%s' '{"data":{"repository":{"nameWithOwner":"org/repo","issue":{"id":"I_1","number":1}}}}'
`,{mode:0o700});
  const logger={debug(){},info(){},warn(){},error(){}};
  const config={...f.config,ghPath:executable};
  const supervisor=new JobSupervisor(f.db,{} as any,config,logger,()=>{});
  const api=new DispatcherApi(f.db,{isRunning:()=>true,wake(){}},supervisor,config,logger);
  try{
    await api.start();const client=new DispatcherApiClient(config.socketPath);
    const created=await client.createTask(f.input),task=created.task as any;
    assert.equal(created.outcome,"created");assert.equal(task.followup.predecessor_task_id,f.task.task_id);
    assert.equal(JSON.stringify(created).includes("workspace_path"),false);
    await fs.unlink(executable);
    const reused=await client.createTask(f.input);assert.equal(reused.outcome,"reused");assert.equal((reused.task as any).task_id,task.task_id);
    assert.equal((await client.getTask(task.task_id,f.follow.event_id)).task!==undefined,true);
  }finally{await api.stop();await f.dispose();}
});

for(const kind of ["before-result","before-notification","delayed-old-message"] as const)test(`完了前の${kind}イベントをfollowup認可へ転用しない`,async()=>{
  const f=await fixture();try{
    if(kind==="before-result")f.sql.prepare("UPDATE events SET occurred_at=? WHERE event_id=?").run(f.db.getJob(f.job.job_id)!.completed_at,f.follow.event_id);
    if(kind==="before-notification")f.sql.prepare("UPDATE events SET completed_at=? WHERE event_id=?").run(f.follow.occurred_at,f.notification.event_id);
    if(kind==="delayed-old-message")f.sql.prepare("UPDATE events SET occurred_at='2026-09-01T10:20:30Z' WHERE event_id=?").run(f.follow.event_id);
    assert.throws(()=>f.create(),/task_followup_requires_new_slack_request/);
    assert.equal(f.db.tasks.get(f.task.task_id)!.resource_id,"github:I_1");assert.equal(f.db.listEventJobs(f.follow.event_id).length,0);
  }finally{await f.dispose();}
});

test("永続sequenceで実行中に受信したeventを、完了後に再提出しても拒否する",async()=>{
  const f=await fixture();try{
    assert.ok(f.pendingMessage.sequence<f.notification.sequence);
    assert.throws(()=>f.create({...f.input,source_event_id:f.pendingMessage.event_id}),/task_followup_requires_new_slack_request/);
    assert.equal(f.db.tasks.get(f.task.task_id)!.resource_id,"github:I_1");
  }finally{await f.dispose();}
});

for(const kind of ["regressed","same-sequence-conflict","newer-clean"] as const)test(`followupのcheckpointは${kind}を永続状態と照合する`,async()=>{
  const f=await fixture();try{
    const saved={schema_version:1 as const,task_id:f.task.task_id,attempt_id:f.job.job_id,sequence:5,summary:"未確定",remaining:[],artifacts:[],unresolved_operations:["push receipt unknown"],waiting:"external_effect_unknown" as const};
    f.db.tasks.checkpoint(f.job,saved);
    const disk={...saved,sequence:kind==="regressed"?4:kind==="same-sequence-conflict"?5:6,summary:"照合済み",unresolved_operations:[],waiting:"none"};
    await fs.mkdir(f.job.result_path.substring(0,f.job.result_path.lastIndexOf("/")),{recursive:true});
    await fs.writeFile(f.job.result_path.replace("result.json","checkpoint.json"),JSON.stringify(disk));
    if(kind==="newer-clean")assert.equal(f.create().outcome,"created");
    else {
      assert.throws(()=>f.create(),kind==="regressed"?/task_checkpoint_sequence_regressed/:/task_checkpoint_conflict/);
      assert.equal(f.db.tasks.attemptCheckpoint(f.job.job_id)!.sequence,5);
      assert.equal(f.db.tasks.get(f.task.task_id)!.resource_id,"github:I_1");assert.equal(f.db.listEventJobs(f.follow.event_id).length,0);
    }
  }finally{await f.dispose();}
});
