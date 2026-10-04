import { once } from "node:events";
import Database from "better-sqlite3";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { DispatcherDatabase } from "../src/database.js";
import { taskRequestSchema } from "../src/task-execution.js";
import { JobSupervisor } from "../src/job-supervisor.js";
import { WorkerStopNotSentError,type JobAgentRuntime } from "../src/job-runtime.js";
import type { WorkerObservation } from "../src/job-handoff.js";
import { DispatcherApi } from "../src/api.js";
import { DispatcherApiClient } from "../src/client.js";
import { eventEnvelope,tempConfig } from "./helpers.js";
const logger={debug(){},info(){},warn(){},error(){}};
async function fixture(limits?:{jobsPerEventMax:number;jobObjectiveTotalMaxBytes:number}){
  const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath,limits);
  const event=db.enqueue(eventEnvelope("task")).row;
  const request=taskRequestSchema.parse({source_event_id:event.event_id,task_key:"implementation",objective:"実装して検証済みPRを提出",workspace:{kind:"scratch"},policy:{max_attempts:3,retry_delay_ms:1000}});
  const task=db.tasks.create(request,config.jobsWorkspaceRoot,config.jobResultsDir).task;
  let observed:WorkerObservation={state:"inactive",reason:"agent_idle",observed_at:new Date().toISOString(),process_ids:[123,124],process_groups:[123]};
  let stopped=false,sends=0;
  const runtime:JobAgentRuntime={async prepare(){return {herdrWorkspaceId:"w",herdrPaneId:"p"};},async prompt(){throw Error("unexpected");},async get(){throw Error("unexpected");},async wait(){throw Error("unexpected");},async cancel(){throw Error("unexpected");},
    async observeWorker(){return observed;},async retireWorker(){sends++;stopped=true;},async workerRetired(){return stopped;}};
  const supervisor=()=>new JobSupervisor(db,runtime,config,logger,()=>{});
  const start=(id=task.current_attempt_id)=>{db.beginJobPreparation(id,new Date(db.getJob(id)!.available_at));db.setJobRuntime(id,"w","p");db.beginJobDispatch(id);db.markJobRunning(id);};
  const interrupt=(id=task.current_attempt_id)=>db.markJobNeedsReview(id,"result_missing","interrupted");
  const due=()=>{const t=db.tasks.get(task.task_id)!;db.tasks.wait(t,t.wait_reason??"observation_unknown",-1);};
  return {root,config,db,event,request,task,runtime,supervisor,start,interrupt,due,sends:()=>sends,setObserved:(o:Partial<WorkerObservation>)=>{observed={...observed,...o};},setStopped:(s:boolean)=>{stopped=s;},async dispose(){db.close();await fs.rm(root,{recursive:true,force:true});}};
}

test("Task作成の冪等性と異内容conflict、Issueのeventを跨ぐ排他",async()=>{
  const f=await fixture();try{
    assert.equal(f.db.tasks.create(f.request,f.config.jobsWorkspaceRoot,f.config.jobResultsDir).task.task_id,f.task.task_id);
    assert.throws(()=>f.db.tasks.create({...f.request,objective:"別作業"},f.config.jobsWorkspaceRoot,f.config.jobResultsDir),/idempotency_conflict/);
    const request=taskRequestSchema.parse({...f.request,task_key:"issue",workspace:{kind:"github",repository:"org/repo"},issue_number:1});
    f.db.tasks.create(request,f.config.jobsWorkspaceRoot,f.config.jobResultsDir,{node_id:"I_1",repository:"org/repo",number:1});
    const next=f.db.enqueue(eventEnvelope("another-event")).row;
    assert.throws(()=>f.db.tasks.create({...request,source_event_id:next.event_id},f.config.jobsWorkspaceRoot,f.config.jobResultsDir,{node_id:"I_1",repository:"org/repo",number:1}),/resource_already_claimed/);
    assert.equal(f.db.listEventJobs(next.event_id).length,0);
  }finally{await f.dispose();}
});

test("停止確認後は同じTaskの次Attemptへ差分を引継ぎ、旧Resultは拒否",async()=>{
  const f=await fixture();try{
    f.start();f.interrupt();const old=f.db.getJob(f.task.current_attempt_id)!;
    await fs.mkdir(old.workspace_path,{recursive:true});await fs.writeFile(path.join(old.workspace_path,"unfinished"),"変更");
    f.db.sealJobGroup(f.event.event_id);
    await f.supervisor().reconcileTasks();
    const task=f.db.tasks.get(f.task.task_id)!;assert.equal(task.attempt_number,2);assert.notEqual(task.current_attempt_id,old.job_id);
    assert.equal(f.sends(),1);assert.equal(f.db.tasks.forAttempt(old.job_id)!.task_id,task.task_id);
    const next=f.db.getJob(task.current_attempt_id)!;assert.equal(next.workspace_path,old.workspace_path);assert.notEqual(next.result_path,old.result_path);
    assert.equal(await fs.readFile(path.join(next.workspace_path,"unfinished"),"utf8"),"変更");
    assert.equal(f.db.tasks.mayNotify(f.db.getJob(old.job_id)!),false);
    assert.throws(()=>f.db.saveJobResult(old.job_id,{schema_version:1,job_id:old.job_id,status:"completed",summary:"late",completed_at:new Date().toISOString()},old.result_path),/superseded/);
    f.start(next.job_id);f.db.saveJobResult(next.job_id,{schema_version:1,job_id:next.job_id,status:"completed",summary:"完了",completed_at:new Date().toISOString()},next.result_path);
    assert.equal(f.db.tasks.get(task.task_id)!.state,"completed");
    const notification=f.db.enqueueJobNotification(next.job_id).row;
    const group=JSON.parse(notification.payload_json).group;assert.equal(group.total,1);assert.equal(group.transition,"all_terminal");
  }finally{await f.dispose();}
});

for(const state of ["working","waiting","unknown"] as const)test(`${state}から自動でworkerを交換しない`,async()=>{
  const f=await fixture();try{f.start();f.interrupt();f.setObserved({state});await f.supervisor().reconcileTasks();
    assert.equal(f.sends(),0);assert.equal(f.db.tasks.get(f.task.task_id)!.attempt_number,1);
    assert.equal(f.db.tasks.get(f.task.task_id)!.wait_reason,state==="working"?null:state==="waiting"?"human_input":"observation_unknown");
  }finally{await f.dispose();}
});

test("停止応答喪失は再送せず、Supervisor再生成後のread-backで続行",async()=>{
  const f=await fixture();try{
    f.start();f.interrupt();let writes=0;
    f.runtime.retireWorker=async()=>{writes++;throw new Error("connection lost");};
    await f.supervisor().reconcileTasks();assert.equal(f.db.tasks.get(f.task.task_id)!.stop_state,"attempting");
    f.due();await f.supervisor().reconcileTasks();assert.equal(writes,1);
    f.setStopped(true);f.due();await f.supervisor().reconcileTasks();
    assert.equal(f.db.tasks.get(f.task.task_id)!.attempt_number,2);assert.equal(writes,1);
  }finally{await f.dispose();}
});

test("worker停止中の取消が後継起動より優先される",async()=>{
  const f=await fixture();try{
    f.start();f.interrupt();
    f.runtime.retireWorker=async()=>{const task=f.db.tasks.get(f.task.task_id)!;const event=f.db.enqueue(eventEnvelope("cancel")).row;f.db.tasks.control(task.task_id,event.event_id,task.revision,"cancel");f.setStopped(true);};
    await f.supervisor().reconcileTasks();assert.equal(f.db.tasks.get(f.task.task_id)!.state,"cancelled");assert.equal(f.db.tasks.get(f.task.task_id)!.attempt_number,1);
  }finally{await f.dispose();}
});

test("pauseは停止を待ち、resume後もTaskと予算を保持する",async()=>{
  const f=await fixture();try{
    f.start();const event=f.db.enqueue(eventEnvelope("pause")).row;
    f.db.tasks.control(f.task.task_id,event.event_id,f.db.tasks.get(f.task.task_id)!.revision,"pause");await f.supervisor().reconcileTasks();
    const paused=f.db.tasks.get(f.task.task_id)!;assert.equal(paused.state,"paused");assert.equal(paused.stop_state,"stopped");assert.equal(paused.attempt_number,1);
    const resume=f.db.enqueue(eventEnvelope("resume")).row;
    f.db.tasks.control(paused.task_id,resume.event_id,paused.revision,"resume");await f.supervisor().reconcileTasks();
    assert.equal(f.db.tasks.get(paused.task_id)!.attempt_number,2);assert.equal(f.sends(),1);
  }finally{await f.dispose();}
});

test("再試行上限では新Attemptを作らず、人間待ちを通知できる",async()=>{
  const f=await fixture();try{
    for(let i=0;i<3;i++){const task=f.db.tasks.get(f.task.task_id)!;f.start(task.current_attempt_id);f.interrupt(task.current_attempt_id);await f.supervisor().reconcileTasks();}
    const task=f.db.tasks.get(f.task.task_id)!;assert.equal(task.attempt_number,3);assert.equal(task.wait_reason,"retry_exhausted");assert.equal(f.db.tasks.mayNotify(f.db.getJob(task.current_attempt_id)!),true);
  }finally{await f.dispose();}
});

test("別actor・別channel・古いrevisionではTaskを操作できない",async()=>{
  const f=await fixture();try{
    const e=eventEnvelope("other");e.subject.actor_id="U_OTHER";const other=f.db.enqueue(e).row;
    assert.throws(()=>f.db.tasks.assertOwner(f.task.task_id,other.event_id),/owner_mismatch/);
    const follow=f.db.enqueue(eventEnvelope("follow")).row;
    assert.throws(()=>f.db.tasks.control(f.task.task_id,follow.event_id,2,"cancel"),/revision_conflict/);
    const task=f.db.tasks.control(f.task.task_id,follow.event_id,1,"pause");assert.equal(task.state,"paused");
    assert.equal(f.db.tasks.control(task.task_id,follow.event_id,1,"pause").revision,task.revision);
    assert.throws(()=>f.db.tasks.control(task.task_id,follow.event_id,1,"cancel"),/control_conflict/);
  }finally{await f.dispose();}
});

