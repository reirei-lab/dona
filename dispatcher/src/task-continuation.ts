import type Database from "better-sqlite3";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { DispatcherDatabase } from "./database.js";
import type { TaskRequest, TaskRow } from "./task-execution.js";
import { stableStringify } from "./validation.js";
import { readEventJobBinding } from "./job-routing.js";

const taskId = z.string().regex(/^task_[0-9a-hjkmnp-tv-z]{26}$/);
export const continuationScopeSchema = z.strictObject({
  objective: z.string().trim().min(1).max(16000),
  targets: z.array(z.strictObject({
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    issue_numbers: z.array(z.number().int().positive()).min(1).max(100),
    project: z.strictObject({owner:z.string().regex(/^[\w-]+$/),number:z.number().int().positive()}).optional(),
  })).max(16),
  allow_scratch: z.boolean(),
  operations: z.array(z.enum(["read_only", "submit_pr"])).min(1).max(2),
  max_tasks: z.number().int().min(2).max(32),
  max_attempts_per_task: z.number().int().min(1).max(10),
});
export const continuationSchema = z.strictObject({
  parent_task_id: taskId,
  parent_revision: z.number().int().positive(),
  scope_revision: z.number().int().positive(),
  operation: z.enum(["read_only", "submit_pr"]),
});
export const continuationControlSchema = z.strictObject({
  source_event_id:z.string().regex(/^evt_[0-9a-hjkmnp-tv-z]{26}$/i),
  revision:z.number().int().positive(), state:z.enum(["active","paused","cancelled"]),
});
interface ScopeRow {root_task_id:string;root_event_id:string;scope_json:string;state:string;revision:number;}
interface Member {root_task_id:string;task_id:string;task_key:string;request_sha256:string;parent_task_id:string|null;}
const digest=(value:unknown)=>createHash("sha256").update(stableStringify(value)).digest("hex");

