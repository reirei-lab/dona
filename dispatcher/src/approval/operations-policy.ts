import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { AuditRepository, assertCurrentAuditReadState } from "../audit/repository.js";
import { assertSynchronousCallback, assertSynchronousResult } from "../audit/synchronous.js";
import type { VerifiedAuditState, AuditEvent } from "../audit/codec.js";
import { ApprovalHistoryTransaction } from "./history-transaction.js";
import type { ApprovalTransactionProviders } from "./transaction.js";
import type { ClockMark } from "./clock.js";
import type { ApprovalRecordScope } from "./record-codec.js";
import { SupervisorBindingRepository, supervisorBindingId,
  type BindingGenerationStore, type BindingGeneration, type OperatorProofAuthority } from "./supervisor-binding.js";
import { verifyApprovalOperationsSchema } from "./schema.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const uid = z.number().int().nonnegative().max(0xffffffff);
const utc = z.string().length(24).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const scopeSchema = z.strictObject({ instance_id: id, workspace_id: id });
const providerAuthorSchema = z.strictObject({ user_id: id, bot_id: id });
export const operationsActionSchema = z.enum(["read", "expire", "reconcile", "retention", "backup", "restore"]);
export type OperationsAction = z.infer<typeof operationsActionSchema>;
const proposalSchema = z.strictObject({ active: z.boolean(), expires_at: utc,
  provider_author: providerAuthorSchema.optional(),
  grants: z.array(z.strictObject({ principal_id: id, uid, actions: z.array(operationsActionSchema).min(1).max(6) })).min(1).max(16) })
  .superRefine((value, context) => {
    if (new Set(value.grants.map(item => item.uid)).size !== value.grants.length
      || new Set(value.grants.map(item => item.principal_id)).size !== value.grants.length
      || value.grants.some(item => new Set(item.actions).size !== item.actions.length))
      context.addIssue({ code: "custom", message: "operations_policy_invalid" });
  });
const policySchema = z.strictObject({ codec_version: z.literal(1), scope: scopeSchema,
  binding_id: id, binding_revision: positive, revision: positive, transaction_id: id,
  provider_author: providerAuthorSchema, active: z.boolean(), expires_at: utc, changed_at: utc, grants: proposalSchema.shape.grants });
export type OperationsPolicy = z.infer<typeof policySchema>;
export type OperationsPolicyProposal = z.infer<typeof proposalSchema>;
export class OperationsAuthorizationError extends Error {
  constructor() { super("approval_operations_authorization_unverified"); this.name = "OperationsAuthorizationError"; }
}
export class OperationsAccessDenied extends Error {
  constructor() { super("approval_operations_denied"); this.name = "OperationsAccessDenied"; }
}
const operatorProofSchema = z.strictObject({ operator_id: id, credential_id: id, credential_domain: id,
  credential_kind: z.enum(["os_account", "hardware_backed"]), action: z.enum(["bootstrap", "rotate", "revoke", "break_glass"]),
  transaction_id: id, proposal_digest: z.string().regex(/^[a-f0-9]{64}$/) });
