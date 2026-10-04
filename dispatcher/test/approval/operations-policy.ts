import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditRepository } from "../../src/audit/repository.js";
import { AuditIntegrityError } from "../../src/audit/codec.js";
import { fixture, scope } from "./fixtures/broker.js";
import { installApprovalExecutionMarkerSchema, installApprovalSupervisorBindingSchema,
  installApprovalOperationsSchema, verifyApprovalOperationsSchema } from "../../src/approval/schema.js";
import { SupervisorBindingOperator, SupervisorBindingRepository, type BindingGeneration,
  type BindingGenerationStore, type OperatorProofAuthority } from "../../src/approval/supervisor-binding.js";
import { OperationsPolicyOperator, OperationsPolicyRepository, OperationsAuthorizationError } from "../../src/approval/operations-policy.js";

import { operationsPolicyFixture } from "./fixtures/operations.js";

test("operations schema migrationは既存rootとbindingを保持し、権限を自動作成しない", t => {
  const f = operationsPolicyFixture(t), anchor = f.anchors.read();
  verifyApprovalOperationsSchema(f.db); installApprovalOperationsSchema(f.db);
  assert.deepEqual(f.anchors.read(), anchor);
  assert.equal(f.policies.read(), null); assert.equal(f.binding.read()?.revision, 1);
  assert.throws(f.authorize, AuditIntegrityError);
});

test("OS uidと監査policyと保護generationの三方向照合でcurrent操作を認可する", t => {
  const f = operationsPolicyFixture(t), policy = f.provision();
  assert.deepEqual(f.policies.read(), policy);
  assert.deepEqual(f.authorize(), { principal_id: "local_operator", policy_revision: 1, binding_revision: 1 });
  assert.equal(JSON.stringify(f.authorize()).includes(String(process.getuid!())), false);
});

test("policy失効・uid不一致・操作scopeなしはdry-run後でも拒否する", t => {
  for (const change of ["revoked", "uid", "action", "expired"] as const) {
    const f = operationsPolicyFixture(t); f.provision(); f.authorize();
    f.operator.change("policy_rotate", { active: change !== "revoked", expires_at: "2026-09-19T00:00:01.000Z",
      grants: [{ principal_id: "local_operator", uid: process.getuid!() + Number(change === "uid"), actions: change === "action" ? ["read"] : ["expire"] }] });
    if (change === "expired") f.setNow("2026-09-19T00:00:01.000Z");
    // prepare内へ渡す観測markの時刻。保護markの更新はbrokerで行う。
    const mark = { ...f.marks.read(), effective_utc: change === "expired" ? "2026-09-19T00:00:01.000Z" : f.marks.read().effective_utc };
    assert.throws(() => f.audit.readVerifiedState(state => f.policies.authorize(state, mark, "expire")), AuditIntegrityError);
  }
});

test("binding rotation/revokeは保存済みpolicyを再利用させない", t => {
  const f = operationsPolicyFixture(t); f.provision(); f.authorize();
  f.bindingOperator.change("binding_rotate", "rotate", { team_id: scope.workspace_id, supervisor_user_id: "new_supervisor",
    reason: null, reason_digest: null, operation_scope_digest: null, target_scope_digest: null, expires_at: null });
  assert.throws(f.authorize, AuditIntegrityError);
});

test("OS real/effective uidの不一致をprincipal引数で代替しない", t => {
  const f = operationsPolicyFixture(t); f.provision();
  const original = process.geteuid!;
  try { process.geteuid = () => process.getuid!() + 1; assert.throws(f.authorize, AuditIntegrityError); }
  finally { process.geteuid = original; }
});

test("ordinary SQLのpolicy改変・generationの巻戻しは失効扱いでなくintegrity failure", t => {
  const f = operationsPolicyFixture(t), original = f.provision();
  const wire = JSON.stringify({ ...original, active: false });
  // revision trigger自体は保持したまま改変。audit/generationは更新できない。
  f.db.prepare("UPDATE approval_operations_policy SET policy_json=?,revision=revision+1").run(wire);
  assert.throws(() => f.policies.read(), OperationsAuthorizationError);
  assert.throws(f.authorize, AuditIntegrityError);
});

test("generation CAS後のDB障害は成功にせず、blind retryを拒否する", t => {
  const f = operationsPolicyFixture(t), prepare = f.db.prepare.bind(f.db);
  f.db.prepare = ((sql: string) => { if (sql.startsWith("INSERT INTO main.approval_operations_policy")) throw Error("fixture_db_failure"); return prepare(sql); }) as typeof f.db.prepare;
  assert.throws(f.provision, OperationsAuthorizationError);
  f.db.prepare = prepare;
  assert.equal(prepare("SELECT count(*) FROM approval_operations_policy").pluck().get(), 0);
  assert.notEqual(f.policyGenerations.read(), null);
  assert.throws(() => f.policies.read(), OperationsAuthorizationError);
  assert.throws(f.provision, OperationsAuthorizationError);
});

test("policy getterと重複uid/principalを認証前に拒否する", t => {
  const f = operationsPolicyFixture(t); let called = false;
  assert.throws(() => f.operator.change("getter", { get active() { called = true; return true; }, expires_at: f.proposal.expires_at,
    grants: [{ principal_id: "local_operator", uid: process.getuid!(), actions: ["read"] }] }), OperationsAuthorizationError);
  assert.equal(called, false);
  assert.throws(() => f.operator.change("duplicate", { active: true, expires_at: f.proposal.expires_at,
    grants: ["one", "two"].map(principal_id => ({ principal_id, uid: process.getuid!(), actions: ["read"] })) }), OperationsAuthorizationError);
  assert.equal(f.policyGenerations.read(), null);
});
