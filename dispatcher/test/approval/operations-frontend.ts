import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { operationsPolicyFixture } from "./fixtures/operations.js";
import type Database from "better-sqlite3";
import { openSecurityReadOnlyDatabase, withSecurityTransactionLock } from "../../src/audit/coordination.js";
import { ApprovalRecordSql } from "../../src/approval/record-sql.js";
import { ApprovalRecordRepository } from "../../src/approval/record-repository.js";
import { ApprovalPayloadRepository } from "../../src/approval/payload-repository.js";
import { attachOperationsPolicy } from "./fixtures/operations.js";
import { executionFixture } from "./fixtures/execution.js";
import { executionKey } from "./fixtures/execution.js";
import { scope, content, wrapping, notification } from "./fixtures/broker.js";
import { ApprovalOperations, ApprovalOperationsError } from "../../src/approval/operations.js";
import { ApprovalDecisionBroker } from "../../src/approval/decision-broker.js";
import { ApprovalRetention } from "../../src/approval/retention.js";
import { ApprovalBackupRestore } from "../../src/approval/backup-restore.js";
import { SupervisorBindingRepository } from "../../src/approval/supervisor-binding.js";
import { OperationsPolicyRepository } from "../../src/approval/operations-policy.js";
import { ApprovalHistoryTransaction } from "../../src/approval/history-transaction.js";
import { ApprovalRecordMutation } from "../../src/approval/record-mutation.js";
import { NativeOperationsConnection, readOperationsConfig } from "../../src/approval/operations-connection.js";
import { executeOperationsCommand, parseOperationsArguments, OperationsCommandError, runOperationsTick, runOperationsSweep,
  type OperationsFrontendConnection } from "../../src/approval/operations-frontend.js";
import type { OperationsConnectionConfig } from "../../src/approval/operations-connection.js";

function frontendFixture(t: { after(fn: () => void): void }, requests = 0) {
  const f = operationsPolicyFixture(t, requests); f.provision();
  const expiry = new ApprovalDecisionBroker(f.db, f.providers, scope, () => ({ status: "denied", reason: "unauthorized" }),
    () => content, () => wrapping, () => notification, undefined, f.policies);
  const retention = new ApprovalRetention(f.db, f.providers, scope, f.policies);
  const operations = new ApprovalOperations(f.db, f.providers, scope, undefined, (state, mark) => retention.countInState(state, mark));
  let restoreWasReadonly = false;
  const recovery = new ApprovalBackupRestore(f.db, f.providers, scope, operations, f.policies, candidate => {
    restoreWasReadonly = candidate.readonly;
    const binding = new SupervisorBindingRepository(candidate, f.providers.auditAnchors, f.providers.auditKeys, scope, f.bindingGenerations);
    return new OperationsPolicyRepository(candidate, f.providers, scope, binding, f.policyGenerations);
  }, { notification: () => notification, execution: () => executionKey });
  const config: OperationsConnectionConfig = { codec_version: 1, enabled: true, scope, workspace_alias: "fixture",
    database: f.filename, used_nodes_database: path.join(path.dirname(f.filename), "not_a_production_store"), evidence_directory: path.dirname(f.filename),
    ledger_id: "fixture", access_group: "ABCDEFGHIJ.lab.reirei.dona", audit_key_version: 1, provider_author: { user_id: "Ubot", bot_id: "Bbot" },
    sweep_interval_ms: 1000, sweep_page_budget: 1 };
  const connection: OperationsFrontendConnection = { db: f.db, providers: f.providers, config, policies: f.policies,
    operations, expiry, retention, recovery, reconcile: () => { throw Error("not used by expiry fixture"); } };
  return { ...f, connection, operations, expiry, recovery, retention, restoreReadonly: () => restoreWasReadonly };
}