test("Task APIの入口から作成・照会・pause・cancelを通す",async()=>{
  const f=await fixture(),s=f.supervisor(),api=new DispatcherApi(f.db,{isRunning:()=>true,wake(){}},s,f.config,logger);
  try{
    await api.start();const client=new DispatcherApiClient(f.config.socketPath);
    const result=await client.createTask({...f.request,task_key:"api"});const task=result.task as any;
    assert.match(task.task_id,/^task_/);assert.equal(JSON.stringify(result).includes("workspace_path"),false);
    const found=await client.getTask(task.task_id,f.event.event_id);assert.equal((found.task as any).current_attempt_id,task.current_attempt_id);
    const control=f.db.enqueue(eventEnvelope("api-cancel")).row;
    const cancelled=await client.controlTask(task.task_id,"cancel",{source_event_id:control.event_id,revision:task.revision});assert.equal((cancelled.task as any).state,"cancelled");
  }finally{await api.stop();await f.dispose();}
});

test("旧jobの暗黙移行を拒否し、管理済みTaskは再起動可能",async()=>{
  const f=await fixture();try{
    f.db.tasks.assertFreshExecutionModel();
    f.db.createJob({source_event_id:f.event.event_id,job_key:"unmanaged",objective:"legacy",workspace:{kind:"scratch"}},f.config.jobsWorkspaceRoot,f.config.jobResultsDir);
    assert.throws(()=>f.db.tasks.assertFreshExecutionModel(),/fresh_generation/);
  }finally{await f.dispose();}
});

test("利用上限のcheckpointは確認時刻まで再起動せず、承認待ちも迂回しない",async()=>{
  const f=await fixture();try{
    f.start();f.interrupt();const job=f.db.getJob(f.task.current_attempt_id)!;
    await fs.mkdir(path.dirname(job.result_path),{recursive:true});
    const checkpoint={schema_version:1,task_id:f.task.task_id,attempt_id:job.job_id,sequence:1,summary:"実装途中",remaining:["テスト"],artifacts:[],unresolved_operations:[],waiting:"usage_limit",retry_after:new Date(Date.now()+3_600_000).toISOString()};
    await fs.writeFile(path.join(path.dirname(job.result_path),"checkpoint.json"),JSON.stringify(checkpoint));
    await f.supervisor().reconcileTasks();assert.equal(f.sends(),0);assert.equal(f.db.tasks.get(f.task.task_id)!.wait_reason,"capacity_wait");
    f.due();await fs.writeFile(path.join(path.dirname(job.result_path),"checkpoint.json"),JSON.stringify({...checkpoint,sequence:2,waiting:"human_input"}));
    await f.supervisor().reconcileTasks();assert.equal(f.sends(),0);assert.equal(f.db.tasks.get(f.task.task_id)!.wait_reason,"human_input");
  }finally{await f.dispose();}
});

test("実DBを再openしても停止intentと使用済みAttemptを維持する",async()=>{
  const f=await fixture();let reopened:DispatcherDatabase|undefined;
  try{
    f.start();f.interrupt();let sends=0;f.runtime.retireWorker=async()=>{sends++;throw Error("lost");};
    await f.supervisor().reconcileTasks();f.db.close();
    reopened=new DispatcherDatabase(f.config.databasePath);reopened.tasks.assertFreshExecutionModel();
    const task=reopened.tasks.get(f.task.task_id)!;assert.equal(task.stop_state,"attempting");
    reopened.tasks.wait(task,"worker_stop_pending",-1);f.setStopped(true);
    const s=new JobSupervisor(reopened,f.runtime,f.config,logger,()=>{});await s.reconcileTasks();
    assert.equal(reopened.tasks.get(task.task_id)!.attempt_number,2);assert.equal(sends,1);assert.equal(reopened.schemaCompatibility().actual,4);
  }finally{reopened?.close();await f.dispose();}
});

test("再試行予算の明示追加は使用済みAttemptを保持し、曖昧応答も二重起動しない",async()=>{
  const f=await fixture();try{
    for(let i=0;i<3;i++){const task=f.db.tasks.get(f.task.task_id)!;f.start(task.current_attempt_id);f.interrupt(task.current_attempt_id);await f.supervisor().reconcileTasks();}
    const task=f.db.tasks.get(f.task.task_id)!;const follow=f.db.enqueue(eventEnvelope("extend-budget")).row;
    const extended=f.db.tasks.retry(task.task_id,follow.event_id,task.revision,4);
    assert.equal(extended.attempt_number,3);assert.equal(extended.max_attempts,4);
    await f.supervisor().reconcileTasks();assert.equal(f.db.tasks.get(task.task_id)!.attempt_number,4);
    f.db.tasks.retry(task.task_id,follow.event_id,task.revision,4);await f.supervisor().reconcileTasks();assert.equal(f.db.tasks.get(task.task_id)!.attempt_number,4);
  }finally{await f.dispose();}
});

test("一つのTaskをpauseしても別Taskの起動候補を塞がない",async()=>{
  const f=await fixture();try{
    const follow=f.db.enqueue(eventEnvelope("pause-queued")).row;
    f.db.tasks.control(f.task.task_id,follow.event_id,1,"pause");
    const second=f.db.tasks.create({...f.request,task_key:"second"},f.config.jobsWorkspaceRoot,f.config.jobResultsDir).task;
    assert.equal(f.db.nextRunnableJob()!.job_id,second.current_attempt_id);
  }finally{await f.dispose();}
});

test("steerの送信直前クラッシュでは指示を保持し、同じwriteを再送しない",async()=>{
  const f=await fixture();try{
    const follow=f.db.enqueue(eventEnvelope("steer")).row;
    assert.equal(f.db.tasks.prepareSteer(f.task.task_id,follow.event_id,1,"追加の検証"),true);
    assert.equal(f.db.tasks.prepareSteer(f.task.task_id,follow.event_id,1,"追加の検証"),false);
    assert.equal(f.db.tasks.get(f.task.task_id)!.wait_reason,"steer_acceptance_unknown");
    assert.match(f.db.tasks.get(f.task.task_id)!.objective,/追加の検証/);
  }finally{await f.dispose();}
});

test("UDS委任から実processの停止・後継Attempt・単一の完了通知まで通す",async()=>{
  const {spawn}=await import("node:child_process");
  const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath);
  const children:Array<ReturnType<typeof spawn>>=[];
  const processes=new Map<string,{child:ReturnType<typeof spawn>;exited:Promise<unknown>}>();
  let starts=0,stops=0;
  const ok={ok:true,stdout:"",stderr:"",exitCode:0,timedOut:false,aborted:false};
  const runtime:JobAgentRuntime={
    async prepare(job){
      starts++;await fs.mkdir(job.workspace_path,{recursive:true});await fs.mkdir(path.dirname(job.result_path),{recursive:true});
      const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});children.push(child);await once(child,"spawn");
      processes.set(job.job_id,{child,exited:once(child,"exit")});return {herdrWorkspaceId:job.job_id,herdrPaneId:`${job.job_id}:pane`};
    },
    async prompt(){return ok;},async get(){return {...ok,agentStatus:"idle"};},async cancel(){throw Error("unexpected legacy cancel");},
    async wait(id){
      const job=db.getJob(id)!;
      if(starts===1)await fs.writeFile(path.join(job.workspace_path,"work.txt"),"中断前の成果");
      else {
        assert.equal(await fs.readFile(path.join(job.workspace_path,"work.txt"),"utf8"),"中断前の成果");
        await fs.writeFile(job.result_path,JSON.stringify({schema_version:1,job_id:id,status:"completed",summary:"照合して続行",completed_at:new Date().toISOString()}));
      }
      return {...ok,agentStatus:"done"};
    },
    async observeWorker(job){const p=processes.get(job.job_id)!;return {state:"inactive",reason:"idle",observed_at:new Date().toISOString(),process_ids:[p.child.pid!],process_groups:[p.child.pid!]};},
    async retireWorker(job){stops++;const p=processes.get(job.job_id)!;p.child.kill("SIGTERM");await p.exited;},
    async workerRetired(job){const p=processes.get(job.job_id)!;try{process.kill(p.child.pid!,0);return false;}catch(error){return (error as NodeJS.ErrnoException).code==="ESRCH";}},
  };
  const supervisor=new JobSupervisor(db,runtime,config,logger,()=>{});
  const api=new DispatcherApi(db,{isRunning:()=>true,wake(){}},supervisor,config,logger);
  try{
    await api.start();const client=new DispatcherApiClient(config.socketPath),event=db.enqueue(eventEnvelope("native-e2e")).row;
    const response=await client.createTask({source_event_id:event.event_id,task_key:"e2e",objective:"続行",workspace:{kind:"scratch"},policy:{max_attempts:3,retry_delay_ms:1000}});
    const id=(response.task as any).task_id;db.sealJobGroup(event.event_id);supervisor.start();
    const {waitFor}=await import("./helpers.js");await waitFor(()=>db.tasks.get(id)?.state==="completed",5000);
    await waitFor(()=>db.getJob(db.tasks.get(id)!.current_attempt_id)!.completion_event_id!==null,5000);
    assert.equal(starts,2);assert.equal(stops,1);
    const notifications=db.list("queued").filter(e=>e.source==="dona_job");assert.equal(notifications.length,1);
    const payload=JSON.parse(notifications[0]!.payload_json);assert.equal(payload.task.task_id,id);assert.equal(payload.group.total,1);assert.equal(payload.group.transition,"all_terminal");
  }finally{await supervisor.stop();await api.stop();for(const child of children)child.kill("SIGTERM");await Promise.allSettled([...processes.values()].map(p=>p.exited));db.close();await fs.rm(root,{recursive:true,force:true});}
});

