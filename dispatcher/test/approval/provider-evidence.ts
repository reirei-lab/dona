import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { SlackApprovalEvidenceProbe, slackApprovalEvidenceMetadata } from "../../../sources/slack/src/approval-evidence.js";
import type { SlackWorkspaceRegistry } from "../../../sources/slack/src/workspace-registry.js";
import { DurableProviderEvidence, OperationsReconcileAuthority, ProviderEvidenceError, type ProviderEvidenceKey } from "../../src/approval/provider-evidence.js";
import { ApprovalRequestLifecycle } from "../../src/approval/request-lifecycle.js";
import { ApprovalExecutionBroker } from "../../src/approval/execution-broker.js";
import { SupervisorBindingGuard } from "../../src/approval/supervisor-binding.js";
import { ApprovalRetention } from "../../src/approval/retention.js";
import { ApprovalOperations } from "../../src/approval/operations.js";
import { ApprovalNotificationBroker } from "../../src/approval/notification-broker.js";
import { notificationFixture } from "./fixtures/notification.js";
import { notification as notificationKey } from "./fixtures/broker.js";
import { executionFixture, executionKey } from "./fixtures/execution.js";
import { attachOperationsPolicy } from "./fixtures/operations.js";
import { scope, content, wrapping } from "./fixtures/broker.js";

const key: ProviderEvidenceKey = { version: 1, purpose: "approval_provider_evidence", state: "active",
  activated_at: "2026-09-01T00:00:00.000Z", signing_expires_at: "2026-11-01T00:00:00.000Z", secret: Buffer.alloc(32, 119) };
const author = { user_id: "Ubot", bot_id: "Bbot" };
function evidenceFixture(t: { after(fn: () => void): void }) {
  const base = executionFixture(t); base.execution.start("start", base.executionCommand()); base.execution.recover("recover", base.executionCommand());
  const f = attachOperationsPolicy(base); f.provision();
  const marker = f.markerStore.read(f.attempt().row.attempt_id)!;
  const query = { ...scope, kind: "execution" as const, request_id: f.requestId, attempt_id: f.attempt().row.attempt_id,
    semantic_hash: f.read().row.semantic_hash, fence: marker.marker.execution_fence, mac: marker.mac };
  const lifecycle = new ApprovalRequestLifecycle(f.db, f.providers, scope), target = lifecycle.snapshot(f.read()).target;
  const directory = path.dirname(f.filename), evidence = new DurableProviderEvidence(directory, () => key);
  const authority = new OperationsReconcileAuthority(f.policies, evidence, lifecycle, "operator confirmed provider record", author, 1);
  const denied = () => ({ status: "denied" as const, reason: "unauthorized" as const });
  const guard = new SupervisorBindingGuard(f.binding, "fixture", () => { throw Error("dispatch disabled"); });
  const broker = new ApprovalExecutionBroker(f.db, f.providers, scope, denied, denied, authority.execution,
    () => content, () => wrapping, () => executionKey, guard);
  const message = (index = 0) => ({ ts: index === 0 ? target.thread_ts : target.thread_ts.replace(/.$/, "2"), threadTs: target.thread_ts,
    userId: author.user_id, botId: author.bot_id, metadata: slackApprovalEvidenceMetadata(query) });
  const capture = async (messages: ReturnType<typeof message>[], complete = true, queryInput = query, reference = "evidence") => {
    const connection = { alias: "fixture", teamId: scope.workspace_id, botUserId: author.user_id, botId: author.bot_id,
      client: { authenticate: async () => ({ teamId: scope.workspace_id, botUserId: author.user_id, botId: author.bot_id }),
        getApprovalEvidencePage: async () => ({ messages, hasMore: !complete }) } } as unknown as ReturnType<SlackWorkspaceRegistry["get"]>;
    const registry = { get: () => connection, getByTeamId: () => connection };
    return new SlackApprovalEvidenceProbe(registry, { ...key, state: "active" }, () => new Date("2026-09-19T00:00:00.000Z"))
      .capture(directory, "fixture", queryInput, target, reference);
  };
  const resolve = (reference = "evidence") => broker.resolve("resolve_" + reference, { attempt_handle: query.attempt_id,
    expected_fence: f.attempt().row.fence, authority_ref: reference });
  return { ...f, query, target, capture, message, resolve, evidence, authority, directory };
}