test("CLI parserはbounded limit/dry-runを既定にし、actor/outcome/重複flagを拒否する", () => {
  assert.deepEqual(parseOperationsArguments(["list", "--config", "/private/config.json"]).command,
    { action: "list", limit: 100, cursor: null, state: "all", due_only: false });
  assert.equal((parseOperationsArguments(["expire", "--config", "/private/config.json", "--handle", "request"]).command as { apply: boolean }).apply, false);
  for (const options of [["--limit", "101"], ["--actor", "operator"], ["--outcome", "accepted"], ["--limit", "1", "--limit", "2"]])
    assert.throws(() => parseOperationsArguments(["list", "--config", "/private/config.json", ...options]), OperationsCommandError);
  assert.throws(() => parseOperationsArguments(["expire", "--config", "/private/config.json", "--handle", "request", "--apply"]), OperationsCommandError);
});

test("CLIのfilterは走査page後に適用し、cursorのfilter/scope/policyを再照合する", t => {
  const f = frontendFixture(t, 3), filter = { state: "expired" as const, due_only: false };
  const first = f.operations.listRequests(f.policies, { limit: 1, cursor: null, filter });
  assert.deepEqual(first.requests, []); assert.equal(first.has_more, true); assert.notEqual(first.cursor, null);
  const second = f.operations.listRequests(f.policies, { limit: 1, cursor: first.cursor, filter });
  assert.equal(second.has_more, true); assert.notEqual(second.cursor, first.cursor);
  const third = f.operations.listRequests(f.policies, { limit: 1, cursor: second.cursor, filter });
  assert.equal(third.has_more, false);
  assert.throws(() => f.operations.listRequests(f.policies, { limit: 1, cursor: first.cursor, filter: { state: "all", due_only: false } }), ApprovalOperationsError);
  f.operator.change("revoke_policy", { active: false, expires_at: f.proposal.expires_at,
    grants: [{ principal_id: "local_operator", uid: process.getuid!(), actions: ["read"] }] });
  assert.throws(() => f.operations.listRequests(f.policies, { limit: 1, cursor: first.cursor, filter }), ApprovalOperationsError);
});

test("dry-runはclock/anchorを変更せず、exact confirmだけが単件expiryを保存する", t => {
  const f = frontendFixture(t, 1); f.setNow("2026-09-19T00:15:00.000Z");
  const command = { action: "expire" as const, handle: f.requestIds[0]!, apply: false, confirm: null }, anchor = f.anchors.read(), mark = f.marks.read();
  const preview = executeOperationsCommand(f.connection, command) as { confirmation: string };
  assert.deepEqual(f.anchors.read(), anchor); assert.deepEqual(f.marks.read(), mark);
  assert.throws(() => executeOperationsCommand(f.connection, { ...command, apply: true, confirm: "0".repeat(64) }), OperationsCommandError);
  const result = executeOperationsCommand(f.connection, { ...command, apply: true, confirm: preview.confirmation });
  assert.equal((result as { status: string }).status, "decided");
  assert.equal(f.records.read("request", command.handle)?.row.state, "expired");
  assert.throws(() => executeOperationsCommand(f.connection, { ...command, apply: true, confirm: preview.confirmation }), OperationsCommandError);
  assert.equal(f.records.read("decision", command.handle)?.row.kind, "expire");
});

test("dry-run後のpolicy更新とwriter lock内のrevision不一致で旧confirmationを拒否する", t => {
  const f = frontendFixture(t, 1), command = { action: "expire" as const, handle: f.requestIds[0]!, apply: false, confirm: null };
  const preview = executeOperationsCommand(f.connection, command) as { confirmation: string };
  f.operator.change("rotate_policy", { active: true, expires_at: f.proposal.expires_at,
    grants: [{ principal_id: "local_operator", uid: process.getuid!(), actions: ["read", "expire"] }] });
  assert.throws(() => executeOperationsCommand(f.connection, { ...command, apply: true, confirm: preview.confirmation }), OperationsCommandError);
  assert.deepEqual(f.expiry.expire("stale_policy", command.handle, 1, 1), { status: "denied", reason: "revision_mismatch" });
});

