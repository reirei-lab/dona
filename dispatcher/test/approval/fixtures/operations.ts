import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditRepository } from "../../../src/audit/repository.js";
import { AuditIntegrityError } from "../../../src/audit/codec.js";
import { fixture, scope, grant, intent } from "./broker.js";
import { installApprovalExecutionMarkerSchema, installApprovalSupervisorBindingSchema,
  installApprovalOperationsSchema, verifyApprovalOperationsSchema } from "../../../src/approval/schema.js";
import { SupervisorBindingOperator, SupervisorBindingRepository, type BindingGeneration,
  type BindingGenerationStore, type OperatorProofAuthority } from "../../../src/approval/supervisor-binding.js";
import { OperationsPolicyOperator, OperationsPolicyRepository, OperationsAuthorizationError } from "../../../src/approval/operations-policy.js";

export function operationsPolicyFixture(t: { after(fn: () => void): void }, initialRequests = 0) {
  const f = fixture(t);
  const requestIds: string[] = [];
  for (let index = 0; index < initialRequests; index++) {
    const current = grant(); current.snapshot.request_source.operation_slot = "operations_" + index; f.setGrant(current);
    const created = f.broker.create("request_" + index, { ...intent, operation_slot: "operations_" + index });
    if (created.status === "denied") throw Error(); requestIds.push(created.request_handle);
  }
  return { ...attachOperationsPolicy(f), requestIds };
}

export function attachOperationsPolicy<F extends Pick<ReturnType<typeof fixture>, "db" | "providers" | "marks">>(f: F) {
  installApprovalExecutionMarkerSchema(f.db); installApprovalSupervisorBindingSchema(f.db);
  const store = () => {
    let value: BindingGeneration | null = null;
    return { read: () => structuredClone(value), reserve: (_scope, expected, proposed) => {
      assert.deepEqual(value, expected); value = structuredClone(proposed); return structuredClone(value);
    } } satisfies BindingGenerationStore;
  };
  const bindingGenerations = store(), policyGenerations = store();
  const proofs: OperatorProofAuthority = (action, transaction_id, proposal_digest) => ["a", "b"].map(name => ({
    operator_id: "operator_" + name, credential_id: "hardware_" + name, credential_domain: "domain_" + name,
    credential_kind: "hardware_backed" as const, action, transaction_id, proposal_digest,
  })) as unknown as ReturnType<OperatorProofAuthority>;
  const bindingOperator = new SupervisorBindingOperator(f.db, f.providers, scope, bindingGenerations, proofs);
  bindingOperator.change("binding_bootstrap", "bootstrap", { team_id: scope.workspace_id, supervisor_user_id: "supervisor",
    reason: null, reason_digest: null, operation_scope_digest: null, target_scope_digest: null, expires_at: null });
  const binding = new SupervisorBindingRepository(f.db, f.providers.auditAnchors, f.providers.auditKeys, scope, bindingGenerations);
  installApprovalOperationsSchema(f.db);
  const operator = new OperationsPolicyOperator(f.db, f.providers, scope, binding, policyGenerations, proofs);
  const policies = new OperationsPolicyRepository(f.db, f.providers, scope, binding, policyGenerations);
  const proposal = { active: true, expires_at: "2026-09-20T00:00:00.000Z",
    provider_author: { user_id: "Ubot", bot_id: "Bbot" },
    grants: [{ principal_id: "local_operator", uid: process.getuid!(), actions: ["read", "expire", "reconcile", "retention", "backup", "restore"] as const }] };
  const provision = () => operator.change("policy_bootstrap", { ...proposal, grants: proposal.grants.map(grant => ({ ...grant, actions: [...grant.actions] })) });
  const audit = new AuditRepository(f.db, f.providers.auditAnchors, f.providers.auditKeys);
  const authorize = () => audit.readVerifiedState(state => policies.authorize(state, f.marks.read(), "expire"));
  return { ...f, operator, policies, binding, bindingOperator, bindingGenerations, policyGenerations, proposal, provision, authorize, audit };
}