/** Admission scope belongs to the original request, not to a worker's suggested next step. */
export class TaskContinuations {
  constructor(private readonly sql:Database.Database,private readonly dispatcher:DispatcherDatabase) {
    sql.exec(`CREATE TABLE IF NOT EXISTS task_continuation_scopes(
      root_task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),root_event_id TEXT NOT NULL REFERENCES events(event_id),
      scope_json TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'active',revision INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS task_continuation_members(
      task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),root_task_id TEXT NOT NULL REFERENCES task_continuation_scopes(root_task_id),
      task_key TEXT NOT NULL,request_sha256 TEXT NOT NULL,parent_task_id TEXT REFERENCES tasks(task_id),UNIQUE(root_task_id,task_key));
      CREATE TABLE IF NOT EXISTS task_continuation_controls(
      root_task_id TEXT NOT NULL REFERENCES task_continuation_scopes(root_task_id),event_id TEXT NOT NULL REFERENCES events(event_id),
      request_sha256 TEXT NOT NULL,PRIMARY KEY(root_task_id,event_id));
      CREATE TABLE IF NOT EXISTS task_continuation_requests(
      task_id TEXT PRIMARY KEY REFERENCES task_continuation_members(task_id),request_json TEXT NOT NULL);`);
  }
  private member(id:string):Member|undefined {return this.sql.prepare("SELECT * FROM task_continuation_members WHERE task_id=?").get(id) as Member|undefined;}
  private scope(id:string):ScopeRow|undefined {
    return this.sql.prepare("SELECT s.* FROM task_continuation_scopes s JOIN task_continuation_members m USING(root_task_id) WHERE m.task_id=?").get(id) as ScopeRow|undefined;
  }
  private notificationTask(eventId:string):TaskRow|undefined {
    const event=this.dispatcher.get(eventId);
    if(event?.source!=="dona_job"||!["job_completed","job_failed","job_cancelled"].includes(event.event_type))return;
    const subject=JSON.parse(event.subject_json),job=this.dispatcher.getJob(subject.job_id);
    if(!job||job.source_event_id!==subject.source_event_id||event.event_type!==`job_${job.status}`)return;
    const group=this.sql.prepare("SELECT all_terminal_event_id FROM job_groups WHERE source_event_id=?").get(job.source_event_id) as {all_terminal_event_id:string|null}|undefined;
    if(group?.all_terminal_event_id!==eventId)return;
    const snapshot=JSON.parse(event.payload_json).group;
    if(snapshot?.transition!=="all_terminal"||!["resolved","not_required"].includes(snapshot.attention_resolution_state))return;
    const task=this.dispatcher.tasks.forAttempt(job.job_id);
    if(!task||task.current_attempt_id!==job.job_id||task.state!==job.status)return;
    return task;
  }
  private notificationScopes(eventId:string):string[] {
    const notification=this.notificationTask(eventId);if(!notification)return [];
    return (this.sql.prepare(`SELECT DISTINCT m.root_task_id FROM task_continuation_members m JOIN tasks t USING(task_id) JOIN jobs j ON j.job_id=t.current_attempt_id
      WHERE t.source_event_id=? AND t.state='completed' AND j.status='completed' AND j.result_json IS NOT NULL`).all(notification.source_event_id) as Array<{root_task_id:string}>).map(row=>row.root_task_id);
  }
  canRead(id:string,eventId:string):boolean {
    const scope=this.scope(id);
    return !!scope&&this.notificationScopes(eventId).includes(scope.root_task_id);
  }
  list(eventId:string):TaskRow[] {
    const notification=this.notificationTask(eventId),scopes=this.notificationScopes(eventId);
    if(!notification||!scopes.length)throw Error("task_owner_mismatch");
    this.dispatcher.tasks.assertOwner(notification.task_id,eventId,true);
    return this.sql.prepare(`SELECT t.* FROM tasks t JOIN task_continuation_members m USING(task_id)
      WHERE m.root_task_id IN (SELECT value FROM json_each(?)) ORDER BY t.created_at DESC,t.task_id LIMIT 100`).all(JSON.stringify(scopes)) as TaskRow[];
  }
  private assertSource(input:TaskRequest):ScopeRow {
    const continuation=input.continuation;
    if(!continuation)throw Error("task_continuation_required");
    const parent=this.dispatcher.tasks.get(continuation.parent_task_id),scope=this.scope(continuation.parent_task_id);
    if(!parent||!scope)throw Error("task_owner_mismatch");
    const event=this.dispatcher.get(input.source_event_id),root=this.dispatcher.get(scope.root_event_id)!;
    const binding=readEventJobBinding(this.sql,input.source_event_id),owner=readEventJobBinding(this.sql,scope.root_event_id);
    if(!event||!binding||owner?.owner.kind!=="slack_thread"||stableStringify(binding)!==stableStringify(owner)||
      event.reply_target_json!==root.reply_target_json||JSON.parse(event.subject_json).actor_id!==JSON.parse(root.subject_json).actor_id)throw Error("task_owner_mismatch");
    if(event.source==="dona_job") {
      const notified=this.notificationTask(event.event_id);
      if(!notified||parent.source_event_id!==notified.source_event_id)throw Error("task_owner_mismatch");
    } else if(event.source!=="slack")throw Error("task_owner_mismatch");
    return scope;
  }
  private requestHash(input:TaskRequest):string {
    // Delivery IDs and observed revisions may change after a lost response; the logical work must not.
    const {source_event_id,continuation,...request}=input;
    return digest({...request,continuation:continuation?{parent_task_id:continuation.parent_task_id,operation:continuation.operation}:undefined});
  }
  storageKey(input:TaskRequest):string {
    return input.continuation ? `c.${digest({root_task_id:this.scope(input.continuation.parent_task_id)!.root_task_id,task_key:input.task_key}).slice(0,62)}` : input.task_key;
  }
  logicalKey(task:TaskRow):string {return this.member(task.task_id)?.task_key??task.task_key;}
  admission(id:string):Record<string,unknown>|null {
    const row=this.sql.prepare("SELECT request_json FROM task_continuation_requests WHERE task_id=?").get(id) as {request_json:string}|undefined;
    return row?JSON.parse(row.request_json):null;
  }
  lookup(input:TaskRequest):TaskRow|undefined {
    const scope=this.assertSource(input);
    const prior=this.sql.prepare("SELECT * FROM task_continuation_members WHERE root_task_id=? AND task_key=?").get(scope.root_task_id,input.task_key) as Member|undefined;
    if(!prior)return;
    if(prior.request_sha256!==this.requestHash(input))throw Error("task_idempotency_conflict");
    return this.dispatcher.tasks.get(prior.task_id)!;
  }
  validate(input:TaskRequest):void {
    if((input.continuation_scope||input.continuation)&&input.task_key==="legacy-default")throw Error("task_continuation_reserved_key");
    if(input.continuation_scope&&input.workspace.kind==="github"&&input.issue_number!==undefined) {
      const repository=input.workspace.repository;
      if(input.continuation_scope.targets.some(t=>t.repository.toLowerCase()===repository.toLowerCase()&&t.issue_numbers.includes(input.issue_number!)))throw Error("task_continuation_initial_issue_conflict");
    }
    if(input.continuation_scope ? !input.initial_operation||!input.continuation_scope.operations.includes(input.initial_operation) : input.initial_operation!==undefined)throw Error("task_continuation_initial_operation_required");
    if(input.continuation_scope) {
      if(input.continuation||this.dispatcher.get(input.source_event_id)?.source!=="slack")throw Error("task_continuation_scope_invalid");
      if(input.policy.max_attempts>input.continuation_scope.max_attempts_per_task)throw Error("task_continuation_budget_exceeded");
    }
    if((input.continuation?.operation??input.initial_operation)==="read_only"&&input.project?.completion_status==="Merge Ready")throw Error("task_continuation_scope_mismatch");
    if(!input.continuation)return;
    const row=this.assertSource(input),scope=continuationScopeSchema.parse(JSON.parse(row.scope_json));
    if(row.state!=="active")throw Error("task_continuation_stopped");
    if(row.revision!==input.continuation.scope_revision)throw Error("task_continuation_revision_conflict");
    const parent=this.dispatcher.tasks.get(input.continuation.parent_task_id)!;
    if(parent.revision!==input.continuation.parent_revision)throw Error("task_revision_conflict");
    if(parent.state!=="completed"||parent.desired_state!=="running"||parent.steer_pending_event_id||!this.dispatcher.getJob(parent.current_attempt_id)?.result_json)throw Error("task_continuation_parent_not_completed");
    const count=this.sql.prepare("SELECT COUNT(*) AS n FROM task_continuation_members WHERE root_task_id=?").get(row.root_task_id) as {n:number};
    if(count.n>=scope.max_tasks||input.policy.max_attempts>scope.max_attempts_per_task)throw Error("task_continuation_budget_exceeded");
    if(!scope.operations.includes(input.continuation.operation))throw Error("task_continuation_scope_mismatch");
    if(input.workspace.kind==="scratch") {
      if(!scope.allow_scratch||input.continuation.operation!=="read_only")throw Error("task_continuation_scope_mismatch");
    } else {
      const repository=input.workspace.repository;
      const allowed=scope.targets.some(target=>target.repository.toLowerCase()===repository.toLowerCase()&&target.issue_numbers.includes(input.issue_number??0)&&
        (input.project ? !!target.project&&input.project.owner.toLowerCase()===target.project.owner.toLowerCase()&&input.project.number===target.project.number : !target.project));
      if(!allowed)throw Error("task_continuation_scope_mismatch");
    }
  }
  attach(input:TaskRequest,task:TaskRow):void {
    if(input.continuation_scope)this.sql.prepare("INSERT INTO task_continuation_scopes(root_task_id,root_event_id,scope_json) VALUES(?,?,?)").run(task.task_id,input.source_event_id,stableStringify(input.continuation_scope));
    const root=input.continuation_scope?task.task_id:input.continuation?this.scope(input.continuation.parent_task_id)!.root_task_id:undefined;
    if(root) {
      this.sql.prepare("INSERT INTO task_continuation_members VALUES(?,?,?,?,?)").run(task.task_id,root,input.task_key,this.requestHash(input),input.continuation?.parent_task_id??null);
      const operation=input.continuation?.operation??input.initial_operation!;
      const project=input.project?{...input.project,project_id:task.project_json?JSON.parse(task.project_json).project_id??null:null}:null;
      const admission={workspace:input.workspace,issue_number:input.issue_number??null,issue_node_id:task.resource_id?.startsWith("github:")?task.resource_id.slice(7):null,project,operation};
      this.sql.prepare("INSERT INTO task_continuation_requests VALUES(?,?)").run(task.task_id,stableStringify(admission));
      const scope=this.scope(task.task_id)!,job=this.dispatcher.getJob(task.current_attempt_id)!;
      const workspace={...JSON.parse(job.workspace_json),_dona_continuation:{root_task_id:root,root_event_id:scope.root_event_id,
        scope:JSON.parse(scope.scope_json),operation,task_key:input.task_key}};
      this.sql.prepare("UPDATE jobs SET workspace_json=? WHERE job_id=?").run(stableStringify(workspace),job.job_id);
    }
  }
  projection(id:string):Record<string,unknown>|undefined {
    const row=this.scope(id);if(!row)return;
    const members=(this.sql.prepare(`SELECT m.task_id,m.task_key,m.parent_task_id,t.state,t.revision,t.max_attempts,r.request_json FROM task_continuation_members m JOIN tasks t USING(task_id)
      LEFT JOIN task_continuation_requests r USING(task_id) WHERE m.root_task_id=? ORDER BY t.created_at,m.task_id`).all(row.root_task_id) as Array<Record<string,unknown>&{request_json:string|null}>)
      .map(({request_json,...member})=>({...member,admission:request_json?JSON.parse(request_json):null}));
    return {root_task_id:row.root_task_id,root_event_id:row.root_event_id,state:row.state,revision:row.revision,scope:JSON.parse(row.scope_json),members};
  }
  control(id:string,input:z.infer<typeof continuationControlSchema>):Record<string,unknown> {
    return this.sql.transaction(()=>{
      this.dispatcher.tasks.assertOwner(id,input.source_event_id,true);
      if(this.dispatcher.get(input.source_event_id)?.source!=="slack")throw Error("task_control_requires_slack");
      const scope=this.scope(id);if(!scope)throw Error("task_continuation_required");
      const prior=this.sql.prepare("SELECT request_sha256 FROM task_continuation_controls WHERE root_task_id=? AND event_id=?").get(scope.root_task_id,input.source_event_id) as {request_sha256:string}|undefined;
      if(prior){if(prior.request_sha256!==digest(input))throw Error("task_control_conflict");return this.projection(id)!;}
      if(scope.revision!==input.revision)throw Error("task_continuation_revision_conflict");
      if(scope.state==="cancelled")throw Error("task_continuation_stopped");
      this.sql.prepare("UPDATE task_continuation_scopes SET state=?,revision=revision+1 WHERE root_task_id=?").run(input.state,scope.root_task_id);
      this.sql.prepare("INSERT INTO task_continuation_controls VALUES(?,?,?)").run(scope.root_task_id,input.source_event_id,digest(input));
      return this.projection(id)!;
    }).immediate();
  }
}