test("sweep重複/restartは同じdecisionを作り直さず、監査と永久fenceを保持する", t => {
  const f = frontendFixture(t, 2), empty = { expiry: null, request_retention: null, attempt_retention: null };
  f.setNow("2026-09-19T00:15:00.000Z");
  runOperationsTick(f.connection, 1, empty);
  const decisions = f.requestIds.map(handle => f.records.read("decision", handle)?.row.decision_id);
  runOperationsTick(f.connection, 1, empty); // fresh process starts with no cursor
  assert.deepEqual(f.requestIds.map(handle => f.records.read("decision", handle)?.row.decision_id), decisions);
  assert.equal(f.db.prepare("SELECT count(*) FROM approval_requests").pluck().get(), 2);
  assert.equal(f.db.prepare("SELECT count(*) FROM approval_decisions").pluck().get(), 2);
  assert.equal(f.db.prepare("SELECT count(*) FROM approval_payload_secrets").pluck().get(), 0);
  assert.equal(f.operations.health(f.policies).counts?.retention_overdue, 0);
});

test("常駐loopは起動時だけでなく次tickの期限到達を処理し、abortで終了する", async t => {
  const f = frontendFixture(t, 1), controller = new AbortController();
  const running = runOperationsSweep(f.connection, 1, controller.signal);
  assert.equal(f.records.read("request", f.requestIds[0]!)?.row.state, "delivery_pending");
  f.setNow("2026-09-19T00:15:00.000Z");
  await new Promise(resolve => setTimeout(resolve, 1250)); controller.abort();
  assert.deepEqual(await running, { status: "stopped" });
  assert.equal(f.records.read("request", f.requestIds[0]!)?.row.state, "expired");
});

test("retentionは期限を過ぎたactive requestを保護しsecretを削除しない", t => {
  const f = frontendFixture(t, 1); f.setNow("2026-09-19T00:15:00.000Z");
  const command = { action: "retention" as const, handle: f.requestIds[0]!, owner_kind: "request" as const, apply: false, confirm: null };
  const preview = executeOperationsCommand(f.connection, command) as { confirmation: string; eligible: boolean };
  assert.equal(preview.eligible, false);
  assert.deepEqual(executeOperationsCommand(f.connection, { ...command, apply: true, confirm: preview.confirmation }), { status: "protected" });
  assert.equal(f.db.prepare("SELECT count(*) FROM approval_payload_secrets").pluck().get(), 1);
});

test("retention exact境界は本文だけを消し、tombstone/record/index/auditを保持する", t => {
  const f = frontendFixture(t, 1), handle = f.requestIds[0]!;
  // Fixture-only legacy terminal row whose body was not yet collected.
  const mutations = new ApprovalRecordMutation(f.db, scope), transaction = new ApprovalHistoryTransaction(f.db, f.providers, scope);
  transaction.runPrepared("fixture_terminal", (mark, state) => {
    const previous = f.records.readInState(state, "request", handle)!;
    return { event: { scope: { instance_id: scope.instance_id, tenant_id: scope.workspace_id }, actor: { kind: "system" as const, id: "fixture" },
      action: "retention" as const, operation: "audit.retain.v1" as const, resource_id: handle, outcome: "succeeded" as const,
      reason: "none" as const, session_ref: null, receipt_id: null, attempt_id: null, policy_revision: 1, binding_revision: 1, authz_revision: 1 },
      ...mutations.prepare(mark, state, [{ previous, next: { ...previous, row: { ...previous.row, state: "expired", revision: previous.row.revision + 1 } } }]) };
  });
  const command = { action: "retention" as const, handle, owner_kind: "request" as const, apply: false, confirm: null };
  f.operator.change("extend_retention_policy", { active: true, expires_at: "2026-09-21T00:00:00.000Z",
    grants: [{ principal_id: "local_operator", uid: process.getuid!(), actions: ["read", "retention"] }] });
  const expiresAt = f.payloads.inspect("request", handle)!.metadata.binding.expires_at;
  f.setNow(new Date(Date.parse(expiresAt) - 1).toISOString());
  assert.equal((executeOperationsCommand(f.connection, command) as { eligible: boolean }).eligible, false);
  f.setNow(expiresAt);
  assert.equal(f.operations.health(f.policies).counts?.retention_overdue, 1);
  const preview = executeOperationsCommand(f.connection, command) as { confirmation: string; eligible: boolean }; assert.equal(preview.eligible, true);
  assert.deepEqual(executeOperationsCommand(f.connection, { ...command, apply: true, confirm: preview.confirmation }), { status: "deleted" });
  assert.equal(f.records.read("request", handle)?.row.state, "expired");
  assert.equal(f.payloads.inspect("request", handle)?.metadata.state, "deleted");
  assert.equal(f.payloads.inspect("request", handle)?.secret.status, "deleted");
  assert.equal(f.operations.health(f.policies).counts?.retention_overdue, 0);
  assert.throws(() => executeOperationsCommand(f.connection, { ...command, apply: true, confirm: preview.confirmation }), OperationsCommandError);
});

