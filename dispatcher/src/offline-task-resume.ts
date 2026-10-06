import {checkpointSnapshot} from "./task-checkpoint.js";
import type Database from "better-sqlite3";
import type {DispatcherDatabase} from "./database.js";
import type {RuntimeStore} from "./app-server/store.js";
import type {TaskRow} from "./task-execution.js";
import fs from "node:fs";

export interface ResumeFrom {name:string;generation:string;thread_id:string;attempt_id:string;}
interface Saved {attempt_id:string;task_id:string;run_id:string;source_json:string|null;state:string;reason:string|null;successor_id:string|null;}
/** 全writer停止後の保守runner専用。API/MCPから発行しない。 */
export class OfflineTaskResumes {
 constructor(private sql:Database.Database,private dispatcher:DispatcherDatabase){
  sql.exec(`CREATE TABLE IF NOT EXISTS offline_task_resumes(attempt_id TEXT PRIMARY KEY REFERENCES jobs(job_id),task_id TEXT NOT NULL REFERENCES tasks(task_id),
   run_id TEXT NOT NULL,source_json TEXT,state TEXT NOT NULL,reason TEXT,successor_id TEXT REFERENCES jobs(job_id));`);
 }
 capture(runtime:RuntimeStore,runId:string):void {
  this.sql.transaction(()=>{
   const tasks=this.sql.prepare("SELECT * FROM tasks WHERE state IN ('active','waiting','paused')").all() as TaskRow[];
   for(const task of tasks){
    const job=this.dispatcher.getJob(task.current_attempt_id)!;
    if(!job.dispatch_started_at||job.result_json||['completed','failed','cancelled'].includes(job.status))continue;
    if(this.saved(job.job_id))continue;
    const agent=runtime.agent(job.agent_name),identity=this.dispatcher.getJobLiveSessionIdentity(job.job_id)?.herdr_agent_session_id;
    let source:ResumeFrom|null=null,reason:string|null=null;
    if(agent?.role==='worker'&&agent.thread_id&&agent.cwd===job.workspace_path&&JSON.parse(agent.config_json).attemptId===job.job_id&&identity===JSON.stringify([agent.generation,agent.thread_id]))
     source={name:agent.name,generation:agent.generation,thread_id:agent.thread_id,attempt_id:job.job_id};
    else reason='worker_unknown';
    try{
     const checkpoint=checkpointSnapshot(job,task.task_id).checkpoint;
     if(checkpoint){this.dispatcher.tasks.checkpoint(job,checkpoint);
      if(checkpoint.unresolved_operations.length||checkpoint.waiting==='external_effect_unknown')reason='external_effect_unknown';
      else if(checkpoint.waiting==='human_input')reason='human_input';
      else if(checkpoint.waiting==='usage_limit')reason='capacity_wait';
     }
    }catch{reason='result_conflict';}
    if(source&&agent){
     const pending=runtime.db.prepare("SELECT 1 FROM questions WHERE agent=? AND generation=? AND state IN ('pending','answering','expired') UNION ALL SELECT 1 FROM external_tool_requests WHERE agent=? AND generation=? AND state IN ('pending','answering','expired') LIMIT 1").get(agent.name,agent.generation,agent.name,agent.generation);
     if(pending||agent.state==='waiting')reason='human_input';
     else if(!['working','idle','interrupted'].includes(agent.state))reason='worker_unknown';
     const hint=runtime.db.prepare("SELECT reason FROM recovery_hints WHERE agent=? AND generation=?").get(agent.name,agent.generation) as {reason:string}|undefined;
     if(hint)reason=hint.reason==='capacity_wait'?'capacity_wait':'human_input';
    }
    if(task.steer_pending_event_id||job.steer_state==='dispatching')reason='steer_acceptance_unknown';
    if(task.desired_state!=='running')reason=task.desired_state==='paused'?'paused':'cancel_requested';
    if(task.wait_reason&&['human_input','external_effect_unknown','external_approval','result_reconciliation_required','retry_exhausted','steer_acceptance_unknown'].includes(task.wait_reason))reason=task.wait_reason;
    this.sql.prepare("INSERT INTO offline_task_resumes VALUES(?,?,?,?,?,?,NULL)").run(job.job_id,task.task_id,runId,source?JSON.stringify(source):null,reason?'held':'pending',reason);
   }
  }).immediate();
 }
 saved(attemptId:string):Saved|undefined{return this.sql.prepare("SELECT * FROM offline_task_resumes WHERE attempt_id=?").get(attemptId) as Saved|undefined;}
 hold(task:TaskRow):string|undefined {
  const row=this.saved(task.current_attempt_id);
  return row?.state==='held'&&task.desired_state==='running'&&task.wait_reason!=='resume_requested'?row.reason??'human_input':undefined;
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
   const evidence={state:'stopped' as const,reason:'offline_update',observed_at:new Date().toISOString(),process_ids:[],process_groups:[]};
   if(row.state==='held'){
    this.sql.prepare("UPDATE jobs SET status='needs_review',last_error_code='offline_update_held' WHERE job_id=?").run(job.job_id);
    this.dispatcher.tasks.wait(task,row.reason??'human_input');return;
   }
   if(this.dispatcher.tasks.externalApprovalRecovery(job.job_id).state!=='ready'){
    this.sql.prepare("UPDATE offline_task_resumes SET state='held',reason='external_effect_unknown' WHERE attempt_id=?").run(job.job_id);
    this.sql.prepare("UPDATE jobs SET status='needs_review',last_error_code='offline_update_held' WHERE job_id=?").run(job.job_id);
    this.dispatcher.tasks.wait(task,'external_effect_unknown');return;
   }
   const claimed=this.dispatcher.tasks.claimStop(task,evidence);
   if(claimed.stop_state!=='stopped')this.dispatcher.tasks.stopped(claimed,evidence);
   this.dispatcher.tasks.replaceStopped(task.task_id,resultDir);
  }).immediate();
 }
}
