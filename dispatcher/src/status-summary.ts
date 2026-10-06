import { AgentReadAuthorization, type AgentReadOwnerBinding } from "./agent-read-authorization.js";
import { createHash } from "node:crypto";
import type { AgentExecutionContext } from "./agent-context.js";
import type { DispatcherDatabase } from "./database.js";
import type { JobRow } from "./types.js";
import { stableStringify } from "./validation.js";

export const statusNotAvailable = { schema_version: 1, status: "not_available" } as const;
export interface StatusMembershipInput {event_id:string;workspace_id:string;channel_id:string;user_id:string;}
export type StatusMembership = (input:StatusMembershipInput)=>Promise<Record<string,unknown>>;
const messages:Record<JobRow["status"],string>={preparing:"準備中です。",dispatching:"開始中です。",cancelling:"中止処理中です。",retryable_failed:"再試行待ちです。",queued:"待機中です。",running:"実行中です。",completed:"完了しています。",failed:"失敗しています。",blocked:"入力待ちです。",cancelled:"中止されています。",needs_review:"確認が必要です。"};

export function projectStatusSummary(value:unknown):Record<string,unknown> {
 if(!value||typeof value!=="object"||Array.isArray(value))return statusNotAvailable;
 const v=value as Record<string,unknown>;
 if(v.schema_version!==1||typeof v.job_id!=="string"||!/^job_[0-9a-hjkmnp-tv-z]{26}$/i.test(v.job_id)||
   typeof v.status!=="string"||!Object.hasOwn(messages,v.status)||typeof v.revision!=="string"||!/^[a-f0-9]{64}$/.test(v.revision)||
   typeof v.observed_at!=="string"||!Number.isFinite(Date.parse(v.observed_at))||new Date(v.observed_at).toISOString()!==v.observed_at)return statusNotAvailable;
 return {schema_version:1,job_id:v.job_id,status:v.status,observed_at:v.observed_at,revision:v.revision,message:messages[v.status as JobRow["status"]]};
}

/** #166のauthority/disclosure分離をstatus専用に限定する。grant永続化や
 * discovery、全文Result、writeにはこの同owner許可を流用しない。 */
export class StatusSummaryService {
 constructor(private readonly database:DispatcherDatabase,private readonly membership:StatusMembership){}
 private snapshot(jobId:string,context:AgentExecutionContext) {
  if(context.purpose!=="human_command"||context.policy_revision!==1||context.principal_kind!=="human")return;
  const event=this.database.get(context.event_id),job=this.database.getJob(jobId);
  if(!event||event.source!=="slack"||!job)return;
  const owner=this.database.getVerifiedPrincipalBinding(job.source_event_id),requester=this.database.getVerifiedPrincipalBinding(context.event_id);
  if(!owner||!requester||owner.revoked_at!==null||requester.revoked_at!==null)return;
  if([owner,requester].some(p=>p.principal_id!==context.principal_id||p.tenant_id!==context.tenant_id||p.workspace_id!==context.workspace_id))return;
  const origin=this.database.get(job.source_event_id);
  if(!origin||origin.source!=="slack")return;
  const destination=event.reply_target_json?JSON.parse(event.reply_target_json) as Record<string,unknown>:undefined;
  const source=origin.reply_target_json?JSON.parse(origin.reply_target_json) as Record<string,unknown>:undefined;
  if(!source||!destination||source.kind!=="slack_thread"||destination.kind!=="slack_thread"||
    source.workspace_id!==context.workspace_id||destination.workspace_id!==context.workspace_id||
    typeof source.channel_id!=="string"||source.channel_id!==destination.channel_id)return;
  const task=this.database.tasks.forAttempt(jobId);
  // 古いAttemptもexact jobの履歴として読めるが、Taskのownerを別jobから推測しない。
  if(task&&task.source_event_id!==job.source_event_id)return;
  const revision=createHash("sha256").update(stableStringify({job_id:job.job_id,status:job.status,updated_at:job.updated_at,
    task_id:task?.task_id??null,task_revision:task?.revision??null,owner_proof:owner.proof_sha256,
    requester_proof:requester.proof_sha256,destination,origin_trace:origin.trace_json,origin_destination:source,policy_revision:1})).digest("hex");
  const originVisibility=origin.trace_json?JSON.parse(origin.trace_json).status_origin_visibility:undefined;
  if(!["public_channel","private_channel","im","mpim"].includes(originVisibility))return;
  const binding:AgentReadOwnerBinding={job_id:job.job_id,source_event_id:job.source_event_id,owner_kind:"human_verified",
    tenant_id:owner.tenant_id,workspace_id:owner.workspace_id,principal_kind:owner.principal_kind,principal_id:owner.principal_id,
    resource_kind:task?.resource_id?.startsWith("github:")?"github_issue":"unknown",repository_node_id:null,
    task_node_id:task?.resource_id?.startsWith("github:")?task.resource_id.slice(7):null,resource_revision:task?.revision??null,
    policy_revision:1,disclosure_origin_json:stableStringify(source)};
  return {job,revision,destination,originVisibility,binding};
 }
 async read(jobId:string,context:AgentExecutionContext|undefined,revalidate:()=>AgentExecutionContext|undefined):Promise<Record<string,unknown>> {
  try {
   if(!context||!/^job_[0-9a-hjkmnp-tv-z]{26}$/i.test(jobId))return statusNotAvailable;
   const before=this.snapshot(jobId,context);if(!before)return statusNotAvailable;
   const input={event_id:context.event_id,workspace_id:context.workspace_id,channel_id:String(before.destination.channel_id),user_id:context.principal_id};
   // 毎回providerを呼ぶ。再起動や前回のsuccessは現在membershipの証拠にしない。
   const access=await this.membership(input);
   if(access.authorized!==true||access.event_id!==input.event_id||access.workspace_id!==input.workspace_id||
     access.channel_id!==input.channel_id||access.user_id!==input.user_id||access.destination_kind!==before.originVisibility)return statusNotAvailable;
   const current=revalidate();if(!current||stableStringify(current)!==stableStringify(context))return statusNotAvailable;
   const after=this.snapshot(jobId,current);if(!after||after.revision!==before.revision||!Object.hasOwn(messages,after.job.status))return statusNotAvailable;
   const policy=new AgentReadAuthorization(
    {authorize:input=>input.operation==="read_exact_job_status"&&input.surface==="get_job_status_summary"},
    {authorize:input=>input.operation==="read_exact_job_status"&&input.surface==="get_job_status_summary"&&
      input.event_id===access.event_id&&input.workspace_id===access.workspace_id&&input.principal_id===access.user_id&&
      stableStringify(input.disclosure_origin)===after.binding.disclosure_origin_json&&stableStringify(input.disclosure_destination)===stableStringify(after.destination)},
   );
   const decision=policy.authorize({context:current,operation:"read_exact_job_status",surface:"get_job_status_summary",job:after.job,
     binding:after.binding,owner_binding_current:true,disclosure_destination:after.destination});
   if(!decision.authority.allowed||!decision.disclosure.allowed)return statusNotAvailable;
   return {schema_version:1,job_id:after.job.job_id,status:after.job.status,observed_at:new Date().toISOString(),revision:after.revision,message:messages[after.job.status]};
  } catch {return statusNotAvailable;}
 }
}