test("metadata Online Backupはenvelopeを永続化せず、active本文欠落restoreをsafe-offにする", t => {
  const f = frontendFixture(t, 1), destination = path.join(path.dirname(f.filename), "metadata.sqlite");
  const envelope = f.db.prepare("SELECT envelope_json FROM approval_payload_secrets LIMIT 1").pluck().get() as string;
  const result = f.recovery.backup(destination, 1);
  assert.equal(result.omitted_payloads, true); assert.equal(fs.statSync(destination).mode & 0o077, 0);
  assert.equal(fs.readFileSync(destination).includes(Buffer.from(envelope)), false);
  assert.deepEqual(f.recovery.verifyRestore(destination), { status: "needs_review", safe_ready: false });
  assert.equal(f.db.prepare("SELECT count(*) FROM approval_payload_secrets").pluck().get(), 1);
});

test("同一instance/binding/clock/auditのmetadata restoreだけをcontinuity_verifiedにする", t => {
  const f = frontendFixture(t), destination = path.join(path.dirname(f.filename), "metadata.sqlite");
  f.recovery.backup(destination, 1);
  assert.deepEqual(f.recovery.verifyRestore(destination), { status: "continuity_verified", safe_ready: false });
  f.operator.change("rotate_after_backup", { active: true, expires_at: f.proposal.expires_at,
    grants: [{ principal_id: "local_operator", uid: process.getuid!(), actions: ["read", "restore"] }] });
  assert.deepEqual(f.recovery.verifyRestore(destination), { status: "needs_review", safe_ready: false });
});

test("sweepのclock異常や権限失効を自動retryせず停止する", async t => {
  const f = frontendFixture(t, 1), observe = f.providers.clock.observe;
  f.providers.clock.observe = () => ({ ...observe(), boot_id: "new_boot" });
  await assert.rejects(runOperationsSweep(f.connection, 1, new AbortController().signal));
  assert.equal(f.records.read("decision", f.requestIds[0]!), null);
  assert.equal(f.operations.health(f.policies).ready, false);
});

test("native frontendは未設定/disabled configurationをfixture fallbackへ置換しない", t => {
  const f = frontendFixture(t), configFile = path.join(path.dirname(f.filename), "disabled.json");
  fs.writeFileSync(configFile, JSON.stringify({ ...f.connection.config, enabled: false }), { mode: 0o600 });
  assert.throws(() => readOperationsConfig(configFile), /configuration_unavailable/);
  assert.throws(() => new NativeOperationsConnection(configFile), /safe_off/);
  assert.throws(() => new NativeOperationsConnection(path.join(path.dirname(f.filename), "missing.json")), /safe_off/);
});