test("旧世代のpreflightはDBを変更せず拒否し、新Task世代は通す",async()=>{
  const {assertTaskGenerationFile}=await import("../src/task-execution.js");
  const {root,config}=await tempConfig();let db=new DispatcherDatabase(config.databasePath);
  try{
    const event=db.enqueue(eventEnvelope("legacy")).row;
    const before=db.schemaCompatibility().actual;assert.equal(before,3);
    assert.throws(()=>assertTaskGenerationFile(config.databasePath),/fresh_generation/);
    assert.equal(db.schemaCompatibility().actual,before);
    db.tasks.create(taskRequestSchema.parse({source_event_id:event.event_id,task_key:"new",objective:"作業",workspace:{kind:"scratch"}}),config.jobsWorkspaceRoot,config.jobResultsDir);
    assertTaskGenerationFile(config.databasePath);assert.deepEqual(db.schemaCompatibility(),{actual:4,read_min:4,read_max:4,write:4});
  }finally{db.close();await fs.rm(root,{recursive:true,force:true});}
});

test("停止直前にworkerがworkingへ戻れば停止writeを送らない",async()=>{
  const f=await fixture();try{
    f.start();f.interrupt();let reads=0;
    f.runtime.observeWorker=async()=>({state:++reads===1?"inactive":"working",reason:"changed",observed_at:new Date().toISOString(),process_ids:[123],process_groups:[123]});
    await f.supervisor().reconcileTasks();assert.equal(f.sends(),0);assert.equal(f.db.tasks.get(f.task.task_id)!.attempt_number,1);
  }finally{await f.dispose();}
});

for(const status of ["blocked","checkpoint"] as const)test(`人間入力待ち(${status})に回答を一度だけ送り同じAttemptを続行`,async()=>{
  const f=await fixture(),api=new DispatcherApi(f.db,{isRunning:()=>true,wake(){}},f.supervisor(),f.config,logger);
  try{
    f.start();const job=f.db.getJob(f.task.current_attempt_id)!;
    if(status==="blocked")f.db.markJobBlocked(job.job_id,"回答待ち");
    else {
      f.interrupt();await fs.mkdir(path.dirname(job.result_path),{recursive:true});
      await fs.writeFile(path.join(path.dirname(job.result_path),"checkpoint.json"),JSON.stringify({schema_version:1,task_id:f.task.task_id,attempt_id:job.job_id,sequence:1,summary:"質問",remaining:[],artifacts:[],unresolved_operations:[],waiting:"human_input"}));
    }
    await f.supervisor().reconcileTasks();const waiting=f.db.tasks.get(f.task.task_id)!;assert.equal(waiting.wait_reason,"human_input");
    let writes=0;f.runtime.prompt=async()=>{writes++;return {ok:true,stdout:"",stderr:"",exitCode:0,timedOut:false,aborted:false};};
    await api.start();const client=new DispatcherApiClient(f.config.socketPath),event=f.db.enqueue(eventEnvelope("answer")).row;
    const control={source_event_id:event.event_id,revision:waiting.revision,instruction:"この条件で続行してください"};
    await client.controlTask(waiting.task_id,"steer",control);await client.controlTask(waiting.task_id,"steer",control);
    assert.equal(writes,1);assert.equal(f.db.tasks.get(waiting.task_id)!.state,"active");assert.equal(f.db.getJob(job.job_id)!.status,"running");
    if(status==="checkpoint"){f.interrupt();await f.supervisor().reconcileTasks();assert.equal(f.db.tasks.get(waiting.task_id)!.attempt_number,2);}
  }finally{await api.stop();await f.dispose();}
});

test("解除時刻なしの利用上限はblockedから定期観測し回復する",async()=>{
  const f=await fixture();try{
    f.start();const job=f.db.getJob(f.task.current_attempt_id)!;f.db.markJobBlocked(job.job_id,"capacity");
    await fs.mkdir(path.dirname(job.result_path),{recursive:true});
    await fs.writeFile(path.join(path.dirname(job.result_path),"checkpoint.json"),JSON.stringify({schema_version:1,task_id:f.task.task_id,attempt_id:job.job_id,sequence:1,summary:"上限",remaining:[],artifacts:[],unresolved_operations:[],waiting:"usage_limit"}));
    f.setObserved({state:"waiting"});const before=Date.now();await f.supervisor().reconcileTasks();
    const waiting=f.db.tasks.get(f.task.task_id)!;assert.equal(waiting.wait_reason,"capacity_wait");assert.ok(Date.parse(waiting.next_check_at!)>=before+waiting.retry_delay_ms);
    assert.equal(f.sends(),0);f.due();f.setObserved({state:"working"});await f.supervisor().reconcileTasks();assert.equal(f.db.getJob(job.job_id)!.status,"running");assert.equal(f.db.tasks.get(waiting.task_id)!.state,"active");
    f.interrupt();f.setObserved({state:"inactive"});await f.supervisor().reconcileTasks();assert.equal(f.db.tasks.get(waiting.task_id)!.attempt_number,2);
  }finally{await f.dispose();}
});

test("needs_review中のwaiting workerをpauseすると停止確認まで進む",async()=>{
  const f=await fixture();try{
    f.start();f.interrupt();f.setObserved({state:"waiting"});const task=f.db.tasks.get(f.task.task_id)!,event=f.db.enqueue(eventEnvelope("pause-waiting")).row;
    f.db.tasks.control(task.task_id,event.event_id,task.revision,"pause");await f.supervisor().reconcileTasks();
    assert.equal(f.sends(),1);assert.equal(f.db.tasks.get(task.task_id)!.stop_state,"stopped");assert.equal(f.db.tasks.get(task.task_id)!.wait_reason,"paused");
  }finally{await f.dispose();}
});

test("中断AttemptはTask受付件数・objective予算を消費しない",async()=>{
  const f=await fixture({jobsPerEventMax:2,jobObjectiveTotalMaxBytes:200});try{
    f.start();f.interrupt();await f.supervisor().reconcileTasks();
    const second=f.db.tasks.create({...f.request,task_key:"second"},f.config.jobsWorkspaceRoot,f.config.jobResultsDir).task;
    assert.ok(second);assert.throws(()=>f.db.tasks.create({...f.request,task_key:"third"},f.config.jobsWorkspaceRoot,f.config.jobResultsDir),/limit exceeded/);
  }finally{await f.dispose();}
});

for(const reason of ["result_path_exists","invalid_result","invalid_result_agent_stopped"])test(`${reason}のTaskは後から有効Resultに置換されても隔離を維持`,async()=>{
  const f=await fixture();try{
    if(reason!=="result_path_exists")f.start();else f.db.beginJobPreparation(f.task.current_attempt_id);
    f.db.markJobNeedsReview(f.task.current_attempt_id,reason,"quarantine");const job=f.db.getJob(f.task.current_attempt_id)!;
    await fs.mkdir(path.dirname(job.result_path),{recursive:true});await fs.writeFile(job.result_path,JSON.stringify({schema_version:1,job_id:job.job_id,status:"completed",summary:"不正な置換",completed_at:new Date().toISOString()}));
    await f.supervisor().reconcileTasks();assert.equal(f.db.tasks.get(f.task.task_id)!.wait_reason,"result_reconciliation_required");assert.equal(f.db.getJob(job.job_id)!.result_json,null);
  }finally{await f.dispose();}
});

test("所有者の異なるIssue claim競合は存在を開示しない",async()=>{
  const f=await fixture();try{
    const input=taskRequestSchema.parse({...f.request,task_key:"issue",workspace:{kind:"github",repository:"org/repo"},issue_number:1}),issue={node_id:"I_1",repository:"org/repo",number:1};
    f.db.tasks.create(input,f.config.jobsWorkspaceRoot,f.config.jobResultsDir,issue);
    const e=eventEnvelope("foreign-claim");e.subject.actor_id="U_OTHER";const event=f.db.enqueue(e).row;
    assert.throws(()=>f.db.tasks.create({...input,source_event_id:event.event_id},f.config.jobsWorkspaceRoot,f.config.jobResultsDir,issue),/^Error: task_owner_mismatch$/);
    const otherThread=eventEnvelope("foreign-thread");otherThread.subject.thread_ts="1700000000.000002";otherThread.reply_target!.thread_ts="1700000000.000002";
    const threadEvent=f.db.enqueue(otherThread).row;
    assert.throws(()=>f.db.tasks.create({...input,source_event_id:threadEvent.event_id},f.config.jobsWorkspaceRoot,f.config.jobResultsDir,issue),/^Error: task_resource_already_claimed$/);
  }finally{await f.dispose();}
});

test("旧委任の表示用Issueはclaimせず表示ラベルとして保持する",async()=>{
  const f=await fixture(),api=new DispatcherApi(f.db,{isRunning:()=>true,wake(){}},f.supervisor(),f.config,logger);
  try{
    await api.start();const client=new DispatcherApiClient(f.config.socketPath);
    const response=await client.createJob({source_event_id:f.event.event_id,job_key:"display",objective:"作業",workspace:{kind:"github",repository:"org/repo"},display:{short_name:"表示名",issue:{repository:"another/repo",number:999}}});
    const task=f.db.tasks.forAttempt((response.job as {job_id:string}).job_id)!;assert.equal(task.resource_id,null);
    assert.equal(JSON.parse(f.db.getJob(task.current_attempt_id)!.workspace_json).__dona_job_display,undefined);
    const matching=await client.createJob({source_event_id:f.event.event_id,job_key:"display-match",objective:"作業",workspace:{kind:"github",repository:"org/repo"},display:{short_name:"表示名",issue:{repository:"org/repo",number:999}}});
    const matched=f.db.tasks.forAttempt((matching.job as {job_id:string}).job_id)!;assert.equal(matched.resource_id,null);
    assert.equal(JSON.parse(f.db.getJob(matched.current_attempt_id)!.workspace_json).__dona_job_display.label,"#999 表示名");
  }finally{await api.stop();await f.dispose();}
});

