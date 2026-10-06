import {checkpointSnapshot} from "./task-checkpoint.js";
import type Database from "better-sqlite3";
import type {DispatcherDatabase} from "./database.js";
import type {RuntimeStore} from "./app-server/store.js";
import type {TaskRow} from "./task-execution.js";
import fs from "node:fs";

export interface ResumeFrom {name:string;generation:string;thread_id:string;attempt_id:string;}
interface Saved {attempt_id:string;task_id:string;run_id:string;source_json:string|null;state:string;reason:string|null;successor_id:string|null;retry_after:string|null;steer_json:string|null;native_requests_json:string|null;}
/** 全writer停止後の保守runner専用。API/MCPから発行しない。 */
export class OfflineTaskResumes {
 constructor(private sql:Database.Database,private dispatcher:DispatcherDatabase){
  sql.exec(`CREATE TABLE IF NOT EXISTS offline_task_resumes(attempt_id TEXT PRIMARY KEY REFERENCES jobs(job_id),task_id TEXT NOT NULL REFERENCES tasks(task_id),
   run_id TEXT NOT NULL,source_json TEXT,state TEXT NOT NULL,reason TEXT,successor_id TEXT REFERENCES jobs(job_id),retry_after TEXT,steer_json TEXT,native_requests_json TEXT);`);
 }
 capture(runtime:RuntimeStore,runId:string):void {
  this.sql.transaction(()=>{
   const tasks=this.sql.prepare("SELECT * FROM tasks WHERE state IN ('active','waiting','paused')").all() as TaskRow[];
   for(const task of tasks){
    const job=this.dispatcher.getJob(task.current_attempt_id)!;
    if(!job.dispatch_started_at||job.result_json||['completed','failed','cancelled'].includes(job.status))continue;
    if(this.saved(job.job_id))continue;
    const agent=runtime.agent(job.agent_name),identity=this.dispatcher.getJobLiveSessionIdentity(job.job_id)?.herdr_agent_session_id;
    let source:ResumeFrom|null=null,reason:string|null=null,blocker:string|null=null,retryAfter:string|null=null;
    let nativeRequests:Array<{question_id:string;kind:string;payload_json:string}>=[];
    if(agent?.role==='worker'&&agent.thread_id&&agent.cwd===job.workspace_path&&JSON.parse(agent.config_json).attemptId===job.job_id&&identity===JSON.stringify([agent.generation,agent.thread_id]))
     source={name:agent.name,generation:agent.generation,thread_id:agent.thread_id,attempt_id:job.job_id};
    else blocker='worker_unknown';
    try{
     const checkpoint=checkpointSnapshot(job,task.task_id).checkpoint??this.dispatcher.tasks.attemptCheckpoint(job.job_id);
     if(checkpoint){this.dispatcher.tasks.checkpoint(job,checkpoint);
      if(checkpoint.unresolved_operations.length||checkpoint.waiting==='external_effect_unknown')blocker='external_effect_unknown';
      else if(!this.dispatcher.tasks.checkpointAnswered(job,checkpoint)&&checkpoint.waiting==='human_input')reason='human_input';
      else if(!this.dispatcher.tasks.checkpointAnswered(job,checkpoint)&&checkpoint.waiting==='usage_limit'){reason='capacity_wait';retryAfter=checkpoint.retry_after??null;}
     }
    }catch{blocker='result_conflict';}
    if(source&&agent){
     nativeRequests=runtime.db.prepare("SELECT question_id,kind,payload_json FROM questions WHERE agent=? AND generation=? AND turn_id IS ? AND (state IN ('pending','answering') OR (state='expired' AND ?='waiting'))").all(agent.name,agent.generation,agent.turn_id,agent.state) as typeof nativeRequests;
     const externalPending=runtime.db.prepare("SELECT 1 FROM external_tool_requests WHERE agent=? AND generation=? AND turn_id IS ? AND (state IN ('pending','answering') OR (state='expired' AND ?='waiting')) LIMIT 1").get(agent.name,agent.generation,agent.turn_id,agent.state);
     if(externalPending)reason=task.wait_reason==='external_approval'?'external_approval':'human_input';
     else if(nativeRequests.length)reason='native_request';
     else if(agent.state==='waiting')reason='human_input';
     else if(agent.state==='stopped'){
      if(!runtime.db.prepare("SELECT 1 FROM stops WHERE agent=? AND generation=? AND state='stopped'").get(agent.name,agent.generation))blocker='worker_unknown';
     }else if(!['working','idle','interrupted'].includes(agent.state))blocker='worker_unknown';
     const hint=runtime.db.prepare("SELECT reason,retry_after FROM recovery_hints WHERE agent=? AND generation=?").get(agent.name,agent.generation) as {reason:string;retry_after:string|null}|undefined;
     if(hint){
      if(hint.reason!=='capacity_wait')reason='human_input';
      else if(!reason||reason==='capacity_wait')reason='capacity_wait';
      if(hint.retry_after&&(!retryAfter||hint.retry_after>retryAfter))retryAfter=hint.retry_after;
     }
    }
    if(task.wait_reason==='external_approval'&&reason==='human_input')reason='external_approval';
    const steer=task.steer_pending_event_id||job.steer_state==='dispatching'?JSON.stringify({pending_event_id:task.steer_pending_event_id,event_id:job.steer_event_id,state:job.steer_state,acceptance:'unknown'}):null;
    if(steer&&!reason)reason='steer_acceptance_unknown';
    if(task.wait_reason&&['external_effect_unknown','result_reconciliation_required','result_conflict','worker_unknown'].includes(task.wait_reason))blocker??=task.wait_reason;
    if(!reason&&task.wait_reason&&['human_input','external_approval','retry_exhausted','steer_acceptance_unknown'].includes(task.wait_reason))reason=task.wait_reason;
    if(reason==='capacity_wait'&&!Number.isFinite(Date.parse(retryAfter??'')))retryAfter=new Date(Date.now()+task.retry_delay_ms).toISOString();
    if(blocker)reason=blocker;
    if(task.desired_state!=='running')reason=task.desired_state==='paused'?'paused':'cancel_requested';
    this.sql.prepare("INSERT INTO offline_task_resumes VALUES(?,?,?,?,?,?,NULL,?,?,?)").run(job.job_id,task.task_id,runId,source?JSON.stringify(source):null,reason&&!['external_approval','capacity_wait','native_request'].includes(reason)?'held':'pending',reason,retryAfter,steer,nativeRequests.length?JSON.stringify(nativeRequests):null);
   }
  }).immediate();
 }
 saved(attemptId:string):Saved|undefined{return this.sql.prepare("SELECT * FROM offline_task_resumes WHERE attempt_id=?").get(attemptId) as Saved|undefined;}
 hold(task:TaskRow):string|undefined {
  const row=this.saved(task.current_attempt_id);
  return row?.state==='held'&&!['capacity_wait','external_approval'].includes(row.reason??'')&&!task.steer_pending_event_id&&task.desired_state==='running'&&task.wait_reason!=='resume_requested'?row.reason??'human_input':undefined;
 }
 capacityDelay(task:TaskRow):number {
  const row=this.saved(task.current_attempt_id);
  return task.desired_state==='running'&&task.wait_reason!=='resume_requested'&&row?.reason==='capacity_wait'?Math.max(0,Date.parse(row.retry_after??'')-Date.now())||0:0;
 }
 canAnswer(task:TaskRow):boolean {const row=this.saved(task.current_attempt_id);return row?.state==='held'&&row.reason==='human_input'&&!!task.steer_pending_event_id;}
 /** 停止済みworkerへ送信せず、prepareSteerで保存済みの回答を後継objectiveへ引き継ぐ。 */
 answer(task:TaskRow):void {
  this.sql.transaction(()=>{
   const current=this.dispatcher.tasks.get(task.task_id)!,job=this.dispatcher.getJob(task.current_attempt_id)!;
   if(current.revision!==task.revision||current.current_attempt_id!==task.current_attempt_id||!this.canAnswer(current)||current.desired_state!=='running'||job.steer_state||job.result_json||fs.existsSync(job.result_path))throw Error('offline_answer_conflict');
   const checkpoint=checkpointSnapshot(job,task.task_id).checkpoint??this.dispatcher.tasks.attemptCheckpoint(job.job_id);
   if(checkpoint&&(checkpoint.unresolved_operations.length||checkpoint.waiting==='external_effect_unknown'))throw Error('task_external_effect_reconciliation_required');
   this.sql.prepare("UPDATE task_attempts SET checkpoint_ack_sequence=MAX(checkpoint_ack_sequence,COALESCE((SELECT checkpoint_sequence FROM task_controls WHERE task_id=? AND source_event_id=?),0)) WHERE attempt_id=?").run(task.task_id,current.steer_pending_event_id,job.job_id);
   this.sql.prepare("UPDATE tasks SET wait_reason='resume_requested',steer_pending_event_id=NULL,next_check_at=NULL WHERE task_id=?").run(task.task_id);
   this.sql.prepare("UPDATE offline_task_resumes SET state='pending' WHERE attempt_id=?").run(job.job_id);
  }).immediate();
 }
 source(attemptId:string):ResumeFrom|undefined {const row=this.saved(attemptId);return row?.source_json?JSON.parse(row.source_json):undefined;}
 completed(attemptId:string,successorId:string):void {this.sql.prepare("UPDATE offline_task_resumes SET state='resumed',successor_id=? WHERE attempt_id=?").run(successorId,attemptId);}
 /** runtime migrationが全process停止を確認した後だけ呼ぶ。途中crashでも旧Attemptごとに一度だけ。 */
 activate(runId:string,resultDir:string):void {
  const rows=this.sql.prepare("SELECT * FROM offline_task_resumes WHERE run_id=? AND state IN ('pending','held')").all(runId) as Saved[];
  for(const row of rows)this.sql.transaction(()=>{
   const task=this.dispatcher.tasks.get(row.task_id)!;
   if(task.current_attempt_id!==row.attempt_id||['completed','failed','cancelled'].includes(task.state))return;
   const job=this.dispatcher.getJob(row.attempt_id)!;
   // 停止直前に公開されたResultは通常collectorへ渡す。上書きも再実行もしない。
   if(job.result_json||fs.existsSync(job.result_path))return;
   // 旧workerの追加指示受付は今後確定しない。元receiptはsnapshotへ保存し、
   // 既知の未解決操作がなければ保存済みobjectiveを新turnへ渡す（旧steerは再送しない）。
   if(row.steer_json&&row.source_json&&(row.reason==='steer_acceptance_unknown'||row.state==='pending')){
    const checkpoint=checkpointSnapshot(job,task.task_id).checkpoint??this.dispatcher.tasks.attemptCheckpoint(job.job_id);
    if(checkpoint&&(checkpoint.unresolved_operations.length||(checkpoint.waiting==='external_effect_unknown'||checkpoint.waiting==='human_input'&&row.reason!=='native_request'))){
     this.sql.prepare("UPDATE offline_task_resumes SET state='held',reason=? WHERE attempt_id=?").run(checkpoint.waiting==='human_input'?'human_input':'external_effect_unknown',job.job_id);
     this.sql.prepare("UPDATE jobs SET status='needs_review',last_error_code='offline_update_held' WHERE job_id=?").run(job.job_id);
     this.dispatcher.tasks.wait(task,checkpoint.waiting==='human_input'?'human_input':'external_effect_unknown');return;
    }
    this.sql.prepare("UPDATE jobs SET steer_state=NULL WHERE job_id=?").run(job.job_id);
    this.sql.prepare("UPDATE tasks SET steer_pending_event_id=NULL WHERE task_id=?").run(task.task_id);
    this.sql.prepare("UPDATE offline_task_resumes SET state='pending' WHERE attempt_id=?").run(job.job_id);
    row.state='pending';
   }
   const evidence={state:'stopped' as const,reason:'offline_update',observed_at:new Date().toISOString(),process_ids:[],process_groups:[]};
   if(row.state==='held'&&!['capacity_wait','external_approval'].includes(row.reason??'')){
    this.sql.prepare("UPDATE jobs SET status='needs_review',last_error_code='offline_update_held' WHERE job_id=?").run(job.job_id);
    this.dispatcher.tasks.wait(task,row.reason??'human_input');return;
   }
   const claimed=this.dispatcher.tasks.claimStop(task,evidence);
   if(claimed.stop_state!=='stopped')this.dispatcher.tasks.stopped(claimed,evidence);
   if(row.reason==='capacity_wait'){
    this.dispatcher.tasks.wait(this.dispatcher.tasks.get(task.task_id)!,'capacity_wait',this.capacityDelay(task));return;
   }
   const external=this.dispatcher.tasks.externalApprovalRecovery(job.job_id);
   // cold migrationにはreceipt検証器がない。サービス起動後の通常照合へ残す。
   if(external.state!=='ready'){
    this.dispatcher.tasks.wait(this.dispatcher.tasks.get(task.task_id)!,external.state==='pending'?'external_approval':'external_effect_unknown',0);return;
   }
   this.dispatcher.tasks.replaceStopped(task.task_id,resultDir);
  }).immediate();
 }
}