test("previewからwriter lockまでの失効は監査付きdenialとなりclock continuityを壊さない", t => {
  const f = frontendFixture(t, 1); f.setNow("2026-09-19T00:15:00.000Z");
  const command = { action: "expire" as const, handle: f.requestIds[0]!, apply: false, confirm: null };
  const preview = executeOperationsCommand(f.connection, command) as { confirmation: string };
  const expire = f.expiry.expire.bind(f.expiry);
  f.expiry.expire = (...args) => {
    f.operator.change("revoke_between_preview_lock", { active: false, expires_at: f.proposal.expires_at,
      grants: [{ principal_id: "local_operator", uid: process.getuid!(), actions: ["read"] }] });
    return expire(...args);
  };
  assert.deepEqual(executeOperationsCommand(f.connection, { ...command, apply: true, confirm: preview.confirmation }),
    { status: "denied", reason: "unauthorized" });
  assert.equal(f.records.read("decision", command.handle), null);
  assert.equal(f.policies.read()?.active, false);
  f.operator.change("reactivate_after_denial", { ...f.proposal, grants: f.proposal.grants.map(grant => ({ ...grant, actions: [...grant.actions] })) });
  assert.notEqual(f.operations.health(f.policies).counts, null);
});

test("restoreはboot不一致やbinding世代不一致でsafe-offを維持する", t => {
  for (const mismatch of ["boot", "binding"] as const) {
    const f = frontendFixture(t), destination = path.join(path.dirname(f.filename), "restore.sqlite");
    f.recovery.backup(destination, 1);
    if (mismatch === "boot") {
      const observe = f.providers.clock.observe;
      f.providers.clock.observe = () => ({ ...observe(), boot_id: "different_boot" });
    } else f.bindingOperator.change("binding_rotate_after_backup", "rotate", { team_id: scope.workspace_id,
      supervisor_user_id: "replacement", reason: null, reason_digest: null, operation_scope_digest: null, target_scope_digest: null, expires_at: null });
    assert.deepEqual(f.recovery.verifyRestore(destination), { status: "needs_review", safe_ready: false });
  }
});


test("least privilegeのbackup-onlyとexpire/retention-onlyをread grantへ拡大しない", t => {
  const f = frontendFixture(t, 1);
  f.operator.change("sweep_only", { active: true, expires_at: f.proposal.expires_at,
    grants: [{ principal_id: "local_operator", uid: process.getuid!(), actions: ["expire", "retention"] }] });
  assert.throws(() => f.operations.listRequests(f.policies, { limit: 1, cursor: null, filter: { state: "all", due_only: false } }));
  const sweep = { action: "sweep" as const, apply: false, confirm: null };
  const preview = executeOperationsCommand(f.connection, sweep) as { confirmation: string };
  assert.equal((executeOperationsCommand(f.connection, { ...sweep, apply: true, confirm: preview.confirmation }) as { status: string }).status, "sweep_authorized");
  f.setNow("2026-09-19T00:15:00.000Z");
  runOperationsTick(f.connection, 2, { expiry: null, request_retention: null, attempt_retention: null });
  assert.equal(f.records.read("request", f.requestIds[0]!)?.row.state, "expired");
  f.operator.change("backup_only", { active: true, expires_at: f.proposal.expires_at,
    grants: [{ principal_id: "local_operator", uid: process.getuid!(), actions: ["backup"] }] });
  const command = { action: "backup" as const, destination: path.join(path.dirname(f.filename), "least.sqlite"), apply: false, confirm: null };
  const backup = executeOperationsCommand(f.connection, command) as { confirmation: string };
  assert.equal((executeOperationsCommand(f.connection, { ...command, apply: true, confirm: backup.confirmation }) as { status: string }).status, "backed_up");
});

test("restore-checkはread-onlyで候補とdirectoryを変更せず、hot journalを回復しない", t => {
  const f = frontendFixture(t), directory = path.dirname(f.filename), candidate = path.join(directory, "readonly.sqlite");
  f.recovery.backup(candidate, 1);
  const bytes = fs.readFileSync(candidate), files = fs.readdirSync(directory).sort();
  assert.equal(f.recovery.verifyRestore(candidate).status, "continuity_verified");
  assert.equal(f.restoreReadonly(), true); assert.deepEqual(fs.readFileSync(candidate), bytes); assert.deepEqual(fs.readdirSync(directory).sort(), files);
  fs.writeFileSync(candidate + "-journal", "fixture hot journal", { mode: 0o600 });
  assert.equal(f.recovery.verifyRestore(candidate).status, "needs_review");
  assert.equal(fs.readFileSync(candidate + "-journal", "utf8"), "fixture hot journal"); assert.deepEqual(fs.readFileSync(candidate), bytes);
});

