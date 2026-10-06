import { z } from "zod";
import type Database from "better-sqlite3";
import type { AuditEvent, VerifiedAuditState } from "../audit/codec.js";
import { assertSynchronousResult } from "../audit/synchronous.js";
import { ApprovalHistoryTransaction } from "./history-transaction.js";
import { ApprovalRecordRepository } from "./record-repository.js";
import { ApprovalRequestLifecycle } from "./request-lifecycle.js";
import { ApprovalClockHistory } from "./clock-history.js";
import { ApprovalPayloadRepository } from "./payload-repository.js";
import { ApprovalPayloadMutation } from "./payload-mutation.js";
import { encodeApprovalPayloadMetadata } from "./payload-metadata.js";
import type { ApprovalRecordScope } from "./record-codec.js";
import type { ApprovalTransactionProviders } from "./transaction.js";
import type { OperationsPolicyRepository } from "./operations-policy.js";
import { OperationsAccessDenied } from "./operations-policy.js";
import type { ClockMark } from "./clock.js";
import { requestPayloadRequired } from "./domain.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const owner = z.enum(["request", "attempt"]);
const commandSchema = z.strictObject({ owner_kind: owner, owner_handle: id, metadata_digest: z.string().regex(/^[a-f0-9]{64}$/),
  policy_revision: positive });
export type RetentionCommand = z.infer<typeof commandSchema>;
export class ApprovalRetentionError extends Error { constructor() { super("approval_retention_unverified"); this.name = "ApprovalRetentionError"; } }
/** 本文envelopeのみを既存payload mutationで消し、metadata tombstone、全record、
 * one-shot fence、unknown、marker、audit/history/indexは永久に保持する。 */
