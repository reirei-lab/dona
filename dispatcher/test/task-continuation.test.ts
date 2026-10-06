import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import Database from "better-sqlite3";
import { DashboardTaskReader } from "../src/dashboard/task-reader.js";
import { buildJobPrompt } from "../src/job-prompt.js";
import { JobSupervisor } from "../src/job-supervisor.js";
import { DispatcherDatabase } from "../src/database.js";
import { taskRequestSchema, type TaskRow } from "../src/task-execution.js";
import { buildEventPrompt,envelopeFromRow } from "../src/prompt.js";
import { eventEnvelope,tempConfig } from "./helpers.js";
async function fixture(options:{projectOwner?:string;longInitial?:boolean;maxAttempts?:number}={}) {
  const {root,config}=await tempConfig();let db=new DispatcherDatabase(config.databasePath);
  const event=db.enqueue(eventEnvelope("request")).row;
  const request=taskRequestSchema.parse({source_event_id:event.event_id,task_key:"audit",objective:options.longInitial?"a".repeat(100000):"14件を監査し順番に進める",workspace:{kind:"scratch"},
    initial_operation:"read_only",policy:{max_attempts:options.maxAttempts??3,retry_delay_ms:1000},
    continuation_scope:{objective:"監査後、Issue 167/168を並行実装してPR・review・CIまで。次にIssue 229を監査。",targets:[{repository:"org/repo",issue_numbers:[167,168,229],...(options.projectOwner?{project:{owner:options.projectOwner,number:4}}:{})}],allow_scratch:true,operations:["read_only","submit_pr"],max_tasks:4,max_attempts_per_task:options.maxAttempts??3}});
  const task=db.tasks.create(request,config.jobsWorkspaceRoot,config.jobResultsDir).task;
  const finish=(t:TaskRow)=>{
    const job=db.getJob(t.current_attempt_id)!;
    db.beginJobPreparation(job.job_id,new Date(job.available_at));db.setJobRuntime(job.job_id,"w","p");db.beginJobDispatch(job.job_id);db.markJobRunning(job.job_id);
    db.saveJobResult(job.job_id,{schema_version:1,job_id:job.job_id,status:"completed",summary:"確認済み",completed_at:new Date().toISOString()},job.result_path);
    db.sealJobGroup(t.source_event_id);return db.enqueueJobNotification(job.job_id).row;
  };
  const notice=finish(task);
  db.manualComplete(event.event_id);
  const child=(key="issue-167",issue=167,parent=task,eventId=notice.event_id)=>taskRequestSchema.parse({source_event_id:eventId,task_key:key,objective:`Issue ${issue}の実装とPR提出`,workspace:{kind:"github",repository:"org/repo"},issue_number:issue,
    policy:{max_attempts:options.maxAttempts??3,retry_delay_ms:1000},continuation:{parent_task_id:parent.task_id,parent_revision:db.tasks.get(parent.task_id)!.revision,scope_revision:1,operation:"submit_pr"}});
  const create=(input:ReturnType<typeof child>)=>db.tasks.create(input,config.jobsWorkspaceRoot,config.jobResultsDir,input.issue_number?{node_id:`I_${input.issue_number}`,repository:"org/repo",number:input.issue_number}:undefined).task;
  return {root,config,event,request,task,notice,child,create,finish,get db(){return db;},restart(){db.close();db=new DispatcherDatabase(config.databasePath);},async dispose(){db.close();await fs.rm(root,{recursive:true,force:true});}};
}
test("監査完了から並行実装、次段階まで元依頼を引き継ぎ、再起動・応答喪失でも重複しない",async()=>{
 const f=await fixture();try {
  const a=f.create(f.child()),b=f.create(f.child("issue-168",168));
  assert.equal(f.db.getJob(a.current_attempt_id)!.source,"dona_job");assert.equal(a.source_event_id,f.notice.event_id);
  assert.deepEqual(f.db.tasks.projection(a).notification_target,JSON.parse(f.event.reply_target_json!));
  assert.match(buildJobPrompt(f.db.getJob(a.current_attempt_id)!),/merge・本番反映/);assert.equal(a.objective,f.db.getJob(a.current_attempt_id)!.objective);
  assert.equal(f.db.tasks.assertOwner(a.task_id,f.notice.event_id).task_id,a.task_id);assert.equal(f.db.tasks.list(f.notice.event_id).length,3);
  f.restart();assert.equal(f.create(f.child()).task_id,a.task_id);
  assert.throws(()=>f.create({...f.child(),objective:"別内容"}),/idempotency_conflict/);
  const progress=f.finish(a);assert.equal(JSON.parse(progress.payload_json).group.transition,"progress");
  assert.throws(()=>f.create(f.child("too-early",229,a,progress.event_id)),/owner_mismatch/);
  const complete=f.finish(b);assert.equal(JSON.parse(complete.payload_json).group.transition,"all_terminal");
  const next=f.create(f.child("audit-229",229,b,complete.event_id));
  assert.equal((f.db.tasks.projection(next).continuation as any).root_task_id,f.task.task_id);
  assert.equal(f.db.tasks.assertOwner(f.task.task_id,complete.event_id).task_id,f.task.task_id);
  assert.throws(()=>f.create({...f.child("extra",229,b,complete.event_id),issue_number:167}),/budget_exceeded/);
  const follow=f.db.enqueue(eventEnvelope("follow")).row;
  assert.equal(f.create({...f.child(),source_event_id:follow.event_id}).task_id,a.task_id);
  assert.match(buildEventPrompt(complete.event_id,"/tmp/result",envelopeFromRow(complete)),/内部イベントを作るための『開始』を再要求しません/);
 }finally{await f.dispose();}
});
for(const violation of ["repository","issue","operation","project","budget","revision","parent-revision"] as const)test(`保存済み範囲外の${violation}を拒否`,async()=>{
 const f=await fixture();try {
  const input=f.child();
  if(violation==="repository")input.workspace={kind:"github",repository:"other/repo"};
  if(violation==="issue")input.issue_number=999;
  if(violation==="operation"){input.workspace={kind:"scratch"};delete input.issue_number;}
  if(violation==="project")input.project={owner:"org",number:8,completion_status:"Merge Ready"};
  if(violation==="budget")input.policy.max_attempts=4;
  if(violation==="revision")input.continuation!.scope_revision=2;
  if(violation==="parent-revision")input.continuation!.parent_revision=1;
  assert.throws(()=>f.create(input),/scope_mismatch|budget_exceeded|revision_conflict/);assert.equal(f.db.tasks.list(f.notice.event_id).length,1);
 }finally{await f.dispose();}
});
test("scope取消を非同期照会後の作成で再検証し、受理済みの照合は維持する",async()=>{
 const f=await fixture();try {
  const a=f.create(f.child()),pending=f.child("issue-168",168);assert.equal(f.db.tasks.lookupRequest(pending),undefined);
  const stop=f.db.enqueue(eventEnvelope("cancel-continuation")).row,control={source_event_id:stop.event_id,revision:1,state:"cancelled" as const};
  f.db.tasks.continuations.control(f.task.task_id,control);assert.throws(()=>f.create(pending),/continuation_stopped/);
  assert.equal(f.db.tasks.lookupRequest(f.child())!.task_id,a.task_id);assert.equal(f.db.tasks.continuations.control(f.task.task_id,control).state,"cancelled");
  assert.throws(()=>f.db.tasks.continuations.control(f.task.task_id,{...control,state:"active"}),/control_conflict/);
  const resume=f.db.enqueue(eventEnvelope("resume")).row;
  assert.throws(()=>f.db.tasks.continuations.control(f.task.task_id,{source_event_id:resume.event_id,revision:2,state:"active"}),/continuation_stopped/);
  assert.equal(f.db.tasks.get(a.task_id)!.state,"active");
 }finally{await f.dispose();}
});
test("scopeのpause/resumeはrevisionを進め、旧snapshotの作成を拒否",async()=>{
 const f=await fixture();try {
  const paused=f.db.enqueue(eventEnvelope("pause")).row;f.db.tasks.continuations.control(f.task.task_id,{source_event_id:paused.event_id,revision:1,state:"paused"});
  assert.throws(()=>f.create(f.child()),/continuation_stopped/);
  const resumed=f.db.enqueue(eventEnvelope("resume")).row;f.db.tasks.continuations.control(f.task.task_id,{source_event_id:resumed.event_id,revision:2,state:"active"});
  assert.throws(()=>f.create(f.child()),/revision_conflict/);const input=f.child();input.continuation!.scope_revision=3;assert.equal(f.create(input).state,"active");
 }finally{await f.dispose();}
});
for(const violation of ["actor","thread","fake-notice","pending-result","missing-scope"] as const)test(`不正な継続元${violation}を拒否`,async()=>{
 const f=await fixture();try {
  const input=f.child();
  if(violation==="actor"||violation==="thread") {
   const envelope=eventEnvelope(violation);if(violation==="actor")envelope.subject.actor_id="U_OTHER";
   else {envelope.subject.thread_ts="1756722031.123456";envelope.reply_target!.thread_ts="1756722031.123456";}
   input.source_event_id=f.db.enqueue(envelope).row.event_id;
  }
  if(violation==="fake-notice") {const forged=envelopeFromRow(f.notice);forged.external_event_id="forged";input.source_event_id=f.db.enqueue(forged).row.event_id;}
  if(violation==="pending-result"||violation==="missing-scope") {
   const sql=new Database(f.config.databasePath);
   if(violation==="pending-result")sql.prepare("UPDATE jobs SET result_json=NULL WHERE job_id=?").run(f.task.current_attempt_id);
   else {sql.prepare("DELETE FROM task_continuation_requests").run();sql.prepare("DELETE FROM task_continuation_members").run();}sql.close();
  }
  assert.throws(()=>f.create(input),violation==="pending-result"?/parent_not_completed/:/owner_mismatch/);
 }finally{await f.dispose();}
});
test("独立した兄弟Taskの一時停止で依頼全体を停止しない",async()=>{
 const f=await fixture();try {
  const a=f.create(f.child()),stop=f.db.enqueue(eventEnvelope("pause-worker")).row;f.db.tasks.control(a.task_id,stop.event_id,a.revision,"pause");
  assert.equal(f.create(f.child("issue-168",168)).state,"active");
 }finally{await f.dispose();}
});