test("未送信停止intent後にworkerがworkingへ戻れば同じAttemptへ再接続",async()=>{
  const f=await fixture();try{
    f.start();f.interrupt();const task=f.db.tasks.get(f.task.task_id)!;
    f.db.tasks.claimStop(task,{state:"inactive",reason:"idle",observed_at:new Date().toISOString(),process_ids:[123],process_groups:[123]});
    f.setObserved({state:"working"});await f.supervisor().reconcileTasks();
    const current=f.db.tasks.get(task.task_id)!;assert.equal(current.stop_state,"none");assert.equal(current.state,"active");assert.equal(f.db.getJob(current.current_attempt_id)!.status,"running");assert.equal(f.sends(),0);
  }finally{await f.dispose();}
});

test("steer受理直後の再起動はexact eventのreceiptだけで復旧する",async()=>{
  const f=await fixture();try{
    f.start();const job=f.db.getJob(f.task.current_attempt_id)!;
    const first=f.db.enqueue(eventEnvelope("accepted-answer")).row,task=f.db.tasks.get(f.task.task_id)!;
    f.db.tasks.prepareSteer(task.task_id,first.event_id,task.revision,"一つ目");f.db.beginJobSteer(job.job_id,first.event_id);f.db.markJobSteerAccepted(job.job_id,first.event_id);
    await f.supervisor().reconcileTasks();assert.equal(f.db.tasks.get(task.task_id)!.state,"active");
    const second=f.db.enqueue(eventEnvelope("unsent-answer")).row,current=f.db.tasks.get(task.task_id)!;
    f.db.tasks.prepareSteer(task.task_id,second.event_id,current.revision,"二つ目");
    await f.supervisor().reconcileTasks();assert.notEqual(f.db.tasks.get(task.task_id)!.state,"active");
  }finally{await f.dispose();}
});

for(const crashed of [false,true])test(`worker質問を${crashed?"prompt送信直後のDispatcher再起動後も":""}親eventへ一度だけ届け、回答後に同じAttemptへ戻る`,async()=>{
 const f=await fixture();try{
  const job=f.db.getJob(f.task.current_attempt_id)!;f.db.beginJobPreparation(job.job_id,new Date(job.available_at));f.db.setJobRuntime(job.job_id,"w","p",JSON.stringify(["generation","thread-question"]));f.db.beginJobDispatch(job.job_id);if(crashed){f.db.recoverStaleJobs();assert.equal(f.db.getJob(job.job_id)?.status,"needs_review");}else f.db.markJobRunning(job.job_id);
  const question:import("../src/app-server/store.js").QuestionRecord={question_id:"550e8400-e29b-41d4-a716-446655440000",agent:job.agent_name,generation:"generation",thread_id:"thread-question",turn_id:"turn",rpc_id_json:'"request"',kind:"question",payload_json:JSON.stringify({questions:[{id:"choice",question:"どちら？"}]}),state:"pending",answer_hash:null,created_at:new Date().toISOString()};
  let pending=true,answers=0;
  f.runtime.pendingQuestions=async()=>pending?[question]:[];f.runtime.questions=async()=>pending?[question]:[];
  f.runtime.get=async()=>({ok:true,stdout:"{}",stderr:"",exitCode:0,timedOut:false,aborted:false,agentStatus:pending?"blocked":"working"});
  f.runtime.answerQuestion=async(name,id)=>{assert.equal(name,job.agent_name);assert.equal(id,question.question_id);answers++;pending=false;return {...question,state:"resolved"};};
  const supervisor=f.supervisor();await supervisor.reconcileQuestions();await supervisor.reconcileQuestions();
  const events=f.db.list().filter(e=>e.event_type==="worker_question");assert.equal(events.length,1);
  assert.equal(f.db.tasks.mayNotify(f.db.getJob(job.job_id)!),false);
  const listed=await supervisor.taskQuestions(f.task.task_id,events[0]!.event_id) as {revision:number;questions:unknown[]};assert.equal(listed.questions.length,1);
  await supervisor.answerTaskQuestion(f.task.task_id,events[0]!.event_id,listed.revision,question.question_id,{choice:{answers:["A"]}});
  f.due();await supervisor.reconcileTasks();
  assert.equal(answers,1);assert.equal(f.db.tasks.get(f.task.task_id)!.current_attempt_id,job.job_id);assert.equal(f.db.tasks.get(f.task.task_id)!.state,"active");
  const foreign=f.db.enqueue({...eventEnvelope("foreign-answer"),subject:{...eventEnvelope("foreign-answer").subject,actor_id:"OTHER"}}).row;
  await assert.rejects(supervisor.answerTaskQuestion(f.task.task_id,foreign.event_id,listed.revision,question.question_id,{choice:{answers:["B"]}}),/owner_mismatch/);
 }finally{await f.dispose();}
});


test("質問回答直後のResultがrunning復帰より先に届いても同じAttemptを完了する",async()=>{
 const f=await fixture();try {
  const job=f.db.getJob(f.task.current_attempt_id)!;
  f.db.beginJobPreparation(job.job_id,new Date(job.available_at));f.db.setJobRuntime(job.job_id,"w","p",JSON.stringify(["generation","thread"]));f.db.beginJobDispatch(job.job_id);f.db.markJobRunning(job.job_id);
  f.db.enqueueWorkerQuestion(job.job_id,{question_id:"question-fast",agent:job.agent_name,generation:"generation",thread_id:"thread",turn_id:"turn",rpc_id_json:"1",kind:"question",payload_json:"{}",state:"pending",answer_hash:null,created_at:new Date().toISOString()});
  await fs.mkdir(path.dirname(job.result_path),{recursive:true});
  await fs.writeFile(job.result_path,JSON.stringify({schema_version:1,job_id:job.job_id,status:"completed",summary:"回答後に完了",completed_at:new Date().toISOString()}));
  f.due();await f.supervisor().reconcileTasks();
  assert.equal(f.db.tasks.get(f.task.task_id)!.state,"completed");assert.equal(f.db.tasks.get(f.task.task_id)!.attempt_number,1);
 }finally{await f.dispose();}
});

test("POST questionsはTaskを変更せずroute errorにする",async()=>{
 const f=await fixture(),api=new DispatcherApi(f.db,{isRunning:()=>true,wake(){}},f.supervisor(),f.config,logger);
 try{
  const pause=f.db.enqueue(eventEnvelope("pause-route")).row;f.db.tasks.control(f.task.task_id,pause.event_id,f.task.revision,"pause");
  const before=f.db.tasks.get(f.task.task_id)!;await api.start();const client=new DispatcherApiClient(f.config.socketPath);
  await assert.rejects(client.controlTask(f.task.task_id,"questions" as "pause",{source_event_id:f.event.event_id,revision:before.revision}),/task_route_not_found/);
  assert.deepEqual(f.db.tasks.get(f.task.task_id),before);
  assert.throws(()=>f.db.tasks.control(f.task.task_id,f.event.event_id,before.revision,"questions" as "pause"),/task_control_invalid/);
 }finally{await api.stop();await f.dispose();}
});


test("Task停止の事前照会だけ失敗した場合は未送信として再照合できる",async()=>{
 const f=await fixture();try{
  f.start();f.interrupt();const stop=f.runtime.retireWorker!;
  f.runtime.retireWorker=async()=>{throw new WorkerStopNotSentError("read unavailable");};
  await f.supervisor().reconcileTasks();assert.equal(f.db.tasks.get(f.task.task_id)?.stop_state,"not_sent");assert.equal(f.sends(),0);
  f.runtime.retireWorker=stop;f.due();await f.supervisor().reconcileTasks();assert.equal(f.sends(),1);assert.equal(f.db.tasks.get(f.task.task_id)?.attempt_number,2);
 }finally{await f.dispose();}
});

test("start応答と直後のstatus喪失でも、後日のAttempt照合を永続化して停止・引継ぐ",async()=>{
 const f=await fixture();try{
  const job=f.db.getJob(f.task.current_attempt_id)!;f.db.beginJobPreparation(job.job_id);f.db.setJobRuntime(job.job_id,"w","p");
  f.db.markJobNeedsReview(job.job_id,"runtime_preparation_unknown","response lost");
  f.runtime.reconcilePreparation=async()=>{throw Error("socket offline");};
  await f.supervisor().reconcileTasks();assert.equal(f.sends(),0);assert.equal(f.db.getJobLiveSessionIdentity(job.job_id),undefined);
  f.due();f.runtime.reconcilePreparation=async()=>({herdrWorkspaceId:"w",herdrPaneId:"p",herdrAgentSessionId:JSON.stringify(["generation",null])});
  f.runtime.retireWorker=async()=>{assert.equal(f.db.getJobLiveSessionIdentity(job.job_id)?.herdr_agent_session_id,JSON.stringify(["generation",null]));f.setStopped(true);};
  await f.supervisor().reconcileTasks();assert.equal(f.db.tasks.get(f.task.task_id)!.attempt_number,2);
  assert.throws(()=>f.db.reconcileJobPreparationRuntime(job.job_id,"w","p","other"),/identity_changed/);
 }finally{await f.dispose();}
});

test("process未生成の停止receiptを確認してTaskを引継ぎ、空のunknown証拠は拒否する",async()=>{
 const f=await fixture();try{
  f.start();f.interrupt();const t=f.db.tasks.get(f.task.task_id)!;
  assert.throws(()=>f.db.tasks.claimStop(t,{state:"unknown",reason:"none",observed_at:new Date().toISOString(),process_ids:[],process_groups:[]}),/evidence_missing/);
  f.setObserved({state:"stopped",process_ids:[],process_groups:[]});f.setStopped(true);
  await f.supervisor().reconcileTasks();assert.equal(f.db.tasks.get(f.task.task_id)!.attempt_number,2);assert.equal(f.sends(),0);
 }finally{await f.dispose();}
});