test("実Slack adapterの署名/custodyからexact durable recordをbrokerへ通してreconcileする", async t => {
  const f = evidenceFixture(t); await f.capture([f.message()]);
  assert.equal(f.evidence.read("evidence").observation.candidates.length, 1);
  const result = f.resolve(); assert.equal(result.status, "updated"); assert.equal(f.attempt().row.state, "succeeded");
  const records = f.db.prepare("SELECT record_json FROM security_audit_records ORDER BY sequence DESC LIMIT 1").pluck().get() as string;
  assert.equal(records.includes("operator confirmed provider record"), false); assert.equal(records.includes("orc_"), true);
  assert.equal(fs.readFileSync(path.join(f.directory, "evidence.json"), "utf8").includes("fixture_only_private_draft"), false);
});

test("providerの0件はunknownを維持し、複数・不完全・author不一致はneeds_review", async t => {
  for (const mode of ["zero", "multiple", "incomplete", "author"] as const) {
    const f = evidenceFixture(t);
    const messages = mode === "zero" ? [] : mode === "multiple" ? [f.message(), f.message(1)]
      : mode === "author" ? [{ ...f.message(), userId: "Uother" }] : [f.message()];
    await f.capture(messages, mode !== "incomplete"); f.resolve();
    assert.equal(f.attempt().row.state, mode === "zero" ? "acceptance_unknown" : "needs_review");
    assert.equal(f.records.read("consume", f.requestId)?.row.attempt_id, f.query.attempt_id);
  }
});

test("evidence不足・旧fence・scope不一致・MAC改変をprovider成功と推測しない", async t => {
  for (const mode of ["missing", "fence", "scope", "mac"] as const) {
    const f = evidenceFixture(t);
    if (mode === "scope") await assert.rejects(f.capture([f.message()], true, { ...f.query, workspace_id: "another" }));
    else if (mode !== "missing") await f.capture([f.message()], true, { ...f.query,
      ...(mode === "fence" ? { fence: f.query.fence + 1 } : {}) });
    if (mode === "mac") {
      const filename = path.join(f.directory, "evidence.json"), parsed = JSON.parse(fs.readFileSync(filename, "utf8")); parsed.mac = "0".repeat(64);
      fs.writeFileSync(filename, JSON.stringify(parsed));
    }
    assert.equal(f.resolve().status, "denied"); assert.equal(f.attempt().row.state, "acceptance_unknown");
  }
});

test("署名済みreceiptでもoperator reason不足・policy失効後は照合を受理しない", async t => {
  const f = evidenceFixture(t); await f.capture([f.message()]);
  assert.throws(() => new OperationsReconcileAuthority(f.policies, f.evidence,
    new ApprovalRequestLifecycle(f.db, f.providers, scope), "short", author), ProviderEvidenceError);
  f.operator.change("revoke", { active: false, expires_at: f.proposal.expires_at,
    grants: [{ principal_id: "local_operator", uid: process.getuid!(), actions: ["read"] }] });
  assert.equal(f.resolve().status, "denied"); assert.equal(f.attempt().row.state, "acceptance_unknown");
});

test("receiptは本文TTL後も保存markerで確定でき、本文・one-shot fenceを復活させない", async t => {
  const f = evidenceFixture(t); await f.capture([f.message()]);
  // policyだけの延長を先に行い、reconcile authorityもcurrent revisionへ結合する。
  f.setNow("2026-09-19T23:59:00.000Z");
  f.operator.change("extend", { active: true, expires_at: "2026-09-21T00:00:00.000Z",
    grants: [{ principal_id: "local_operator", uid: process.getuid!(), actions: ["read", "reconcile"] }] });
  f.setNow("2026-09-20T00:00:00.000Z");
  const authority = new OperationsReconcileAuthority(f.policies, f.evidence,
    new ApprovalRequestLifecycle(f.db, f.providers, scope), "operator retained durable receipt", author, 2);
  const denied = () => ({ status: "denied" as const, reason: "unauthorized" as const });
  const broker = new ApprovalExecutionBroker(f.db, f.providers, scope, denied, denied, authority.execution,
    () => content, () => wrapping, () => executionKey, new SupervisorBindingGuard(f.binding, "fixture", () => { throw Error(); }));
  broker.resolve("late_durable", { attempt_handle: f.query.attempt_id, expected_fence: f.attempt().row.fence, authority_ref: "evidence" });
  assert.equal(f.attempt().row.state, "succeeded");
  assert.equal(f.db.prepare("SELECT count(*) FROM approval_payload_secrets").pluck().get(), 0);
  assert.equal(f.records.read("consume", f.requestId)?.row.attempt_id, f.query.attempt_id);
});