test("既存TaskのDBへ追加tableを移行しても継続権限を自動付与しない",async()=>{
 const f=await fixture();try {
  const plainEvent=f.db.enqueue(eventEnvelope("plain")).row;
  const plain=f.db.tasks.create(taskRequestSchema.parse({source_event_id:plainEvent.event_id,task_key:"plain",objective:"既存作業",workspace:{kind:"scratch"}}),f.config.jobsWorkspaceRoot,f.config.jobResultsDir).task;
  const sql=new Database(f.config.databasePath);
  sql.exec("DROP TABLE task_continuation_requests; DROP TABLE task_continuation_controls; DROP TABLE task_continuation_members; DROP TABLE task_continuation_scopes;");sql.close();
  f.restart();assert.equal(f.db.tasks.get(plain.task_id)!.current_attempt_id,plain.current_attempt_id);
  assert.equal(f.db.tasks.projection(plain).continuation,undefined);
  assert.throws(()=>f.create(f.child()),/owner_mismatch/);
 }finally{await f.dispose();}
});


test("100000文字の初回・後続objectiveを契約の追記で拒否せず、別fieldへ保持する",async()=>{
 const f=await fixture({longInitial:true});try {
  assert.equal(f.db.getJob(f.task.current_attempt_id)!.objective.length,100000);
  const child=f.create({...f.child(),objective:"b".repeat(100000)}),job=f.db.getJob(child.current_attempt_id)!;
  assert.equal(job.objective.length,100000);
  const prompt=buildJobPrompt(job),data=JSON.parse(prompt.split("job_json:\n")[1]!.split("\n[DONA_JOB_END]")[0]!);
  assert.equal(data.objective,"b".repeat(100000));assert.equal(data.continuation.scope.max_tasks,4);
  assert.equal(data.continuation.operation,"submit_pr");
 }finally{await f.dispose();}
});