test("質問回答後の失敗turnをrunningへ戻さず利用上限の解除を待つ",async()=>{
 const f=await fixture();try{
  f.start();f.db.markJobNeedsReview(f.task.current_attempt_id,"runtime_question_pending","question");
  f.runtime.questions=async()=>[];
  f.runtime.get=async()=>({ok:false,stdout:"",stderr:"runtime_turn_interrupted",exitCode:1,timedOut:false,aborted:false,agentStatus:"idle",errorCode:"runtime_turn_interrupted"});
  f.runtime.recoveryHint=async()=>({reason:"capacity_wait",retry_after:new Date(Date.now()+3600000).toISOString()});
  await f.supervisor().reconcileTasks();const t=f.db.tasks.get(f.task.task_id)!;
  assert.equal(t.state,"waiting");assert.equal(t.wait_reason,"capacity_wait");assert.equal(t.attempt_number,1);assert.equal(f.sends(),0);
 }finally{await f.dispose();}
});

for(const reason of ["invalid_result","cancel_acceptance_unknown","ambiguous_steer_acceptance"])test(`${reason}は質問通知で解除しない`,async()=>{
 const f=await fixture();try{
  const job=f.db.getJob(f.task.current_attempt_id)!;f.db.beginJobPreparation(job.job_id);f.db.setJobRuntime(job.job_id,"w","p",JSON.stringify(["g","t"]));f.db.beginJobDispatch(job.job_id);f.db.markJobRunning(job.job_id);f.db.markJobNeedsReview(job.job_id,reason,"unresolved");
  f.db.enqueueWorkerQuestion(job.job_id,{question_id:"q",agent:job.agent_name,generation:"g",thread_id:"t",turn_id:"turn",rpc_id_json:"1",kind:"question",payload_json:"{}",state:"pending",answer_hash:null,created_at:new Date().toISOString()});
  assert.equal(f.db.getJob(job.job_id)?.last_error_code,reason);assert.equal(f.db.list().filter(e=>e.event_type==="worker_question").length,0);
 }finally{await f.dispose();}
});

test("承認は通知後に取り込んだ所有者の返信だけを許可し時計差を使わない",async()=>{
 const f=await fixture();try{
  const job=f.db.getJob(f.task.current_attempt_id)!;
  f.db.beginJobPreparation(job.job_id,new Date(job.available_at));f.db.setJobRuntime(job.job_id,"w","p",JSON.stringify(["g","t"]));f.db.beginJobDispatch(job.job_id);f.db.markJobRunning(job.job_id);
  const before=f.db.enqueue({...eventEnvelope("before-approval"),occurred_at:"2099-01-01T00:00:00.000Z"}).row;
  const request={question_id:"approval",agent:job.agent_name,generation:"g",thread_id:"t",turn_id:"turn",rpc_id_json:"1",kind:"approval" as const,payload_json:"{}",state:"pending" as const,answer_hash:null,created_at:"2000-01-01T00:00:00.000Z"};
  let sent=0;f.runtime.questions=async()=>[request];f.runtime.approveRequest=async()=>{sent++;return {...request,state:"resolved"};};
  const supervisor=f.supervisor();
  await assert.rejects(supervisor.approveTaskRequest(f.task.task_id,before.event_id,f.db.tasks.get(f.task.task_id)!.revision,request.question_id,true),/requires_user_reply/);
  f.db.enqueueWorkerQuestion(job.job_id,request);
  const revision=f.db.tasks.get(f.task.task_id)!.revision;
  for(const event of [f.event,before])await assert.rejects(supervisor.approveTaskRequest(f.task.task_id,event.event_id,revision,request.question_id,true),/requires_user_reply/);
  const elsewhere=eventEnvelope("approval-other-thread");elsewhere.subject.thread_ts="1700000000.000099";elsewhere.reply_target!.thread_ts=elsewhere.subject.thread_ts;
  const cross=f.db.enqueue(elsewhere).row;
  await assert.rejects(supervisor.approveTaskRequest(f.task.task_id,cross.event_id,revision,request.question_id,true),/owner_mismatch/);assert.equal(sent,0);
  const after=f.db.enqueue({...eventEnvelope("after-approval"),occurred_at:"1999-01-01T00:00:00.000Z"}).row;
  await supervisor.approveTaskRequest(f.task.task_id,after.event_id,revision,request.question_id,true);assert.equal(sent,1);
 }finally{await f.dispose();}
});

test("質問照合cursorは既通知pendingの次へ進み終端後に先頭へ戻る",async()=>{
 const f=await fixture();try{
  const received:Array<string|undefined>=[];const ids=["first","last"];let n=0;
  f.runtime.pendingQuestions=async after=>{received.push(after);const id=ids[n++];return id?[{question_id:id,agent:"missing"} as import("../src/app-server/store.js").QuestionRecord]:[];};
  const supervisor=f.supervisor();for(let i=0;i<4;i++)await supervisor.reconcileQuestions();
  assert.deepEqual(received,[undefined,"first","last",undefined]);
 }finally{await f.dispose();}
});


test("明示Issueを同じ依頼者の別threadから照会しTaskを継続、通知先は保持",async()=>{
 const f=await fixture();try{
  const issue={node_id:"I_lookup",repository:"org/repo",number:24};
  const input=taskRequestSchema.parse({...f.request,task_key:"lookup",workspace:{kind:"github",repository:"org/repo"},issue_number:24});
  const task=f.db.tasks.create(input,f.config.jobsWorkspaceRoot,f.config.jobResultsDir,issue).task;
  const e=eventEnvelope("cross-thread");e.subject.thread_ts="1700000000.000009";e.reply_target!.thread_ts=e.subject.thread_ts;
  const event=f.db.enqueue(e).row;
  assert.equal(f.db.tasks.list(event.event_id).length,0);
  assert.equal(f.db.tasks.findIssue(event.event_id,issue).task_id,task.task_id);
  const paused=f.db.tasks.control(task.task_id,event.event_id,task.revision,"pause");assert.equal(paused.state,"paused");
  assert.deepEqual(f.db.tasks.projection(paused).notification_target,JSON.parse(f.event.reply_target_json!));
  assert.throws(()=>f.db.tasks.assertOwner(task.task_id,event.event_id,true),/owner_mismatch/);
  assert.equal(f.db.listEventJobs(event.event_id).length,0);
  for(const key of ["actor_id","channel_id","workspace_id"] as const){
   const foreign=eventEnvelope(`foreign-${key}`);foreign.subject[key]="other";if(key!=="actor_id")foreign.reply_target![key]="other";
   const denied=f.db.enqueue(foreign).row;
   assert.throws(()=>f.db.tasks.findIssue(denied.event_id,issue),/owner_mismatch/);
   assert.throws(()=>f.db.tasks.control(task.task_id,denied.event_id,paused.revision,"resume"),/owner_mismatch/);
  }
  assert.throws(()=>f.db.tasks.findIssue(event.event_id,{...issue,node_id:"missing"}),/owner_mismatch/);
 }finally{await f.dispose();}
});

