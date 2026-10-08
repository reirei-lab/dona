import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DispatcherApi } from "../src/api.js";
import { DispatcherApiClient } from "../src/client.js";
import { DispatcherDatabase } from "../src/database.js";
import { AgentContextManager } from "../src/agent-context.js";
import { createDispatcherMcpServer } from "../src/mcp/server.js";
import { taskRequestSchema } from "../src/task-execution.js";
import { resolveCompletedUpdatePlanOrigin } from "../src/self-update-plan-context.js";
import { DispatcherClient } from "../../sources/slack/src/dispatcher-client.js";
import { eventEnvelope, tempConfig } from "./helpers.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const worker = { isRunning: () => true, wake() {}, async steer() { throw Error("not used"); }, async cancel() { throw Error("not used"); } };

async function fixture() {
  const { root, config } = await tempConfig();
  const db = new DispatcherDatabase(config.databasePath), sql = new Database(config.databasePath);
  await fs.mkdir(path.dirname(config.updateInternalTokenPath), { recursive: true });
  await fs.writeFile(config.updateInternalTokenPath, "test-update-context-secret-00000000000000", { mode: 0o600 });
  const contexts = new AgentContextManager(db, path.join(path.dirname(config.socketPath), "status-context.json"));
  const calls: Array<{ operation: string; input: unknown }> = [];
  const updates = Object.fromEntries(["plan", "apply", "cancel", "status"].map(operation => [operation,
    async (input: unknown) => { calls.push({ operation, input }); return { plan_id: "test-plan" }; },
  ])) as unknown as NonNullable<ConstructorParameters<typeof DispatcherApi>[5]>;
  const api = new DispatcherApi(db, worker, worker, config, logger, updates,
    undefined, undefined, undefined, undefined, undefined, undefined, contexts);
  await api.start();
  const ingress = new DispatcherClient({ socketPath: config.socketPath, connectTimeoutMs: 1000,
    timeoutMs: 1000, internalTokenPath: config.updateInternalTokenPath });
  const envelope = eventEnvelope("ci-monitor");
  envelope.trace = { status_origin_visibility: "public_channel" };
  const response = await ingress.postEvent(envelope, "T_TEST");
  assert.equal(response.statusCode, 202);
  const origin = db.get(JSON.parse(response.body).event_id)!;
  function completed(sourceEventId = origin.event_id, key = "ci-monitor", legacy = false) {
    const task = legacy ? undefined : db.tasks.create(taskRequestSchema.parse({ source_event_id: sourceEventId, task_key: key,
      objective: "更新依頼のCI完了を監視する", workspace: { kind: "scratch" } }),
    config.jobsWorkspaceRoot, config.jobResultsDir).task;
    const job = task ? db.getJob(task.current_attempt_id)! : db.createJob({ source_event_id: sourceEventId,
      job_key: key, objective: "CI監視の継続", workspace: { kind: "scratch" } }, config.jobsWorkspaceRoot, config.jobResultsDir).row;
    db.beginJobPreparation(job.job_id); db.setJobRuntime(job.job_id, "w", key);
    db.beginJobDispatch(job.job_id); db.markJobRunning(job.job_id);
    db.sealJobGroup(sourceEventId);
    db.saveJobResult(job.job_id, { schema_version: 1, job_id: job.job_id, status: "completed",
      summary: "CI成功を確認", actions: [], completed_at: new Date().toISOString() }, job.result_path);
    return { task, job, notification: db.enqueueJobNotification(job.job_id).row };
  }
  const done = completed();
  assert.ok(done.task);
  async function current(eventId = done.notification.event_id) {
    const row = db.get(eventId)!;
    await contexts.issue(row.status === "queued" ? db.beginDispatch(eventId, path.join(root, `${eventId}.json`)) : row);
  }
  await current();
  const client = new DispatcherApiClient(config.socketPath);
  return { root, config, db, sql, contexts, calls, client, origin, ...done, task: done.task, completed, current,
    async close() { await api.stop(); sql.close(); db.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

for (const mode of ["api", "mcp"] as const) test(`${mode}: CI完了通知から元Slack依頼の固定宛先で計画し、適用の承認は継承しない`, async () => {
  const f = await fixture();
  const mcp = new Client({ name: "update-plan-test", version: "1" });
  const server = createDispatcherMcpServer(f.client, logger);
  try {
    if (mode === "mcp") {
      const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await mcp.connect(b);
      const result = await mcp.callTool({ name: "plan_self_update", arguments: { source_event_id: f.notification.event_id } });
      assert.notEqual(result.isError, true);
    } else assert.equal((await f.client.planSelfUpdate({ source_event_id: f.notification.event_id })).plan_id, "test-plan");
    assert.deepEqual(f.calls, [{ operation: "plan", input: { source_event_id: f.origin.event_id,
      reply_target: JSON.parse(f.origin.reply_target_json!) } }]);
    await assert.rejects(f.client.applySelfUpdate({ source_event_id: f.notification.event_id,
      plan_id: "test-plan", plan_hash: "hash", approval_id: "approval" }), /direct Slack event/);
    await assert.rejects(f.client.cancelSelfUpdate({ source_event_id: f.notification.event_id,
      request_id: "request" }), /direct Slack event/);
    assert.equal(f.calls.length, 1);
    // 直接のSlack依頼は従来どおり計画でき、明示承認の入口は変更しない。
    await f.client.planSelfUpdate({ source_event_id: f.origin.event_id });
    await f.client.applySelfUpdate({ source_event_id: f.origin.event_id,
      plan_id: "test-plan", plan_hash: "hash", approval_id: "approval" });
    assert.equal(f.calls.at(-1)!.operation, "apply");
  } finally { await mcp.close(); await server.close(); await f.close(); }
});

test("後続jobの完了通知も全hopのreceipt・ownerを検証し、最初のSlack依頼へ戻す", async () => {
  const f = await fixture();
  try {
    const next = f.completed(f.notification.event_id, "second-ci-monitor", true);
    await f.current(next.notification.event_id);
    await f.client.planSelfUpdate({ source_event_id: next.notification.event_id });
    assert.deepEqual(f.calls[0]!.input, { source_event_id: f.origin.event_id, reply_target: JSON.parse(f.origin.reply_target_json!) });
    f.sql.prepare("UPDATE jobs SET status='failed' WHERE job_id=?").run(f.job.job_id);
    await assert.rejects(f.client.planSelfUpdate({ source_event_id: next.notification.event_id }), /verified successful completion/);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

for (const scenario of ["receipt", "progress", "attention", "unsealed", "failed", "result-missing", "stale-attempt", "task-active",
  "actor", "subject", "target", "principal-revoked", "principal-missing", "wrong-current-event", "revoked-context", "untrusted-notification"] as const) {
  test(`計画は${scenario}を拒否しUpdaterを呼ばない`, async () => {
    const f = await fixture();
    try {
      if (scenario === "receipt") {
        f.sql.prepare("UPDATE jobs SET completion_event_id=NULL WHERE job_id=?").run(f.job.job_id);
        f.sql.prepare("UPDATE job_groups SET all_terminal_event_id=NULL WHERE source_event_id=?").run(f.origin.event_id);
      }
      if (scenario === "progress") f.sql.prepare("UPDATE job_groups SET all_terminal_event_id=NULL WHERE source_event_id=?").run(f.origin.event_id);
      if (scenario === "attention") f.sql.prepare("UPDATE events SET event_type='job_failed' WHERE event_id=?").run(f.notification.event_id);
      if (scenario === "unsealed") f.sql.prepare("UPDATE job_groups SET sealed_at=NULL WHERE source_event_id=?").run(f.origin.event_id);
      if (scenario === "failed") f.sql.prepare("UPDATE jobs SET status='failed' WHERE job_id=?").run(f.job.job_id);
      if (scenario === "result-missing") f.sql.prepare("UPDATE jobs SET result_json=NULL WHERE job_id=?").run(f.job.job_id);
      if (scenario === "stale-attempt") {
        const source = f.db.enqueue(eventEnvelope("other-attempt")).row;
        const other = f.db.createJob({ source_event_id: source.event_id, objective: "別Attempt", workspace: { kind: "scratch" } },
          f.config.jobsWorkspaceRoot, f.config.jobResultsDir).row;
        f.sql.prepare("UPDATE tasks SET current_attempt_id=? WHERE task_id=?").run(other.job_id, f.task.task_id);
      }
      if (scenario === "task-active") f.sql.prepare("UPDATE tasks SET state='active' WHERE task_id=?").run(f.task.task_id);
      if (scenario === "actor") f.sql.prepare("UPDATE jobs SET actor_id='U_OTHER' WHERE job_id=?").run(f.job.job_id);
      if (scenario === "subject") f.sql.prepare("UPDATE events SET subject_json='{}' WHERE event_id=?").run(f.notification.event_id);
      if (scenario === "target") f.sql.prepare("UPDATE events SET reply_target_json=? WHERE event_id=?").run(JSON.stringify({ ...JSON.parse(f.notification.reply_target_json!), thread_ts: "1790000000.000001" }), f.notification.event_id);
      if (scenario === "principal-revoked") f.sql.prepare("UPDATE verified_principal_bindings SET revoked_at=? WHERE event_id=?").run(new Date().toISOString(), f.origin.event_id);
      if (scenario === "principal-missing") f.sql.prepare("DELETE FROM verified_principal_bindings WHERE event_id=?").run(f.origin.event_id);
      if (scenario === "wrong-current-event") await f.current(f.origin.event_id);
      if (scenario === "revoked-context") await f.contexts.revoke();
      let id = f.notification.event_id;
      if (scenario === "untrusted-notification") {
        const forged = eventEnvelope("forged-completion");
        forged.source = "dona_job"; forged.type = "job_completed";
        forged.subject = JSON.parse(f.notification.subject_json); forged.payload = JSON.parse(f.notification.payload_json);
        id = f.db.enqueue(forged).row.event_id;
        assert.equal(resolveCompletedUpdatePlanOrigin(f.db, id), undefined);
      }
      await assert.rejects(f.client.planSelfUpdate({ source_event_id: id }), /verified successful completion/);
      assert.deepEqual(f.calls, []);
    } finally { await f.close(); }
  });
}