test("backupは別scopeの監査recordや無関係なtableをcurrent scope認可だけで持ち出さない", t => {
  for (const unrelated of [false, true]) {
    const f = frontendFixture(t), candidate = path.join(path.dirname(f.filename), "forbidden.sqlite");
    if (unrelated) f.db.exec("CREATE TABLE unrelated_private_context(body TEXT)");
    else f.audit.append("foreign_audit", 1, { occurred_at: "2026-09-19T00:00:00.000Z",
      scope: { instance_id: scope.instance_id, tenant_id: "another_workspace" }, actor: { kind: "system" as const, id: "fixture" },
      action: "retention" as const, operation: "audit.retain.v1" as const, resource_id: "foreign", outcome: "succeeded" as const,
      reason: "none" as const, session_ref: null, receipt_id: null, attempt_id: null, policy_revision: 1, binding_revision: 1, authz_revision: 1 },
      () => null);
    assert.throws(() => f.recovery.backup(candidate, 1)); assert.equal(fs.existsSync(candidate), false);
  }
});

test("backup digestはfile全体のBuffer読込に依存しない", t => {
  const f = frontendFixture(t), destination = path.join(path.dirname(f.filename), "chunked.sqlite"), read = fs.readFileSync;
  fs.readFileSync = ((file: Parameters<typeof read>[0], ...args: unknown[]) => {
    if (typeof file === "string" && path.basename(file).startsWith(".approval-backup-")) throw Error("fixture disallows unbounded read");
    return (read as (...values: unknown[]) => unknown)(file, ...args);
  }) as typeof read;
  try { assert.equal(f.recovery.backup(destination, 1).status, "backed_up"); }
  finally { fs.readFileSync = read; }
});

function terminalRestoreFixture(t: { after(fn: () => void): void }) {
  const base = executionFixture(t); base.execution.start("start", base.executionCommand()); base.execution.resolve("settle", base.executionCommand());
  const f = attachOperationsPolicy(base); f.provision(); const operations = new ApprovalOperations(f.db, f.providers, scope);
  const recovery = new ApprovalBackupRestore(f.db, f.providers, scope, operations, f.policies, candidate => {
    const binding = new SupervisorBindingRepository(candidate, f.providers.auditAnchors, f.providers.auditKeys, scope, f.bindingGenerations);
    return new OperationsPolicyRepository(candidate, f.providers, scope, binding, f.policyGenerations);
  }, { notification: () => notification, execution: () => executionKey });
  const candidate = path.join(path.dirname(f.filename), "terminal.sqlite"); recovery.backup(candidate, 1);
  assert.equal(recovery.verifyRestore(candidate).status, "continuity_verified");
  return { ...f, recovery, candidate };
}

test("restoreはverified readerが返したdecision/consumeの保存時刻も独立して履歴へ照合する", t => {
  const execution = terminalRestoreFixture(t), expired = frontendFixture(t, 1), read = ApprovalRecordRepository.prototype.readListPageInState;
  expired.setNow("2026-09-19T00:15:00.000Z"); expired.expiry.expire("expire_for_history", expired.requestIds[0]!, 1, 1);
  const expiryCandidate = path.join(path.dirname(expired.filename), "expired.sqlite"); expired.recovery.backup(expiryCandidate, 1);
  assert.equal(expired.recovery.verifyRestore(expiryCandidate).status, "continuity_verified");
  for (const kind of ["decision", "consume"] as const) {
    const f = kind === "decision" ? { recovery: expired.recovery, candidate: expiryCandidate } : execution;
    // Fault injection at the repository boundary models an authenticated legacy
    // image with valid clock references but mismatched owner timestamps.
    ApprovalRecordRepository.prototype.readListPageInState = function (...args) {
      const page = read.apply(this, args);
      if (!(this as unknown as { db: Database.Database }).db.readonly) return page;
      return { ...page, records: page.records.map(record => record.kind !== kind ? record : { ...record,
        row: { ...record.row, ...(record.kind === "decision" ? { decided_at: "2026-09-19T00:00:00.001Z" } : { claimed_at: "2026-09-19T00:00:00.001Z" }) } }) } as typeof page;
    };
    try { assert.equal(f.recovery.verifyRestore(f.candidate).status, "needs_review"); }
    finally { ApprovalRecordRepository.prototype.readListPageInState = read; }
  }
});