async function failedSteerFixture(){
  const f=await fixture();f.start();f.db.sealJobGroup(f.event.event_id);f.db.markJobNeedsReview(f.task.current_attempt_id,"steer_acceptance_unknown","acceptance unknown");
  const job=f.db.getJob(f.task.current_attempt_id)!;
  const result={schema_version:1 as const,job_id:job.job_id,status:"failed" as const,summary:"部分成果あり、残作業あり",completed_at:new Date().toISOString()};
  await fs.mkdir(path.dirname(job.result_path),{recursive:true});await fs.writeFile(job.result_path,JSON.stringify(result));
  await fs.mkdir(job.workspace_path,{recursive:true});await fs.writeFile(path.join(job.workspace_path,"unfinished"),"残作業");
  f.db.tasks.wait(f.db.tasks.get(f.task.task_id)!,"result_reconciliation_required",-1);
  const checkpoint={schema_version:1,task_id:f.task.task_id,attempt_id:job.job_id,sequence:1,summary:"設計資料あり",remaining:[],artifacts:[{kind:"design",reference:"design.md"}],unresolved_operations:[] as string[],waiting:"none"};
  const checkpointPath=path.join(path.dirname(job.result_path),"checkpoint.json");await fs.writeFile(checkpointPath,JSON.stringify(checkpoint));
  f.setObserved({state:"stopped"});f.setStopped(true);
  const input=async()=>{const event=f.db.enqueue(eventEnvelope("explicit-result-reconcile")).row;
    const inspected=await f.supervisor().inspectTaskRecovery(f.task.task_id,event.event_id);
    return {source_event_id:event.event_id,revision:inspected.revision as number,attempt_id:job.job_id,result_sha256:inspected.result_sha256 as string,checkpoint_sha256:inspected.checkpoint_sha256 as string,
      reason:"旧追加指示の未送信と既存成果を照合",steer_resolution:"not_delivered" as const,evidence:[{reference:"command receipt / existing PR",finding:"validationで未送信、PR差分を照合、再送対象なし"}]};};
  return {...f,job,result,input,checkpoint,checkpointPath};
}
test("明示照合は停止済み旧Attemptの失敗Resultを保持し、同一Taskで一度だけ継続する",async()=>{
  const f=await failedSteerFixture();try{
    const input=await f.input(),before=await fs.readFile(f.job.result_path,"utf8");
    await f.supervisor().reconcileTaskResult(f.task.task_id,input);
    const task=f.db.tasks.get(f.task.task_id)!;assert.equal(task.attempt_number,2);assert.equal(task.state,"active");assert.equal(task.steer_pending_event_id,null);assert.equal(f.sends(),0);
    const next=f.db.getJob(task.current_attempt_id)!;assert.equal(next.workspace_path,f.job.workspace_path);assert.notEqual(next.result_path,f.job.result_path);assert.match(next.objective,/未受理失敗Result/);assert.ok(next.objective.includes(input.reason));assert.ok(next.objective.includes(input.steer_resolution));assert.ok(next.objective.includes(input.evidence[0]!.reference));assert.ok(next.objective.includes(input.evidence[0]!.finding));
    assert.equal(await fs.readFile(f.job.result_path,"utf8"),before);assert.equal(await fs.readFile(path.join(next.workspace_path,"unfinished"),"utf8"),"残作業");
    assert.equal(f.db.getJob(f.job.job_id)!.result_json,null);assert.equal(f.db.tasks.mayNotify(f.db.getJob(f.job.job_id)!),false);
    const Database=(await import("better-sqlite3")).default,sql=new Database(f.config.databasePath,{readonly:true});
    const audit=sql.prepare("SELECT * FROM task_attempt_result_recoveries WHERE attempt_id=?").get(f.job.job_id) as {result_json:string;source_event_id:string;request_json:string};
    assert.deepEqual(JSON.parse(audit.result_json),f.result);assert.equal(audit.source_event_id,input.source_event_id);assert.deepEqual(JSON.parse(audit.request_json),input);sql.close();
    await f.supervisor().reconcileTaskResult(f.task.task_id,input);assert.equal(f.db.tasks.get(task.task_id)!.attempt_number,2);
    await assert.rejects(f.supervisor().reconcileTaskResult(f.task.task_id,{...input,reason:"changed"}),/conflict/);
    assert.throws(()=>f.db.saveJobResult(f.job.job_id,f.result,f.job.result_path),/superseded/);
    f.start(next.job_id);f.db.saveJobResult(next.job_id,{...f.result,job_id:next.job_id,status:"completed"},next.result_path);assert.equal(f.db.tasks.get(task.task_id)!.state,"completed");
    const notice=f.db.enqueueJobNotification(next.job_id).row;assert.equal(JSON.parse(notice.payload_json).group.total,1);
  }finally{await f.dispose();}
});
for(const mode of ["working","waiting","unknown","stop-unverified","completed","invalid","result-drift","checkpoint-drift","unresolved","quarantine","missing-evidence","other-owner"] as const)test(`Result照合は${mode}を許可しない`,async()=>{
  const f=await failedSteerFixture();try{
    let input=await f.input();
    if(["working","waiting","unknown"].includes(mode))f.setObserved({state:mode as "working"|"waiting"|"unknown"});
    if(mode==="stop-unverified"||mode==="unknown")f.setStopped(false);
    if(mode==="completed")await fs.writeFile(f.job.result_path,JSON.stringify({...f.result,status:"completed"}));
    if(mode==="invalid")await fs.writeFile(f.job.result_path,"broken");
    if(mode==="result-drift")f.runtime.workerRetired=async()=>{await fs.writeFile(f.job.result_path,JSON.stringify({...f.result,summary:"changed"}));return true;};
    if(mode==="checkpoint-drift")f.runtime.workerRetired=async()=>{await fs.writeFile(f.checkpointPath,JSON.stringify({...f.checkpoint,sequence:2,unresolved_operations:["unknown write"]}));return true;};
    if(mode==="unresolved"){await fs.writeFile(f.checkpointPath,JSON.stringify({...f.checkpoint,unresolved_operations:["write unknown"],waiting:"external_effect_unknown"}));input=await f.input();}
    if(mode==="quarantine")f.db.markJobNeedsReview(f.job.job_id,"invalid_result","quarantine");
    if(mode==="missing-evidence")input={...input,evidence:[]};
    if(mode==="other-owner"){const e=eventEnvelope("other-owner");e.subject.actor_id="U_OTHER";input={...input,source_event_id:f.db.enqueue(e).row.event_id};}
    await assert.rejects(f.supervisor().reconcileTaskResult(f.task.task_id,input));assert.equal(f.db.tasks.get(f.task.task_id)!.attempt_number,1);assert.equal(f.sends(),0);assert.equal(f.db.getJob(f.job.job_id)!.result_json,null);
  }finally{await f.dispose();}
});
test("通常resumeだけではResult照合を迂回しない",async()=>{
  const f=await failedSteerFixture();try{const t=f.db.tasks.get(f.task.task_id)!,e=f.db.enqueue(eventEnvelope("resume-only")).row;f.db.tasks.control(t.task_id,e.event_id,t.revision,"resume");await f.supervisor().reconcileTasks();assert.equal(f.db.tasks.get(t.task_id)!.attempt_number,1);assert.equal(f.db.tasks.get(t.task_id)!.wait_reason,"result_reconciliation_required");}finally{await f.dispose();}
});
test("照合済みResultは予算上限からretryで継続できる",async()=>{
  const f=await failedSteerFixture();try{
    const Database=(await import("better-sqlite3")).default,sql=new Database(f.config.databasePath);sql.prepare("UPDATE tasks SET max_attempts=1 WHERE task_id=?").run(f.task.task_id);sql.close();
    await f.supervisor().reconcileTaskResult(f.task.task_id,await f.input());let task=f.db.tasks.get(f.task.task_id)!;assert.equal(task.wait_reason,"retry_exhausted");assert.equal(task.stop_state,"stopped");
    f.due();await f.supervisor().reconcileTasks();assert.equal(f.db.tasks.get(task.task_id)!.wait_reason,"retry_exhausted");
    const e=f.db.enqueue(eventEnvelope("retry-reconciled")).row;f.db.tasks.retry(task.task_id,e.event_id,task.revision,3);await f.supervisor().reconcileTasks();assert.equal(f.db.tasks.get(task.task_id)!.attempt_number,2);
  }finally{await f.dispose();}
});
for(const action of ["cancel","pause"] as const)test(`照合と競合した${action}は次回巡回で停止済みに確定する`,async()=>{
  const f=await failedSteerFixture();try{
    const input=await f.input();f.runtime.workerRetired=async()=>{const t=f.db.tasks.get(f.task.task_id)!;if(t.desired_state==="running"){const e=f.db.enqueue(eventEnvelope("control-during-reconcile")).row;f.db.tasks.control(t.task_id,e.event_id,t.revision,action);}return true;};
    await assert.rejects(f.supervisor().reconcileTaskResult(f.task.task_id,input),/revision/);await f.supervisor().reconcileTasks();
    const t=f.db.tasks.get(f.task.task_id)!;assert.equal(t.state,action==="pause"?"paused":"cancelled");assert.equal(t.stop_state,"stopped");assert.equal(t.attempt_number,1);assert.equal(f.db.tasks.resultRecovery(f.job.job_id),undefined);assert.ok(await fs.stat(f.job.result_path));
  }finally{await f.dispose();}
});
test("別threadの所有者照合をAPIから受け、通知処理中なら証拠と後継作成をrollbackする",async()=>{
  const f=await failedSteerFixture(),api=new DispatcherApi(f.db,{isRunning:()=>true,wake(){}},f.supervisor(),f.config,logger);
  try{
    await api.start();const client=new DispatcherApiClient(f.config.socketPath),input=await f.input();
    const e=eventEnvelope("cross-thread-result-reconcile");e.subject.thread_ts="1700000000.000009";e.reply_target!.thread_ts="1700000000.000009";const event=f.db.enqueue(e).row;
    const notice=f.db.enqueueJobNotification(f.job.job_id).row;
    const Database=(await import("better-sqlite3")).default,sql=new Database(f.config.databasePath);sql.prepare("UPDATE events SET status='dispatching' WHERE event_id=?").run(notice.event_id);
    await assert.rejects(client.controlTask(f.task.task_id,"reconcile",{...input,source_event_id:event.event_id}));assert.equal(f.db.tasks.get(f.task.task_id)!.attempt_number,1);
    assert.equal((sql.prepare("SELECT count(*) AS n FROM task_attempt_result_recoveries").get() as {n:number}).n,0);assert.equal(f.db.tasks.get(f.task.task_id)!.stop_state,"none");sql.close();
  }finally{await api.stop();await f.dispose();}
});

test("main用の照合MCPからUDSを通し、理由と証拠を保存して継続する",async()=>{
  const f=await failedSteerFixture(),api=new DispatcherApi(f.db,{isRunning:()=>true,wake(){}},f.supervisor(),f.config,logger);
  const {Client}=await import("@modelcontextprotocol/sdk/client/index.js"),{InMemoryTransport}=await import("@modelcontextprotocol/sdk/inMemory.js"),{createDispatcherMcpServer}=await import("../src/mcp/server.js");
  await api.start();const server=createDispatcherMcpServer(new DispatcherApiClient(f.config.socketPath),logger),client=new Client({name:"recovery-contract",version:"1"});const [a,b]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b),client.connect(a)]);
  try{
    const input=await f.input();const inspected=await client.callTool({name:"inspect_task_recovery",arguments:{task_id:f.task.task_id,source_event_id:input.source_event_id}});assert.equal(inspected.isError,undefined);assert.equal((inspected.structuredContent as {result_sha256:string}).result_sha256,input.result_sha256);
    const call={name:"reconcile_task_result",arguments:{task_id:f.task.task_id,...input}};const result=await client.callTool(call);assert.equal(result.isError,undefined);assert.equal(f.db.tasks.get(f.task.task_id)!.attempt_number,2);
    assert.equal((await client.callTool(call)).isError,undefined);assert.equal(f.db.tasks.get(f.task.task_id)!.attempt_number,2);
  }finally{await client.close();await server.close();await api.stop();await f.dispose();}
});

test("checkpoint file欠落時に永続checkpointの未解決操作を忘れない",async()=>{
  const f=await failedSteerFixture();try{
    const {checkpointSchema}=await import("../src/task-checkpoint.js");
    f.db.tasks.checkpoint(f.job,checkpointSchema.parse({...f.checkpoint,unresolved_operations:["unknown external write"],waiting:"external_effect_unknown"}));
    await fs.unlink(f.checkpointPath);const input=await f.input();assert.equal(input.checkpoint_sha256,"missing");
    await assert.rejects(f.supervisor().reconcileTaskResult(f.task.task_id,input),/checkpoint_missing/);assert.equal(f.db.tasks.get(f.task.task_id)!.attempt_number,1);
  }finally{await f.dispose();}
});
test("回復検査は観測・checkpointをDBへ書き込まない",async()=>{
  const f=await failedSteerFixture();try{
    assert.equal(f.db.getWorkerObservation(f.job),undefined);assert.equal(f.db.tasks.latestCheckpoint(f.task.task_id),undefined);
    await f.input();assert.equal(f.db.getWorkerObservation(f.job),undefined);assert.equal(f.db.tasks.latestCheckpoint(f.task.task_id),undefined);
  }finally{await f.dispose();}
});