test("Project ownerの大小文字差は同じ対象として扱い、別ownerは拒否する",async()=>{
 const f=await fixture({projectOwner:"OrG"});try {
  const input={...f.child(),project:{owner:"org",number:4,completion_status:"Merge Ready" as const}};
  const task=f.db.tasks.create(input,f.config.jobsWorkspaceRoot,f.config.jobResultsDir,{node_id:"I_167",repository:"org/repo",number:167,project:{completion_status:"Merge Ready"}}).task;
  assert.equal(task.state,"active");
  assert.throws(()=>f.create({...f.child("different",168),project:{owner:"Other",number:4,completion_status:"Merge Ready"}}),/scope_mismatch/);
 }finally{await f.dispose();}
});

test("自動回復の次Attemptにも独立した継続契約を保持する",async()=>{
 const f=await fixture();try {
  const task=f.create(f.child()),job=f.db.getJob(task.current_attempt_id)!;
  f.db.beginJobPreparation(job.job_id,new Date(job.available_at));f.db.setJobRuntime(job.job_id,"w","p");f.db.beginJobDispatch(job.job_id);f.db.markJobRunning(job.job_id);
  await fs.mkdir(job.workspace_path,{recursive:true});f.db.markJobNeedsReview(job.job_id,"result_missing","interrupted");
  const forbidden=async():Promise<never>=>{throw Error("unexpected");};
  const supervisor=new JobSupervisor(f.db,{prepare:forbidden,prompt:forbidden,get:forbidden,wait:forbidden,cancel:forbidden,
   observeWorker:async()=>({state:"inactive",reason:"agent_idle",observed_at:new Date().toISOString(),process_ids:[123],process_groups:[123]}),
   retireWorker:async()=>{},workerRetired:async()=>true},f.config,{debug(){},info(){},warn(){},error(){}},()=>{});
  await supervisor.reconcileTasks();const current=f.db.tasks.get(task.task_id)!;
  assert.equal(current.attempt_number,2);const next=f.db.getJob(current.current_attempt_id)!;
  assert.deepEqual(JSON.parse(next.workspace_json)._dona_continuation,JSON.parse(job.workspace_json)._dona_continuation);
  assert.match(buildJobPrompt(next),/merge・本番反映/);
 }finally{await f.dispose();}
});