test("通知のprovider証拠はimmutable送信fenceを照合し、recovery後も再配送せず確定する", async t => {
  const base = notificationFixture(t);
  base.notifications.claim("claim", base.notificationCommand());
  base.notifications.recover("recover", base.notificationCommand());
  const f = attachOperationsPolicy(base); f.provision();
  const row = f.notification("approval_card").row;
  assert.equal(row.fence, 2);
  const lifecycle = new ApprovalRequestLifecycle(f.db, f.providers, scope), target = lifecycle.snapshot(f.read()).target;
  const query = { ...scope, kind: "notification" as const, request_id: row.request_id, attempt_id: row.notification_attempt_id,
    semantic_hash: f.read().row.semantic_hash, fence: 1, mac: row.marker_mac };
  const connection = { alias: "fixture", teamId: scope.workspace_id, botUserId: author.user_id, botId: author.bot_id,
    client: { authenticate: async () => ({ teamId: scope.workspace_id, botUserId: author.user_id, botId: author.bot_id }),
      getApprovalEvidencePage: async () => ({ messages: [{ ts: target.thread_ts, threadTs: target.thread_ts,
        userId: author.user_id, botId: author.bot_id, metadata: slackApprovalEvidenceMetadata(query) }], hasMore: false }) }
  } as unknown as ReturnType<SlackWorkspaceRegistry["get"]>;
  const directory = path.dirname(f.filename);
  await new SlackApprovalEvidenceProbe({ get: () => connection, getByTeamId: () => connection }, { ...key, state: "active" },
    () => new Date("2026-09-19T00:00:00.000Z")).capture(directory, "fixture", query, target, "notification_evidence");
  const authority = new OperationsReconcileAuthority(f.policies, new DurableProviderEvidence(directory, () => key), lifecycle,
    "operator verified notification record", author, 1);
  const denied = () => ({ status: "denied" as const, reason: "unauthorized" as const });
  const broker = new ApprovalNotificationBroker(f.db, f.providers, scope, denied, denied, authority.notification,
    () => content, () => wrapping, () => notificationKey, new SupervisorBindingGuard(f.binding, "fixture", () => { throw Error(); }));
  assert.equal(broker.resolve("notification_resolve", { notification_handle: row.notification_attempt_id,
    expected_fence: 2, authority_ref: "notification_evidence" }).status, "updated");
  assert.equal(f.notification("approval_card").row.state, "sent");
  assert.equal(broker.claim("never_resend", { notification_handle: row.notification_attempt_id,
    expected_fence: 3, authority_ref: "notification_evidence" }).status, "denied");
});


test("retentionはTTL後のunknown/needs_review attemptと永久consume fenceを保護する", async t => {
  for (const needsReview of [false, true]) {
    const f = evidenceFixture(t);
    if (needsReview) { await f.capture([f.message(), f.message(1)]); f.resolve(); }
    f.operator.change("extend_retention", { active: true, expires_at: "2026-09-21T00:00:00.000Z",
      grants: [{ principal_id: "local_operator", uid: process.getuid!(), actions: ["read", "retention"] }] });
    f.setNow("2026-09-20T00:00:00.000Z");
    const retention = new ApprovalRetention(f.db, f.providers, scope, f.policies);
    const operations = new ApprovalOperations(f.db, f.providers, scope);
    const preview = operations.authorizedObservation(f.policies, "retention", (state, mark) =>
      retention.previewInState(state, mark, "attempt", f.query.attempt_id));
    assert.equal(preview.eligible, false);
    assert.equal(f.records.read("consume", f.requestId)?.row.attempt_id, f.query.attempt_id);
    assert.equal(f.attempt().row.state, needsReview ? "needs_review" : "acceptance_unknown");
    assert.throws(() => f.execution.start("no_retry", f.executionCommand()));
  }
});