test("restoreはtombstoneもrequest/attemptのpayload bindingへ照合する", t => {
  const f = terminalRestoreFixture(t), inspect = ApprovalPayloadRepository.prototype.inspectInState;
  for (const kind of ["request", "attempt"] as const) {
    ApprovalPayloadRepository.prototype.inspectInState = function (...args) {
      const payload = inspect.apply(this, args);
      if (!(this as unknown as { db: Database.Database }).db.readonly || args[1] !== kind || payload === null) return payload;
      return { ...payload, metadata: { ...payload.metadata, binding: { ...payload.metadata.binding, semantic_hash: "0".repeat(64) } } };
    };
    try { assert.equal(f.recovery.verifyRestore(f.candidate).status, "needs_review"); }
    finally { ApprovalPayloadRepository.prototype.inspectInState = inspect; }
  }
});

test("restoreはnotification/execution markerの欠落・失効・取り違え鍵をsafe-offにする", t => {
  const f = terminalRestoreFixture(t);
  for (const kind of ["notification", "execution"] as const) for (const fault of ["missing", "revoked", "wrong"] as const) {
    const recovery = new ApprovalBackupRestore(f.db, f.providers, scope, new ApprovalOperations(f.db, f.providers, scope), f.policies, candidate => {
      const binding = new SupervisorBindingRepository(candidate, f.providers.auditAnchors, f.providers.auditKeys, scope, f.bindingGenerations);
      return new OperationsPolicyRepository(candidate, f.providers, scope, binding, f.policyGenerations);
    }, { notification: () => { if (kind === "notification" && fault === "missing") throw Error();
      return { ...notification, ...(kind === "notification" ? fault === "revoked" ? { state: "revoked" as const } : fault === "wrong" ? { secret: Buffer.alloc(32) } : {} : {}) }; },
      execution: () => { if (kind === "execution" && fault === "missing") throw Error();
        return { ...executionKey, ...(kind === "execution" ? fault === "revoked" ? { state: "revoked" as const } : fault === "wrong" ? { secret: Buffer.alloc(32) } : {} : {}) }; } });
    assert.equal(recovery.verifyRestore(f.candidate).status, "needs_review");
  }
});


test("read-only admissionはwrite lockや同内容stageの許可へ転用できない", t => {
  const f = frontendFixture(t, 1); f.setNow("2026-09-19T00:15:00.000Z"); f.expiry.expire("expire_for_readonly", f.requestIds[0]!, 1, 1);
  const destination = path.join(path.dirname(f.filename), "read_admission.sqlite"); f.recovery.backup(destination, 1);
  const candidate = openSecurityReadOnlyDatabase(destination), before = fs.readFileSync(destination);
  try {
    const sql = new ApprovalRecordSql(candidate, scope), row = f.records.read("request", f.requestIds[0]!)!;
    assert.throws(() => withSecurityTransactionLock(candidate, () => null));
    assert.throws(() => candidate.transaction(() => sql.stage([{ previous: row, next: row }]))());
    assert.deepEqual(fs.readFileSync(destination), before);
  } finally { candidate.close(); }
});

test("期限前のexpire確認値は期限到達後に再利用できない", t => {
  const f = frontendFixture(t, 1), command = { action: "expire" as const, handle: f.requestIds[0]!, apply: false, confirm: null };
  const before = executeOperationsCommand(f.connection, command) as { eligible: boolean; confirmation: string };
  assert.equal(before.eligible, false);
  f.setNow("2026-09-19T00:15:00.000Z");
  assert.throws(() => executeOperationsCommand(f.connection, { ...command, apply: true, confirm: before.confirmation }), OperationsCommandError);
  assert.equal(f.records.read("request", command.handle)?.row.state, "delivery_pending");
  const due = executeOperationsCommand(f.connection, command) as { eligible: boolean; confirmation: string };
  assert.equal(due.eligible, true); assert.notEqual(due.confirmation, before.confirmation);
});

