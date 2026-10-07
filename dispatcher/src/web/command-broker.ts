import { randomBytes } from "node:crypto";
import { z } from "zod";
import { JobCreationError, type DispatcherDatabase, type WebCommandIdentity } from "../database.js";
import type { JobSupervisor } from "../job-supervisor.js";
import type { WebAuthRepository } from "./repository.js";
import { type WebCommandInput, type WebCommandResult } from "./command-wire.js";

const requestId = z.string().length(43).refine(value => /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, "base64url").byteLength === 32
  && Buffer.from(value, "base64url").toString("base64url") === value);
const workspace = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("scratch") }),
  z.strictObject({ kind: z.literal("github"), repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
    base_ref: z.string().min(1).max(255).optional() })]);
const submitBody = z.strictObject({ request_id: requestId, objective: z.string().trim().min(1).max(100000), workspace });
const cancelBody = z.strictObject({ request_id: requestId, task_id: z.string().regex(/^task_[0-9a-hjkmnp-tv-z]{26}$/).optional(), revision: z.number().int().positive().optional() });
const taskProjection=(task:import("../task-execution.js").TaskRow)=>({task_id:task.task_id,current_attempt_id:task.current_attempt_id,revision:task.revision,state:task.state,wait_reason:task.wait_reason});
export interface WebCommandPaths { jobsWorkspaceRoot: string; jobResultsDir: string }

export class WebCommandBroker {
  constructor(private readonly auth: WebAuthRepository, private readonly database: DispatcherDatabase,
    private readonly jobs: Pick<JobSupervisor, "wake">, private readonly paths: WebCommandPaths) {}
  async execute(input: WebCommandInput): Promise<WebCommandResult> {
    try {
      const body = Buffer.from(input.browser_body, "base64url"); let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
      catch { return { status: "denied", reason: "invalid_request" }; }
      const ingress = this.auth.verifySessionIngress(`web_command_${randomBytes(16).toString("hex")}`, input.context,
        input.method, input.target, body, { csrf_verified: true });
      if (ingress.status === "denied") return { status: "denied", reason: ingress.reason === "scope_denied" ? "scope_denied" : "identity_unavailable" };
      if (ingress.kind !== "session_verified") return { status: "denied", reason: "identity_unavailable" };
      const identity: WebCommandIdentity = { instance_id: ingress.principal.instance_id, tenant_id: ingress.principal.tenant_id,
        principal_id: ingress.principal.principal_id };
      const cancelTarget = /^\/api\/jobs\/([A-Za-z0-9_-]{1,128})\/cancel$/.exec(input.target);
      if ((input.operation === "submit" && input.target !== "/api/jobs") || (input.operation === "cancel" && !cancelTarget))
        return { status: "denied", reason: "invalid_request" };
      if (input.operation === "submit") {
        const command = submitBody.parse(parsed);
        const commandWorkspace = command.workspace.kind === "scratch" ? command.workspace
          : { kind: "github" as const, repository: command.workspace.repository,
            ...(command.workspace.base_ref === undefined ? {} : { base_ref: command.workspace.base_ref }) };
        const created = this.database.createWebTask({ ...identity, idempotency_key: input.idempotency_key,
          objective: command.objective, workspace: commandWorkspace }, this.paths.jobsWorkspaceRoot, this.paths.jobResultsDir);
        this.jobs.wake();
        return { status: "succeeded", outcome: created.outcome, receipt_id: created.receipt.receipt_id,
          job: { job_id: created.row.job_id, status: created.row.status }, ...(created.task?{task:taskProjection(created.task)}:{}) };
      }
      const command = cancelBody.parse(parsed);
      const jobId = cancelTarget?.[1];
      if (!jobId) return { status: "denied", reason: "invalid_request" };
      const candidate=this.database.getJob(jobId);
      if(!candidate)return {status:"denied",reason:"not_found"};
      if(candidate.source!=="web")return {status:"denied",reason:"scheduled_policy"};
      this.database.assertWebJobOwner(jobId,identity);
      if(!this.database.tasks.forAttempt(jobId))return {status:"denied",reason:"migration_required"};
      if(!command.task_id||command.revision===undefined)return {status:"denied",reason:"invalid_request"};
      const result=this.database.cancelWebTask({...identity,task_id:command.task_id,attempt_id:jobId,revision:command.revision,idempotency_key:input.idempotency_key});
      this.jobs.wake();
      const row=this.database.getJob(jobId)!;
      return {status:"succeeded",outcome:result.task.state==="cancelled"?(result.duplicate?"already_cancelled":"cancelled"):"cancel_requested",
        receipt_id:result.receipt.receipt_id,job:{job_id:jobId,status:row.status},task:taskProjection(result.task)};

    } catch (error) {
      const message=error instanceof Error?error.message:"";
      if(message==="task_revision_conflict")return {status:"denied",reason:"revision_conflict"};
      if(message==="web_job_owner_mismatch")return {status:"denied",reason:"owner_mismatch"};
      if(message==="web_task_migration_required")return {status:"denied",reason:"migration_required"};
      if(message==="task_terminal")return {status:"denied",reason:"terminal"};
      if(message==="web_command_conflict")return {status:"denied",reason:"idempotency_conflict"};
      if (error instanceof JobCreationError) return { status: "denied", reason: error.code === "job_group_limit_exceeded" ? "quota_exceeded" : "idempotency_conflict" };
      if (error instanceof z.ZodError)
        return { status: "denied", reason: "invalid_request" };
      return { status: "denied", reason: "internal_error" };
    }
  }
}