for(const scopedLast of [true,false])test(`all_terminalの最後のTaskが${scopedLast?"別scope":"scopeなし"}でも各scopeを継続する`,async()=>{
 const f=await fixture();try {
  const event=f.db.enqueue(eventEnvelope("multi-scope")).row;
  const one=f.db.tasks.create({...f.request,source_event_id:event.event_id,task_key:"first-scope"},f.config.jobsWorkspaceRoot,f.config.jobResultsDir).task;
  const secondRequest={...f.request,source_event_id:event.event_id,task_key:"second-scope",...(scopedLast?{}:{continuation_scope:undefined,initial_operation:undefined})};
  const two=f.db.tasks.create(secondRequest,f.config.jobsWorkspaceRoot,f.config.jobResultsDir).task;
  assert.equal(JSON.parse(f.finish(one).payload_json).group.transition,"progress");
  const notice=f.finish(two);assert.equal(JSON.parse(notice.payload_json).group.transition,"all_terminal");
  const a=f.create(f.child("first-implementation",167,one,notice.event_id));
  assert.equal(f.db.tasks.assertOwner(a.task_id,notice.event_id).task_id,a.task_id);
  if(scopedLast){const b=f.create(f.child("second-implementation",168,two,notice.event_id));assert.equal(f.db.tasks.assertOwner(b.task_id,notice.event_id).task_id,b.task_id);}
  assert.equal(f.db.tasks.list(notice.event_id).length,scopedLast?4:2);
  // 他eventのscopeへは拡張しない。
  assert.throws(()=>f.create(f.child("unrelated",229,f.task,notice.event_id)),/owner_mismatch/);
 }finally{await f.dispose();}
});

test("初回が後続対象Issueを先取りする設定はclaim前に拒否し、同じeventで訂正できる",async()=>{
 const f=await fixture();try {
  const event=f.db.enqueue(eventEnvelope("initial-issue")).row;
  const input={...f.request,source_event_id:event.event_id,workspace:{kind:"github" as const,repository:"ORG/REPO"},issue_number:167};
  assert.equal(taskRequestSchema.safeParse(input).success,false);
  assert.throws(()=>f.db.tasks.create(input,f.config.jobsWorkspaceRoot,f.config.jobResultsDir,{node_id:"I_167",repository:"org/repo",number:167}),/task_continuation_initial_issue_conflict/);
  assert.equal(f.db.listEventJobs(event.event_id).length,0);
  assert.equal(f.db.tasks.create({...f.request,source_event_id:event.event_id},f.config.jobsWorkspaceRoot,f.config.jobResultsDir).task.state,"active");
 }finally{await f.dispose();}
});

