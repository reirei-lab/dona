import {evaluateProgress,type ProgressDecision} from "./worker-progress-policy.js";
import path from "node:path";
import {existsSync} from "node:fs";
import {credentialShaped} from "./credential-shaped.js";
import {workerMessageTerminalTrigger} from "./worker-message-schema.js";
import { createHash, randomBytes } from "node:crypto";

import Database from "better-sqlite3";
import { ulid } from "ulid";
import { z } from "zod";

import { insertEventJobBinding, readEventJobBinding } from "./job-routing.js";
import type { JobRow,ResultEnvelope } from "./types.js";
import type {JobNotificationEvidence,JobNotificationVerificationRequest} from "./database.js";
import { jobObjectiveCharacterMax, stableStringify } from "./validation.js";

export const workerMessageProtocolVersion = 1 as const;
export const workerMessagePayloadUtf8ByteMax = 16_384;
export const workerMessageRetentionDays = 30;
export const workerMessageLeaseMaxMs = 300_000;
export const workerReportMaxPerJob = 256;
const workerMessageOverdueGraceMs = 60_000;

const utcRfc3339Pattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;
const utcRfc3339 = z.string().regex(utcRfc3339Pattern)
  .refine((value) => {
    const match=utcRfc3339Pattern.exec(value);
    const parsed=new Date(value);
    if(!match||Number.isNaN(parsed.getTime()))return false;
    const [,year,month,day,hour,minute,second]=match.map(Number);
    return parsed.getUTCFullYear()===year&&parsed.getUTCMonth()+1===month&&parsed.getUTCDate()===day
      &&parsed.getUTCHours()===hour&&parsed.getUTCMinutes()===minute&&parsed.getUTCSeconds()===second;
  }, "must be a real UTC RFC 3339 date-time");
const identifier = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const safeText = z.string().trim().min(1).max(4_000);
const reportPayload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("checkpoint"), summary: safeText }).strict(),
  z.object({ kind: z.literal("question"), question: safeText }).strict(),
  z.object({ kind: z.literal("risk"), summary: safeText, severity: z.enum(["low", "medium", "high"]) }).strict(),
  z.object({ kind: z.literal("decision_request"), question: safeText, options: z.array(safeText.max(1_000)).min(1).max(8) }).strict(),
]);
const instructionPayload = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("answer"), text: safeText }).strict(),
  z.object({ operation: z.literal("add_condition"), text: safeText }).strict(),
  z.object({ operation: z.literal("change_priority"), priority: z.enum(["low", "normal", "high", "urgent"]), reason: safeText.optional() }).strict(),
]);

const commonMessage = {
  schema_version: z.literal(workerMessageProtocolVersion),
  source_event_id: identifier,
  producer_sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  idempotency_key: identifier,
  occurred_at: utcRfc3339,
  correlation_message_id: z.string().regex(/^msg_[0-9a-hjkmnp-tv-z]{26}$/).optional(),
  conversation_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
};

export const workerReportSchema = z.object({ ...commonMessage, payload: reportPayload }).strict().superRefine((value, context) => {
  if ((value.payload.kind === "question" || value.payload.kind === "decision_request")
    && value.conversation_revision === Number.MAX_SAFE_INTEGER) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["conversation_revision"],
      message: "must leave room for the correlated answer revision" });
  }
});
export const donaInstructionSchema = z.object({ ...commonMessage, payload: instructionPayload }).strict().superRefine((value, context) => {
  if (value.payload.operation !== "answer") return;
  if (!value.correlation_message_id) context.addIssue({ code:z.ZodIssueCode.custom,path:["correlation_message_id"],
    message:"is required for an answer" });
  if (value.conversation_revision === undefined) context.addIssue({ code:z.ZodIssueCode.custom,path:["conversation_revision"],
    message:"is required for an answer" });
});

export type WorkerReportInput = z.infer<typeof workerReportSchema>;
export type DonaInstructionInput = z.infer<typeof donaInstructionSchema>;
export type WorkerMessageInput = WorkerReportInput | DonaInstructionInput;
export type WorkerMessageDirection = "worker_to_dona" | "dona_to_worker";
export type WorkerMessageKind = "checkpoint" | "question" | "risk" | "decision_request" | "answer" | "add_condition" | "change_priority";

export interface WorkerMessageRow {
  message_id: string;
  schema_version: number;
  job_id: string;
  source_event_id: string;
  workspace_id: string | null;
  channel_id: string | null;
  thread_ts: string | null;
  direction: WorkerMessageDirection;
  kind: WorkerMessageKind;
  producer: "worker" | "dona-main";
  producer_sequence: number;
  idempotency_key: string;
  payload_json: string;
  payload_sha256: string;
  correlation_message_id: string | null;
  conversation_revision: number | null;
  occurred_at: string;
  accepted_at: string;
}

export interface WorkerMessageDeliveryRow {
  delivery_id: string;
  message_id: string;
  consumer: "dona-main" | "worker";
  state: "pending" | "leased" | "delivered" | "superseded";
  available_at: string;
  lease_owner: string | null;
  lease_token_sha256: string | null;
  lease_expires_at: string | null;
  fence: number;
  attempt_count: number;
  delivered_at: string | null;
  delivered_lease_owner: string | null;
  delivered_lease_token_sha256: string | null;
  delivered_fence: number | null;
  created_at: string;
  updated_at: string;
}

export interface WorkerInstructionController {
  steer(jobId:string,sourceEventId:string,instruction:string,operationId?:string):Promise<unknown>;
}

export class WorkerMessageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkerMessageError";
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.length ? `${issue.path.join(".")} ` : "";
    throw new WorkerMessageError("invalid_worker_message", `${location}${issue?.message ?? "is invalid"}`);
  }
  const bytes = Buffer.byteLength(stableStringify(parsed.data), "utf8");
  if (bytes > workerMessagePayloadUtf8ByteMax) {
    throw new WorkerMessageError("worker_message_too_large", `message exceeds ${workerMessagePayloadUtf8ByteMax} UTF-8 bytes`);
  }
  return parsed.data;
}

export function parseWorkerReport(value: unknown): WorkerReportInput { return parse(workerReportSchema, value); }
export function parseDonaInstruction(value: unknown): DonaInstructionInput { return parse(donaInstructionSchema, value); }