test("前Attemptだけのcheckpointは現在Attemptのfile欠落として拒否しない",async()=>{
  const f=await fixture();try{
    f.start();const previous=f.db.getJob(f.task.current_attempt_id)!;
    f.db.tasks.checkpoint(previous,{schema_version:1,task_id:f.task.task_id,attempt_id:previous.job_id,sequence:1,summary:"前回成果",remaining:[],artifacts:[],unresolved_operations:[],waiting:"none"});
    f.interrupt();await f.supervisor().reconcileTasks();const second=f.db.getJob(f.db.tasks.get(f.task.task_id)!.current_attempt_id)!;f.start(second.job_id);
    f.db.markJobNeedsReview(second.job_id,"steer_acceptance_unknown","unknown");await fs.mkdir(path.dirname(second.result_path),{recursive:true});await fs.writeFile(second.result_path,JSON.stringify({schema_version:1,job_id:second.job_id,status:"failed",summary:"続きが必要",completed_at:new Date().toISOString()}));
    f.db.tasks.wait(f.db.tasks.get(f.task.task_id)!,"result_reconciliation_required",-1);f.setObserved({state:"stopped"});f.setStopped(true);
    const event=f.db.enqueue(eventEnvelope("reconcile-second")).row,inspected=await f.supervisor().inspectTaskRecovery(f.task.task_id,event.event_id);
    assert.equal(inspected.checkpoint_sha256,"missing");assert.equal(inspected.persisted_checkpoint,null);
    await f.supervisor().reconcileTaskResult(f.task.task_id,{source_event_id:event.event_id,revision:inspected.revision,attempt_id:second.job_id,result_sha256:inspected.result_sha256,checkpoint_sha256:"missing",reason:"現Attemptの成果を照合",steer_resolution:"not_delivered",evidence:[{reference:"receipt",finding:"送信前拒否"}]});
    assert.equal(f.db.tasks.get(f.task.task_id)!.attempt_number,3);assert.ok(f.db.tasks.attemptCheckpoint(previous.job_id));
  }finally{await f.dispose();}
});

for(const code of ["job_preparation_failed","command_failed","command_timeout","EACCES"])for(const action of ["resume","cancel"] as const)test(`worker未作成の${code}をpause後${action}し、同じAttemptと準備回数を保持する`,async()=>{
 const f=await fixture();try{
  f.db.beginJobPreparation(f.task.current_attempt_id);
  f.db.recordJobPreparationFailure(f.task.current_attempt_id,code,"preparation failed",5);
  const job=f.db.getJob(f.task.current_attempt_id)!;
  f.runtime.observeWorker=async()=>{throw Error("worker was never created");};
  const pause=f.db.enqueue(eventEnvelope("pause-preparation")).row;
  const before=f.db.tasks.get(f.task.task_id)!;
  f.db.tasks.control(before.task_id,pause.event_id,before.revision,"pause");
  await f.supervisor().reconcileTasks();
  const paused=f.db.tasks.get(before.task_id)!;assert.equal(paused.wait_reason,"paused");assert.equal(f.db.getJob(job.job_id)!.status,"blocked");assert.equal(f.db.tasks.canRun(f.db.getJob(job.job_id)!),false);
  const follow=f.db.enqueue(eventEnvelope(action+"-preparation")).row;
  const result=f.db.tasks.control(paused.task_id,follow.event_id,paused.revision,action);
  assert.equal(result.state,action==="resume"?"active":"cancelled");assert.equal(result.current_attempt_id,job.job_id);assert.equal(result.attempt_number,1);assert.equal(f.db.getJob(job.job_id)!.attempt_count,job.attempt_count);assert.equal(f.sends(),0);
  if(action==="resume")assert.equal(f.db.tasks.canRun(f.db.getJob(job.job_id)!),true);
 }finally{await f.dispose();}
});

for(const boundary of ["stale_preparing","runtime_identity","dispatch_intent"] as const)test(`準備失敗の${boundary}はworker未作成と断定して再開しない`,async()=>{
 const f=await fixture();try{
  f.db.beginJobPreparation(f.task.current_attempt_id);
  if(boundary==="runtime_identity")f.db.setJobRuntime(f.task.current_attempt_id,"w","p");
  f.db.recordJobPreparationFailure(f.task.current_attempt_id,boundary==="stale_preparing"?"stale_preparing":"job_preparation_failed","failure",5);
  if(boundary==="dispatch_intent"){const Database=(await import("better-sqlite3")).default,sql=new Database(f.config.databasePath);sql.prepare("UPDATE jobs SET dispatch_started_at=? WHERE job_id=?").run(new Date().toISOString(),f.task.current_attempt_id);sql.close();}
  const before=f.db.tasks.get(f.task.task_id)!;
  const pause=f.db.enqueue(eventEnvelope("pause-ambiguous-preparation")).row;f.db.tasks.control(before.task_id,pause.event_id,before.revision,"pause");
  const paused=f.db.tasks.get(before.task_id)!;assert.equal(paused.wait_reason,"pause_requested");assert.equal(f.db.getJob(before.current_attempt_id)!.status,"retryable_failed");
  const follow=f.db.enqueue(eventEnvelope("resume-ambiguous-preparation")).row;
  const result=f.db.tasks.control(paused.task_id,follow.event_id,paused.revision,"resume");assert.equal(result.state,"waiting");assert.equal(f.db.tasks.canRun(f.db.getJob(result.current_attempt_id)!),false);
 }finally{await f.dispose();}
});

 test("旧版で準備失敗をpauseしたTaskも未起動の同じAttemptへ復帰する",async()=>{
 const f=await fixture();try{
  f.db.beginJobPreparation(f.task.current_attempt_id);f.db.recordJobPreparationFailure(f.task.current_attempt_id,"job_preparation_failed","branch mismatch",5);
  const Database=(await import("better-sqlite3")).default,sql=new Database(f.config.databasePath);
  sql.prepare("UPDATE tasks SET state='paused',desired_state='paused',wait_reason='worker_unknown',observation_failures=3 WHERE task_id=?").run(f.task.task_id);sql.close();
  const task=f.db.tasks.get(f.task.task_id)!,event=f.db.enqueue(eventEnvelope("resume-old-paused")).row;
  const result=f.db.tasks.control(task.task_id,event.event_id,task.revision,"resume");assert.equal(result.state,"active");assert.equal(result.current_attempt_id,task.current_attempt_id);assert.equal(f.db.getJob(task.current_attempt_id)!.status,"queued");assert.equal(f.db.getJob(task.current_attempt_id)!.attempt_count,1);assert.equal(result.observation_failures,0);f.db.tasks.wait(result,"observation_unknown");assert.equal(f.db.tasks.get(task.task_id)!.wait_reason,"observation_unknown");
 }finally{await f.dispose();}
});

for(const code of ["command_failed","command_timeout"])test(`未起動Attemptの${code}後の取消通知に古いerrorを残さない`,async()=>{
 const f=await fixture();try{
  f.db.beginJobPreparation(f.task.current_attempt_id);f.db.recordJobPreparationFailure(f.task.current_attempt_id,code,"old preparation error",5,new Date("2026-01-01T00:00:00Z"));
  const Database=(await import("better-sqlite3")).default,sql=new Database(f.config.databasePath);sql.prepare("UPDATE jobs SET updated_at='2026-01-01T00:00:00Z' WHERE job_id=?").run(f.task.current_attempt_id);sql.close();
  const before=f.db.getJob(f.task.current_attempt_id)!,task=f.db.tasks.get(f.task.task_id)!,event=f.db.enqueue(eventEnvelope("cancel-preparation-error")).row;
  f.db.tasks.control(task.task_id,event.event_id,task.revision,"cancel");
  const after=f.db.getJob(before.job_id)!;assert.equal(after.status,"cancelled");assert.equal(after.last_error_code,null);assert.equal(after.last_error_message,null);assert.equal(after.updated_at,after.completed_at);assert.notEqual(after.updated_at,before.updated_at);
  f.db.sealJobGroup(f.event.event_id);const notice=f.db.enqueueJobNotification(after.job_id).row,payload=JSON.parse(notice.payload_json);
  assert.equal(payload.job_status,"cancelled");assert.equal(payload.error,undefined);
 }finally{await f.dispose();}
});

async function failedPreparationFixture(){
 const f=await fixture();const id=f.task.current_attempt_id;
 f.db.beginJobPreparation(id);f.db.recordJobPreparationFailure(id,"job_preparation_failed","runtime_mcp_inventory_failed",1);
 const task=f.db.tasks.get(f.task.task_id)!;
 const retry=(revision=task.revision,max=task.max_attempts,event=f.event.event_id)=>f.db.tasks.retryPreparation(task.task_id,event,revision,max,id,f.config.jobResultsDir);
 return {...f,failed:task,retry};
}

test("起動前失敗の明示retryは履歴・成果・既存controlを保ち、応答喪失後も次Attemptを一度だけ作る",async()=>{
 const f=await failedPreparationFixture();try{
  const old=f.db.getJob(f.failed.current_attempt_id)!;
  await fs.mkdir(old.workspace_path,{recursive:true});await fs.writeFile(path.join(old.workspace_path,"changes"),"keep");
  // An earlier operation on the same event must not be overwritten by retry.
  const sql=new Database(f.config.databasePath);sql.prepare("INSERT INTO task_controls(task_id,source_event_id,request_sha256) VALUES(?,?,?)").run(f.task.task_id,f.event.event_id,"earlier-pause");sql.close();
  f.db.sealJobGroup(f.event.event_id);
  const first=f.retry();assert.equal(first.state,"active");assert.equal(first.attempt_number,2);assert.equal(first.stop_state,"none");
  assert.equal(f.retry().current_attempt_id,first.current_attempt_id);assert.throws(()=>f.retry(f.failed.revision,4),/task_control_conflict/);
  const next=f.db.getJob(first.current_attempt_id)!;assert.equal(next.status,"queued");assert.equal(next.objective,old.objective);assert.equal(next.workspace_path,old.workspace_path);assert.notEqual(next.result_path,old.result_path);
  assert.deepEqual(f.db.getJob(old.job_id),old);assert.equal(await fs.readFile(path.join(next.workspace_path,"changes"),"utf8"),"keep");
  const after=new Database(f.config.databasePath);assert.equal((after.prepare("SELECT request_sha256 FROM task_controls WHERE task_id=?").get(first.task_id) as {request_sha256:string}).request_sha256,"earlier-pause");after.close();
  const attempts=f.db.tasks.projection(first).attempts as Array<Record<string,unknown>>;assert.equal(attempts[0]!.outcome,"failed");assert.equal(attempts[0]!.preparation_retry_successor_id,next.job_id);
  f.start(next.job_id);f.db.saveJobResult(next.job_id,{schema_version:1,job_id:next.job_id,status:"completed",summary:"done",completed_at:new Date().toISOString()},next.result_path);
  const notification=f.db.enqueueJobNotification(next.job_id).row;assert.equal(JSON.parse(notification.payload_json).group.total,1);assert.equal(JSON.parse(notification.payload_json).group.transition,"all_terminal");assert.equal(f.db.tasks.get(first.task_id)!.state,"completed");
 }finally{await f.dispose();}
});