test("scope付き初回・後続ではlegacy-defaultを作成前に拒否する",async()=>{
 const f=await fixture();try {
  for(const input of [f.request,f.child()]) {
   assert.equal(taskRequestSchema.safeParse({...input,task_key:"legacy-default"}).success,false);
   assert.throws(()=>f.create({...input,task_key:"legacy-default"}),/task_continuation_reserved_key/);
  }
  assert.equal(f.db.tasks.list(f.notice.event_id).length,1);
 }finally{await f.dispose();}
});

test("将来のsubmit_prを含むscopeでも現在のread_onlyにwrite許可を渡さない",async()=>{
 const f=await fixture();try {
  const input=f.child();input.continuation!.operation="read_only";
  const task=f.create(input),prompt=buildJobPrompt(f.db.getJob(task.current_attempt_id)!);
  assert.match(prompt,/現在のTaskはread-only/);assert.match(prompt,/外部write・commit・push・PR作成・設定変更は行わず/);
  assert.doesNotMatch(prompt,/commit、push、PR作成まで行えます|dona_request_thread_reply/);
  const write=f.create(f.child("submit-168",168)),writePrompt=buildJobPrompt(f.db.getJob(write.current_attempt_id)!);
  assert.match(writePrompt,/commit、push、PR作成まで行えます/);
 }finally{await f.dispose();}
});

test("初回監査の権限を将来のsubmit_prから推測せず明示する",async()=>{
 const f=await fixture();try {
  const prompt=buildJobPrompt(f.db.getJob(f.task.current_attempt_id)!);
  assert.match(prompt,/現在のTaskはread-only/);assert.doesNotMatch(prompt,/commit、push、PR作成まで行えます|dona_request_thread_reply/);
  assert.equal(taskRequestSchema.safeParse({...f.request,initial_operation:undefined}).success,false);
  assert.equal(taskRequestSchema.safeParse({...f.request,initial_operation:"submit_pr",continuation_scope:{...f.request.continuation_scope!,operations:["read_only"]}}).success,false);
  const event=f.db.enqueue(eventEnvelope("initial-write")).row;
  const writer=f.db.tasks.create({...f.request,source_event_id:event.event_id,initial_operation:"submit_pr"},f.config.jobsWorkspaceRoot,f.config.jobResultsDir).task;
  assert.match(buildJobPrompt(f.db.getJob(writer.current_attempt_id)!),/commit、push、PR作成まで行えます/);
 }finally{await f.dispose();}
});

test("同じIssueの複数Project targetを順序に依存せず照合する",async()=>{
 const f=await fixture();try {
  const event=f.db.enqueue(eventEnvelope("projects")).row;
  const scope={...f.request.continuation_scope!,targets:[{repository:"org/repo",issue_numbers:[167],project:{owner:"org",number:1}},{repository:"org/repo",issue_numbers:[167],project:{owner:"ORG",number:2}}]};
  const root=f.db.tasks.create({...f.request,source_event_id:event.event_id,continuation_scope:scope},f.config.jobsWorkspaceRoot,f.config.jobResultsDir).task,notice=f.finish(root);
  const input={...f.child("second-project",167,root,notice.event_id),project:{owner:"org",number:2,completion_status:"Merge Ready" as const}};
  assert.equal(f.db.tasks.create(input,f.config.jobsWorkspaceRoot,f.config.jobResultsDir,{node_id:"I_167",repository:"org/repo",number:167,project:{completion_status:"Merge Ready"}}).task.state,"active");
  assert.throws(()=>f.create({...input,task_key:"outside-project",project:{...input.project,number:3}}),/scope_mismatch/);
 }finally{await f.dispose();}
});

