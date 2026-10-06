import assert from "node:assert/strict";
import { test } from "node:test";
import { executionReceiptGrantSchema } from "../../src/approval/execution-authority.js";
import { notificationReceiptGrantSchema } from "../../src/approval/notification-authority.js";

test("receipt proofはreconcileのoperator監査fieldを必須にしcallbackへの混入を拒否する", () => {
  for (const [schema, target] of [[executionReceiptGrantSchema, { attempt_id: "attempt", execution_fence: 2 }],
    [notificationReceiptGrantSchema, { notification_id: "notification", delivery_fence: 2 }]] as const) {
    const base = { status: "verified", scope: { instance_id: "instance", workspace_id: "workspace" }, consumer_id: "operator",
      ...target, receipt: { outcome: "unknown" } };
    assert.equal(schema.safeParse({ ...base, proof_kind: "callback" }).success, true);
    const operator = { operator_context_ref: "reason_evidence_digest", operator_revision: 3 };
    assert.equal(schema.safeParse({ ...base, proof_kind: "reconcile", ...operator }).success, true);
    for (const context of [{}, { operator_context_ref: operator.operator_context_ref }, { operator_revision: 3 }])
      assert.equal(schema.safeParse({ ...base, proof_kind: "reconcile", ...context }).success, false);
    for (const context of [{ operator_context_ref: operator.operator_context_ref }, { operator_revision: 3 }, operator])
      assert.equal(schema.safeParse({ ...base, proof_kind: "callback", ...context }).success, false);
  }
});
