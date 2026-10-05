import type Database from "better-sqlite3";
import {stableStringify} from "../validation.js";
import type {DispatcherDatabase} from "../database.js";
import type {RuntimeClient} from "../app-server/client.js";
import type {ExternalToolRequest} from "../app-server/external-tools.js";
import type {LocalExternalApprovalService} from "./local-external-service.js";
import type {ExternalApprovalSource} from "./local-external-types.js";
const terminal=new Set(["succeeded","failed","cancelled","rejected","expired","execution_cancelled","consume_expired","delivery_failed"]);
/** private Runtime socketからのみtyped intentを受理。HTTP/MCPの自由入力sourceを認可しない。 */
export class LocalExternalApprovalIngress {
 private live=new Map<string,{source:ExternalApprovalSource;until:number}>();private busy=false;private rowCursor="";
 constructor(private readonly sql:Database.Database,private readonly dispatcher:DispatcherDatabase,private readonly runtime:Pick<RuntimeClient,"externalRequests"|"externalRequest"|"resolveExternal"|"status">,
  private readonly service:LocalExternalApprovalService,private readonly config:{instance_id:string;workspace_id:string;owner_id:string;main_agent:string},private readonly wake:()=>void=()=>{}){
  sql.exec(`CREATE TABLE IF NOT EXISTS local_external_ingress(runtime_request_id TEXT PRIMARY KEY,source_json TEXT NOT NULL,request_id TEXT,operation_slot TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS task_external_approval_checkpoints(attempt_id TEXT NOT NULL,runtime_request_id TEXT NOT NULL,request_id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(attempt_id,runtime_request_id));`);
 }
 private durable(source:ExternalApprovalSource){
  if(source.instance_id!==this.config.instance_id||source.workspace_id!==this.config.workspace_id||source.owner_id!==this.config.owner_id)return false;
  const event=this.dispatcher.get(source.source_event_id);if(!event||event.source!=="slack")return false;
  const subject=JSON.parse(event.subject_json),target=event.reply_target_json?JSON.parse(event.reply_target_json):{};
  if(target.kind!=="slack_thread"||target.workspace_id!==source.workspace_id||subject.channel_id!==source.channel_id||subject.thread_ts!==source.thread_ts||subject.actor_id!==source.requester_id||subject.workspace_id!==source.workspace_id||target.channel_id!==source.channel_id||target.thread_ts!==source.thread_ts)return false;
  if(source.source_job_id){
   const job=this.dispatcher.getJob(source.source_job_id),task=this.dispatcher.tasks.forAttempt(source.source_job_id);
   if(!job||!task||task.current_attempt_id!==job.job_id||task.desired_state!=="running"||task.stop_state!=="none"||!["running","blocked"].includes(job.status)||job.source_event_id!==event.event_id||job.actor_id!==source.requester_id||job.workspace_id!==source.workspace_id||job.channel_id!==source.channel_id||job.thread_ts!==source.thread_ts||job.agent_name!==source.agent)return false;
   const binding=this.dispatcher.getJobRuntimeBinding(job.job_id,source.generation);if(!binding||binding.thread_id!==source.thread_id||binding.agent_name!==source.agent)return false;
  }else if(source.agent!==this.config.main_agent||!["dispatching","completed"].includes(event.status))return false;
  return true;
 }
 authorizeSource(source:ExternalApprovalSource){const current=this.live.get(source.runtime_request_id);return !!current&&current.until>Date.now()&&stableStringify(current.source)===stableStringify(source)&&this.durable(source);}
 private source(row:ExternalToolRequest):ExternalApprovalSource{
  const job=row.attempt_id?this.dispatcher.getJob(row.attempt_id):undefined,eventId=row.role==="worker"?job?.source_event_id:row.source_event_id;
  const event=eventId?this.dispatcher.get(eventId):undefined;if(!event||event.source!=="slack"||row.role==="worker"&&!job)throw Error("external_approval_source_unavailable");
  const subject=JSON.parse(event.subject_json),target=event.reply_target_json?JSON.parse(event.reply_target_json):{};
  const source:ExternalApprovalSource={kind:"slack",instance_id:this.config.instance_id,owner_id:this.config.owner_id,requester_id:subject.actor_id,source_event_id:event.event_id,source_job_id:job?.job_id??null,runtime_request_id:row.request_id,agent:row.agent,generation:row.generation,thread_id:row.thread_id,turn_id:row.turn_id,workspace_id:subject.workspace_id,channel_id:target.channel_id,thread_ts:target.thread_ts};
  if(!this.durable(source))throw Error("external_approval_source_unavailable");return source;
 }
 private hold(source:ExternalApprovalSource,requestId:string){if(!source.source_job_id)return;
  this.sql.transaction(()=>{
   if(!this.authorizeSource(source))throw Error("external_approval_source_unavailable");
   this.sql.prepare("INSERT OR IGNORE INTO task_external_approval_checkpoints VALUES(?,?,?,'pending')").run(source.source_job_id,source.runtime_request_id,requestId);
   this.sql.prepare("UPDATE jobs SET status='blocked',last_error_code='runtime_external_approval_pending',last_error_message='External action awaits operator approval' WHERE job_id=? AND status IN ('running','blocked')").run(source.source_job_id);
   const task=this.dispatcher.tasks.forAttempt(source.source_job_id!)!;this.dispatcher.tasks.wait(task,"external_approval");
  }).immediate();
 }
 private finish(source:ExternalApprovalSource,requestId:string,state:string){
  this.sql.transaction(()=>{
   const event=this.dispatcher.get(source.source_event_id);if(!event?.reply_target_json)throw Error("external_approval_source_unavailable");
   if(!source.source_job_id){const result=this.dispatcher.enqueue({schema_version:1,source:"dona_approval",external_event_id:`external:${requestId}:terminal`,type:"external_approval_finished",occurred_at:new Date().toISOString(),subject:{workspace_id:source.workspace_id,channel_id:source.channel_id,thread_ts:source.thread_ts,actor_id:source.requester_id},payload:{request_id:requestId,state,source_event_id:source.source_event_id},reply_target:JSON.parse(event.reply_target_json)});if(result.payloadMismatch)throw Error("external_approval_outbox_conflict");}
   else {
    this.sql.prepare("UPDATE task_external_approval_checkpoints SET state=? WHERE attempt_id=? AND runtime_request_id=?").run(state,source.source_job_id,source.runtime_request_id);
    const other=this.sql.prepare("SELECT 1 FROM task_external_approval_checkpoints WHERE attempt_id=? AND state='pending' LIMIT 1").get(source.source_job_id);
    const task=this.dispatcher.tasks.forAttempt(source.source_job_id);
    if(!other&&task?.current_attempt_id===source.source_job_id&&task.desired_state==="running"&&task.stop_state==="none"){
     this.sql.prepare("UPDATE jobs SET status='running',last_error_code=NULL,last_error_message=NULL WHERE job_id=? AND last_error_code='runtime_external_approval_pending'").run(source.source_job_id);
     this.sql.prepare("UPDATE tasks SET state='active',wait_reason=NULL,next_check_at=NULL,revision=revision+1 WHERE task_id=? AND wait_reason='external_approval'").run(task.task_id);
    }
   }
   this.sql.prepare("UPDATE local_external_ingress SET state='terminal' WHERE runtime_request_id=?").run(source.runtime_request_id);
  }).immediate();this.wake();
 }
 async tick(){if(this.busy)return;this.busy=true;
  try{
   const pending=await this.runtime.externalRequests();
   const rows=this.sql.prepare("SELECT * FROM local_external_ingress WHERE state='pending' AND runtime_request_id>? ORDER BY runtime_request_id LIMIT 64").all(this.rowCursor) as {runtime_request_id:string;source_json:string;request_id:string|null;operation_slot:string}[];
   this.rowCursor=rows.length===64?rows.at(-1)!.runtime_request_id:"";
   for(const [id,entry] of this.live)if(entry.until<=Date.now())this.live.delete(id);
   for(const row of pending){try{const source=this.source(row);this.live.set(row.request_id,{source,until:Date.now()+30000});}catch{await this.runtime.resolveExternal(row.agent,row.request_id,{request_id:null,state:"source_denied"}).catch(()=>{});}}
   // mainへpending handleを返した後も、元のDona世代とsaved sourceを照合する。
   for(const row of rows){const source=JSON.parse(row.source_json) as ExternalApprovalSource;if(this.live.has(source.runtime_request_id))continue;
    const record=await this.runtime.externalRequest(source.runtime_request_id),agent=await this.runtime.status(source.agent);if(!record||record.state==="expired"||record.agent!==source.agent||record.generation!==source.generation||record.thread_id!==source.thread_id||record.turn_id!==source.turn_id||!agent||agent.generation!==source.generation||agent.thread_id!==source.thread_id||!this.durable(source))continue;
    this.live.set(source.runtime_request_id,{source,until:Date.now()+30000});
   }
   for(const row of pending){const source=this.live.get(row.request_id)?.source;if(!source)continue;
    try{
     let saved=this.sql.prepare("SELECT source_json,request_id FROM local_external_ingress WHERE runtime_request_id=?").get(row.request_id) as {source_json:string;request_id:string|null}|undefined;
     if(saved&&saved.source_json!==stableStringify(source))throw Error("external_approval_source_conflict");
     if(!saved){this.sql.prepare("INSERT INTO local_external_ingress VALUES(?,?,NULL,?,'pending',?)").run(row.request_id,stableStringify(source),row.operation_slot,row.created_at);saved={source_json:stableStringify(source),request_id:null};}
     if(!saved.request_id){const created=await this.service.requestFromSource(source,{idempotency_key:row.operation_slot,text:row.text});if(created.status==="denied")throw Error("external_approval_request_denied");saved.request_id=created.request_handle;this.sql.prepare("UPDATE local_external_ingress SET request_id=? WHERE runtime_request_id=?").run(created.request_handle,row.request_id);}
     this.hold(source,saved.request_id);
     if(row.role==="main")await this.runtime.resolveExternal(row.agent,row.request_id,{request_id:saved.request_id,state:"pending"});
    }catch{/* exact source/idempotencyで次回照合。外部sendはしない。 */}
   }
   await this.service.executePending();
   const ready=this.sql.prepare("SELECT source_json,request_id FROM local_external_ingress WHERE state='pending' AND request_id IS NOT NULL AND runtime_request_id IN (SELECT value FROM json_each(?)) ORDER BY runtime_request_id LIMIT 128").all(JSON.stringify([...new Set([...rows.map(r=>r.runtime_request_id),...pending.map(r=>r.request_id)])])) as {source_json:string;request_id:string}[];
   for(const row of ready){const source=JSON.parse(row.source_json) as ExternalApprovalSource;if(!this.authorizeSource(source))continue;
    try{const status=this.service.sourceStatus(source,row.request_id),state=status.execution?.state??status.state;if(!terminal.has(state))continue;
     if(source.source_job_id){const response=await this.runtime.resolveExternal(source.agent,source.runtime_request_id,{request_id:row.request_id,state}) as {state?:string};if(response.state!=="resolved")continue;}
     this.finish(source,row.request_id,state);
    }catch{/* response lossは同じrequestのread-only statusから照合 */}
   }
  }finally{this.busy=false;}
 }
}