test("利用者の明示的なretryは当該Taskの予算だけを増やし後続作成には波及しない",async()=>{
 const f=await fixture({maxAttempts:1});try {
  const task=f.create(f.child()),job=f.db.getJob(task.current_attempt_id)!;
  f.db.beginJobPreparation(job.job_id,new Date(job.available_at));f.db.setJobRuntime(job.job_id,"w","p");f.db.beginJobDispatch(job.job_id);f.db.markJobRunning(job.job_id);
  await fs.mkdir(job.workspace_path,{recursive:true});f.db.markJobNeedsReview(job.job_id,"result_missing","interrupted");
  const forbidden=async():Promise<never>=>{throw Error("unexpected");};
  const supervisor=new JobSupervisor(f.db,{prepare:forbidden,prompt:forbidden,get:forbidden,wait:forbidden,cancel:forbidden,
   observeWorker:async()=>({state:"inactive",reason:"agent_idle",observed_at:new Date().toISOString(),process_ids:[123],process_groups:[123]}),retireWorker:async()=>{},workerRetired:async()=>true},f.config,{debug(){},info(){},warn(){},error(){}},()=>{});
  await supervisor.reconcileTasks();const exhausted=f.db.tasks.get(task.task_id)!;assert.equal(exhausted.wait_reason,"retry_exhausted");
  const retry=f.db.enqueue(eventEnvelope("explicit-retry")).row;
  f.db.tasks.retry(task.task_id,retry.event_id,exhausted.revision,2);await supervisor.reconcileTasks();
  const resumed=f.db.tasks.get(task.task_id)!;assert.equal(resumed.attempt_number,2);assert.equal(resumed.max_attempts,2);
  const next=f.child("another",168);next.policy.max_attempts=2;
  assert.throws(()=>f.create(next),/continuation_budget_exceeded/);
 }finally{await f.dispose();}
});

test("初回read_only TaskもProjectをMerge Readyへ進められない",async()=>{
 const f=await fixture();try {
  const event=f.db.enqueue(eventEnvelope("root-readonly-project")).row;
  const input={...f.request,source_event_id:event.event_id,workspace:{kind:"github" as const,repository:"org/repo"},issue_number:999,project:{owner:"org",number:4,completion_status:"Merge Ready" as const}};
  assert.equal(taskRequestSchema.safeParse(input).success,false);
  assert.throws(()=>f.db.tasks.create(input,f.config.jobsWorkspaceRoot,f.config.jobResultsDir,{node_id:"I_999",repository:"org/repo",number:999,project:{completion_status:"Merge Ready"}}),/scope_mismatch/);
  assert.equal(f.db.tasks.list(event.event_id).filter(t=>t.source_event_id===event.event_id).length,0);
 }finally{await f.dispose();}
});

for(const terminal of ["failed","cancelled"] as const)test(`最後の通知元が${terminal}でも確定済み兄弟scopeを継続できる`,async()=>{
 const f=await fixture();try {
  const event=f.db.enqueue(eventEnvelope(`last-${terminal}`)).row;
  const good=f.db.tasks.create({...f.request,source_event_id:event.event_id,task_key:"good"},f.config.jobsWorkspaceRoot,f.config.jobResultsDir).task;
  const bad=f.db.tasks.create({...f.request,source_event_id:event.event_id,task_key:"bad"},f.config.jobsWorkspaceRoot,f.config.jobResultsDir).task;
  f.finish(good);
  const job=f.db.getJob(bad.current_attempt_id)!;
  if(terminal==="failed") {
   f.db.beginJobPreparation(job.job_id,new Date(job.available_at));f.db.setJobRuntime(job.job_id,"w","p");f.db.beginJobDispatch(job.job_id);f.db.markJobRunning(job.job_id);
   f.db.saveJobResult(job.job_id,{schema_version:1,job_id:job.job_id,status:"failed",summary:"確定失敗",completed_at:new Date().toISOString()},job.result_path);
  } else {f.db.beginJobCancellation(job.job_id,event.event_id);f.db.markJobCancelled(job.job_id,"取り消し");}
  let notice=f.db.enqueueJobNotification(job.job_id).row;
  if(terminal==="failed") {
   assert.equal(JSON.parse(notice.payload_json).group.transition,"attention");
   assert.throws(()=>f.create(f.child("not-yet",167,good,notice.event_id)),/owner_mismatch/);
   const resultPath=`${f.config.resultsDir}/${notice.event_id}.json`;
   f.db.beginDispatch(notice.event_id,resultPath);f.db.markWaiting(notice.event_id);
   f.db.saveCompleted(notice.event_id,{schema_version:1,event_id:notice.event_id,status:"completed",completed_at:new Date().toISOString(),actions:[
    {tool:"dona_slack.post_message",workspace_id:"T_TEST",channel_id:"C_TEST",thread_ts:"1756722030.123456",message_ts:"123.456"},
    {tool:"dona_slack.set_agent_session_status",workspace_id:"T_TEST",channel_id:"C_TEST",thread_ts:"1756722030.123456",status:"suspended"}
   ]},resultPath);
   f.db.resolveFailedJobAttention(event.event_id,job.job_id,notice.event_id,f.db.getJob(job.job_id)!.updated_at);
   notice=f.db.get(f.db.getJobGroup(event.event_id)!.all_terminal_event_id!)!;
  }
  assert.equal(notice.event_type,`job_${terminal}`);
  assert.equal(JSON.parse(notice.payload_json).group.transition,"all_terminal");
  assert.deepEqual(f.db.tasks.list(notice.event_id).map(t=>t.task_id),[good.task_id]);
  assert.equal(f.create(f.child("continue-good",167,good,notice.event_id)).state,"active");
  assert.throws(()=>f.create(f.child("continue-bad",168,bad,notice.event_id)),/parent_not_completed/);
 }finally{await f.dispose();}
});