export function migrateWorkerMessaging(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_messages (
      message_id              TEXT PRIMARY KEY,
      schema_version          INTEGER NOT NULL CHECK (schema_version = 1),
      job_id                  TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
      source_event_id         TEXT NOT NULL REFERENCES events(event_id),
      workspace_id            TEXT,
      channel_id              TEXT,
      thread_ts               TEXT,
      direction               TEXT NOT NULL CHECK (direction IN ('worker_to_dona','dona_to_worker')),
      kind                    TEXT NOT NULL CHECK (kind IN ('checkpoint','question','risk','decision_request','answer','add_condition','change_priority')),
      producer                TEXT NOT NULL CHECK (producer IN ('worker','dona-main')),
      producer_sequence       INTEGER NOT NULL CHECK (producer_sequence > 0),
      idempotency_key         TEXT NOT NULL,
      payload_json            TEXT NOT NULL,
      payload_sha256          TEXT NOT NULL CHECK (length(payload_sha256) = 64),
      correlation_message_id  TEXT REFERENCES worker_messages(message_id),
      conversation_revision   INTEGER,
      occurred_at             TEXT NOT NULL,
      accepted_at             TEXT NOT NULL,
      UNIQUE(job_id, producer, producer_sequence),
      UNIQUE(job_id, producer, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS worker_messages_job_idx ON worker_messages(job_id, accepted_at, message_id);
    CREATE INDEX IF NOT EXISTS worker_messages_retention_idx ON worker_messages(accepted_at, message_id);

    CREATE TABLE IF NOT EXISTS worker_message_runtime_identities (
      message_id               TEXT PRIMARY KEY REFERENCES worker_messages(message_id) ON DELETE CASCADE,
      runtime_identity_sha256  TEXT NOT NULL CHECK (length(runtime_identity_sha256) = 64),
      first_seen_at            TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS worker_message_deliveries (
      delivery_id          TEXT PRIMARY KEY,
      message_id           TEXT NOT NULL REFERENCES worker_messages(message_id) ON DELETE CASCADE,
      consumer             TEXT NOT NULL CHECK (consumer IN ('dona-main','worker')),
      state                TEXT NOT NULL CHECK (state IN ('pending','leased','delivered','superseded')),
      available_at         TEXT NOT NULL,
      lease_owner          TEXT,
      lease_token_sha256   TEXT,
      lease_expires_at     TEXT,
      fence                INTEGER NOT NULL DEFAULT 0,
      attempt_count        INTEGER NOT NULL DEFAULT 0,
      delivered_at        TEXT,
      delivered_lease_owner TEXT,
      delivered_lease_token_sha256 TEXT,
      delivered_fence      INTEGER,
      event_id             TEXT REFERENCES events(event_id),
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL,
      UNIQUE(message_id, consumer)
    );
    CREATE INDEX IF NOT EXISTS worker_message_delivery_claim_idx
      ON worker_message_deliveries(consumer, state, available_at, created_at);



    CREATE TABLE IF NOT EXISTS worker_message_receipts (
      receipt_id       TEXT PRIMARY KEY,
      message_id       TEXT NOT NULL REFERENCES worker_messages(message_id) ON DELETE CASCADE,
      delivery_id      TEXT REFERENCES worker_message_deliveries(delivery_id) ON DELETE SET NULL,
      receipt_kind     TEXT NOT NULL CHECK (receipt_kind IN ('accepted','delivered')),
      consumer         TEXT NOT NULL CHECK (consumer IN ('dispatcher','dona-main','worker')),
      created_at       TEXT NOT NULL,
      UNIQUE(message_id, receipt_kind, consumer)
    );

    CREATE TABLE IF NOT EXISTS worker_message_cadence (
      job_id                 TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,
      minimum_interval_ms    INTEGER NOT NULL DEFAULT 60000 CHECK (minimum_interval_ms BETWEEN 0 AND 3600000),
      silence_interval_ms    INTEGER NOT NULL DEFAULT 900000 CHECK (silence_interval_ms BETWEEN 60000 AND 86400000),
      last_report_at         TEXT,
      last_delivery_at       TEXT,
      silence_due_at         TEXT,
      pending_message_id     TEXT REFERENCES worker_messages(message_id),
      generation             INTEGER NOT NULL DEFAULT 0,
      updated_at             TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS worker_progress_decisions (
      decision_key TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(job_id),
      event_id TEXT NOT NULL REFERENCES events(event_id),
      snapshot_sha256 TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      decided_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS worker_progress_decisions_job_idx ON worker_progress_decisions(job_id,decided_at);
    CREATE TABLE IF NOT EXISTS worker_progress_decision_roots (
      root_key TEXT PRIMARY KEY,decision_key TEXT NOT NULL REFERENCES worker_progress_decisions(decision_key)
    );
    CREATE TABLE IF NOT EXISTS worker_progress_applications (
      decision_key TEXT PRIMARY KEY REFERENCES worker_progress_decisions(decision_key),
      event_id TEXT NOT NULL REFERENCES events(event_id),
      result_json TEXT NOT NULL,
      next_check_at TEXT,
      followup_event_id TEXT REFERENCES events(event_id),
      applied_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS worker_progress_applications_due_idx ON worker_progress_applications(next_check_at,decision_key) WHERE next_check_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS worker_message_activity (
      job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,activity_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worker_message_workspace_cadence (
      workspace_id           TEXT PRIMARY KEY,
      minimum_interval_ms    INTEGER NOT NULL DEFAULT 60000 CHECK (minimum_interval_ms BETWEEN 0 AND 3600000),
      last_delivery_at       TEXT,
      updated_at             TEXT NOT NULL
    );
  `);
  const trigger=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(workerMessageTerminalTrigger.name) as {sql:string}|undefined;
  if(trigger&&trigger.sql!==workerMessageTerminalTrigger.sql)throw new WorkerMessageError("worker_message_schema_invalid","terminal fence was modified");
  if(!trigger)db.exec(workerMessageTerminalTrigger.sql);
  if(!(db.pragma("table_info(worker_progress_applications)") as {name:string}[]).some(c=>c.name==="followup_generation"))db.exec("ALTER TABLE worker_progress_applications ADD COLUMN followup_generation INTEGER NOT NULL DEFAULT 0");
  const runtimeIdentityColumns=new Set((db.pragma("table_info(worker_message_runtime_identities)") as Array<{name:string}>).map(row=>row.name));
  if(runtimeIdentityColumns.has("job_id"))db.exec(`
    CREATE TABLE worker_message_runtime_identities_v2 (
      message_id TEXT PRIMARY KEY REFERENCES worker_messages(message_id) ON DELETE CASCADE,
      runtime_identity_sha256 TEXT NOT NULL CHECK (length(runtime_identity_sha256) = 64),
      first_seen_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO worker_message_runtime_identities_v2(message_id,runtime_identity_sha256,first_seen_at)
      SELECT m.message_id,r.runtime_identity_sha256,r.first_seen_at
      FROM worker_message_runtime_identities r JOIN worker_messages m ON m.job_id=r.job_id AND m.producer='worker'
      WHERE (SELECT COUNT(*) FROM worker_message_runtime_identities legacy WHERE legacy.job_id=r.job_id)=1;
    DROP TABLE worker_message_runtime_identities;
    ALTER TABLE worker_message_runtime_identities_v2 RENAME TO worker_message_runtime_identities;
  `);
  const deliveryColumns=new Set((db.pragma("table_info(worker_message_deliveries)") as Array<{name:string}>).map(row=>row.name));
  if(!deliveryColumns.has("event_id"))db.exec("ALTER TABLE worker_message_deliveries ADD COLUMN event_id TEXT REFERENCES events(event_id)");
  if(!deliveryColumns.has("delivered_lease_owner"))db.exec("ALTER TABLE worker_message_deliveries ADD COLUMN delivered_lease_owner TEXT");
  if(!deliveryColumns.has("delivered_lease_token_sha256"))db.exec("ALTER TABLE worker_message_deliveries ADD COLUMN delivered_lease_token_sha256 TEXT");
  if(!deliveryColumns.has("delivered_fence"))db.exec("ALTER TABLE worker_message_deliveries ADD COLUMN delivered_fence INTEGER");
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function terminal(status: JobRow["status"]): boolean { return status === "completed" || status === "failed" || status === "cancelled"; }
function reportKind(input: WorkerReportInput): WorkerMessageKind { return input.payload.kind; }
function instructionKind(input: DonaInstructionInput): WorkerMessageKind { return input.payload.operation; }
function typedInstructionText(messageId:string,kind:WorkerMessageKind,payload:unknown,correlationMessageId:string|null,conversationRevision:number|null):string {
  const instruction=stableStringify({schema_version:workerMessageProtocolVersion,message_id:messageId,result_file:`${messageId}.json`,
    correlation_message_id:correlationMessageId,conversation_revision:conversationRevision,operation:kind,payload});
  return `[DONA_TYPED_INSTRUCTION]\n${instruction}\n[/DONA_TYPED_INSTRUCTION]`;
}

export class WorkerMessageRepository {
  constructor(private readonly db: Database.Database,private readonly jobObjectiveTotalMaxBytes=400_000) {}

  private queuedInstructionReservations(sourceEventId:string):Array<{job_id:string;addition:string}> {
    const rows=this.db.prepare(`SELECT m.message_id,m.job_id,m.kind,m.payload_json,m.correlation_message_id,m.conversation_revision
      FROM worker_messages m JOIN worker_message_deliveries d USING(message_id) JOIN jobs j USING(job_id)
      WHERE j.source_event_id=? AND j.status IN ('queued','retryable_failed') AND m.direction='dona_to_worker'
        AND d.consumer='worker' AND d.state IN ('pending','leased')`)
      .all(sourceEventId) as Array<{message_id:string;job_id:string;kind:WorkerMessageKind;payload_json:string;
        correlation_message_id:string|null;conversation_revision:number|null}>;
    return rows.map(row=>({job_id:row.job_id,addition:`\n\n[DONA_FOLLOW_UP]\n${typedInstructionText(row.message_id,row.kind,
      JSON.parse(row.payload_json),row.correlation_message_id,row.conversation_revision)}\n[/DONA_FOLLOW_UP]`}));
  }

  reservedQueuedInstructionCharacters(jobId:string):number {
    const job=this.db.prepare("SELECT source_event_id FROM jobs WHERE job_id=?").get(jobId) as {source_event_id:string};
    return this.queuedInstructionReservations(job.source_event_id).filter(row=>row.job_id===jobId).reduce((sum,row)=>sum+[...row.addition].length,0);
  }

  reservedQueuedInstructionBytes(sourceEventId:string):number {
    return this.queuedInstructionReservations(sourceEventId)
      .reduce((sum,row)=>sum+Buffer.byteLength(row.addition,"utf8"),0);
  }

  rearmUndispatchedAggregate(eventId:string,availableAt:string):boolean {
    return this.db.prepare(`UPDATE worker_progress_applications SET followup_event_id=NULL,next_check_at=?,followup_generation=followup_generation+1
      WHERE followup_event_id=? AND EXISTS (SELECT 1 FROM events e WHERE e.event_id=? AND e.source='dona_message' AND e.event_type='worker_message_aggregate' AND e.status='dead_letter')`)
      .run(availableAt,eventId,eventId).changes>0;
  }

  rearmUndispatchedReport(eventId:string,availableAt:string,at=new Date()):boolean {
    const row=this.db.prepare(`SELECT d.delivery_id,j.status,m.job_id,m.kind,m.payload_json,m.producer_sequence FROM worker_message_deliveries d
      JOIN worker_messages m USING(message_id) JOIN jobs j USING(job_id)
      WHERE d.event_id=? AND d.consumer='dona-main' AND d.state='delivered'`)
      .get(eventId) as {delivery_id:string;status:JobRow["status"];job_id:string;kind:WorkerMessageKind;payload_json:string;producer_sequence:number}|undefined;
    if(!row||terminal(row.status))return false;
    this.db.prepare("DELETE FROM worker_message_receipts WHERE delivery_id=? AND consumer='dona-main' AND receipt_kind='delivered'")
      .run(row.delivery_id);
    const urgent=row.kind==="question"||row.kind==="decision_request"
      ||(row.kind==="risk"&&(JSON.parse(row.payload_json) as {severity?:string}).severity==="high");
    const newer=!urgent&&this.db.prepare(`SELECT 1 FROM worker_messages WHERE job_id=? AND direction='worker_to_dona'
      AND producer_sequence>? LIMIT 1`).get(row.job_id,row.producer_sequence);
    if(newer){
      this.db.prepare(`UPDATE worker_message_deliveries SET state='superseded',event_id=NULL,delivered_at=NULL,updated_at=?
        WHERE delivery_id=? AND event_id=? AND state='delivered'`).run(at.toISOString(),row.delivery_id,eventId);
      return true;
    }
    this.db.prepare(`UPDATE worker_message_deliveries SET state='pending',event_id=NULL,delivered_at=NULL,
      available_at=?,updated_at=? WHERE delivery_id=? AND event_id=? AND state='delivered'`)
      .run(availableAt,at.toISOString(),row.delivery_id,eventId);
    if(!urgent)this.db.prepare("UPDATE worker_message_cadence SET pending_message_id=(SELECT message_id FROM worker_message_deliveries WHERE delivery_id=?),updated_at=? WHERE job_id=?")
      .run(row.delivery_id,at.toISOString(),row.job_id);
    return true;
  }

  appendWorkerReport(jobId: string, runtimeIdentity: string, raw: unknown, at = new Date()) {
    this.assertWorkerRuntime(jobId, runtimeIdentity);
    return this.db.transaction(() => {
      const result=this.appendReport(jobId, raw, at);
      this.db.prepare(`INSERT OR IGNORE INTO worker_message_runtime_identities(message_id,runtime_identity_sha256,first_seen_at)
        VALUES(?,?,?)`).run(result.message.message_id,sha256(runtimeIdentity),at.toISOString());
      return result;
    }).immediate();
  }

  /** Runtimeの受付順とledgerの受理順を分け、確定拒否でproducer sequenceに穴を開けない。 */
  acceptRuntimeReport(jobId:string,runtimeIdentity:string,raw:unknown){
    const input=parseWorkerReport(raw);
    return this.db.transaction(()=>{
      const prior=this.db.prepare("SELECT producer_sequence FROM worker_messages WHERE job_id=? AND producer='worker' AND idempotency_key=?").get(jobId,input.idempotency_key) as {producer_sequence:number}|undefined;
      const next=prior?.producer_sequence??(this.db.prepare("SELECT COALESCE(MAX(producer_sequence),0)+1 n FROM worker_messages WHERE job_id=? AND producer='worker'").get(jobId) as {n:number}).n;
      const canonical={...input,producer_sequence:next};
      return this.reconcileWorkerReport(jobId,runtimeIdentity,canonical)??this.appendWorkerReport(jobId,runtimeIdentity,canonical);
    }).immediate();
  }

  reconcileRuntimeReport(jobId:string,runtimeIdentity:string,raw:unknown){
    const input=parseWorkerReport(raw),prior=this.db.prepare("SELECT producer_sequence FROM worker_messages WHERE job_id=? AND producer='worker' AND idempotency_key=?").get(jobId,input.idempotency_key) as {producer_sequence:number}|undefined;
    if(!prior)return undefined;return this.reconcileWorkerReport(jobId,runtimeIdentity,{...input,producer_sequence:prior.producer_sequence});
  }
  reconcileWorkerReport(jobId:string,runtimeIdentity:string,raw:unknown) {
    const input=parseWorkerReport(raw);
    this.assertWorkerReconciliationRuntime(jobId,runtimeIdentity,input.idempotency_key);
    const job=this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId) as JobRow|undefined;
    if(!job)throw new WorkerMessageError("job_not_found","job does not exist");
    this.assertAuthorized(job,input.source_event_id);
    const message=this.db.prepare("SELECT * FROM worker_messages WHERE job_id=? AND producer='worker' AND idempotency_key=?").get(jobId,input.idempotency_key) as WorkerMessageRow|undefined;
    if(!message)return undefined;
    if(message.payload_sha256!==sha256(stableStringify(input.payload))||message.producer_sequence!==input.producer_sequence||message.occurred_at!==input.occurred_at||message.source_event_id!==input.source_event_id||message.correlation_message_id!==(input.correlation_message_id??null)||message.conversation_revision!==(input.conversation_revision??null))throw new WorkerMessageError("worker_message_idempotency_conflict","report identity does not match");
    const receipt=this.db.prepare("SELECT receipt_id FROM worker_message_receipts WHERE message_id=? AND receipt_kind='accepted' AND consumer='dispatcher'").get(message.message_id) as {receipt_id:string};
    return {message,receipt_id:receipt.receipt_id,outcome:"created" as const};
  }

  appendReport(jobId: string, raw: unknown, at = new Date()) {
    return this.append(jobId, "worker_to_dona", parseWorkerReport(raw), at);
  }

  hasUnansweredQuestion(jobId:string):boolean {
    return !!this.db.prepare(`SELECT 1 FROM worker_messages m WHERE m.job_id=? AND m.direction='worker_to_dona' AND m.kind IN ('question','decision_request') AND NOT EXISTS (
      SELECT 1 FROM worker_messages a JOIN worker_message_deliveries d USING(message_id) WHERE a.correlation_message_id=m.message_id AND a.kind='answer' AND d.consumer='worker' AND d.state='delivered')`).get(jobId);
  }
  progressDecisionCandidate(jobId:string,eventId:string,at=new Date(),persist=true) {
    const job=this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId) as JobRow|undefined;
    if(!job)throw Error("job_not_found");
    this.assertAuthorized(job,eventId);
    if(!this.ownsMessageEvent(jobId,eventId))return undefined;
    const operation=this.db.transaction(()=>{
      const job=this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId) as JobRow|undefined;
      if(!job)throw Error("job_not_found");
      this.assertAuthorized(job,eventId);
      if(!this.ownsMessageEvent(jobId,eventId))return undefined;
      const event=this.db.prepare("SELECT * FROM events WHERE event_id=?").get(eventId) as {payload_json:string;external_event_id:string;event_type:string};
      const payload=JSON.parse(event.payload_json) as {message_id?:string};
      const task=this.db.prepare("SELECT current_attempt_id,desired_state,revision,stop_state,steer_pending_event_id FROM tasks WHERE current_attempt_id=?").get(jobId) as {current_attempt_id:string;desired_state:string;revision:number;stop_state:string;steer_pending_event_id:string|null}|undefined;
      const rows=this.db.prepare(`SELECT j.job_id,j.status,j.last_error_code FROM jobs j LEFT JOIN tasks t ON t.current_attempt_id=j.job_id
        WHERE j.source_event_id=? AND (t.task_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM task_attempts a WHERE a.attempt_id=j.job_id))
        ORDER BY j.created_at,j.job_id LIMIT 33`).all(job.source_event_id) as Array<{job_id:string;status:string;last_error_code:string|null}>;
      const project=(message:WorkerMessageRow)=>({message_id:message.message_id,payload:JSON.parse(message.payload_json),occurred_at:message.occurred_at,accepted_at:message.accepted_at});
      const report=payload.message_id?this.db.prepare("SELECT * FROM worker_messages WHERE message_id=? AND job_id=? AND direction='worker_to_dona'").get(payload.message_id,jobId) as WorkerMessageRow|undefined:undefined;
      const members=rows.slice(0,32).map(row=>{
        const latest=this.db.prepare("SELECT * FROM worker_messages WHERE job_id=? AND direction='worker_to_dona' ORDER BY producer_sequence DESC LIMIT 1").get(row.job_id) as WorkerMessageRow|undefined;
        return {job_id:row.job_id,phase:row.status,...(latest?{report:project(latest)}:{})};
      });
      const group=this.db.prepare("SELECT attention_event_id,all_terminal_event_id FROM job_groups WHERE source_event_id=?").get(job.source_event_id) as {attention_event_id:string|null;all_terminal_event_id:string|null}|undefined;
      const liveAttention=rows.some(row=>["failed","needs_review","blocked"].includes(row.status)
        &&!["worker_message_question_pending","worker_instruction_acceptance_unknown"].includes(row.last_error_code??"")
        &&!this.db.prepare("SELECT 1 FROM job_attention_resolutions WHERE job_id=? AND status_at_resolution=?").get(row.job_id,row.status));
      const attentionActive=!!group?.attention_event_id&&!!this.db.prepare("SELECT 1 FROM events WHERE event_id=? AND status NOT IN ('completed','dead_letter')").get(group.attention_event_id);
      const pending=this.db.prepare(`SELECT m.message_id,d.attempt_count FROM worker_messages m JOIN worker_message_deliveries d USING(message_id)
        WHERE m.job_id=? AND m.direction='dona_to_worker' AND d.state IN ('pending','leased') ORDER BY m.producer_sequence LIMIT 1`).get(jobId) as {message_id:string;attempt_count:number}|undefined;
      const cadence=this.db.prepare("SELECT COALESCE(a.activity_at,c.last_report_at) last_report_at FROM worker_message_cadence c LEFT JOIN worker_message_activity a USING(job_id) WHERE c.job_id=?").get(jobId) as {last_report_at:string|null}|undefined;
      const latestForJob=members.find(m=>m.job_id===jobId)?.report;
      // A retained unanswered question remains actionable even after a later checkpoint.
      const pendingQuestion=report&&["question","decision_request"].includes(report.kind)&&!!this.db.prepare(`SELECT 1 FROM worker_messages q
        WHERE q.message_id=? AND NOT EXISTS (SELECT 1 FROM worker_messages a JOIN worker_message_deliveries d USING(message_id)
          WHERE a.correlation_message_id=q.message_id AND a.kind='answer' AND d.consumer='worker' AND d.state='delivered')`).get(report.message_id);
      const pendingRisk=report?.kind==="risk"&&JSON.parse(report.payload_json).severity==="high"&&!this.db.prepare(`SELECT 1 FROM worker_progress_decisions p JOIN worker_progress_applications a USING(decision_key)
        WHERE p.job_id=? AND json_extract(p.decision_json,'$.target.message_id')=? AND json_extract(a.result_json,'$.state')='presentation_ready' LIMIT 1`).get(jobId,report.message_id);
      const priorRisk=report?this.db.prepare("SELECT json_extract(payload_json,'$.severity') severity FROM worker_messages WHERE job_id=? AND direction='worker_to_dona' AND kind='risk' AND producer_sequence<? AND json_extract(payload_json,'$.severity') IN ('low','medium','high') ORDER BY producer_sequence DESC LIMIT 1").get(jobId,report.producer_sequence) as {severity:'low'|'medium'|'high'}|undefined:undefined;
      const identity={report_current:!report||latestForJob?.message_id===report.message_id||!!pendingQuestion||!!pendingRisk,job_id:jobId,current:task?.current_attempt_id===jobId&&task.stop_state==="none",control_pending:!!task?.steer_pending_event_id,desired_state:task?.desired_state??"cancelled",phase:job.status,
        members:members.map(m=>({job_id:m.job_id,phase:m.phase,message_id:m.report?.message_id??null})),
        group_attention:liveAttention||attentionActive,group_terminal:!!group?.all_terminal_event_id,context_complete:rows.length<=32,
        ...(priorRisk?{last_risk_severity:priorRisk.severity}:{}),
        ...(!report&&cadence?.last_report_at?{silence_since:cadence.last_report_at}:{}),
        ...(pending?{pending_instruction:{message_id:pending.message_id,state:pending.attempt_count>0?"unknown":"pending"}}:{})};
      const snapshot=sha256(stableStringify({identity,control:{revision:task?.revision,stop_state:task?.stop_state,steer_event:task?.steer_pending_event_id,job_error:job.last_error_code}}));
      const root=sha256(stableStringify({version:1,job_id:jobId,report_id:report?.message_id??event.external_event_id,...(event.event_type==="worker_message_aggregate"?{stage:event.external_event_id}:{})}));
      const pointer=this.db.prepare("SELECT decision_key FROM worker_progress_decision_roots WHERE root_key=?").get(root) as {decision_key:string}|undefined;
      const priorKey=pointer?.decision_key??root;
      const saved=this.db.prepare("SELECT * FROM worker_progress_decisions WHERE decision_key=?").get(priorKey) as {snapshot_sha256:string;decision_json:string;decided_at:string}|undefined;
      if(saved){
        const application=this.db.prepare("SELECT result_json FROM worker_progress_applications WHERE decision_key=?").get(priorKey) as {result_json:string}|undefined;
        if(application||saved.snapshot_sha256===snapshot||!persist)return {decision_id:priorKey,decision:JSON.parse(saved.decision_json) as ProgressDecision,eligible_now:saved.snapshot_sha256===snapshot,replayed:true,
          decided_at:saved.decided_at,applied:!!application,...(application?{application_receipt:JSON.parse(application.result_json)}:{})};
      }
      if(!persist)return undefined;
      const key=sha256(stableStringify({root,snapshot}));
      const prior=this.db.prepare("SELECT p.decision_json,p.decided_at FROM worker_progress_decisions p JOIN worker_progress_applications a USING(decision_key) WHERE p.job_id=? ORDER BY p.decided_at DESC,p.decision_key DESC LIMIT 1").get(jobId) as {decision_json:string;decided_at:string}|undefined;
      const previous=prior?JSON.parse(prior.decision_json) as ProgressDecision:undefined;
      const lastEta=this.db.prepare(`SELECT json_extract(p.decision_json,'$.observed.eta_minutes') eta_minutes
        FROM worker_progress_decisions p JOIN worker_progress_applications a USING(decision_key)
        WHERE p.job_id=? AND json_type(p.decision_json,'$.observed.eta_minutes')='integer'
        ORDER BY p.decided_at DESC,p.decision_key DESC LIMIT 1`).get(jobId) as {eta_minutes:number}|undefined;
      const presentation=this.db.prepare(`SELECT a.applied_at,p.decision_json FROM worker_progress_applications a JOIN worker_progress_decisions p USING(decision_key) JOIN jobs j ON j.job_id=p.job_id
        WHERE j.source_event_id=? AND json_extract(a.result_json,'$.state')='presentation_ready' ORDER BY a.applied_at DESC,a.decision_key DESC LIMIT 1`).get(job.source_event_id) as {applied_at:string;decision_json:string}|undefined;
      const reserved=presentation?JSON.parse(presentation.decision_json) as ProgressDecision:undefined;
      const currentHighIds=[...new Set([...(report?.kind==='risk'&&JSON.parse(report.payload_json).severity==='high'?[report.message_id]:[]),...members.flatMap(m=>m.report?.payload.kind==='risk'&&m.report.payload.severity==='high'?[m.report.message_id]:[])])];
      const reservedHighIds=currentHighIds.length?(this.db.prepare(`SELECT DISTINCT risk.value AS message_id FROM worker_progress_applications a
        JOIN worker_progress_decisions p USING(decision_key) JOIN jobs j ON j.job_id=p.job_id JOIN json_each(p.decision_json,'$.observed.high_risk_message_ids') risk
        WHERE j.source_event_id=? AND json_extract(a.result_json,'$.state') IN ('presentation_ready','presentation_delivered','presentation_duplicate','local_artifact_ready')
          AND json_extract(p.decision_json,'$.action')='report_to_user' AND risk.value IN (${currentHighIds.map(()=>'?').join(',')}) LIMIT 64`)
        .all(job.source_event_id,...currentHighIds) as Array<{message_id:string}>).map(r=>r.message_id):[];
      const delivered=this.db.prepare(`SELECT MAX(json_extract(a.result_json,'$.provider_receipt.posted_at')) posted_at FROM worker_progress_applications a
        JOIN worker_progress_decisions p USING(decision_key) JOIN jobs j ON j.job_id=p.job_id WHERE j.source_event_id=? AND json_extract(a.result_json,'$.state')='presentation_delivered'`).get(job.source_event_id) as {posted_at:string|null};
      const decision=evaluateProgress({event_id:eventId,...identity,context_complete:rows.length<=32,...(lastEta?{last_eta_minutes:lastEta.eta_minutes}:{}),now:at.toISOString(),members,reserved_high_risk_ids:reservedHighIds,presentation_pending:!!presentation,...(delivered.posted_at?{last_user_report_at:delivered.posted_at}:{}),...(presentation?{last_presentation_fingerprint:reserved?.observed?.group_fingerprint}:{}),...(report?{report:project(report)}:{}),
        ...(!report&&cadence?.last_report_at?{silence_since:cadence.last_report_at}:{}),
        ...(pending?{pending_instruction:{message_id:pending.message_id,state:pending.attempt_count>0?"unknown":"pending"}}:{}),
        ...(previous&&prior?{previous:{fingerprint:previous.fingerprint??"",action:previous.action,decided_at:prior.decided_at,...previous.observed,...(previous.target?.message_id?{message_id:previous.target.message_id}:{})}}:{})});
      this.db.prepare("INSERT OR IGNORE INTO worker_progress_decisions VALUES(?,?,?,?,?,?)").run(key,jobId,eventId,snapshot,stableStringify(decision),at.toISOString());
      this.db.prepare("INSERT INTO worker_progress_decision_roots VALUES(?,?) ON CONFLICT(root_key) DO UPDATE SET decision_key=excluded.decision_key").run(root,key);
      return {decision_id:key,decision,eligible_now:true,replayed:false,decided_at:at.toISOString(),applied:false};
    });
    return persist?operation.immediate():operation();
  }

  applyProgressDecision(jobId:string,eventId:string,decisionId:string,at=new Date()) {
    if(!/^[0-9a-f]{64}$/.test(decisionId))throw Error("progress_decision_invalid");
    return this.db.transaction(()=>{
      const candidate=this.progressDecisionCandidate(jobId,eventId,at,false);
      if(!candidate||candidate.decision_id!==decisionId)throw Error("progress_decision_not_current");
      const prior=this.db.prepare("SELECT result_json FROM worker_progress_applications WHERE decision_key=?").get(decisionId) as {result_json:string}|undefined;
      if(prior)return {...JSON.parse(prior.result_json),replayed:true,eligible_now:candidate.eligible_now};
      const job=this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId) as JobRow;
      const task=this.db.prepare("SELECT desired_state,stop_state,steer_pending_event_id FROM tasks WHERE current_attempt_id=?").get(jobId) as {desired_state:string;stop_state:string;steer_pending_event_id:string|null}|undefined;
      if(candidate.decision.action!=="ack_internal"&&(!task||task.desired_state!=="running"||task.stop_state!=="none"||(task.steer_pending_event_id&&!(candidate.decision.action==="aggregate_wait"&&candidate.decision.reason==="task_control_pending"))||!["running","blocked"].includes(job.status)))throw Error("progress_snapshot_changed");
      const answer=candidate.decision.action==="ask_user"&&candidate.decision.target?.message_id
        ?this.db.prepare(`SELECT m.message_id,d.state,d.attempt_count FROM worker_messages m JOIN worker_message_deliveries d USING(message_id)
          WHERE m.job_id=? AND m.direction='dona_to_worker' AND m.kind='answer' AND m.correlation_message_id=?
            AND d.consumer='worker' AND d.state!='superseded' LIMIT 1`).get(jobId,candidate.decision.target.message_id) as {message_id:string;state:string;attempt_count:number}|undefined:undefined;
      if(!candidate.eligible_now&&!answer)throw Error("progress_snapshot_changed");
      const result:Record<string,unknown>={version:1,decision_id:decisionId,job_id:jobId,source_event_id:eventId,
        action:candidate.decision.action,state:"recorded",receipt_id:`policy_${decisionId}`,replayed:false,eligible_now:candidate.eligible_now};
      let nextCheck:string|null=null;
      if(answer){
        result.action="instruct_worker";result.state=answer.state==="delivered"?"instruction_delivered":answer.attempt_count>0?"instruction_unknown":"instruction_pending";
        result.instruction_message_id=answer.message_id;
      }else if(candidate.decision.action==="ask_worker"){
        if(job.status!=="running"||this.hasUnansweredQuestion(jobId)||this.hasPendingInstructions(jobId)){
          result.action="ack_internal";result.state="worker_wait_priority";
        }else{
          const next=this.instructionReceipts(jobId,eventId).next_producer_sequence;
          const accepted=this.append(jobId,"dona_to_worker",parseDonaInstruction({schema_version:1,source_event_id:eventId,producer_sequence:next,
            idempotency_key:`policy-${decisionId}`,occurred_at:at.toISOString(),payload:{operation:"add_condition",
              text:"現在の進捗・残作業・見込み時間・riskを短く報告してください。既存成果を読み取りだけで照合し、新しい外部操作・承認・作業範囲の変更は行わないでください。"}}),at);
          result.state="instruction_pending";result.instruction_message_id=accepted.message.message_id;result.instruction_receipt_id=accepted.receipt_id;
        }
      }else if(candidate.decision.action==="instruct_worker"){
        result.state=candidate.decision.operation==="read_instruction_receipt"?"instruction_unknown":"instruction_pending";
        result.instruction_message_id=candidate.decision.target?.message_id;
      }else if(candidate.decision.action==="aggregate_wait"){
        result.state="aggregate_wait";nextCheck=new Date(at.getTime()+30000).toISOString();result.next_check_at=nextCheck;
      }else if(["report_to_user","ask_user"].includes(candidate.decision.action)){
        const binding=readEventJobBinding(this.db,job.source_event_id);
        if(!binding)throw Error("progress_destination_unverified");
        const riskIds=stableStringify(candidate.decision.observed?.severity==='high'?[candidate.decision.target!.message_id!]:candidate.decision.signals.risk_escalation?candidate.decision.observed?.high_risk_message_ids??[]:[]);
        const reserved=candidate.decision.action==="report_to_user"&&this.db.prepare(`SELECT 1 FROM worker_progress_applications a
          JOIN worker_progress_decisions p USING(decision_key) JOIN jobs j ON j.job_id=p.job_id
          WHERE j.source_event_id=? AND json_extract(a.result_json,'$.state') IN ('presentation_ready','presentation_delivered') AND json_extract(p.decision_json,'$.action')='report_to_user'
            AND ((json_array_length(?)=0 AND json_extract(p.decision_json,'$.observed.group_fingerprint')=?)
              OR (json_array_length(?)>0 AND NOT EXISTS(SELECT 1 FROM json_each(?) incoming WHERE NOT EXISTS
                (SELECT 1 FROM json_each(json_extract(p.decision_json,'$.observed.high_risk_message_ids')) reserved WHERE reserved.value=incoming.value)))) LIMIT 1`)
          .get(job.source_event_id,riskIds,candidate.decision.observed?.group_fingerprint??null,riskIds,riskIds);
        const undelivered=candidate.decision.action==="report_to_user"&&!candidate.decision.signals.risk_escalation&&!candidate.decision.signals.eta_changed&&this.db.prepare(`SELECT 1 FROM worker_progress_applications a JOIN worker_progress_decisions p USING(decision_key)
          JOIN jobs j ON j.job_id=p.job_id WHERE j.source_event_id=? AND json_extract(a.result_json,'$.state')='presentation_ready' LIMIT 1`).get(job.source_event_id);
        if(reserved){result.action="ack_internal";result.state="presentation_duplicate";}
        else if(undelivered){result.action="aggregate_wait";result.state="aggregate_wait";nextCheck=new Date(at.getTime()+30000).toISOString();result.next_check_at=nextCheck;}
        else {result.state=binding.destination.kind==='none'?"local_artifact_ready":"presentation_ready";
        const body=this.renderPresentation(candidate.decision);
        result.artifact={version:1,decision_id:decisionId,action:candidate.decision.action,
          source_event_id:job.source_event_id,destination:binding.destination,
          operation_slot:decisionId,reply_broadcast:false,desired_session_status:candidate.decision.action==="ask_user"?"suspended":null,safe_projection:candidate.decision.safe_projection,rendered_body:body,rendered_body_sha256:sha256(body)};}
      }
      this.db.prepare("INSERT INTO worker_progress_applications(decision_key,event_id,result_json,next_check_at,followup_event_id,applied_at) VALUES(?,?,?,?,NULL,?)").run(decisionId,eventId,stableStringify(result),nextCheck,at.toISOString());
      return result;
    }).immediate();
  }

  private renderPresentation(decision:ProgressDecision):string {
    const p=decision.safe_projection;if(!p)throw Error("progress_projection_missing");
    const lines=[p.question??p.summary??"進捗を確認しました",...(p.options??[]).map(option=>`- ${option}`),
      ...(decision.action==='report_to_user'?(p.members??[]).map((m,i)=>`並行作業 ${i+1}: ${Array.from(m.summary??m.phase).slice(0,100).join("")}`):[])];
    const body=Buffer.from(lines.join("\n"),"utf8").toString("utf8").replace(/<!(?:channel|here|everyone)(?:\|[^>]+)?>|<!subteam\^[A-Z0-9]+(?:\|[^>]+)?>|<@[A-Z0-9]+(?:\|[^>]+)?>/gi,mention=>`&lt;${mention.slice(1)}`);
    // question 4,000 + options 8×1,000。mention無効化の展開（最大2倍）と8行の接頭辞を含める。
    if(body.length>24_024)throw Error("progress_presentation_body_limit");return body;
  }

  presentationVerificationRequest(eventId:string,result:ResultEnvelope):JobNotificationVerificationRequest|undefined {
    const posts=(result.actions??[]).filter(a=>a&&typeof a==='object'&&!Array.isArray(a)&&['dona_slack.post_message','mcp__dona_slack__post_message'].includes(String((a as Record<string,unknown>).tool))) as Array<Record<string,unknown>>;
    const rows=this.db.prepare("SELECT decision_key,result_json FROM worker_progress_applications WHERE event_id=? AND json_extract(result_json,'$.state') IN ('presentation_ready','presentation_delivered','local_artifact_ready') LIMIT 2").all(eventId) as Array<{decision_key:string;result_json:string}>;
    if(!rows.length)return undefined;
    if(rows.length===1&&!posts.length&&JSON.parse(rows[0]!.result_json).artifact?.destination?.kind==='none')return undefined;
    if(!posts.length)throw Error("progress_presentation_action_missing");
    if(rows.length!==1||posts.length!==1)throw Error("progress_presentation_ambiguous");
    const artifact=JSON.parse(rows[0]!.result_json).artifact as {action:string;destination:{kind:string;workspace_id?:string;channel_id?:string;thread_ts?:string};rendered_body?:string;rendered_body_sha256?:string};
    const target=artifact.destination,post=posts[0]!;
    if(target.kind!=='slack_thread'||typeof artifact.rendered_body_sha256!=='string'||!/^[a-f0-9]{64}$/.test(artifact.rendered_body_sha256))throw Error("progress_presentation_body_unbound");
    if(post.event_id!==eventId||post.workspace_id!==target.workspace_id||post.channel_id!==target.channel_id||post.thread_ts!==target.thread_ts||post.reply_broadcast!==false||post.parse!=='none'||post.mrkdwn!==true||typeof post.message_ts!=='string'||!/^\d{1,20}\.\d{6}$/.test(post.message_ts))throw Error("progress_presentation_action_mismatch");
    return {schema_version:1,event_id:eventId,workspace_id:target.workspace_id!,channel_id:target.channel_id!,thread_ts:target.thread_ts!,message_ts:post.message_ts,body_sha256:artifact.rendered_body_sha256!,desired_session_status:artifact.action==="ask_user"?"suspended":null};
  }

  confirmPresentation(eventId:string,request:JobNotificationVerificationRequest,evidence:JobNotificationEvidence):void {
    this.db.transaction(()=>{
      const rows=this.db.prepare("SELECT decision_key,result_json FROM worker_progress_applications WHERE event_id=? AND json_extract(result_json,'$.state') IN ('presentation_ready','presentation_delivered','local_artifact_ready') LIMIT 2").all(eventId) as Array<{decision_key:string;result_json:string}>;
      if(rows.length!==1)throw Error("progress_presentation_not_found");
      const row=rows[0]!,result=JSON.parse(row.result_json),artifact=result.artifact;
      if(request.event_id!==eventId||evidence.event_id!==eventId||evidence.workspace_id!==artifact.destination.workspace_id||evidence.channel_id!==artifact.destination.channel_id||evidence.thread_ts!==artifact.destination.thread_ts||evidence.message_ts!==request.message_ts||evidence.body_sha256!==artifact.rendered_body_sha256||request.body_sha256!==evidence.body_sha256||evidence.reply_broadcast!==false||evidence.identity_block_verified!==true||request.desired_session_status!==(artifact.action==="ask_user"?"suspended":null)||evidence.session_status!==(artifact.action==="ask_user"?"suspended":null)||!Number.isFinite(Date.parse(evidence.posted_at)))throw Error("progress_presentation_receipt_mismatch");
      if(result.state==='presentation_delivered'){
        if(stableStringify(result.provider_receipt)!==stableStringify(evidence))throw Error("progress_presentation_receipt_conflict");return;
      }
      result.state='presentation_delivered';result.provider_receipt=evidence;
      this.db.prepare("UPDATE worker_progress_applications SET result_json=? WHERE decision_key=?").run(stableStringify(result),row.decision_key);
    }).immediate();
  }

  publishDueProgressDecisions(limit=32,at=new Date()):number {
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error("progress_publish_limit_invalid");
    return this.db.transaction(()=>{
      const due=this.db.prepare(`SELECT a.decision_key,a.followup_generation,p.job_id,p.decision_json FROM worker_progress_applications a JOIN worker_progress_decisions p USING(decision_key)
        WHERE a.next_check_at<=? AND a.followup_event_id IS NULL ORDER BY a.next_check_at,a.decision_key LIMIT ?`).all(at.toISOString(),limit) as Array<{decision_key:string;followup_generation:number;job_id:string;decision_json:string}>;
      let count=0;
      for(const row of due){
        const job=this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(row.job_id) as JobRow;
        const task=this.db.prepare("SELECT task_id,desired_state,steer_pending_event_id FROM tasks WHERE current_attempt_id=?").get(row.job_id) as {task_id:string;desired_state:string;steer_pending_event_id:string|null}|undefined;
        if(!task||task.desired_state!=="running"||!["running","blocked"].includes(job.status)){
          this.db.prepare("UPDATE worker_progress_applications SET next_check_at=NULL WHERE decision_key=?").run(row.decision_key);continue;
        }
        if(task.steer_pending_event_id){this.db.prepare("UPDATE worker_progress_applications SET next_check_at=? WHERE decision_key=?").run(new Date(at.getTime()+30000).toISOString(),row.decision_key);continue;}
        const hintedId=(JSON.parse(row.decision_json) as ProgressDecision).target?.message_id;
        const hinted=hintedId?this.db.prepare("SELECT * FROM worker_messages WHERE message_id=? AND job_id=? AND direction='worker_to_dona'").get(hintedId,row.job_id) as WorkerMessageRow|undefined:undefined;
        const important=hinted&&(['question','decision_request'].includes(hinted.kind)||(hinted.kind==='risk'&&JSON.parse(hinted.payload_json).severity==='high'));
        const message=important?hinted:this.db.prepare("SELECT * FROM worker_messages WHERE job_id=? AND direction='worker_to_dona' ORDER BY producer_sequence DESC LIMIT 1").get(row.job_id) as WorkerMessageRow|undefined;
        if(!message){this.db.prepare("UPDATE worker_progress_applications SET next_check_at=NULL WHERE decision_key=?").run(row.decision_key);continue;}
        const pendingPresentation=this.db.prepare(`SELECT 1 FROM worker_progress_applications a JOIN worker_progress_decisions p USING(decision_key)
          JOIN jobs j ON j.job_id=p.job_id WHERE j.source_event_id=? AND json_extract(a.result_json,'$.state')='presentation_ready' LIMIT 1`).get(job.source_event_id);
        if(pendingPresentation&&!important){
          this.db.prepare("UPDATE worker_progress_applications SET next_check_at=? WHERE decision_key=? AND followup_event_id IS NULL")
            .run(new Date(at.getTime()+30000).toISOString(),row.decision_key);continue;
        }
        const original=this.db.prepare("SELECT subject_json FROM events WHERE event_id=?").get(job.source_event_id) as {subject_json:string};
        const binding=readEventJobBinding(this.db,job.source_event_id);if(!binding)throw Error("progress_owner_unverified");
        const eventId=`evt_${ulid(at.getTime())}`,externalId=`progress-aggregate:${row.decision_key}${row.followup_generation?`:${row.followup_generation}`:""}`;
        const subject=stableStringify({job_id:row.job_id,message_id:message.message_id,source_event_id:job.source_event_id,actor_id:JSON.parse(original.subject_json).actor_id});
        const payload=stableStringify({schema_version:1,job_id:row.job_id,task_id:task.task_id,message_id:message.message_id,source_event_id:job.source_event_id,owner_kind:binding.owner.kind,decision_id:row.decision_key});
        const reply=job.workspace_id&&job.channel_id&&job.thread_ts?stableStringify({kind:"slack_thread",workspace_id:job.workspace_id,channel_id:job.channel_id,thread_ts:job.thread_ts}):null;
        this.db.prepare(`INSERT OR IGNORE INTO events(event_id,schema_version,source,external_event_id,event_type,occurred_at,subject_json,payload_json,reply_target_json,trace_json,status,available_at,created_at,updated_at)
          VALUES(?,1,'dona_message',?,'worker_message_aggregate',?,?,?,?,?,'queued',?,?,?)`).run(eventId,externalId,at.toISOString(),subject,payload,reply,stableStringify({decision_id:row.decision_key}),at.toISOString(),at.toISOString(),at.toISOString());
        const event=this.db.prepare("SELECT event_id,subject_json,payload_json,event_type FROM events WHERE source='dona_message' AND external_event_id=?").get(externalId) as {event_id:string;subject_json:string;payload_json:string;event_type:string};
        if(event.subject_json!==subject||event.payload_json!==payload||event.event_type!=="worker_message_aggregate")throw Error("progress_event_conflict");
        insertEventJobBinding(this.db,event.event_id,binding);
        this.db.prepare("UPDATE worker_progress_applications SET followup_event_id=?,next_check_at=NULL WHERE decision_key=? AND followup_event_id IS NULL").run(event.event_id,row.decision_key);count++;
      }
      return count;
    }).immediate();
  }

  instructionReceipts(jobId:string,sourceEventId:string){
    const job=this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId) as JobRow|undefined;
    if(!job)throw Error("job_not_found");this.assertAuthorized(job,sourceEventId);
    const rows=this.db.prepare(`SELECT m.message_id,m.idempotency_key,m.payload_sha256,m.producer_sequence,d.state FROM worker_messages m JOIN worker_message_deliveries d USING(message_id)
      WHERE m.job_id=? AND m.direction='dona_to_worker' AND d.consumer='worker' ORDER BY m.producer_sequence DESC LIMIT 20`).all(jobId);
    const next=(this.db.prepare("SELECT COALESCE(MAX(producer_sequence),0)+1 n FROM worker_messages WHERE job_id=? AND producer='dona-main'").get(jobId) as {n:number}).n;
    return {instructions:rows,next_producer_sequence:next};
  }
  eventReport(jobId:string,eventId:string){
    if(this.ownsProgressAggregateEvent(jobId,eventId)){
      const job=this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId) as JobRow;this.assertAuthorized(job,eventId);
      if(terminal(job.status))return undefined;
      const id=(JSON.parse((this.db.prepare("SELECT payload_json FROM events WHERE event_id=?").get(eventId) as {payload_json:string}).payload_json) as {message_id:string}).message_id;
      const message=this.getMessageRequired(id);return {...this.project(message),payload:JSON.parse(message.payload_json)};
    }
    if(!this.ownsReportEvent(jobId,eventId))return undefined;
    const event=this.db.prepare("SELECT payload_json FROM events WHERE event_id=?").get(eventId) as {payload_json:string};
    const messageId=(JSON.parse(event.payload_json) as {message_id:string}).message_id;
    const message=this.getMessage(jobId,messageId,eventId);
    return message?{...this.project(message),payload:JSON.parse(message.payload_json)}:undefined;
  }
  hasPendingInstructions(jobId:string):boolean {
    return !!this.db.prepare(`SELECT 1 FROM worker_messages m JOIN worker_message_deliveries d USING(message_id)
      WHERE m.job_id=? AND m.direction='dona_to_worker' AND d.consumer='worker' AND d.state IN ('pending','leased') LIMIT 1`).get(jobId);
  }

  reports(jobId:string,sourceEventId:string){
    const job=this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId) as JobRow|undefined;
    if(!job)throw Error("job_not_found");this.assertAuthorized(job,sourceEventId);
    return (this.db.prepare("SELECT * FROM worker_messages WHERE job_id=? AND direction='worker_to_dona' ORDER BY producer_sequence DESC LIMIT 20").all(jobId) as WorkerMessageRow[]).map(row=>({...this.project(row),payload:JSON.parse(row.payload_json)}));
  }
  ownsProgressAggregateEvent(jobId:string,eventId:string):boolean {
    return !!this.db.prepare(`SELECT 1 FROM worker_progress_applications a JOIN worker_progress_decisions p USING(decision_key)
      JOIN events e ON e.event_id=a.followup_event_id JOIN jobs j ON j.job_id=p.job_id JOIN worker_messages m ON m.message_id=json_extract(e.payload_json,'$.message_id')
      WHERE p.job_id=? AND e.event_id=? AND e.source='dona_message' AND e.event_type='worker_message_aggregate'
        AND e.external_event_id='progress-aggregate:'||a.decision_key||CASE WHEN a.followup_generation>0 THEN ':'||a.followup_generation ELSE '' END AND m.job_id=p.job_id AND m.direction='worker_to_dona'
        AND json_extract(e.subject_json,'$.job_id')=p.job_id AND json_extract(e.subject_json,'$.source_event_id')=j.source_event_id
        AND json_extract(e.payload_json,'$.job_id')=p.job_id AND json_extract(e.payload_json,'$.source_event_id')=j.source_event_id`).get(jobId,eventId);
  }

  ownsMessageEvent(jobId:string,eventId:string):boolean {
    if(this.ownsReportEvent(jobId,eventId)||this.ownsProgressAggregateEvent(jobId,eventId))return true;
    return !!this.db.prepare(`SELECT 1 FROM events e JOIN jobs j ON j.job_id=? JOIN worker_message_cadence c USING(job_id)
      WHERE e.event_id=? AND e.source='dona_message' AND e.event_type='worker_message_silence'
      AND e.external_event_id='worker-message-silence:'||j.job_id||':'||c.generation
      AND json_extract(e.payload_json,'$.job_id')=j.job_id AND json_extract(e.payload_json,'$.source_event_id')=j.source_event_id
      AND json_extract(e.payload_json,'$.generation')=c.generation AND json_extract(e.subject_json,'$.job_id')=j.job_id
      AND json_extract(e.subject_json,'$.source_event_id')=j.source_event_id
      AND j.status IN ('running','blocked') AND NOT(j.status='blocked' AND j.last_error_code='worker_message_question_pending')`).get(jobId,eventId);
  }

  ownsReportEvent(jobId:string,eventId:string):boolean {
    return !!this.db.prepare(`SELECT 1 FROM worker_message_deliveries d JOIN worker_messages m USING(message_id) JOIN events e ON e.event_id=d.event_id
      WHERE m.job_id=? AND e.event_id=? AND e.source='dona_message' AND e.event_type='worker_message_report'
      AND m.direction='worker_to_dona' AND json_extract(e.subject_json,'$.message_id')=m.message_id
      AND json_extract(e.subject_json,'$.source_event_id')=m.source_event_id
      AND json_extract(e.subject_json,'$.job_id')=m.job_id AND json_extract(e.payload_json,'$.job_id')=m.job_id AND json_extract(e.payload_json,'$.message_id')=m.message_id`).get(jobId,eventId);
  }
  appendInstruction(jobId: string, raw: unknown, at = new Date()) {
    const input=parseDonaInstruction(raw);
    const event=this.db.prepare("SELECT source FROM events WHERE event_id=?").get(input.source_event_id) as {source:string}|undefined;
    const localAnswer=event?.source==="web"&&input.payload.operation==="answer"&&!!this.db.prepare(`SELECT 1 FROM events e JOIN local_dashboard_command_receipts r ON r.event_id=e.event_id
      WHERE e.event_id=? AND e.event_type='local_typed_question_reply' AND r.operation='question_reply' AND r.attempt_id=?
      AND json_extract(e.payload_json,'$.message_id')=?`).get(input.source_event_id,jobId,input.correlation_message_id);
    if(event?.source!=="slack"&&!localAnswer&&!(event?.source==="dona_message"&&input.payload.operation==="answer"&&(this.ownsReportEvent(jobId,input.source_event_id)||this.ownsProgressAggregateEvent(jobId,input.source_event_id))&&input.correlation_message_id===(JSON.parse((this.db.prepare("SELECT subject_json FROM events WHERE event_id=?").get(input.source_event_id) as {subject_json:string}).subject_json).message_id)))throw new WorkerMessageError("worker_message_instruction_source_invalid","worker instructions require a Slack source event");
    return this.append(jobId, "dona_to_worker", input, at);
  }

  private append(jobId: string, direction: WorkerMessageDirection, input: WorkerMessageInput, at: Date): { message: WorkerMessageRow; receipt_id: string; outcome: "created" | "reused" } {
    const job = this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId) as JobRow | undefined;
    if (!job) throw new WorkerMessageError("job_not_found", "job does not exist");
    this.assertAuthorized(job, input.source_event_id);
    const producer = direction === "worker_to_dona" ? "worker" : "dona-main";
    const kind = direction === "worker_to_dona" ? reportKind(input as WorkerReportInput) : instructionKind(input as DonaInstructionInput);
    const payloadJson = stableStringify(input.payload);
    if(direction==="worker_to_dona"&&credentialShaped.test(payloadJson))throw new WorkerMessageError("worker_report_payload_denied","report contains credential-shaped data");
    const payloadSha = sha256(payloadJson);
    const acceptedAt = at.toISOString();
    const keyExisting = this.db.prepare("SELECT * FROM worker_messages WHERE job_id=? AND producer=? AND idempotency_key=?")
      .get(jobId, producer, input.idempotency_key) as WorkerMessageRow | undefined;
    if (keyExisting) {
      if (keyExisting.payload_sha256 !== payloadSha || keyExisting.producer_sequence !== input.producer_sequence
        || keyExisting.occurred_at !== input.occurred_at || keyExisting.source_event_id !== input.source_event_id
        || keyExisting.correlation_message_id !== (input.correlation_message_id ?? null)
        || keyExisting.conversation_revision !== (input.conversation_revision ?? null)) {
        throw new WorkerMessageError("worker_message_idempotency_conflict", "idempotency key already has a different canonical message");
      }
      const receipt = this.db.prepare("SELECT receipt_id FROM worker_message_receipts WHERE message_id=? AND receipt_kind='accepted' AND consumer='dispatcher'")
        .get(keyExisting.message_id) as { receipt_id: string };
      return { message: keyExisting, receipt_id: receipt.receipt_id, outcome: "reused" };
    }
    if (terminal(job.status)) throw new WorkerMessageError("worker_message_terminal_fence", "new messages are rejected after terminal job state");
    if(direction==="dona_to_worker"&&!["queued","retryable_failed","preparing","dispatching","running","blocked"].includes(job.status))
      throw new WorkerMessageError("worker_message_instruction_unavailable",`job in status ${job.status} cannot accept instructions`);
    if(direction==="worker_to_dona"&&["question","decision_request"].includes(kind)
      &&!["queued","retryable_failed","running","blocked"].includes(job.status))
      throw new WorkerMessageError("worker_message_report_unavailable",`job in status ${job.status} cannot accept a question report`);
    if(direction==="worker_to_dona") {
      const reportCount=this.db.prepare("SELECT COUNT(*) AS count FROM worker_messages WHERE job_id=? AND direction='worker_to_dona'")
        .get(jobId) as {count:number};
      if(reportCount.count>=workerReportMaxPerJob)
        throw new WorkerMessageError("worker_message_report_limit_exceeded",`worker report limit of ${workerReportMaxPerJob} has been reached`);
      if(["question","decision_request"].includes(kind)) {
        if(job.status==="blocked"&&job.last_error_code!=="worker_message_question_pending")throw new WorkerMessageError("worker_message_existing_block","existing worker wait must be resolved before a typed question");
        const pending=this.db.prepare(`SELECT 1 FROM worker_messages question
          JOIN worker_message_deliveries question_delivery ON question_delivery.message_id=question.message_id
          WHERE question.job_id=? AND question.direction='worker_to_dona' AND question.kind IN ('question','decision_request')
            AND question_delivery.consumer='dona-main' AND question_delivery.state!='superseded'
            AND NOT EXISTS (SELECT 1 FROM worker_messages answer
              JOIN worker_message_deliveries answer_delivery ON answer_delivery.message_id=answer.message_id
              WHERE answer.job_id=question.job_id AND answer.direction='dona_to_worker' AND answer.kind='answer'
                AND answer.correlation_message_id=question.message_id AND answer_delivery.consumer='worker'
                AND answer_delivery.state='delivered') LIMIT 1`).get(jobId);
        if(pending)throw new WorkerMessageError("worker_message_question_pending","job already has an unanswered question");
      }
    }
    if(direction==="dona_to_worker"){
      const count=this.db.prepare("SELECT COUNT(*) count FROM worker_messages WHERE job_id=? AND direction='dona_to_worker'").get(jobId) as {count:number};
      if(count.count>=256)throw new WorkerMessageError("worker_message_instruction_limit_exceeded","instruction handoff count limit of 256 has been reached");
    }
    let correlated:WorkerMessageRow|undefined;
    if (input.correlation_message_id) {
      correlated = this.db.prepare("SELECT * FROM worker_messages WHERE message_id=?").get(input.correlation_message_id) as WorkerMessageRow | undefined;
      if (!correlated || correlated.job_id !== jobId) throw new WorkerMessageError("worker_message_correlation_mismatch", "correlated message is not bound to this job");
    }
    if (direction === "dona_to_worker" && instructionKind(input as DonaInstructionInput) === "answer") {
      if (!correlated || correlated.direction !== "worker_to_dona" || !["question","decision_request"].includes(correlated.kind))
        throw new WorkerMessageError("worker_message_answer_target_invalid", "answer must correlate to a worker question or decision request");
      const expectedRevision=(correlated.conversation_revision ?? 0)+1;
      if (input.conversation_revision !== expectedRevision)
        throw new WorkerMessageError("worker_message_answer_revision_mismatch", `answer revision must be ${expectedRevision}`);
      const answered=this.db.prepare(`SELECT 1 FROM worker_messages answer JOIN worker_message_deliveries delivery ON delivery.message_id=answer.message_id
        WHERE answer.job_id=? AND answer.direction='dona_to_worker' AND answer.kind='answer'
          AND answer.correlation_message_id=? AND delivery.consumer='worker' AND delivery.state!='superseded'`).get(jobId,correlated.message_id);
      if(answered)throw new WorkerMessageError("worker_message_answer_already_exists","correlated question already has an answer");
    }
    const max = this.db.prepare("SELECT MAX(producer_sequence) AS value FROM worker_messages WHERE job_id=? AND producer=?")
      .get(jobId, producer) as { value: number | null };
    const expected = (max.value ?? 0) + 1;
    if (input.producer_sequence < expected) throw new WorkerMessageError("worker_message_sequence_rollback", `expected producer sequence ${expected}`);
    if (input.producer_sequence > expected) throw new WorkerMessageError("worker_message_sequence_gap", `expected producer sequence ${expected}`);

    return this.db.transaction(() => {
      const messageId = `msg_${ulid(at.getTime()).toLowerCase()}`;
      const receiptId = `rcpt_${ulid(at.getTime()).toLowerCase()}`;
      const deliveryId = `dlv_${ulid(at.getTime()).toLowerCase()}`;
      if(direction==="worker_to_dona"&&["question","decision_request"].includes(kind)){
        const pendingContext=stableStringify({message_id:messageId,kind,payload:input.payload});
        if([...job.objective,...this.stoppedInstructionContext(jobId),...pendingContext].length>jobObjectiveCharacterMax-1024)
          throw new WorkerMessageError("worker_message_question_handoff_limit","question handoff objective limit exceeded");
      }
      if(direction==="dona_to_worker"&&!["queued","retryable_failed"].includes(job.status)) {
        const addition=stableStringify({message_id:messageId,kind,payload:input.payload,
          correlation_message_id:input.correlation_message_id??null,conversation_revision:input.conversation_revision??null,state:"pending",attempt_count:0,
          ...(kind==="answer"&&correlated?{correlated_report:{kind:correlated.kind,payload:JSON.parse(correlated.payload_json)}}:{})});
        if([...job.objective,...this.stoppedInstructionContext(jobId),...addition].length>90_000)
          throw new WorkerMessageError("worker_message_instruction_unavailable","instruction handoff character limit exceeded");
      }
      if(direction==="dona_to_worker"&&["queued","retryable_failed"].includes(job.status)){
        const typed=typedInstructionText(messageId,kind,input.payload,input.correlation_message_id??null,input.conversation_revision??null);
        const addition=`\n\n[DONA_FOLLOW_UP]\n${typed}\n[/DONA_FOLLOW_UP]`;
        const reservations=this.queuedInstructionReservations(job.source_event_id);
        const own=reservations.filter(row=>row.job_id===jobId).map(row=>row.addition).join("");
        if([...job.objective,...own,...addition].length>jobObjectiveCharacterMax)
          throw new WorkerMessageError("worker_message_instruction_unavailable","effective job objective character limit exceeded");
        const siblings=this.db.prepare("SELECT objective FROM jobs WHERE source_event_id=?").all(job.source_event_id) as Array<{objective:string}>;
        const current=siblings.reduce((sum,sibling)=>sum+Buffer.byteLength(sibling.objective,"utf8"),0)
          +reservations.reduce((sum,row)=>sum+Buffer.byteLength(row.addition,"utf8"),0);
        if(current+Buffer.byteLength(addition,"utf8")>this.jobObjectiveTotalMaxBytes)
          throw new WorkerMessageError("worker_message_instruction_unavailable","effective job group objective byte limit exceeded");
      }
      if(direction==="worker_to_dona"&&["question","decision_request"].includes(kind)&&job.status==="blocked"){
        if(job.completion_event_id){
          const attention=this.db.prepare("SELECT status FROM events WHERE event_id=?").get(job.completion_event_id) as {status:string}|undefined;
          if(!attention)throw new WorkerMessageError("worker_message_attention_conflict","blocked attention event is missing");
          if(["dispatching","waiting_agent","blocked","needs_review"].includes(attention.status))
            throw new WorkerMessageError("worker_message_attention_conflict","blocked attention delivery is uncertain");
          if(["queued","retryable_failed"].includes(attention.status)){
            const siblingAttention=this.db.prepare(`SELECT 1 FROM jobs WHERE source_event_id=? AND job_id!=?
              AND status IN ('blocked','failed','needs_review') LIMIT 1`).get(job.source_event_id,jobId);
            if(siblingAttention)throw new WorkerMessageError("worker_message_attention_conflict","group attention includes another job");
            this.db.prepare(`UPDATE events SET status='completed',completed_at=?,updated_at=?,
              last_error_code='worker_message_question_superseded',last_error_message=NULL WHERE event_id=? AND status IN ('queued','retryable_failed')`)
              .run(acceptedAt,acceptedAt,job.completion_event_id);
            this.db.prepare("UPDATE job_groups SET attention_event_id=NULL,updated_at=? WHERE source_event_id=? AND attention_event_id=?")
              .run(acceptedAt,job.source_event_id,job.completion_event_id);
            this.db.prepare("UPDATE jobs SET completion_event_id=NULL,updated_at=? WHERE job_id=? AND completion_event_id=?")
              .run(acceptedAt,jobId,job.completion_event_id);
            this.db.prepare("UPDATE job_completion_results SET notification_state='none' WHERE notification_event_id=? AND notification_state='pending'")
              .run(job.completion_event_id);
          }
          if(["completed","dead_letter"].includes(attention.status)){
            this.db.prepare("UPDATE job_groups SET attention_event_id=NULL,updated_at=? WHERE source_event_id=? AND attention_event_id=?")
              .run(acceptedAt,job.source_event_id,job.completion_event_id);
            this.db.prepare("UPDATE jobs SET completion_event_id=NULL,updated_at=? WHERE job_id=? AND completion_event_id=?")
              .run(acceptedAt,jobId,job.completion_event_id);
          }
        }
        this.db.prepare(`UPDATE jobs SET last_error_code='worker_message_question_pending',
          last_error_message='Background worker is waiting for an answer',updated_at=? WHERE job_id=? AND status='blocked'`)
          .run(acceptedAt,jobId);
      }
      this.db.prepare(`INSERT INTO worker_messages(message_id,schema_version,job_id,source_event_id,workspace_id,channel_id,thread_ts,direction,kind,producer,producer_sequence,idempotency_key,payload_json,payload_sha256,correlation_message_id,conversation_revision,occurred_at,accepted_at)
        VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(messageId, jobId, input.source_event_id, job.workspace_id, job.channel_id, job.thread_ts,
        direction, kind, producer, input.producer_sequence, input.idempotency_key, payloadJson, payloadSha,
        input.correlation_message_id ?? null, input.conversation_revision ?? null, input.occurred_at, acceptedAt);
      this.db.prepare("INSERT INTO worker_message_receipts(receipt_id,message_id,delivery_id,receipt_kind,consumer,created_at) VALUES(?,?,NULL,'accepted','dispatcher',?)")
        .run(receiptId, messageId, acceptedAt);

      let availableAt = acceptedAt;
      if (direction === "worker_to_dona") {
        this.db.prepare("INSERT INTO worker_message_activity VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET activity_at=excluded.activity_at").run(jobId,acceptedAt);
        const silencePrefix=`worker-message-silence:${jobId}:`;
        this.db.prepare(`UPDATE events SET status='completed',completed_at=?,updated_at=?,
          last_error_code='worker_message_silence_superseded',last_error_message=NULL
          WHERE source='dona_message' AND event_type='worker_message_silence'
            AND substr(external_event_id,1,length(?))=?
            AND status IN ('queued','retryable_failed')`)
          .run(acceptedAt,acceptedAt,silencePrefix,silencePrefix);
        const cadence = this.db.prepare("SELECT * FROM worker_message_cadence WHERE job_id=?").get(jobId) as { minimum_interval_ms:number;silence_interval_ms:number;last_delivery_at:string|null;pending_message_id:string|null } | undefined;
        const workspaceCadence=job.workspace_id?this.db.prepare("SELECT * FROM worker_message_workspace_cadence WHERE workspace_id=?").get(job.workspace_id) as
          {minimum_interval_ms:number;last_delivery_at:string|null}|undefined:undefined;
        const minimum = cadence?.minimum_interval_ms ?? 60_000;
        const report = input as WorkerReportInput;
        const urgent = kind === "question" || kind === "decision_request" || (report.payload.kind === "risk" && report.payload.severity === "high");
        if (!urgent && cadence?.last_delivery_at) availableAt = new Date(Math.max(at.getTime(), Date.parse(cadence.last_delivery_at) + minimum)).toISOString();
        if (!urgent && workspaceCadence?.last_delivery_at) availableAt = new Date(Math.max(Date.parse(availableAt),
          Date.parse(workspaceCadence.last_delivery_at)+workspaceCadence.minimum_interval_ms)).toISOString();
        this.db.prepare(`UPDATE worker_message_deliveries SET state='superseded',updated_at=?
          WHERE consumer='dona-main' AND state='pending' AND message_id IN
          (SELECT message_id FROM worker_messages WHERE job_id=? AND direction='worker_to_dona'
            AND (kind='checkpoint' OR (kind='risk' AND json_extract(payload_json,'$.severity')!='high')))`)
          .run(acceptedAt,jobId);
        const silenceInterval = cadence?.silence_interval_ms ?? 900_000;
        this.db.prepare(`INSERT INTO worker_message_cadence(job_id,last_report_at,silence_due_at,pending_message_id,generation,updated_at)
          VALUES(?,?,?,?,1,?) ON CONFLICT(job_id) DO UPDATE SET last_report_at=excluded.last_report_at,silence_due_at=excluded.silence_due_at,
          pending_message_id=excluded.pending_message_id,
          generation=worker_message_cadence.generation+1,updated_at=excluded.updated_at`)
          .run(jobId, acceptedAt, new Date(at.getTime() + silenceInterval).toISOString(), urgent ? null : messageId, acceptedAt);
      }
      const consumer = direction === "worker_to_dona" ? "dona-main" : "worker";
      this.db.prepare(`INSERT INTO worker_message_deliveries(delivery_id,message_id,consumer,state,available_at,lease_owner,lease_token_sha256,lease_expires_at,fence,attempt_count,delivered_at,created_at,updated_at)
        VALUES(?,?,?,'pending',?,NULL,NULL,NULL,0,0,NULL,?,?)`).run(deliveryId, messageId, consumer, availableAt, acceptedAt, acceptedAt);
      if(direction==="worker_to_dona"&&["question","decision_request"].includes(kind)&&job.status==="running"){
        const changed=this.db.prepare(`UPDATE jobs SET status='blocked',last_error_code='worker_message_question_pending',
          last_error_message='Background worker is waiting for an answer',updated_at=? WHERE job_id=? AND status='running'`)
          .run(acceptedAt,jobId).changes;
        if(changed!==1)throw new WorkerMessageError("worker_message_job_state_changed","job state changed while accepting the question report");
      }
      return { message: this.getMessageRequired(messageId), receipt_id: receiptId, outcome: "created" as const };
    }).immediate();
  }

  getMessage(jobId: string, messageId: string, sourceEventId: string): WorkerMessageRow | undefined {
    const job=this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId) as JobRow|undefined;
    if(!job)return undefined;
    this.assertAuthorized(job,sourceEventId);
    const message=this.db.prepare("SELECT * FROM worker_messages WHERE job_id=? AND message_id=?")
      .get(jobId, messageId) as WorkerMessageRow | undefined;
    if(message?.direction==="worker_to_dona"){
      const delivery=this.db.prepare("SELECT event_id FROM worker_message_deliveries WHERE message_id=? AND consumer='dona-main'")
        .get(messageId) as {event_id:string|null}|undefined;
      if(!delivery?.event_id||delivery.event_id!==sourceEventId)
        throw new WorkerMessageError("job_binding_mismatch","source event is not the notification event for this message");
      if(terminal(job.status))
        throw new WorkerMessageError("worker_message_terminal_fence","worker report is stale after terminal job state");
      if(["question","decision_request"].includes(message.kind)
        &&!["queued","retryable_failed","running","blocked"].includes(job.status))
        throw new WorkerMessageError("worker_message_report_unavailable","question can no longer receive an answer");
    }
    return message;
  }

  pendingQuestion(jobId: string) {
    const rows=this.db.prepare(`SELECT m.message_id,m.kind,m.payload_json,
        COALESCE((SELECT MAX(next.producer_sequence) FROM worker_messages next WHERE next.job_id=m.job_id AND next.producer='dona-main'),0)+1 AS next_producer_sequence,
        COALESCE(m.conversation_revision,0)+1 AS next_conversation_revision
      FROM worker_messages m JOIN worker_message_deliveries d ON d.message_id=m.message_id JOIN jobs j ON j.job_id=m.job_id
      WHERE m.job_id=? AND m.direction='worker_to_dona' AND m.kind IN ('question','decision_request') AND d.consumer='dona-main'
        AND d.state='delivered' AND j.status IN ('running','blocked')
        AND NOT EXISTS (SELECT 1 FROM worker_messages answer JOIN worker_message_deliveries answer_delivery ON answer_delivery.message_id=answer.message_id
          WHERE answer.job_id=m.job_id AND answer.direction='dona_to_worker' AND answer.kind='answer'
            AND answer.correlation_message_id=m.message_id AND answer_delivery.consumer='worker' AND answer_delivery.state!='superseded')
      ORDER BY m.producer_sequence DESC,m.message_id DESC LIMIT 4`).all(jobId) as Array<
        {message_id:string;kind:"question"|"decision_request";payload_json:string;next_producer_sequence:number;next_conversation_revision:number}>;
    if(rows.length>1)return {ambiguous:true,pending_count_at_least:rows.length,candidates:rows.map(({payload_json,...row})=>({
      ...row,question:(JSON.parse(payload_json) as {question:string}).question,
    }))};
    const row=rows[0];
    return row ? {ambiguous:false,message_id:row.message_id,kind:row.kind,next_producer_sequence:row.next_producer_sequence,
      next_conversation_revision:row.next_conversation_revision,payload:JSON.parse(row.payload_json)} : undefined;
  }

  stoppedInstructionContext(jobId:string):string {
    const rows=this.db.prepare(`SELECT m.message_id,m.kind,m.payload_json,m.correlation_message_id,m.conversation_revision,d.state,d.attempt_count,
        q.kind AS correlated_kind,q.payload_json AS correlated_payload_json
      FROM worker_messages m JOIN worker_message_deliveries d USING(message_id)
      LEFT JOIN worker_messages q ON q.message_id=m.correlation_message_id AND q.job_id=m.job_id AND m.kind='answer'
      WHERE m.job_id=? AND m.direction='dona_to_worker' AND d.consumer='worker' AND (d.state IN ('pending','leased') OR (d.state='delivered' AND m.kind IN ('answer','add_condition','change_priority'))) ORDER BY m.producer_sequence LIMIT 257`).all(jobId) as Array<Record<string,unknown>>;
    if(rows.length>256)throw Error("worker_instruction_handoff_limit");
    const questions=this.db.prepare(`SELECT q.message_id,q.kind,q.payload_json FROM worker_messages q
      JOIN worker_message_deliveries d ON d.message_id=q.message_id
      WHERE q.job_id=? AND q.direction='worker_to_dona' AND q.kind IN ('question','decision_request')
        AND d.consumer='dona-main' AND d.state!='superseded'
        AND NOT EXISTS(SELECT 1 FROM worker_messages a JOIN worker_message_deliveries ad ON ad.message_id=a.message_id
          WHERE a.correlation_message_id=q.message_id AND a.kind='answer' AND ad.consumer='worker' AND ad.state!='superseded') LIMIT 5`).all(jobId) as Array<{message_id:string;kind:string;payload_json:string}>;
    if(questions.length>4)throw Error("worker_question_handoff_ambiguous");
    const questionContext=questions.length?"\n\n前Attemptの未回答質問（旧IDを回答対象に流用しない）:\n"+stableStringify(questions.map(({payload_json,...q})=>({...q,payload:JSON.parse(payload_json)})))+
      "\n利用者判断は未確定です。必要な質問は新Attemptで新しいmessage_idへ再報告し、親Donaに既存の会話・回答を照合してもらってください。旧質問を承認や新しい実行権限として扱わないでください。":"";
    if(!rows.length)return questionContext;
    return "\n\n前Attemptで受理済みの追加指示（同じ依頼・権限の範囲を維持）:\n"+stableStringify(rows.map(({payload_json,correlated_kind,correlated_payload_json,...row})=>({...row,payload:JSON.parse(payload_json as string),...(correlated_payload_json?{correlated_report:{kind:correlated_kind,payload:JSON.parse(correlated_payload_json as string)}}:{})})))+
      "\ndeliveredは配送済みの条件として維持し、同じ外部操作を再送しない。未配送でattempt_count=0は未投入として残作業へ引き継ぐ。未配送でattempt_count>0は受理不明なので、既存成果・操作を照合するまで同じ指示や外部操作を再実行しない。相関IDは前Attemptの証拠であり新Attemptのanswer対象として流用しない。"+questionContext;
  }

  supersedeUndeliveredInstructions(jobId:string,at=new Date().toISOString()):number {
    return this.db.prepare(`UPDATE worker_message_deliveries SET state='superseded',lease_owner=NULL,lease_token_sha256=NULL,
      lease_expires_at=NULL,updated_at=? WHERE consumer='worker' AND state IN ('pending','leased')
      AND message_id IN (SELECT message_id FROM worker_messages WHERE job_id=? AND direction='dona_to_worker')`).run(at,jobId).changes;
  }

  reconcile(jobId: string, sourceEventId: string, producer: "worker" | "dona-main", idempotencyKey: string) {
    const job = this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId) as JobRow | undefined;
    if (!job) throw new WorkerMessageError("job_not_found", "job does not exist");
    this.assertAuthorized(job,sourceEventId);
    const message = this.db.prepare("SELECT * FROM worker_messages WHERE job_id=? AND producer=? AND idempotency_key=?")
      .get(jobId, producer, idempotencyKey) as WorkerMessageRow | undefined;
    if (!message) return { reconciliation: "not_found" as const };
    const receipt = this.db.prepare("SELECT receipt_id,receipt_kind,consumer,created_at FROM worker_message_receipts WHERE message_id=? ORDER BY created_at")
      .all(message.message_id);
    const delivery = this.db.prepare("SELECT delivery_id,consumer,state,available_at,fence,attempt_count,delivered_at FROM worker_message_deliveries WHERE message_id=?")
      .get(message.message_id);
    return { reconciliation: "matched" as const, message: this.project(message), receipts: receipt, delivery };
  }

  claim(jobId: string, sourceEventId: string, consumer: "dona-main" | "worker", leaseOwner: string, limit: number, leaseMs: number, at = new Date()) {
    if (!identifier.safeParse(leaseOwner).success) throw new WorkerMessageError("invalid_lease_owner", "lease owner is invalid");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new WorkerMessageError("invalid_claim_limit", "claim limit must be between 1 and 100");
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > workerMessageLeaseMaxMs) throw new WorkerMessageError("invalid_lease_duration", "lease duration is invalid");
    const job = this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId) as JobRow|undefined;
    if (!job) throw new WorkerMessageError("job_not_found", "job does not exist");
    this.assertAuthorized(job,sourceEventId);
    return this.db.transaction(() => {
      const now = at.toISOString();
      if(consumer==="worker"&&["runtime_question_pending","runtime_external_approval_pending"].includes(job.last_error_code??""))return [];
      if(consumer==="worker"&&this.db.prepare("SELECT 1 FROM task_attempts a JOIN tasks t USING(task_id) WHERE a.attempt_id=? AND (t.current_attempt_id<>a.attempt_id OR t.desired_state<>'running')").get(jobId))return [];
      this.db.prepare(`UPDATE worker_message_deliveries SET state='pending',lease_owner=NULL,lease_token_sha256=NULL,lease_expires_at=NULL,updated_at=?
        WHERE consumer=? AND state='leased' AND lease_expires_at<=?`).run(now, consumer, now);
      const candidates = this.db.prepare(`SELECT d.delivery_id FROM worker_message_deliveries d JOIN worker_messages m USING(message_id)
        WHERE m.job_id=? AND d.consumer=? AND d.state='pending' AND d.available_at<=?
          AND NOT EXISTS (
            SELECT 1 FROM worker_messages prior JOIN worker_message_deliveries prior_delivery USING(message_id)
            WHERE prior.job_id=m.job_id AND prior.producer=m.producer AND prior.producer_sequence<m.producer_sequence
              AND prior_delivery.consumer=d.consumer AND prior_delivery.state IN ('pending','leased')
          )
        ORDER BY m.producer_sequence,d.available_at,d.created_at,d.delivery_id LIMIT ?`).all(jobId, consumer, now, limit) as Array<{delivery_id:string}>;
      return candidates.map(({ delivery_id }) => {
        const token = `lease_${ulid(at.getTime()).toLowerCase()}_${randomBytes(16).toString("hex")}`;
        const expires = new Date(at.getTime() + leaseMs).toISOString();
        const changed = this.db.prepare(`UPDATE worker_message_deliveries SET state='leased',lease_owner=?,lease_token_sha256=?,lease_expires_at=?,fence=fence+1,attempt_count=attempt_count+1,updated_at=?
          WHERE delivery_id=? AND state='pending'`).run(leaseOwner, sha256(token), expires, now, delivery_id).changes;
        if (changed !== 1) throw new WorkerMessageError("delivery_claim_conflict", "delivery was concurrently claimed");
        const row = this.db.prepare(`SELECT d.*,m.job_id,m.source_event_id,m.kind,m.direction,m.producer_sequence,m.correlation_message_id,m.conversation_revision,m.occurred_at,m.payload_json
          FROM worker_message_deliveries d JOIN worker_messages m USING(message_id) WHERE d.delivery_id=?`).get(delivery_id) as WorkerMessageDeliveryRow & WorkerMessageRow;
        const {payload_json,...projected}=row;
        return { delivery: {...projected,payload:JSON.parse(payload_json)}, lease_token: token };
      });
    }).immediate();
  }

  claimWorker(jobId:string,sourceEventId:string,runtimeIdentity:string,leaseOwner:string,limit:number,leaseMs:number,at=new Date()) {
    this.assertWorkerRuntime(jobId,runtimeIdentity);
    return this.claim(jobId,sourceEventId,"worker",leaseOwner,limit,leaseMs,at);
  }

  claimNextWorkerInstruction(leaseOwner:string,leaseMs:number,at=new Date()) {
    const now=at.toISOString();
    this.db.prepare(`UPDATE worker_message_deliveries SET state='pending',lease_owner=NULL,lease_token_sha256=NULL,
      lease_expires_at=NULL,updated_at=? WHERE consumer='worker' AND state='leased' AND lease_expires_at<=?`).run(now,now);
    const candidate=this.db.prepare(`SELECT m.job_id,m.source_event_id FROM worker_message_deliveries d
      JOIN worker_messages m USING(message_id) JOIN jobs j USING(job_id)
      WHERE d.consumer='worker' AND d.state='pending' AND d.available_at<=?
        AND j.status IN ('running','blocked')
        AND COALESCE(j.last_error_code,'') NOT IN ('runtime_question_pending','runtime_external_approval_pending')
        AND NOT EXISTS (SELECT 1 FROM task_attempts a JOIN tasks t USING(task_id) WHERE a.attempt_id=j.job_id AND (t.current_attempt_id<>j.job_id OR t.desired_state<>'running'))
        AND NOT EXISTS (
          SELECT 1 FROM worker_messages prior JOIN worker_message_deliveries prior_delivery USING(message_id)
          WHERE prior.job_id=m.job_id AND prior.producer=m.producer AND prior.producer_sequence<m.producer_sequence
            AND prior_delivery.consumer=d.consumer AND prior_delivery.state IN ('pending','leased')
        )
      ORDER BY d.available_at,d.created_at,m.job_id,m.producer_sequence,d.delivery_id LIMIT 1`)
      .get(now) as {job_id:string;source_event_id:string}|undefined;
    return candidate ? this.claim(candidate.job_id,candidate.source_event_id,"worker",leaseOwner,1,leaseMs,at)[0] : undefined;
  }

  releaseUnsent(deliveryId:string,leaseOwner:string,leaseToken:string,fence:number,at=new Date()):void {
    const changed=this.db.prepare(`UPDATE worker_message_deliveries SET state='pending',lease_owner=NULL,
      lease_token_sha256=NULL,lease_expires_at=NULL,updated_at=? WHERE delivery_id=? AND state='leased'
      AND lease_owner=? AND lease_token_sha256=? AND fence=? AND lease_expires_at>?`)
      .run(at.toISOString(),deliveryId,leaseOwner,sha256(leaseToken),fence,at.toISOString()).changes;
    if(!changed)throw new WorkerMessageError("delivery_fence_mismatch","unsent release requires current lease proof");
  }

  acknowledge(jobId: string, sourceEventId: string, deliveryId: string, leaseOwner: string, leaseToken: string, fence: number, at = new Date()) {
    return this.db.transaction(() => {
      const now = at.toISOString();
      const row = this.db.prepare("SELECT * FROM worker_message_deliveries WHERE delivery_id=?")
        .get(deliveryId) as WorkerMessageDeliveryRow | undefined;
      if (!row) throw new WorkerMessageError("delivery_not_found", "delivery does not exist");
      const bound = this.db.prepare("SELECT job_id,source_event_id FROM worker_messages WHERE message_id=?").get(row.message_id) as {job_id:string;source_event_id:string}|undefined;
      const job=this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId) as JobRow|undefined;
      if(!job)throw new WorkerMessageError("job_not_found","job does not exist");
      this.assertAuthorized(job,sourceEventId);
      if (!bound || bound.job_id !== jobId) throw new WorkerMessageError("job_binding_mismatch", "source event does not own this delivery");
      const tokenSha = sha256(leaseToken);
      if (row.state === "delivered") {
        if (row.delivered_lease_owner !== leaseOwner || row.delivered_lease_token_sha256 !== tokenSha || row.delivered_fence !== fence) {
          throw new WorkerMessageError("delivery_fence_mismatch", "delivered receipt does not match the original lease proof");
        }
        return { delivery: row, outcome: "reused" as const };
      }
      if (row.state !== "leased" || row.lease_owner !== leaseOwner || row.lease_token_sha256 !== tokenSha || row.fence !== fence || !row.lease_expires_at || row.lease_expires_at <= now) {
        throw new WorkerMessageError("delivery_fence_mismatch", "delivery lease is not current");
      }
      this.db.prepare(`UPDATE worker_message_deliveries SET state='delivered',delivered_at=?,delivered_lease_owner=?,
        delivered_lease_token_sha256=?,delivered_fence=?,lease_owner=NULL,lease_token_sha256=NULL,lease_expires_at=NULL,updated_at=? WHERE delivery_id=?`)
        .run(now, leaseOwner, tokenSha, fence, now, deliveryId);
      const receiptId = `rcpt_${ulid(at.getTime()).toLowerCase()}`;
      this.db.prepare("INSERT OR IGNORE INTO worker_message_receipts(receipt_id,message_id,delivery_id,receipt_kind,consumer,created_at) VALUES(?,?,?,'delivered',?,?)")
        .run(receiptId, row.message_id, deliveryId, row.consumer, now);
      const message = this.getMessageRequired(row.message_id);
      if (row.consumer === "dona-main") this.db.prepare(`UPDATE worker_message_cadence SET last_delivery_at=?,pending_message_id=CASE WHEN pending_message_id=? THEN NULL ELSE pending_message_id END,updated_at=? WHERE job_id=?`)
        .run(now, row.message_id, now, message.job_id);
      if(row.consumer==="dona-main"&&message.workspace_id)this.recordWorkspaceDelivery(message.workspace_id,now);
      if(row.consumer==="worker") {
        this.db.prepare(`UPDATE jobs SET status='running',last_error_code=NULL,last_error_message=NULL,updated_at=? WHERE job_id=? AND status='blocked' AND ((last_error_code='worker_message_question_pending' AND ?='answer') OR (last_error_code='worker_instruction_acceptance_unknown' AND last_error_message=?))
          AND EXISTS(SELECT 1 FROM tasks WHERE current_attempt_id=jobs.job_id AND desired_state='running')`).run(now,jobId,message.kind,message.message_id);
        const unanswered=this.db.prepare(`SELECT 1 FROM worker_messages q JOIN worker_message_deliveries d USING(message_id)
          WHERE q.job_id=? AND q.direction='worker_to_dona' AND q.kind IN ('question','decision_request')
            AND d.consumer='dona-main' AND d.state!='superseded'
            AND NOT EXISTS (SELECT 1 FROM worker_messages a JOIN worker_message_deliveries ad USING(message_id)
              WHERE a.correlation_message_id=q.message_id AND a.kind='answer' AND ad.consumer='worker' AND ad.state='delivered') LIMIT 1`).get(jobId);
        if(unanswered){
          this.db.prepare("UPDATE jobs SET status='blocked',last_error_code='worker_message_question_pending',last_error_message=NULL,updated_at=? WHERE job_id=? AND status='running'").run(now,jobId);
          this.db.prepare("UPDATE tasks SET state='waiting',wait_reason='human_input',next_check_at=NULL,revision=revision+1,updated_at=? WHERE current_attempt_id=? AND desired_state='running' AND state='waiting'").run(now,jobId);
        }
        this.db.prepare(`UPDATE tasks SET state='active',wait_reason=NULL,next_check_at=NULL,revision=revision+1,
          project_state=CASE WHEN project_state IN ('attempting','unknown') THEN project_state ELSE 'pending' END,updated_at=?
          WHERE current_attempt_id=? AND desired_state='running' AND state='waiting' AND wait_reason IN ('human_input','external_effect_unknown','worker_instruction_delivery_pending')
          AND EXISTS(SELECT 1 FROM jobs WHERE job_id=? AND status='running' AND last_error_code IS NULL)`).run(now,jobId,jobId);
      }
      if(row.consumer==='worker'&&job.status==='blocked'){
        const resumed=this.db.prepare("SELECT status,last_error_code FROM jobs WHERE job_id=?").get(jobId) as {status:string;last_error_code:string|null};
        if(resumed.status==='running'&&resumed.last_error_code===null)this.resetSilenceAfterInput(jobId,at);
      }
      return { delivery: this.db.prepare("SELECT * FROM worker_message_deliveries WHERE delivery_id=?").get(deliveryId), receipt_id: receiptId, outcome: "delivered" as const };
    }).immediate();
  }

  acknowledgeWorker(jobId: string, sourceEventId: string, runtimeIdentity:string, deliveryId: string, leaseOwner: string, leaseToken: string, fence: number, at = new Date()) {
    this.assertWorkerRuntime(jobId,runtimeIdentity);
    const row = this.db.prepare("SELECT consumer FROM worker_message_deliveries WHERE delivery_id=?")
      .get(deliveryId) as {consumer:WorkerMessageDeliveryRow["consumer"]}|undefined;
    if (row && row.consumer !== "worker") throw new WorkerMessageError("delivery_consumer_mismatch", "worker bridge cannot acknowledge this delivery");
    return this.acknowledge(jobId,sourceEventId,deliveryId,leaseOwner,leaseToken,fence,at);
  }

  reconcileWorker(jobId:string,sourceEventId:string,runtimeIdentity:string,idempotencyKey:string) {
    this.assertWorkerReconciliationRuntime(jobId,runtimeIdentity,idempotencyKey);
    return this.reconcile(jobId,sourceEventId,"worker",idempotencyKey);
  }

  operationalSnapshot(at = new Date()) {
    const pending = this.db.prepare("SELECT COUNT(*) AS count FROM worker_message_deliveries WHERE state IN ('pending','leased')").get() as {count:number};
    const overdue = this.db.prepare("SELECT COUNT(*) AS count FROM worker_message_deliveries WHERE state='pending' AND available_at<=?")
      .get(new Date(at.getTime()-workerMessageOverdueGraceMs).toISOString()) as {count:number};
    const expired = this.db.prepare("SELECT COUNT(*) AS count FROM worker_message_deliveries WHERE state='leased' AND lease_expires_at<=?").get(at.toISOString()) as {count:number};
    const dueSilence = this.db.prepare(`SELECT COUNT(*) AS count FROM worker_message_cadence c JOIN jobs j USING(job_id)
      WHERE c.silence_due_at<=? AND j.status NOT IN ('completed','failed','cancelled','needs_review')
        AND NOT (j.status='blocked' AND j.last_error_code IN ('worker_message_question_pending','runtime_question_pending','runtime_external_approval_pending'))`).get(at.toISOString()) as {count:number};
    return { protocol_version: workerMessageProtocolVersion, pending_deliveries: pending.count, overdue_deliveries: overdue.count,
      expired_leases: expired.count, due_silence_deadlines: dueSilence.count, degraded: expired.count > 0 || overdue.count > 0 };
  }

  publishPendingReports(limit = 100, at = new Date()): number {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new WorkerMessageError("invalid_publish_limit", "publish limit must be between 1 and 100");
    return this.db.transaction(() => {
      const now = at.toISOString();
      this.db.prepare(`UPDATE worker_message_deliveries SET state='pending',lease_owner=NULL,lease_token_sha256=NULL,lease_expires_at=NULL,updated_at=?
        WHERE consumer='dona-main' AND state='leased' AND lease_expires_at<=?`).run(now, now);
      this.db.prepare(`UPDATE worker_message_deliveries SET state='superseded',lease_owner=NULL,lease_token_sha256=NULL,
        lease_expires_at=NULL,updated_at=? WHERE consumer='dona-main' AND state IN ('pending','leased') AND message_id IN
        (SELECT m.message_id FROM worker_messages m JOIN jobs j USING(job_id) WHERE j.status IN ('completed','failed','cancelled','needs_review'))`)
        .run(now);
      this.db.prepare(`UPDATE worker_message_cadence SET pending_message_id=NULL,updated_at=? WHERE pending_message_id IN
        (SELECT m.message_id FROM worker_messages m JOIN jobs j USING(job_id) WHERE j.status IN ('completed','failed','cancelled','needs_review'))`)
        .run(now);
      const rows = this.db.prepare(`SELECT d.delivery_id,d.message_id,m.job_id,m.source_event_id,m.workspace_id,m.channel_id,m.thread_ts,m.kind,m.payload_json,m.occurred_at,j.status
        FROM worker_message_deliveries d JOIN worker_messages m USING(message_id) JOIN jobs j USING(job_id)
        WHERE d.consumer='dona-main' AND d.state='pending' AND d.available_at<=?
          AND j.status NOT IN ('completed','failed','cancelled','needs_review')
          AND ((m.workspace_id IS NOT NULL AND m.channel_id IS NOT NULL AND m.thread_ts IS NOT NULL) OR EXISTS(
            SELECT 1 FROM event_job_bindings b JOIN tasks t ON t.current_attempt_id=m.job_id JOIN local_dashboard_command_receipts r ON r.task_id=t.task_id
            WHERE b.event_id=m.source_event_id AND json_extract(b.owner_json,'$.kind')='local_dashboard' AND json_extract(b.destination_json,'$.kind')='none'
              AND r.operation='create' AND r.event_id=m.source_event_id AND r.instance_id=json_extract(b.owner_json,'$.instance_id') AND r.owner_id=json_extract(b.owner_json,'$.owner_id')))
        ORDER BY d.available_at,d.created_at,m.job_id,m.producer_sequence,d.delivery_id LIMIT ?`).all(now, limit) as Array<{
          delivery_id:string;message_id:string;job_id:string;source_event_id:string;workspace_id:string|null;channel_id:string|null;thread_ts:string|null;
          kind:WorkerMessageKind;payload_json:string;occurred_at:string;status:JobRow["status"];
        }>;
      let published = 0;
      for (const row of rows) {
        if (terminal(row.status)||row.status==='needs_review') {
          this.db.prepare("UPDATE worker_message_deliveries SET state='superseded',updated_at=? WHERE delivery_id=? AND state='pending'").run(now,row.delivery_id);
          this.db.prepare("UPDATE worker_message_cadence SET pending_message_id=NULL,updated_at=? WHERE job_id=? AND pending_message_id=?")
            .run(now,row.job_id,row.message_id);
          continue;
        }
        const ownerBinding=readEventJobBinding(this.db,row.source_event_id);
        const local=ownerBinding?.owner.kind==="local_dashboard"&&ownerBinding.destination.kind==="none";
        if ((!row.workspace_id || !row.channel_id || !row.thread_ts)&&!local) continue;
        const report=JSON.parse(row.payload_json) as {severity?:unknown};
        const urgent=row.kind==="question"||row.kind==="decision_request"||(row.kind==="risk"&&report.severity==="high");
        if(!urgent&&row.workspace_id){
          const cadence=this.db.prepare("SELECT minimum_interval_ms,last_delivery_at FROM worker_message_workspace_cadence WHERE workspace_id=?")
            .get(row.workspace_id) as {minimum_interval_ms:number;last_delivery_at:string|null}|undefined;
          if(cadence?.last_delivery_at){
            const availableAt=new Date(Date.parse(cadence.last_delivery_at)+cadence.minimum_interval_ms).toISOString();
            if(availableAt>now){
              this.db.prepare("UPDATE worker_message_deliveries SET available_at=?,updated_at=? WHERE delivery_id=? AND state='pending'")
                .run(availableAt,now,row.delivery_id);
              continue;
            }
          }
        }
        const leaseExpires = new Date(at.getTime()+30_000).toISOString();
        const claimed=this.db.prepare(`UPDATE worker_message_deliveries SET state='leased',lease_owner='dispatcher-worker-message-publisher',lease_token_sha256=?,lease_expires_at=?,fence=fence+1,attempt_count=attempt_count+1,updated_at=?
          WHERE delivery_id=? AND state='pending'`).run(sha256(`${row.delivery_id}:${now}`),leaseExpires,now,row.delivery_id).changes;
        if(claimed!==1)continue;
        const eventId=`evt_${ulid(at.getTime())}`;
        const claimedDelivery=this.db.prepare("SELECT fence FROM worker_message_deliveries WHERE delivery_id=?").get(row.delivery_id) as {fence:number};
        const externalId=`worker-message:${row.message_id}${claimedDelivery.fence===1?"":`:${claimedDelivery.fence}`}`;
        const original=this.db.prepare("SELECT subject_json FROM events WHERE event_id=?").get(row.source_event_id) as {subject_json:string};
        const subject=stableStringify({job_id:row.job_id,message_id:row.message_id,source_event_id:row.source_event_id,actor_id:JSON.parse(original.subject_json).actor_id});
        const task=this.db.prepare("SELECT task_id FROM tasks WHERE current_attempt_id=?").get(row.job_id) as {task_id:string}|undefined;
        const payload=stableStringify({schema_version:1,message_id:row.message_id,job_id:row.job_id,task_id:task?.task_id,source_event_id:row.source_event_id,owner_kind:ownerBinding?.owner.kind,kind:row.kind});
        const replyTarget=row.workspace_id&&row.channel_id&&row.thread_ts?stableStringify({kind:"slack_thread",workspace_id:row.workspace_id,channel_id:row.channel_id,thread_ts:row.thread_ts}):null;
        this.db.prepare(`INSERT OR IGNORE INTO events(event_id,schema_version,source,external_event_id,event_type,occurred_at,subject_json,payload_json,reply_target_json,trace_json,status,available_at,created_at,updated_at)
          VALUES(?,1,'dona_message',?,'worker_message_report',?,?,?,?,?,'queued',?,?,?)`).run(eventId,externalId,row.occurred_at,subject,payload,replyTarget,
          stableStringify({message_id:row.message_id,job_id:row.job_id}),now,now,now);
        const event=this.db.prepare("SELECT event_id,event_type,payload_json FROM events WHERE source='dona_message' AND external_event_id=?")
          .get(externalId) as {event_id:string;event_type:string;payload_json:string};
        if(event.event_type!=="worker_message_report"||event.payload_json!==payload)
          throw new WorkerMessageError("worker_message_event_conflict","internal event identity has a different projection");
        const binding=readEventJobBinding(this.db,row.source_event_id);
        if(binding)insertEventJobBinding(this.db,event.event_id,binding);
        this.db.prepare(`UPDATE worker_message_deliveries SET state='delivered',event_id=?,delivered_at=?,lease_owner=NULL,lease_token_sha256=NULL,lease_expires_at=NULL,updated_at=? WHERE delivery_id=? AND state='leased'`)
          .run(event.event_id,now,now,row.delivery_id);
        this.db.prepare("INSERT OR IGNORE INTO worker_message_receipts(receipt_id,message_id,delivery_id,receipt_kind,consumer,created_at) VALUES(?,?,?,'delivered','dona-main',?)")
          .run(`rcpt_${ulid(at.getTime()).toLowerCase()}`,row.message_id,row.delivery_id,now);
        this.db.prepare("UPDATE worker_message_cadence SET last_delivery_at=?,pending_message_id=CASE WHEN pending_message_id=? THEN NULL ELSE pending_message_id END,updated_at=? WHERE job_id=?")
          .run(now,row.message_id,now,row.job_id);
        if(row.workspace_id)this.recordWorkspaceDelivery(row.workspace_id,now);
        published += 1;
      }
      return published;
    }).immediate();
  }

  resetSilenceAfterInput(jobId:string,at=new Date()):void {
    const now=at.toISOString();
    this.db.prepare("UPDATE worker_message_cadence SET silence_due_at=strftime('%Y-%m-%dT%H:%M:%fZ',?, '+'||(silence_interval_ms/1000)||' seconds'),generation=generation+1,updated_at=? WHERE job_id=?").run(now,now,jobId);
    this.db.prepare("INSERT INTO worker_message_activity VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET activity_at=excluded.activity_at").run(jobId,now);
    this.db.prepare("UPDATE events SET status='completed',completed_at=?,updated_at=?,last_error_code='worker_message_input_resumed' WHERE source='dona_message' AND event_type='worker_message_silence' AND json_extract(payload_json,'$.job_id')=? AND status IN ('queued','retryable_failed')").run(now,now,jobId);
  }

  publishDueSilenceEvents(limit = 100, at = new Date()): number {
    return this.db.transaction(() => {
      const now=at.toISOString();
      const rows=this.db.prepare(`SELECT c.job_id,c.generation,c.silence_interval_ms,j.source_event_id,j.workspace_id,j.channel_id,j.thread_ts
        FROM worker_message_cadence c JOIN jobs j USING(job_id) WHERE c.silence_due_at<=? AND j.status NOT IN ('completed','failed','cancelled','needs_review')
          AND NOT (j.status='blocked' AND j.last_error_code IN ('worker_message_question_pending','runtime_question_pending','runtime_external_approval_pending'))
          AND (NOT EXISTS (SELECT 1 FROM task_attempts a WHERE a.attempt_id=j.job_id) OR EXISTS (SELECT 1 FROM tasks t WHERE t.current_attempt_id=j.job_id AND t.desired_state='running'))
        ORDER BY c.silence_due_at,c.job_id LIMIT ?`).all(now,limit) as Array<{job_id:string;generation:number;silence_interval_ms:number;source_event_id:string;workspace_id:string|null;channel_id:string|null;thread_ts:string|null}>;
      for(const row of rows){
        const task=this.db.prepare("SELECT task_id FROM tasks WHERE current_attempt_id=?").get(row.job_id) as {task_id:string}|undefined;
        const silencePayload={schema_version:1,job_id:row.job_id,source_event_id:row.source_event_id,generation:row.generation,...(task?{task_id:task.task_id}:{})};
        const externalId=`worker-message-silence:${row.job_id}:${row.generation}`;
        const eventId=`evt_${ulid(at.getTime())}`;
        const replyTarget=row.workspace_id&&row.channel_id&&row.thread_ts?stableStringify({kind:"slack_thread",workspace_id:row.workspace_id,channel_id:row.channel_id,thread_ts:row.thread_ts}):null;
        this.db.prepare(`INSERT OR IGNORE INTO events(event_id,schema_version,source,external_event_id,event_type,occurred_at,subject_json,payload_json,reply_target_json,trace_json,status,available_at,created_at,updated_at)
          VALUES(?,1,'dona_message',?,'worker_message_silence',?,?,?,?,?,'queued',?,?,?)`).run(eventId,externalId,now,
          stableStringify({job_id:row.job_id,source_event_id:row.source_event_id,actor_id:(this.db.prepare("SELECT actor_id FROM jobs WHERE job_id=?").get(row.job_id) as {actor_id:string}).actor_id}),stableStringify(silencePayload),replyTarget,
          stableStringify({job_id:row.job_id,generation:row.generation}),now,now,now);
        const expectedPayload=stableStringify(silencePayload);
        const event=this.db.prepare("SELECT event_id,event_type,payload_json FROM events WHERE source='dona_message' AND external_event_id=?")
          .get(externalId) as {event_id:string;event_type:string;payload_json:string};
        if(event.event_type!=="worker_message_silence"||event.payload_json!==expectedPayload)
          throw new WorkerMessageError("worker_message_event_conflict","silence event identity has a different projection");
        const binding=readEventJobBinding(this.db,row.source_event_id);
        if(binding)insertEventJobBinding(this.db,event.event_id,binding);
        this.db.prepare("UPDATE worker_message_cadence SET silence_due_at=NULL,updated_at=? WHERE job_id=? AND generation=?")
          .run(now,row.job_id,row.generation);
      }
      return rows.length;
    }).immediate();
  }

  silenceEventState(jobId:string,eventId:string):{worker_message_silence:{event_id:string,event_generation:number,current_generation:number,current:boolean}}|undefined {
    const event=this.db.prepare("SELECT status,payload_json FROM events WHERE event_id=? AND source='dona_message' AND event_type='worker_message_silence'")
      .get(eventId) as {status:string;payload_json:string}|undefined;
    if(!event)return undefined;
    let payload:unknown;
    try {payload=JSON.parse(event.payload_json);} catch {return undefined;}
    if(!payload||typeof payload!=="object"||Array.isArray(payload))return undefined;
    const projected=payload as {job_id?:unknown;generation?:unknown};
    if(projected.job_id!==jobId||!Number.isSafeInteger(projected.generation))return undefined;
    const cadence=this.db.prepare("SELECT generation FROM worker_message_cadence WHERE job_id=?").get(jobId) as {generation:number}|undefined;
    const job=this.db.prepare("SELECT status,last_error_code FROM jobs WHERE job_id=?").get(jobId) as Pick<JobRow,"status"|"last_error_code">|undefined;
    const task=this.db.prepare("SELECT t.current_attempt_id,t.desired_state FROM tasks t JOIN task_attempts a USING(task_id) WHERE a.attempt_id=?").get(jobId) as {current_attempt_id:string;desired_state:string}|undefined;
    const currentGeneration=cadence?.generation ?? 0,eventGeneration=projected.generation as number;
    return {worker_message_silence:{event_id:eventId,event_generation:eventGeneration,current_generation:currentGeneration,
      current:(!task||(task.current_attempt_id===jobId&&task.desired_state==="running"))&&event.status==="waiting_agent"&&eventGeneration===currentGeneration&&!!job&&!terminal(job.status)&&job.status!=="needs_review"
        &&!(job.status==="blocked"&&["worker_message_question_pending","runtime_question_pending","runtime_external_approval_pending"].includes(job.last_error_code??""))}};
  }

  purge(at = new Date()): number {
    const cutoff = new Date(at.getTime() - workerMessageRetentionDays * 86_400_000).toISOString();
    return this.db.transaction(() => {
      this.db.prepare(`UPDATE worker_message_deliveries SET state='superseded',lease_owner=NULL,lease_token_sha256=NULL,
        lease_expires_at=NULL,updated_at=? WHERE state IN ('pending','leased') AND message_id IN
        (SELECT m.message_id FROM worker_messages m JOIN jobs j USING(job_id) WHERE j.status IN ('completed','failed','cancelled'))`)
        .run(at.toISOString());
      this.db.prepare(`UPDATE worker_message_cadence SET pending_message_id=NULL,updated_at=? WHERE pending_message_id IN
        (SELECT m.message_id FROM worker_messages m JOIN jobs j USING(job_id) WHERE j.status IN ('completed','failed','cancelled'))`)
        .run(at.toISOString());
      this.db.prepare(`UPDATE worker_message_cadence SET pending_message_id=NULL,updated_at=? WHERE pending_message_id IN
        (SELECT m.message_id FROM worker_messages m WHERE m.accepted_at<? AND m.job_id IN
          (SELECT job_id FROM jobs WHERE status IN ('completed','failed','cancelled'))
          AND NOT EXISTS (SELECT 1 FROM worker_message_deliveries d WHERE d.message_id=m.message_id AND d.state IN ('pending','leased'))
          AND NOT EXISTS (SELECT 1 FROM worker_messages child WHERE child.correlation_message_id=m.message_id))`)
        .run(at.toISOString(),cutoff);
      this.db.prepare(`UPDATE worker_progress_decisions SET decision_json=json_set(json_remove(decision_json,'$.safe_projection'),'$.payload_retired',json('true'))
        WHERE decided_at<? AND job_id IN (SELECT job_id FROM jobs WHERE status IN ('completed','failed','cancelled'))`).run(cutoff);
      this.db.prepare(`UPDATE worker_progress_applications SET result_json=json_set(json_remove(result_json,'$.artifact.safe_projection','$.artifact.rendered_body'),'$.payload_retired',json('true')),
        next_check_at=NULL WHERE decision_key IN (SELECT decision_key FROM worker_progress_decisions WHERE decided_at<?
          AND job_id IN (SELECT job_id FROM jobs WHERE status IN ('completed','failed','cancelled')))` ).run(cutoff);
      const deleted=this.db.prepare(`DELETE FROM worker_messages WHERE accepted_at<? AND job_id IN
        (SELECT job_id FROM jobs WHERE status IN ('completed','failed','cancelled'))
        AND NOT EXISTS (SELECT 1 FROM worker_message_deliveries d WHERE d.message_id=worker_messages.message_id AND d.state IN ('pending','leased'))
        AND NOT EXISTS (SELECT 1 FROM worker_messages child WHERE child.correlation_message_id=worker_messages.message_id)`).run(cutoff).changes;
      return deleted;
    }).immediate();
  }

  project(row: WorkerMessageRow) {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const safeSummary = typeof payload.summary === "string" ? payload.summary : typeof payload.question === "string" ? payload.question : undefined;
    return { message_id: row.message_id, schema_version: row.schema_version, job_id: row.job_id, source_event_id: row.source_event_id,
      direction: row.direction, kind: row.kind, producer_sequence: row.producer_sequence, correlation_message_id: row.correlation_message_id,
      conversation_revision: row.conversation_revision, occurred_at: row.occurred_at, accepted_at: row.accepted_at,
      ...(safeSummary ? { safe_summary: Array.from(safeSummary).slice(0, 240).join("") } : {}) };
  }

  bindInstructionRuntime(jobId:string,messageId:string,identity:string){
    this.assertWorkerRuntime(jobId,identity);
    const message=this.getMessageRequired(messageId);if(message.job_id!==jobId||message.direction!=="dona_to_worker")throw Error("worker_instruction_identity_invalid");
    const old=this.db.prepare("SELECT runtime_identity_sha256 FROM worker_message_runtime_identities WHERE message_id=?").get(messageId) as {runtime_identity_sha256:string}|undefined;
    if(old&&old.runtime_identity_sha256!==sha256(identity))throw Error("worker_instruction_runtime_changed");
    this.db.prepare("INSERT OR IGNORE INTO worker_message_runtime_identities VALUES(?,?,?)").run(messageId,sha256(identity),new Date().toISOString());
  }
  instructionReceived(jobId:string,messageId:string,identity:string):boolean {
    return !!this.db.prepare(`SELECT 1 FROM worker_messages i JOIN worker_message_runtime_identities bound ON bound.message_id=i.message_id
      JOIN worker_messages report ON report.job_id=i.job_id AND report.correlation_message_id=i.message_id AND report.direction='worker_to_dona'
      JOIN worker_message_runtime_identities received ON received.message_id=report.message_id
      WHERE i.job_id=? AND i.message_id=? AND i.direction='dona_to_worker' AND bound.runtime_identity_sha256=? AND received.runtime_identity_sha256=bound.runtime_identity_sha256
      AND COALESCE(report.conversation_revision,-1)=COALESCE(i.conversation_revision,-1) AND report.occurred_at>=i.accepted_at`).get(jobId,messageId,sha256(identity));
  }

  instructionResultPath(jobId:string,messageId?:string):string {
    const job=this.db.prepare("SELECT result_path FROM jobs WHERE job_id=?").get(jobId) as {result_path:string}|undefined;
    if(!job)throw Error("job_not_found");
    const latest=messageId?this.db.prepare("SELECT message_id FROM worker_messages WHERE job_id=? AND message_id=? AND direction='dona_to_worker'").get(jobId,messageId):this.db.prepare("SELECT m.message_id FROM worker_messages m JOIN worker_message_deliveries d USING(message_id) WHERE m.job_id=? AND m.direction='dona_to_worker' AND d.consumer='worker' AND d.state='delivered' ORDER BY m.producer_sequence DESC LIMIT 1").get(jobId);
    if(messageId&&!latest)throw Error("worker_message_instruction_mismatch");
    return latest?path.join(path.dirname(job.result_path),`${(latest as {message_id:string}).message_id}.json`):job.result_path;
  }
  resultPathForRead(jobId:string):string {
    const job=this.db.prepare("SELECT result_path FROM jobs WHERE job_id=?").get(jobId) as {result_path:string}|undefined;
    if(!job)throw Error("job_not_found");
    const delivered=this.db.prepare("SELECT m.message_id FROM worker_messages m JOIN worker_message_deliveries d USING(message_id) WHERE m.job_id=? AND m.direction='dona_to_worker' AND d.consumer='worker' AND d.state='delivered' ORDER BY m.producer_sequence DESC").all(jobId) as {message_id:string}[];
    for(const message of delivered){
      const revised=path.join(path.dirname(job.result_path),`${message.message_id}.json`);
      if(existsSync(revised))return revised;
    }
    return job.result_path;
  }

  instructionForDelivery(jobId:string,sourceEventId:string,messageId:string):string {
    const job=this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId) as JobRow|undefined;
    if(!job)throw new WorkerMessageError("job_not_found","job does not exist");
    this.assertAuthorized(job,sourceEventId);
    const message=this.getMessageRequired(messageId);
    if(message.job_id!==jobId||message.source_event_id!==sourceEventId||message.direction!=="dona_to_worker")throw new WorkerMessageError("worker_message_instruction_mismatch","instruction identity does not match");
    return typedInstructionText(message.message_id,message.kind,JSON.parse(message.payload_json),message.correlation_message_id,message.conversation_revision);
  }

  private getMessageRequired(messageId: string): WorkerMessageRow {
    const row = this.db.prepare("SELECT * FROM worker_messages WHERE message_id=?").get(messageId) as WorkerMessageRow | undefined;
    if (!row) throw new Error(`Worker message ${messageId} disappeared`);
    return row;
  }

  private assertAuthorized(job:JobRow,sourceEventId:string):void {
    const owner=readEventJobBinding(this.db,job.source_event_id)?.owner;
    const caller=sourceEventId===job.source_event_id?owner:readEventJobBinding(this.db,sourceEventId)?.owner;
    if(!owner||!caller||stableStringify(owner)!==stableStringify(caller))
      throw new WorkerMessageError("job_binding_mismatch","source event does not own this job");
  }

  private assertWorkerRuntime(jobId:string,runtimeIdentity:string):void {
    if(typeof runtimeIdentity!=="string"||runtimeIdentity.length<1||runtimeIdentity.length>512)
      throw new WorkerMessageError("worker_runtime_mismatch","worker runtime identity is invalid");
    const identity=this.db.prepare("SELECT herdr_agent_session_id FROM job_live_session_identities WHERE job_id=?")
      .get(jobId) as {herdr_agent_session_id:string}|undefined;
    if(!identity||identity.herdr_agent_session_id!==runtimeIdentity)
      throw new WorkerMessageError("worker_runtime_mismatch","worker runtime identity does not own this job");
  }

  private assertWorkerReconciliationRuntime(jobId:string,runtimeIdentity:string,idempotencyKey:string):void {
    if(typeof runtimeIdentity!=="string"||runtimeIdentity.length<1||runtimeIdentity.length>512)
      throw new WorkerMessageError("worker_runtime_mismatch","worker runtime identity is invalid");
    const historical=this.db.prepare(`SELECT 1 FROM worker_messages m JOIN worker_message_runtime_identities r USING(message_id)
      WHERE m.job_id=? AND m.producer='worker' AND m.idempotency_key=? AND r.runtime_identity_sha256=?`)
      .get(jobId,idempotencyKey,sha256(runtimeIdentity));
    if(historical)return;
    const existing=this.db.prepare("SELECT 1 FROM worker_messages WHERE job_id=? AND producer='worker' AND idempotency_key=?")
      .get(jobId,idempotencyKey);
    if(existing)throw new WorkerMessageError("worker_runtime_mismatch","worker runtime identity does not own this job");
    this.assertWorkerRuntime(jobId,runtimeIdentity);
  }

  private recordWorkspaceDelivery(workspaceId:string,at:string):void {
    this.db.prepare(`INSERT INTO worker_message_workspace_cadence(workspace_id,last_delivery_at,updated_at) VALUES(?,?,?)
      ON CONFLICT(workspace_id) DO UPDATE SET last_delivery_at=excluded.last_delivery_at,updated_at=excluded.updated_at`).run(workspaceId,at,at);
  }
}

