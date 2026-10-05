import type Database from "better-sqlite3";
import {createHash} from "node:crypto";
import {z} from "zod";
import type {DispatcherDatabase} from "./database.js";
import type {CreateJobRequest} from "./types.js";
import {insertEventJobBinding,readEventJobBinding} from "./job-routing.js";
import {parseCreateJobRequest,stableStringify} from "./validation.js";

const identifier=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const authoritySchema=z.strictObject({instance_id:identifier,owner_id:identifier,device_id:identifier,grant_revision:z.number().int().positive()});
export type LocalDashboardAuthority=z.infer<typeof authoritySchema>;
export type LocalDashboardCreate={request_id:string;objective:string;workspace:CreateJobRequest["workspace"]};
export type LocalDashboardCancel={request_id:string;task_id:string;attempt_id:string;revision:number};
export type LocalDashboardQuestionReply={request_id:string;task_id:string;attempt_id:string;revision:number;question_id:string} & ({kind:"question";answers:Record<string,{answers:string[]}>}|{kind:"approval";accepted:boolean});
export interface LocalDashboardReceipt {
  receipt_id:string;instance_id:string;owner_id:string;device_id:string;grant_revision:number;request_id:string;
  operation:"create"|"cancel"|"question_reply"|"native_approval";canonical_sha256:string;task_id:string;attempt_id:string;task_revision:number;event_id:string;created_at:string;
}
const digest=(value:unknown)=>createHash("sha256").update(stableStringify(value)).digest("hex");
/** 認可registryの同一connection/transaction内からだけ呼ぶ同期primitive。 */
export class LocalDashboardCommands {
  constructor(private readonly sql:Database.Database,private readonly dispatcher:DispatcherDatabase,private readonly activeTaskLimit:number){
    sql.exec(`CREATE TABLE IF NOT EXISTS local_dashboard_command_receipts(
      receipt_id TEXT PRIMARY KEY,instance_id TEXT NOT NULL,owner_id TEXT NOT NULL,device_id TEXT NOT NULL,
      grant_revision INTEGER NOT NULL,request_id TEXT NOT NULL,operation TEXT NOT NULL CHECK(operation IN ('create','cancel','question_reply','native_approval')),
      canonical_sha256 TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(task_id),attempt_id TEXT NOT NULL REFERENCES jobs(job_id),
      task_revision INTEGER NOT NULL,event_id TEXT NOT NULL REFERENCES events(event_id),created_at TEXT NOT NULL,
      UNIQUE(instance_id,owner_id,device_id,request_id))`);
  }
  private key(authority:LocalDashboardAuthority,requestId:string):string {
    authoritySchema.parse(authority);identifier.parse(requestId);
    return digest([authority.instance_id,authority.owner_id,authority.device_id,requestId]);
  }
  receipt(authority:LocalDashboardAuthority,requestId:string):LocalDashboardReceipt|undefined {
    return this.sql.prepare("SELECT * FROM local_dashboard_command_receipts WHERE receipt_id=?").get(this.key(authority,requestId)) as LocalDashboardReceipt|undefined;
  }
  task(authority:LocalDashboardAuthority,taskId:string) {
    authoritySchema.parse(authority);const task=this.dispatcher.tasks.get(taskId);
    if(!task)throw Error("local_dashboard_owner_mismatch");
    this.assertOwner(authority,task.current_attempt_id);return {task,row:this.dispatcher.getJob(task.current_attempt_id)!};
  }
  nativeApprovalTask(authority:LocalDashboardAuthority,taskId:string) {
    authoritySchema.parse(authority);const task=this.dispatcher.tasks.get(taskId);
    if(!task)throw Error("task_approval_not_current");
    const row=this.dispatcher.getJob(task.current_attempt_id)!,binding=readEventJobBinding(this.sql,row.source_event_id);
    if(!binding||!["slack_thread","local_dashboard"].includes(binding.owner.kind))throw Error("task_approval_not_current");
    this.dispatcher.assertJobSourceMatchesThread(row.job_id,row.source_event_id);
    return {task,row};
  }
  isLocalJob(jobId:string):boolean {
    const job=this.dispatcher.getJob(jobId);if(job?.source!=="web")return false;
    const binding=readEventJobBinding(this.sql,job.source_event_id);
    if(binding?.owner.kind!=="local_dashboard"||binding.destination.kind!=="none")return false;
    const row=this.sql.prepare("SELECT owner_json,source_event_id FROM job_owner_bindings WHERE job_id=?").get(jobId) as {owner_json:string;source_event_id:string}|undefined;
    const event=this.dispatcher.get(job.source_event_id);if(event?.source!=="web"||event.reply_target_json!==null)return false;
    const subject=JSON.parse(event.subject_json);
    return row?.source_event_id===job.source_event_id&&row.owner_json===stableStringify(binding.owner)&&subject.instance_id===binding.owner.instance_id&&subject.owner_id===binding.owner.owner_id;
  }
  matchesRecordedReply(eventId:string,jobId:string,questionId:string,kind:"question"|"approval",response:unknown):boolean {
    const event=this.dispatcher.get(eventId);
    if(event?.source!=="web"||event.event_type!=="worker_question_reply")return false;
    const payload=JSON.parse(event.payload_json);
    const receipt=this.sql.prepare("SELECT * FROM local_dashboard_command_receipts WHERE event_id=? AND operation=? AND attempt_id=?").get(eventId,kind==="approval"?"native_approval":"question_reply",jobId) as LocalDashboardReceipt|undefined;
    const binding=readEventJobBinding(this.sql,eventId);
    if(!receipt||binding?.owner.kind!=="local_dashboard"||binding.owner.instance_id!==receipt.instance_id||binding.owner.owner_id!==receipt.owner_id||payload.task_id!==receipt.task_id||payload.attempt_id!==jobId||payload.question_id!==questionId||payload.request_kind!==kind)return false;
    return receipt.canonical_sha256===digest({task_id:receipt.task_id,attempt_id:jobId,revision:receipt.task_revision,question_id:questionId,kind,...(kind==="approval"?{accepted:response}:{answers:response})});
  }
  private assertOwner(authority:LocalDashboardAuthority,attemptId:string):void {
    if(!this.isLocalJob(attemptId))throw Error("local_dashboard_owner_mismatch");
    const job=this.dispatcher.getJob(attemptId)!,binding=readEventJobBinding(this.sql,job.source_event_id)!;
    if(binding.owner.kind!=="local_dashboard"||binding.owner.instance_id!==authority.instance_id||binding.owner.owner_id!==authority.owner_id)throw Error("local_dashboard_owner_mismatch");
  }
  private replay(authority:LocalDashboardAuthority,requestId:string,operation:LocalDashboardReceipt["operation"],canonical:string) {
    const receipt=this.receipt(authority,requestId);if(!receipt)return;
    if(receipt.operation!==operation||receipt.canonical_sha256!==canonical)throw Error("local_dashboard_command_conflict");
    return {outcome:"reused" as const,receipt,task:this.dispatcher.tasks.get(receipt.task_id)!,row:this.dispatcher.getJob(receipt.attempt_id)!};
  }
  private record(authority:LocalDashboardAuthority,requestId:string,operation:LocalDashboardReceipt["operation"],canonical:string,taskId:string,attemptId:string,eventId?:string) {
    const task=this.dispatcher.tasks.get(taskId)!;
    this.sql.prepare("INSERT INTO local_dashboard_command_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(this.key(authority,requestId),authority.instance_id,authority.owner_id,authority.device_id,authority.grant_revision,requestId,operation,canonical,taskId,attemptId,task.revision,eventId??task.source_event_id,new Date().toISOString());
    return this.receipt(authority,requestId)!;
  }
  create(authority:LocalDashboardAuthority,input:LocalDashboardCreate,workspaceRoot:string,resultDir:string) {
    const key=this.key(authority,input.request_id);
    const parsed=parseCreateJobRequest({source_event_id:"evt_00000000000000000000000000",objective:input.objective,workspace:input.workspace});
    const canonical=digest({objective:parsed.objective,workspace:parsed.workspace});
    return this.sql.transaction(()=>{
      const prior=this.replay(authority,input.request_id,"create",canonical);if(prior)return prior;
      const owner={kind:"local_dashboard" as const,instance_id:authority.instance_id,owner_id:authority.owner_id};
      const active=this.sql.prepare(`SELECT COUNT(*) AS count FROM tasks t JOIN job_owner_bindings b ON b.job_id=t.current_attempt_id
        WHERE b.owner_json=? AND t.state NOT IN ('completed','failed','cancelled')`).get(stableStringify(owner)) as {count:number};
      if(active.count>=this.activeTaskLimit)throw Error("local_dashboard_active_task_limit");
      const now=new Date(),source=this.dispatcher.enqueue({schema_version:1,source:"web",type:"local_task_submit",external_event_id:`local-command:${key}`,occurred_at:now.toISOString(),subject:{instance_id:authority.instance_id,owner_id:authority.owner_id},payload:{canonical_sha256:canonical},reply_target:null},now);
      if(source.duplicate||source.payloadMismatch)throw Error("local_dashboard_command_conflict");
      insertEventJobBinding(this.sql,source.row.event_id,{owner,destination:{kind:"none"}});
      const row=this.dispatcher.createJob({source_event_id:source.row.event_id,objective:parsed.objective,workspace:parsed.workspace},workspaceRoot,resultDir,now).row;
      const task=this.dispatcher.tasks.attachLocalDashboardAttempt(row,key);
      this.sql.prepare("UPDATE events SET status='completed',completed_at=?,updated_at=? WHERE event_id=?").run(now.toISOString(),now.toISOString(),source.row.event_id);
      this.dispatcher.sealJobGroup(source.row.event_id);
      const receipt=this.record(authority,input.request_id,"create",canonical,task.task_id,row.job_id);
      return {outcome:"created" as const,receipt,task,row:this.dispatcher.getJob(row.job_id)!};
    }).immediate();
  }
  reply(authority:LocalDashboardAuthority,input:LocalDashboardQuestionReply) {
    const key=this.key(authority,input.request_id);
    if(!Number.isSafeInteger(input.revision)||input.revision<1)throw Error("local_dashboard_command_invalid");
    identifier.parse(input.question_id);
    const response=input.kind==="approval"?{accepted:z.boolean().parse(input.accepted)}:
      {answers:z.record(z.string().min(1).max(128),z.strictObject({answers:z.array(z.string().max(10000)).min(1).max(32)})).parse(input.answers)};
    const operation=input.kind==="approval"?"native_approval" as const:"question_reply" as const;
    const canonical=digest({task_id:input.task_id,attempt_id:input.attempt_id,revision:input.revision,question_id:input.question_id,kind:input.kind,...response});
    return this.sql.transaction(()=>{
      if(input.kind!=="approval")this.assertOwner(authority,input.attempt_id);
      const prior=this.replay(authority,input.request_id,operation,canonical);if(prior)return prior;
      if(input.kind==="approval"&&this.nativeApprovalTask(authority,input.task_id).row.job_id!==input.attempt_id)throw Error("task_approval_not_current");
      const task=this.dispatcher.tasks.get(input.task_id);
      if(!task||task.current_attempt_id!==input.attempt_id||task.revision!==input.revision||task.desired_state!=="running"||task.stop_state!=="none"||!["active","waiting"].includes(task.state))throw Error("task_question_not_current");
      const notification=this.sql.prepare(`SELECT event_id FROM events WHERE source IN ('web','dona_job') AND event_type='worker_question'
        AND external_event_id=? AND json_extract(subject_json,'$.job_id')=? AND json_extract(payload_json,'$.task_id')=?
        AND json_extract(payload_json,'$.request_kind')=?`).get(`question:${input.question_id}`,input.attempt_id,input.task_id,input.kind) as {event_id:string}|undefined;
      if(!notification)throw Error("task_question_not_current");
      // 1つのnative requestに相反する利用者回答をqueueしない。再送は上のreceiptで照合する。
      if(this.sql.prepare(`SELECT 1 FROM events WHERE source='web' AND event_type='worker_question_reply'
        AND json_extract(subject_json,'$.job_id')=? AND json_extract(payload_json,'$.question_id')=?`).get(input.attempt_id,input.question_id))throw Error("local_dashboard_question_already_answered");
      const binding={owner:{kind:"local_dashboard" as const,instance_id:authority.instance_id,owner_id:authority.owner_id},destination:{kind:"none" as const}};
      const event=this.dispatcher.enqueue({schema_version:1,source:"web",type:"worker_question_reply",external_event_id:`local-reply:${key}`,occurred_at:new Date().toISOString(),
        subject:{instance_id:authority.instance_id,owner_id:authority.owner_id,job_id:input.attempt_id,source_event_id:task.source_event_id},
        payload:{task_id:task.task_id,attempt_id:input.attempt_id,revision:input.revision,question_id:input.question_id,request_kind:input.kind,...response},reply_target:null});
      if(event.duplicate||event.payloadMismatch)throw Error("local_dashboard_command_conflict");
      insertEventJobBinding(this.sql,event.row.event_id,binding);
      const receipt=this.record(authority,input.request_id,operation,canonical,task.task_id,input.attempt_id,event.row.event_id);
      return {outcome:"created" as const,receipt,task,row:this.dispatcher.getJob(input.attempt_id)!};
    }).immediate();
  }
  cancel(authority:LocalDashboardAuthority,input:LocalDashboardCancel) {
    this.key(authority,input.request_id);
    if(!Number.isSafeInteger(input.revision)||input.revision<1)throw Error("local_dashboard_command_invalid");
    const canonical=digest({task_id:input.task_id,attempt_id:input.attempt_id,revision:input.revision});
    return this.sql.transaction(()=>{
      this.assertOwner(authority,input.attempt_id);
      const prior=this.replay(authority,input.request_id,"cancel",canonical);if(prior)return prior;
      const task=this.dispatcher.tasks.get(input.task_id);
      if(!task||task.current_attempt_id!==input.attempt_id)throw Error("task_revision_conflict");
      const updated=this.dispatcher.tasks.cancelWeb(task.task_id,input.attempt_id,input.revision);
      const receipt=this.record(authority,input.request_id,"cancel",canonical,task.task_id,input.attempt_id);
      return {outcome:"created" as const,receipt,task:updated,row:this.dispatcher.getJob(input.attempt_id)!};
    }).immediate();
  }
}