for(const guard of ["revision","budget","owner","runtime","dispatch","prompt","result","result_file","result_symlink","stale","ambiguous","unknown_preparation","paused","steer","identity"] as const)test(`起動前retryは${guard}の競合・未確認状態を拒否`,async()=>{
 const f=await failedPreparationFixture();try{
  const old=f.db.getJob(f.failed.current_attempt_id)!;let event=f.event.event_id,revision=f.failed.revision,max=f.failed.max_attempts;
  const sql=new Database(f.config.databasePath);
  if(guard==="revision")revision--;
  if(guard==="budget")max=1;
  if(guard==="owner"){const e=eventEnvelope("foreign");e.subject.actor_id="U_OTHER";event=f.db.enqueue(e).row.event_id;}
  if(guard==="runtime")sql.prepare("UPDATE jobs SET herdr_pane_id='worker' WHERE job_id=?").run(old.job_id);
  if(guard==="dispatch")sql.prepare("UPDATE jobs SET dispatch_started_at=? WHERE job_id=?").run(new Date().toISOString(),old.job_id);
  if(guard==="prompt")sql.prepare("UPDATE jobs SET prompt_accepted_at=? WHERE job_id=?").run(new Date().toISOString(),old.job_id);
  if(guard==="result")sql.prepare("UPDATE jobs SET result_json='{}' WHERE job_id=?").run(old.job_id);
  if(guard==="result_file"||guard==="result_symlink"){await fs.mkdir(path.dirname(old.result_path),{recursive:true});if(guard==="result_file")await fs.writeFile(old.result_path,"{}");else await fs.symlink(path.join(f.root,"missing"),old.result_path);}
  if(guard==="stale"||guard==="ambiguous")sql.prepare("UPDATE jobs SET last_error_code=? WHERE job_id=?").run(guard==="stale"?"stale_preparing":"runtime_preparation_unknown",old.job_id);
  if(guard==="unknown_preparation")sql.prepare("UPDATE jobs SET last_error_message='unclassified error after worker start' WHERE job_id=?").run(old.job_id);
  if(guard==="paused")sql.prepare("UPDATE tasks SET desired_state='paused' WHERE task_id=?").run(f.task.task_id);
  if(guard==="steer")sql.prepare("UPDATE jobs SET steer_state='dispatching' WHERE job_id=?").run(old.job_id);
  if(guard==="identity")sql.prepare("INSERT INTO job_live_session_identities(job_id,identity_version,herdr_agent_session_id,herdr_workspace_id,herdr_pane_id,agent_name,recorded_at,generation_nonce) VALUES(?,1,'session','w','p','a',?,'nonce')").run(old.job_id,new Date().toISOString());
  sql.close();assert.throws(()=>f.retry(revision,max,event));assert.equal(f.db.tasks.get(f.task.task_id)!.current_attempt_id,old.job_id);
  assert.equal(f.db.listEventJobs(f.event.event_id).length,1);
 }finally{await f.dispose();}
});

for(const status of ["queued","dispatching","needs_review","completed","mcp_completed","ambiguous_completed"] as const)test(`失敗通知${status}と起動前retryの順序を保つ`,async()=>{
 const f=await failedPreparationFixture();try{
  f.db.sealJobGroup(f.event.event_id);const notification=f.db.enqueueJobNotification(f.failed.current_attempt_id).row;
  if(status==="completed"||status==="mcp_completed"||status==="ambiguous_completed") {
    const resultPath=path.join(f.config.resultsDir,"attention.json"),target=JSON.parse(notification.reply_target_json!);
    f.db.beginDispatch(notification.event_id,resultPath);f.db.markWaiting(notification.event_id);
    f.db.saveCompleted(notification.event_id,{schema_version:1,event_id:notification.event_id,status:"completed",summary:"delivered",completed_at:new Date().toISOString(),actions:[
      {tool:status==="mcp_completed"?"mcp__dona_slack__post_message":"dona_slack.post_message",...target,message_ts:"123.456",ambiguous:status==="ambiguous_completed"},
      {tool:status==="mcp_completed"?"mcp__dona_slack__set_agent_session_status":"dona_slack.set_agent_session_status",...target,status:"suspended"}
    ]},resultPath);
  }else {const sql=new Database(f.config.databasePath);sql.prepare("UPDATE events SET status=? WHERE event_id=?").run(status,notification.event_id);sql.close();}
  if(status!=="completed"&&status!=="mcp_completed")assert.throws(()=>f.retry(),/task_prior_notification_requires_reconciliation/);
  else {
    const task=f.retry();assert.equal(f.db.get(notification.event_id)!.status,"completed");assert.equal(f.db.getJobGroup(f.event.event_id)!.all_terminal_event_id,null);
    f.start(task.current_attempt_id);f.db.saveJobResult(task.current_attempt_id,{schema_version:1,job_id:task.current_attempt_id,status:"completed",summary:"done",completed_at:new Date().toISOString()},f.db.getJob(task.current_attempt_id)!.result_path);
    const final=f.db.enqueueJobNotification(task.current_attempt_id).row;assert.notEqual(final.event_id,notification.event_id);
    assert.equal(JSON.parse(final.payload_json).group.transition,"all_terminal");assert.equal(JSON.parse(final.payload_json).group.attention_resolution_state,"resolved");
  }
 }finally{await f.dispose();}
});

for(const status of ["failed","needs_review","blocked"] as const)test(`旧attention配送後の後継${status}を新しいattentionとして通知する`,async()=>{
 const f=await failedPreparationFixture();try{
  f.db.sealJobGroup(f.event.event_id);const notification=f.db.enqueueJobNotification(f.failed.current_attempt_id).row;
  const resultPath=path.join(f.config.resultsDir,"attention.json"),target=JSON.parse(notification.reply_target_json!);
  f.db.beginDispatch(notification.event_id,resultPath);f.db.markWaiting(notification.event_id);
  f.db.saveCompleted(notification.event_id,{schema_version:1,event_id:notification.event_id,status:"completed",summary:"delivered",completed_at:new Date().toISOString(),actions:[
    {tool:"dona_slack.post_message",...target,message_ts:"123.456"},
    {tool:"dona_slack.set_agent_session_status",...target,status:"suspended"}
  ]},resultPath);
  const oldNotice=f.db.get(notification.event_id),oldJob=f.db.getJob(f.failed.current_attempt_id);
  const task=f.retry();f.start(task.current_attempt_id);const job=f.db.getJob(task.current_attempt_id)!;
  if(status==="failed")f.db.saveJobResult(job.job_id,{schema_version:1,job_id:job.job_id,status:"failed",summary:"failed again",completed_at:new Date().toISOString()},job.result_path);
  else if(status==="needs_review")f.db.markJobNeedsReview(job.job_id,"invalid_result","review needed");
  else f.db.markJobBlocked(job.job_id,"input needed");
  assert.ok(f.db.listJobsNeedingNotification().some(row=>row.job_id===job.job_id));
  const next=f.db.enqueueJobNotification(job.job_id).row,group=JSON.parse(next.payload_json).group;
  assert.notEqual(next.event_id,notification.event_id);assert.equal(group.transition,"attention");assert.equal(group.total,1);assert.equal(group.jobs[0].job_id,job.job_id);
  assert.equal(f.db.getJobGroup(f.event.event_id)!.attention_event_id,next.event_id);assert.deepEqual(f.db.get(notification.event_id),oldNotice);assert.deepEqual(f.db.getJob(f.failed.current_attempt_id),oldJob);
  if(status==="blocked") {
    const nextPath=path.join(f.config.resultsDir,"next-attention.json");f.db.beginDispatch(next.event_id,nextPath);f.db.markWaiting(next.event_id);
    f.db.saveCompleted(next.event_id,{schema_version:1,event_id:next.event_id,status:"completed",summary:"delivered",completed_at:new Date().toISOString(),actions:[
      {tool:"dona_slack.post_message",...target,message_ts:"123.457"},{tool:"dona_slack.set_agent_session_status",...target,status:"suspended"}
    ]},nextPath);
    const answer=f.db.enqueue(eventEnvelope("answer-after-retry")).row;
    f.db.tasks.prepareSteer(task.task_id,answer.event_id,f.db.tasks.get(task.task_id)!.revision,"回答して続行");
    f.db.beginJobSteer(job.job_id,answer.event_id);f.db.markJobSteerAccepted(job.job_id,answer.event_id);f.db.tasks.finishSteer(task.task_id,answer.event_id);
    f.db.saveJobResult(job.job_id,{schema_version:1,job_id:job.job_id,status:"completed",summary:"answered and done",completed_at:new Date().toISOString()},job.result_path);
    assert.deepEqual(f.db.listJobsNeedingNotification().map(row=>row.job_id),[job.job_id]);
    const final=f.db.enqueueJobNotification(job.job_id).row;assert.equal(JSON.parse(final.payload_json).group.transition,"all_terminal");
  }
 }finally{await f.dispose();}
});