export class ApprovalRetention {
  private readonly records: ApprovalRecordRepository;
  private readonly payloads: ApprovalPayloadRepository;
  private readonly mutation: ApprovalPayloadMutation;
  private readonly lifecycle: ApprovalRequestLifecycle;
  private readonly history: ApprovalClockHistory;
  private readonly transaction: ApprovalHistoryTransaction;
  constructor(private readonly db: Database.Database, providers: ApprovalTransactionProviders, private readonly scope: ApprovalRecordScope,
    private readonly policies: OperationsPolicyRepository) {
    if (!policies.matchesContext(db, scope)) throw new ApprovalRetentionError();
    this.records = new ApprovalRecordRepository(db, providers.auditAnchors, providers.auditKeys, scope);
    this.payloads = new ApprovalPayloadRepository(db, providers.auditAnchors, providers.auditKeys, scope);
    this.mutation = new ApprovalPayloadMutation(db, scope); this.lifecycle = new ApprovalRequestLifecycle(db, providers, scope);
    this.history = new ApprovalClockHistory(db, scope); this.transaction = new ApprovalHistoryTransaction(db, providers, scope);
  }
  private inspect(state: VerifiedAuditState, mark: Readonly<ClockMark>, kind: "request" | "attempt", handle: string) {
    const record = this.records.readInState(state, kind === "request" ? "request" : "execution", handle);
    if (record === null) throw Error();
    const request = record.kind === "request" ? record : this.records.readInState(state, "request", record.row.request_id);
    if (request === null) throw Error(); this.lifecycle.verifyClock(request, mark, state);
    const payload = this.payloads.inspectInState(state, kind, handle);
    if (payload === null) return { eligible: false, payload, digest: null };
    if (payload.metadata.binding.request_id !== request.row.request_id || payload.metadata.binding.semantic_hash !== request.row.semantic_hash) throw Error();
    let protectedState = request.row.state === "needs_review" || requestPayloadRequired(request.row.state);
    if (record.kind === "execution") {
      const claimed = this.history.readInState(state, record.row.clock_transaction_id);
      if (claimed === null || claimed.effective_utc !== record.row.claimed_at || claimed.boot_id !== mark.boot_id
        || claimed.continuous_ms > mark.continuous_ms || claimed.effective_utc > mark.effective_utc) throw Error();
      protectedState ||= !["succeeded", "failed"].includes(record.row.state);
    } else if (request.row.state === "consumed") {
      const consume = this.records.readInState(state, "consume", request.row.request_id);
      if (consume === null) throw Error();
      const attempt = this.records.readInState(state, "execution", consume.row.attempt_id);
      if (attempt === null) throw Error(); protectedState ||= !["succeeded", "failed"].includes(attempt.row.state);
    }
    for (const notificationKind of ["approval_card", "pending_notice"] as const) {
      const notification = this.lifecycle.notification(state, request, notificationKind);
      protectedState ||= ["dispatching", "acceptance_unknown", "needs_review"].includes(notification.row.state);
    }
    const metadata = payload.metadata;
    return { payload, digest: encodeApprovalPayloadMetadata(metadata, this.scope).digest,
      eligible: !protectedState && metadata.state === "active" && payload.secret.status === "present" && metadata.binding.expires_at <= mark.effective_utc };
  }
  pageInState(state: VerifiedAuditState, mark: Readonly<ClockMark>, kind: "request" | "attempt", after: string | null, limit: number) {
    owner.parse(kind); z.number().int().min(1).max(100).parse(limit); if (after !== null) id.parse(after);
    const page = this.records.readListPageInState(state, { record_kind: kind === "request" ? "request" : "execution", membership: "all" }, after, limit);
    const candidates: { owner_kind: "request" | "attempt"; owner_handle: string; metadata_digest: string }[] = [];
    for (const record of page.records) {
      const handle = record.kind === "request" ? record.row.request_id : record.kind === "execution" ? record.row.attempt_id : null;
      if (handle === null) throw Error(); const result = this.inspect(state, mark, kind, handle);
      if (result.eligible) candidates.push({ owner_kind: kind, owner_handle: handle, metadata_digest: result.digest! });
    }
    return { candidates, next_after: page.next_after, has_more: page.has_more };
  }
  countInState(state: VerifiedAuditState, mark: Readonly<ClockMark>): number {
    let count = 0;
    for (const kind of ["request", "attempt"] as const) {
      const page = this.pageInState(state, mark, kind, null, 100); if (page.has_more) throw Error(); count += page.candidates.length;
    }
    return count;
  }
  previewInState(state: VerifiedAuditState, mark: Readonly<ClockMark>, kind: "request" | "attempt", handle: string) {
    owner.parse(kind); id.parse(handle); const result = this.inspect(state, mark, kind, handle);
    return { eligible: result.eligible, metadata_digest: result.digest };
  }
  retain(transactionId: string, input: RetentionCommand) {
    try {
      assertSynchronousResult(input); const command = commandSchema.parse(input);
      return this.transaction.runPrepared<() => { status: "denied" | "protected" | "deleted" }>(transactionId, (mark, state) => {
        let principal: ReturnType<OperationsPolicyRepository["authorize"]>;
        try { principal = this.policies.authorize(state, mark, "retention"); }
        catch (error) {
          if (!(error instanceof OperationsAccessDenied)) throw error;
          return { event: { scope: { instance_id: this.scope.instance_id, tenant_id: this.scope.workspace_id },
            actor: { kind: "unauthenticated" as const, id: null }, action: "retention" as const, operation: "audit.retain.v1" as const,
            resource_id: command.owner_handle, outcome: "denied" as const, reason: "unauthorized" as const, session_ref: null,
            receipt_id: null, attempt_id: null, policy_revision: 0, binding_revision: 0, authz_revision: 0 },
            resource_digest: null, mutation: () => ({ status: "denied" as const }) };
        }
        const inspected = this.inspect(state, mark, command.owner_kind, command.owner_handle);
        const event: Omit<AuditEvent, "occurred_at"> = { scope: { instance_id: this.scope.instance_id, tenant_id: this.scope.workspace_id },
          actor: { kind: "operator", id: principal.principal_id }, action: "retention", operation: "audit.retain.v1",
          resource_id: command.owner_handle, outcome: "denied", reason: "revision_mismatch", session_ref: null, receipt_id: null, attempt_id: null,
          policy_revision: principal.policy_revision, binding_revision: principal.binding_revision, authz_revision: principal.policy_revision };
        if (principal.policy_revision !== command.policy_revision || inspected.digest !== command.metadata_digest)
          return { event, resource_digest: null, mutation: () => ({ status: "denied" as const }) };
        if (!inspected.eligible || inspected.payload === null) return { event: { ...event, outcome: "succeeded" as const, reason: "none" as const },
          resource_digest: null, mutation: () => ({ status: "protected" as const }) };
        const metadata = inspected.payload.metadata;
        const plan = this.mutation.prepare(mark, state, [{ previous: metadata, next: { ...metadata, state: "deleted", deleted_at: mark.effective_utc }, envelope: null }]);
        return { event: { ...event, outcome: "succeeded" as const, reason: "none" as const }, resource_commitments: plan.resource_commitments,
          mutation: () => { plan.mutation(); return { status: "deleted" as const }; } };
      });
    } catch { throw new ApprovalRetentionError(); }
  }
}