test("別scopeの同じ論理keyを独立受理し、再起動後も構造化対象と作業種別を照合できる",async()=>{
 const f=await fixture();try {
  const event=f.db.enqueue(eventEnvelope("same-key-scopes")).row;
  const one=f.db.tasks.create({...f.request,source_event_id:event.event_id,task_key:"one"},f.config.jobsWorkspaceRoot,f.config.jobResultsDir).task;
  const two=f.db.tasks.create({...f.request,source_event_id:event.event_id,task_key:"two"},f.config.jobsWorkspaceRoot,f.config.jobResultsDir).task;
  f.finish(one);const notice=f.finish(two);
  const first=f.child("submit",167,one,notice.event_id),second=f.child("submit",168,two,notice.event_id);
  const a=f.create(first),b=f.create(second);
  assert.notEqual(a.task_id,b.task_id);assert.notEqual(a.task_key,b.task_key);
  f.restart();assert.equal(f.create(first).task_id,a.task_id);assert.equal(f.create(second).task_id,b.task_id);
  for(const [task,issue] of [[a,167],[b,168]] as const) {
   const projected=f.db.tasks.projection(task);
   assert.equal(projected.task_key,"submit");
   assert.deepEqual(projected.admission,{workspace:{kind:"github",repository:"org/repo"},issue_number:issue,issue_node_id:`I_${issue}`,project:null,operation:"submit_pr"});
   const member=(projected.continuation as any).members.find((m:any)=>m.task_id===task.task_id);
   assert.equal(member.task_key,"submit");assert.deepEqual(member.admission,projected.admission);
  }
  const reader=new DashboardTaskReader(f.config.databasePath);
  try {assert.equal(reader.snapshot(a.task_id)!.task.task_key,"submit");assert.equal(reader.list(()=>true).items.find(t=>t.task_id===b.task_id)!.task_key,"submit");}finally{reader.close();}
 }finally{await f.dispose();}
});


test("Project付きtargetでは後続のProject省略を拒否し、指定訂正後に作成できる",async()=>{
 const f=await fixture({projectOwner:"org"});try {
  const input=f.child();assert.throws(()=>f.create(input),/scope_mismatch/);
  assert.equal(f.db.tasks.continuations.lookup(input),undefined);
  const specified={...input,project:{owner:"org",number:4,completion_status:"Merge Ready" as const}};
  const task=f.db.tasks.create(specified,f.config.jobsWorkspaceRoot,f.config.jobResultsDir,{node_id:"I_167",repository:"org/repo",number:167,project:{completion_status:"Merge Ready"}}).task;
  assert.equal(task.state,"active");assert.equal(JSON.parse(task.project_json!).completion_status,"Merge Ready");
 }finally{await f.dispose();}
});