test("sweepは最初のexpire認可拒否で停止し、次の候補を実行しない", t => {
  const f = frontendFixture(t, 2); f.setNow("2026-09-19T00:15:00.000Z"); let calls = 0;
  const expire = f.expiry.expire.bind(f.expiry);
  f.expiry.expire = (...args) => {
    calls++; f.operator.change("revoke_in_tick", { active: false, expires_at: f.proposal.expires_at,
      grants: [{ principal_id: "local_operator", uid: process.getuid!(), actions: ["read", "expire", "retention"] }] });
    return expire(...args);
  };
  assert.throws(() => runOperationsTick(f.connection, 1, { expiry: null, request_retention: null, attempt_retention: null }), OperationsCommandError);
  assert.equal(calls, 1); assert.equal(f.requestIds.filter(id => f.records.read("request", id)?.row.state === "expired").length, 0);
});

test("sweepは最初のretention拒否で停止し、次の候補を実行しない", t => {
  const f = frontendFixture(t, 2); let calls = 0;
  f.retention.pageInState = () => ({ candidates: f.requestIds.map(owner_handle => ({ owner_kind: "request" as const,
    owner_handle, metadata_digest: "0".repeat(64) })), has_more: false, next_after: null });
  const retain = f.retention.retain.bind(f.retention);
  f.retention.retain = (...args) => {
    calls++; f.operator.change("revoke_retention_in_tick", { active: false, expires_at: f.proposal.expires_at,
      grants: [{ principal_id: "local_operator", uid: process.getuid!(), actions: ["read", "expire", "retention"] }] });
    return retain(...args);
  };
  assert.throws(() => runOperationsTick(f.connection, 1, { expiry: null, request_retention: null, attempt_retention: null }), OperationsCommandError);
  assert.equal(calls, 1);
});

test("start前にneeds_reviewとなった未送信attemptはmarkerなしで復元検証できる", t => {
  const base = executionFixture(t); base.setNow(base.attempt().row.execution_expires_at);
  base.execution.start("expired_start", base.executionCommand());
  assert.equal(base.attempt().row.state, "needs_review"); assert.equal(base.attempt().row.fence, 2);
  assert.equal(base.markerStore.read(base.claim.attempt_handle), null);
  const f = attachOperationsPolicy(base); f.provision(); const operations = new ApprovalOperations(f.db, f.providers, scope);
  const recovery = new ApprovalBackupRestore(f.db, f.providers, scope, operations, f.policies, candidate => {
    const binding = new SupervisorBindingRepository(candidate, f.providers.auditAnchors, f.providers.auditKeys, scope, f.bindingGenerations);
    return new OperationsPolicyRepository(candidate, f.providers, scope, binding, f.policyGenerations);
  }, { notification: () => notification, execution: () => executionKey });
  const candidate = path.join(path.dirname(f.filename), "unsent.sqlite"); recovery.backup(candidate, 1);
  assert.equal(recovery.verifyRestore(candidate).status, "continuity_verified");
});


test("期限前applyはpreview直後に期限へ達してもexpiryを実行しない", t => {
  const f = frontendFixture(t, 1), command = { action: "expire" as const, handle: f.requestIds[0]!, apply: false, confirm: null };
  const before = executeOperationsCommand(f.connection, command) as { confirmation: string };
  const observe = f.operations.authorizedObservation.bind(f.operations);
  f.operations.authorizedObservation = ((...args: Parameters<typeof observe>) => {
    const result = observe(...args); f.setNow("2026-09-19T00:15:00.000Z"); return result;
  }) as typeof f.operations.authorizedObservation;
  assert.deepEqual(executeOperationsCommand(f.connection, { ...command, apply: true, confirm: before.confirmation }), { status: "not_due" });
  assert.equal(f.records.read("request", command.handle)?.row.state, "delivery_pending");
});