export function operationsCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(operationsCanonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${operationsCanonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function operationsDigest(value: unknown): string {
  return createHash("sha256").update("dona.approval.operations-policy.v1\0").update(operationsCanonical(value)).digest("hex");
}
/** policy generationはbindingとは別のpolicy_generation Keychain itemを使う。
 * DBや通常設定fileをgeneration storeへ転用してはいけない。 */
export class OperationsPolicyRepository {
  private readonly scope: ApprovalRecordScope;
  private readonly audit: AuditRepository;
  constructor(private readonly db: Database.Database, providers: ApprovalTransactionProviders, scope: ApprovalRecordScope,
    private readonly binding: SupervisorBindingRepository, private readonly generations: BindingGenerationStore) {
    try {
      assertSynchronousResult(scope); this.scope = Object.freeze(scopeSchema.parse(scope));
      verifyApprovalOperationsSchema(db);
      if (!binding.matchesScope(this.scope)) throw Error();
      this.audit = new AuditRepository(db, providers.auditAnchors, providers.auditKeys);
    } catch { throw new OperationsAuthorizationError(); }
  }
  read(): OperationsPolicy | null {
    try { return this.audit.readVerifiedState(state => this.readInState(state)); }
    catch { throw new OperationsAuthorizationError(); }
  }
  matchesContext(db: Database.Database, scope: ApprovalRecordScope): boolean {
    try { assertSynchronousResult(scope); return db === this.db && operationsCanonical(scopeSchema.parse(scope)) === operationsCanonical(this.scope); }
    catch { return false; }
  }
  matchesScope(scope: ApprovalRecordScope): boolean { return this.matchesContext(this.db, scope); }
  readInState(state: VerifiedAuditState): OperationsPolicy | null {
    try {
      assertCurrentAuditReadState(this.db, state); verifyApprovalOperationsSchema(this.db);
      const roots = state.resource_bindings.filter(item => item.scope.instance_id === this.scope.instance_id
        && item.scope.tenant_id === this.scope.workspace_id && item.resource_id === "approval_operations_policy");
      if (roots.length > 1) throw Error();
      const row = this.db.prepare("SELECT policy_json,revision FROM main.approval_operations_policy WHERE instance_id=? AND workspace_id=?")
        .get(this.scope.instance_id, this.scope.workspace_id) as { policy_json: string; revision: number } | undefined;
      const generation = this.generations.read(this.scope); assertSynchronousResult(generation);
      if (row === undefined) { if (roots.length !== 0 || generation !== null) throw Error(); return null; }
      const policy = policySchema.parse(JSON.parse(row.policy_json));
      proposalSchema.parse({ active: policy.active, expires_at: policy.expires_at, provider_author: policy.provider_author, grants: policy.grants });
      const digest = operationsDigest(policy);
      if (row.policy_json !== operationsCanonical(policy) || policy.revision !== row.revision
        || operationsCanonical(policy.scope) !== operationsCanonical(this.scope) || roots[0]?.resource_digest !== digest
        || generation === null || generation.revision !== policy.revision || generation.digest !== digest
        || generation.transaction_id !== policy.transaction_id) throw Error();
      return policy;
    } catch { throw new OperationsAuthorizationError(); }
  }
  /** current uid/euidはOSから取得する。CLI actor/handle/環境変数は使わない。
   * readは監査read内、writeはwriter lock内のbroker prepareで呼ぶ。 */
  authorize(state: VerifiedAuditState, mark: Readonly<ClockMark>, action: OperationsAction) {
    try {
      operationsActionSchema.parse(action);
      if (process.getuid === undefined || process.geteuid === undefined) throw new OperationsAccessDenied();
      const real = process.getuid(), effective = process.geteuid();
      if (real !== effective) throw new OperationsAccessDenied();
      const policy = this.readInState(state), binding = this.binding.readInState(state);
      if (policy === null || !policy.active || policy.expires_at <= mark.effective_utc
        || binding === null || binding.status !== "active" || supervisorBindingId(binding) !== policy.binding_id
        || binding.revision !== policy.binding_revision) throw new OperationsAccessDenied();
      const grant = policy.grants.find(item => item.uid === real);
      if (grant === undefined || !grant.actions.includes(action)) throw new OperationsAccessDenied();
      return Object.freeze({ principal_id: grant.principal_id, policy_revision: policy.revision, binding_revision: binding.revision });
    } catch (error) { if (error instanceof OperationsAccessDenied) throw error; throw new OperationsAuthorizationError(); }
  }
}

/** 別途明示されたoperator provisioning経路。通常操作CLIから呼ばない。
 * current bindingの二人を再認証してpolicyを変更し、OS generationもCASする。 */
export class OperationsPolicyOperator {
  private readonly transaction: ApprovalHistoryTransaction;
  private readonly policies: OperationsPolicyRepository;
  private readonly scope: ApprovalRecordScope;
  constructor(private readonly db: Database.Database, providers: ApprovalTransactionProviders, scope: ApprovalRecordScope,
    private readonly binding: SupervisorBindingRepository, private readonly generations: BindingGenerationStore,
    private readonly proofs: OperatorProofAuthority) {
    assertSynchronousResult(scope); this.scope = Object.freeze(scopeSchema.parse(scope)); assertSynchronousCallback(proofs);
    this.policies = new OperationsPolicyRepository(db, providers, this.scope, binding, generations);
    this.transaction = new ApprovalHistoryTransaction(db, providers, this.scope);
  }
  change(transactionId: string, input: OperationsPolicyProposal): OperationsPolicy {
    try {
      assertSynchronousResult(input); const proposal = proposalSchema.parse(input);
      return this.transaction.runPrepared<() => OperationsPolicy>(transactionId, (mark, state) => {
        const binding = this.binding.readInState(state), previous = this.policies.readInState(state);
        if (binding === null || binding.status !== "active" || proposal.expires_at <= mark.effective_utc
          || Date.parse(proposal.expires_at) - Date.parse(mark.effective_utc) > 90 * 86400000) throw Error();
        const providerAuthor = proposal.provider_author ?? previous?.provider_author;
        if (providerAuthor === undefined || previous !== null && operationsCanonical(providerAuthor) !== operationsCanonical(previous.provider_author)) throw Error();
        const action = previous === null ? "bootstrap" : "rotate", digest = operationsDigest({ scope: this.scope,
          transaction_id: transactionId, binding_id: supervisorBindingId(binding), binding_revision: binding.revision, proposal });
        const rawProofs = this.proofs(action, transactionId, digest); assertSynchronousResult(rawProofs);
        const proofs = z.tuple([operatorProofSchema, operatorProofSchema]).parse(rawProofs);
        if (proofs.length !== 2 || proofs[0].operator_id === proofs[1].operator_id
          || proofs[0].credential_domain === proofs[1].credential_domain
          || proofs[0].credential_id === proofs[1].credential_id
          || proofs.some(proof => !binding.operator_ids.includes(proof.operator_id) || proof.action !== action
            || proof.transaction_id !== transactionId || proof.proposal_digest !== digest
            || !["os_account", "hardware_backed"].includes(proof.credential_kind))) throw Error();
        const policy = policySchema.parse({ codec_version: 1, scope: this.scope, binding_id: supervisorBindingId(binding),
          binding_revision: binding.revision, revision: (previous?.revision ?? 0) + 1, transaction_id: transactionId,
          changed_at: mark.effective_utc, ...proposal, provider_author: providerAuthor });
        const next: BindingGeneration = { revision: policy.revision, digest: operationsDigest(policy), transaction_id: transactionId };
        const expected = previous === null ? null : { revision: previous.revision, digest: operationsDigest(previous), transaction_id: previous.transaction_id };
        const accepted = this.generations.reserve(this.scope, expected, next); assertSynchronousResult(accepted);
        if (operationsCanonical(accepted) !== operationsCanonical(next)
          || operationsCanonical(this.generations.read(this.scope)) !== operationsCanonical(next)) throw Error();
        const event: Omit<AuditEvent, "occurred_at"> = { scope: { instance_id: this.scope.instance_id, tenant_id: this.scope.workspace_id },
          actor: { kind: "operator", id: proofs[0].operator_id }, action: "policy_change", operation: "policy.change.v1",
          resource_id: "approval_operations_policy", outcome: "succeeded", reason: "none", session_ref: null, receipt_id: null,
          attempt_id: null, policy_revision: policy.revision, binding_revision: binding.revision, authz_revision: policy.revision };
        return { event, resource_digest: next.digest, mutation: () => {
          if (previous === null) this.db.prepare("INSERT INTO main.approval_operations_policy VALUES (?,?,?,?)")
            .run(this.scope.instance_id, this.scope.workspace_id, operationsCanonical(policy), policy.revision);
          else if (this.db.prepare("UPDATE main.approval_operations_policy SET policy_json=?,revision=? WHERE instance_id=? AND workspace_id=? AND revision=?")
            .run(operationsCanonical(policy), policy.revision, this.scope.instance_id, this.scope.workspace_id, previous.revision).changes !== 1) throw Error();
          return policy;
        } };
      });
    } catch { throw new OperationsAuthorizationError(); }
  }
}
