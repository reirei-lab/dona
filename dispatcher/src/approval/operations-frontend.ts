import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { z } from "zod";
import { NativeOperationsConnection } from "./operations-connection.js";
import { ApprovalRecordRepository } from "./record-repository.js";
import type { OperationsAction } from "./operations-policy.js";
import { operationsCanonical } from "./operations-policy.js";
import { assertSynchronousResult } from "../audit/synchronous.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), file = z.string().max(4096).refine(value => path.isAbsolute(value) && path.normalize(value) === value);
const write = { apply: z.boolean(), confirm: z.string().regex(/^[a-f0-9]{64}$/).nullable() };
const commandSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list"), limit: z.number().int().min(1).max(100), cursor: z.string().max(2048).nullable(),
    state: z.enum(["all", "requested", "delivery_pending", "delivery_unknown", "sent", "approved", "rejected", "cancelled", "expired", "delivery_failed", "consumed", "execution_cancelled", "consume_expired", "needs_review"]), due_only: z.boolean() }),
  z.strictObject({ action: z.enum(["health", "metrics"]) }),
  z.strictObject({ action: z.literal("expire"), handle: id, ...write }),
  z.strictObject({ action: z.literal("retention"), handle: id, owner_kind: z.enum(["request", "attempt"]), ...write }),
  z.strictObject({ action: z.literal("reconcile"), handle: id, kind: z.enum(["execution", "notification"]), evidence: id, reason: z.string().min(8).max(512), ...write }),
  z.strictObject({ action: z.literal("backup"), destination: file, ...write }),
  z.strictObject({ action: z.literal("restore-check"), candidate: file }),
  z.strictObject({ action: z.literal("sweep"), ...write }),
]);
export type OperationsCommand = z.infer<typeof commandSchema>;
export type OperationsFrontendConnection = Pick<NativeOperationsConnection, "db" | "providers" | "config" | "policies" | "operations" | "expiry" | "retention" | "recovery" | "reconcile">;
export class OperationsCommandError extends Error { constructor() { super("approval_operations_command_unverified"); this.name = "OperationsCommandError"; } }
/** 標準はdry-run。unknown flag、重複flag、actor、outcome、任意commandを拒否する。 */
export function parseOperationsArguments(args: string[]): { config: string; command: OperationsCommand } {
  try {
    const raw: Record<string, unknown> = { action: args[0] };
    const seen = new Set<string>(); let config: string | undefined;
    const flags = new Map([ ["--handle", "handle"], ["--owner-kind", "owner_kind"], ["--kind", "kind"], ["--evidence", "evidence"],
      ["--reason", "reason"], ["--destination", "destination"], ["--candidate", "candidate"], ["--limit", "limit"],
      ["--state", "state"], ["--cursor", "cursor"], ["--confirm", "confirm"] ]);
    for (let index = 1; index < args.length; index++) {
      const flag = args[index]!; if (seen.has(flag)) throw Error(); seen.add(flag);
      if (flag === "--apply" || flag === "--dry-run" || flag === "--due-only") {
        raw[flag === "--due-only" ? "due_only" : "apply"] = flag === "--apply" || flag === "--due-only"; continue;
      }
      const value = args[++index]; if (value === undefined) throw Error();
      if (flag === "--config") { config = file.parse(value); continue; }
      const field = flags.get(flag); if (field === undefined) throw Error(); raw[field] = field === "limit" ? Number(value) : value;
    }
    if (config === undefined || seen.has("--apply") && seen.has("--dry-run")) throw Error();
    if (raw.action === "list") { raw.limit ??= 100; raw.cursor ??= null; raw.state ??= "all"; raw.due_only ??= false; }
    if (["expire", "retention", "reconcile", "backup", "sweep"].includes(String(raw.action))) { raw.apply ??= false; raw.confirm ??= null; }
    const command = commandSchema.parse(raw);
    if ("apply" in command && (command.apply ? command.confirm === null : command.confirm !== null)) throw Error();
    return { config, command };
  } catch { throw new OperationsCommandError(); }
}
const transaction = () => "ops_" + randomUUID().replaceAll("-", "");
function preview(connection: OperationsFrontendConnection, command: Extract<OperationsCommand, { apply: boolean }>) {
  const action: OperationsAction = command.action === "sweep" ? "expire" : command.action;
  const records = new ApprovalRecordRepository(connection.db, connection.providers.auditAnchors, connection.providers.auditKeys, connection.config.scope);
  return connection.operations.authorizedObservation(connection.policies, action, (state, mark, principal) => {
    const base = { scope: connection.config.scope, policy_revision: principal.policy_revision, binding_revision: principal.binding_revision };
    if (command.action === "expire") {
      const request = records.readInState(state, "request", command.handle); if (request === null) throw Error();
      return { ...base, revision: request.row.revision, fence: null, metadata_digest: null, eligible: true };
    }
    if (command.action === "reconcile") {
      const attempt = records.readInState(state, command.kind === "execution" ? "execution" : "notification", command.handle); if (attempt === null) throw Error();
      return { ...base, revision: null, fence: attempt.row.fence, metadata_digest: null, eligible: true };
    }
    if (command.action === "retention") {
      const result = connection.retention.previewInState(state, mark, command.owner_kind, command.handle);
      return { ...base, revision: null, fence: null, metadata_digest: result.metadata_digest, eligible: result.eligible };
    }
    if (command.action === "sweep") connection.policies.authorize(state, mark, "retention");
    return { ...base, revision: null, fence: null, metadata_digest: null, eligible: true };
  });
}
export function executeOperationsCommand(connection: OperationsFrontendConnection, input: OperationsCommand) {
  try {
    assertSynchronousResult(input);
    const command = commandSchema.parse(input);
    if (command.action === "list") return connection.operations.listRequests(connection.policies, { limit: command.limit, cursor: command.cursor,
      filter: { state: command.state, due_only: command.due_only } });
    if (command.action === "health") return connection.operations.health(connection.policies);
    if (command.action === "metrics") return connection.operations.metrics(connection.policies);
    if (command.action === "restore-check") return connection.recovery.verifyRestore(command.candidate);
    if (!("apply" in command)) throw Error();
    const observed = preview(connection, command), { apply: _apply, confirm: _confirm, ...intent } = command;
    const confirmation = createHash("sha256").update("dona.approval.operations-confirm.v1\0")
      .update(operationsCanonical({ intent, observed, ...(command.action === "sweep" ? {
        interval: connection.config.sweep_interval_ms, pages: connection.config.sweep_page_budget } : {}) })).digest("hex");
    if (!command.apply) return { dry_run: true as const, confirmation, eligible: observed.eligible,
      policy_revision: observed.policy_revision, revision: observed.revision, fence: observed.fence };
    if (command.confirm !== confirmation) throw Error();
    if (command.action === "expire") return connection.expiry.expire(transaction(), command.handle, observed.revision!, observed.policy_revision);
    if (command.action === "retention") {
      if (observed.metadata_digest === null) return { status: "protected" as const };
      return connection.retention.retain(transaction(), { owner_kind: command.owner_kind, owner_handle: command.handle,
        metadata_digest: observed.metadata_digest, policy_revision: observed.policy_revision });
    }
    if (command.action === "backup") return connection.recovery.backup(command.destination, observed.policy_revision);
    if (command.action === "reconcile") return connection.reconcile(command.kind,
      command.kind === "execution" ? { attempt_handle: command.handle, expected_fence: observed.fence!, authority_ref: command.evidence }
        : { notification_handle: command.handle, expected_fence: observed.fence!, authority_ref: command.evidence }, command.reason, transaction(), observed.policy_revision);
    return { status: "sweep_authorized" as const, policy_revision: observed.policy_revision };
  } catch { throw new OperationsCommandError(); }
}
export interface SweepCursors { expiry: string | null; request_retention: string | null; attempt_retention: string | null }
/** 一回の有界tick。単件brokerがwriter lock内でrevision/認可/期限を再検査する。 */
export function runOperationsTick(connection: OperationsFrontendConnection, policyRevision: number, cursors: SweepCursors): SweepCursors {
  let expiry = cursors.expiry;
  for (let page = 0; page < connection.config.sweep_page_budget; page++) {
    connection.operations.authorizedObservation(connection.policies, "expire", (_state, _mark, principal) => {
      if (principal.policy_revision !== policyRevision) throw Error(); return null;
    });
    const selected = connection.operations.listExpiryRequests(connection.policies, { limit: 100, cursor: expiry, filter: { state: "all", due_only: true } });
    for (const request of selected.requests) connection.expiry.expire(transaction(), request.handle, request.revision, policyRevision);
    expiry = selected.has_more ? selected.cursor : null; if (!selected.has_more) break;
  }
  const next = { expiry, request_retention: cursors.request_retention, attempt_retention: cursors.attempt_retention };
  for (const kind of ["request", "attempt"] as const) {
    const key = kind === "request" ? "request_retention" : "attempt_retention";
    for (let page = 0; page < connection.config.sweep_page_budget; page++) {
      const selected = connection.operations.authorizedObservation(connection.policies, "retention", (state, mark, principal) => {
        if (principal.policy_revision !== policyRevision) throw Error();
        return connection.retention.pageInState(state, mark, kind, next[key], 100);
      });
      for (const candidate of selected.candidates) connection.retention.retain(transaction(), { ...candidate, policy_revision: policyRevision });
      next[key] = selected.has_more ? selected.next_after : null; if (!selected.has_more) break;
    }
  }
  return next;
}
/** foregroundの常駐loop。tickの例外や応答不明で停止し、writeを再試行しない。
 * restartではcursorを捨てて監査付きstateから再走査する。daemonを登録しない。 */
export async function runOperationsSweep(connection: OperationsFrontendConnection, policyRevision: number, signal: AbortSignal) {
  let cursors: SweepCursors = { expiry: null, request_retention: null, attempt_retention: null };
  while (!signal.aborted) {
    cursors = runOperationsTick(connection, policyRevision, cursors);
    try { await delay(connection.config.sweep_interval_ms, undefined, { signal }); }
    catch { if (!signal.aborted) throw new OperationsCommandError(); }
  }
  return { status: "stopped" as const };
}
export async function runOperationsFrontend(args: string[]) {
  const parsed = parseOperationsArguments(args), connection = new NativeOperationsConnection(parsed.config);
  try {
    const result = executeOperationsCommand(connection, parsed.command);
    if (parsed.command.action !== "sweep" || !parsed.command.apply || typeof result !== "object" || !("policy_revision" in result)) return result;
    const controller = new AbortController(), stop = () => controller.abort();
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    try { return await runOperationsSweep(connection, result.policy_revision as number, controller.signal); }
    finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
  } finally { connection.close(); }
}