export class WorkerMessagePublisher {
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly repository:WorkerMessageRepository,private readonly wake:()=>void,private readonly pollMs=30_000,
    private readonly onError:(error:unknown)=>void=()=>{}) {}
  start():void { if(this.timer)return; this.runOnce(); this.timer=setInterval(()=>this.runOnce(),this.pollMs); this.timer.unref(); }
  stop():void { if(this.timer)clearInterval(this.timer); this.timer=undefined; }
  runOnce(at=new Date()):void {
    try {
      const published=this.repository.publishPendingReports(100,at);
      const silence=this.repository.publishDueSilenceEvents(100,at);
      const decisions=this.repository.publishDueProgressDecisions(32,at);
      this.repository.purge(at);
      if(published+silence+decisions>0)this.wake();
    }
    catch(error){this.onError(error);}
  }
}

export class WorkerInstructionBridge {
  private timer:NodeJS.Timeout|undefined;
  private operation:Promise<void>|undefined;
  private stopping=false;
  private readonly leaseOwner="dispatcher-worker-instruction-bridge";
  constructor(private readonly repository:WorkerMessageRepository,private readonly controller:WorkerInstructionController,
    private readonly pollMs=1_000,private readonly onError:(error:unknown)=>void=()=>{},
    private readonly onDelivered:()=>void=()=>{}) {}
  start():void {
    if(this.timer)return;
    this.stopping=false;
    this.run();
    this.timer=setInterval(()=>this.run(),this.pollMs);
    this.timer.unref();
  }
  beginShutdown():void {
    this.stopping=true;
    if(this.timer)clearInterval(this.timer);
    this.timer=undefined;
  }
  async stop():Promise<void> {
    this.beginShutdown();
    await this.operation;
  }
  async runOnce(at=new Date()):Promise<boolean> {
    const claimed=this.repository.claimNextWorkerInstruction(this.leaseOwner,workerMessageLeaseMaxMs,at);
    if(!claimed)return false;
    const {delivery,lease_token}=claimed;
    try {await this.controller.steer(delivery.job_id,delivery.source_event_id,
      typedInstructionText(delivery.message_id,delivery.kind,delivery.payload,delivery.correlation_message_id,delivery.conversation_revision),delivery.message_id);}
    catch(error){
      const detail=error as {code?:string;acceptance?:string};
      if(detail.code==="runtime_not_ready"||detail.acceptance==="not_sent"||detail.acceptance==="rejected")
        this.repository.releaseUnsent(delivery.delivery_id,this.leaseOwner,lease_token,delivery.fence);
      throw error;
    }
    this.repository.acknowledge(delivery.job_id,delivery.source_event_id,delivery.delivery_id,this.leaseOwner,
      lease_token,delivery.fence,new Date());
    this.onDelivered();
    return true;
  }
  private run():void {
    if(this.operation)return;
    const operation=(async()=>{while(!this.stopping&&await this.runOnce());})().catch(error=>this.onError(error));
    this.operation=operation;
    void operation.finally(()=>{if(this.operation===operation)this.operation=undefined;});
  }
}
