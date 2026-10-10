import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { SlackSocketAdapter, type WorkspaceSocket } from "../../sources/slack/src/socket-adapter.js";
import { DispatcherClient as SlackDispatcherClient } from "../../sources/slack/src/dispatcher-client.js";
import type { SlackAdapterConfig } from "../../sources/slack/src/adapter-config.js";
import { DispatcherDatabase } from "../src/database.js";
import { DispatcherApi } from "../src/api.js";
import { DispatcherApiClient } from "../src/client.js";
import { DispatcherWorker } from "../src/worker.js";
import { AgentContextManager } from "../src/agent-context.js";
import type { HerdrClient, HerdrCommandResult } from "../src/herdr.js";
import { taskRequestSchema } from "../src/task-execution.js";
import { eventEnvelope, tempConfig, waitFor } from "./helpers.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const ok = (agentStatus: "idle" | "working" | "done"): HerdrCommandResult => ({
  ok: true, stdout: "{}", stderr: "", exitCode: 0, timedOut: false, aborted: false, agentStatus,
});
class Socket extends EventEmitter {
  async start() { this.emit("connected"); }
  async disconnect() {}
}

async function fixture(visibility: WorkspaceSocket["statusOriginVisibility"], team: string | null = "T_TEST") {
  const { root, config } = await tempConfig();
  await fs.mkdir(path.dirname(config.updateInternalTokenPath), { recursive: true });
  await fs.writeFile(config.updateInternalTokenPath, "ingress-test-key-00000000000000000000", { mode: 0o600 });
  await fs.mkdir(config.resultsDir, { recursive: true });
  config.ghPath = path.join(root, "github-fixture");
  await fs.writeFile(config.ghPath, '#!/usr/bin/env node\nconst n=Number(process.argv.find(a=>a.startsWith("number=")).slice(7));console.log(JSON.stringify({data:{repository:{nameWithOwner:"org/repo",issue:{id:"I_"+n,number:n}}}}));\n', { mode: 0o700 });
  const db = new DispatcherDatabase(config.databasePath);
  const contexts = new AgentContextManager(db, path.join(path.dirname(config.socketPath), "status-context.json"));
  let prompt = "", release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime: HerdrClient = {
    async get() { return ok("idle"); },
    async prompt(value) { prompt = value; await gate; return ok("working"); },
    async wait() { return ok("done"); },
  };
  const worker = new DispatcherWorker(db, runtime, config, logger, undefined, () => {}, contexts);
  const jobs = { isRunning: () => true, wake() {}, async steer() { throw Error("unused"); }, async cancel() { throw Error("unused"); } };
  const api = new DispatcherApi(db, worker, jobs, config, logger, undefined, undefined, undefined, undefined, undefined, undefined, undefined, contexts);
  await api.start();
  const socket = new Socket();
  const adapterConfig: SlackAdapterConfig = {
    workspaces: ["test"], dispatcherSocketPath: config.socketPath, healthSocketPath: path.join(root, "slack.sock"),
    updateInternalTokenPath: config.updateInternalTokenPath, dispatcherConnectTimeoutMs: 500, dispatcherTimeoutMs: 2000,
    shutdownGraceMs: 200, socketModeEnabled: true, logLevel: "info", buildSha: "development", appSchemaWrite: 4, appSchemaReadMax: 4,
  };
  let acked = false, rejected = false;
  const adapter = new SlackSocketAdapter([{ workspace: "test", client: socket, ...(team ? { authenticatedTeamId: team } : {}),
    ...(visibility ? { statusOriginVisibility: visibility } : {}) }],
    new SlackDispatcherClient({ socketPath: config.socketPath, connectTimeoutMs: 500, timeoutMs: 2000, internalTokenPath: config.updateInternalTokenPath }),
    adapterConfig, { ...logger, error() { rejected = true; } });
  await adapter.start();
  // 本番と同じapp_mentionを受信し、署名・HTTP ingress・永続化・workerのcontext発行を通す。
  socket.emit("slack_event", { type: "events_api", envelope_id: "envelope-task-ingress", ack: async () => { acked = true; }, body: {
    type: "event_callback", team_id: "T_TEST", event_id: "EvIngressTask", authorizations: [{ user_id: "U_BOT" }],
    event: { type: "app_mention", user: "U_TEST", channel: "C_TEST", ts: "1791615423.357439", event_ts: "1791615423.357439", text: "Issueを再開してください" },
  } });
  return { db, config, root, contexts, client: new DispatcherApiClient(config.socketPath),
    acked: () => acked, rejected: () => rejected,
    async dispatch() { await waitFor(() => acked); worker.start(); await waitFor(() => !!prompt); return /^event_id: (.+)$/m.exec(prompt)![1]!; },
    async close() { release(); await worker.stop(); await adapter.stop(); await api.stop(); db.close(); await fs.rm(root, { recursive: true, force: true }); },
  };
}

for (const outcome of ["success", "failure", "timeout", "unavailable"] as const) {
  test(`Slack channel情報の${outcome}でも受信から既存Task照合・新規委任・制御まで通る`, async () => {
    let release: (value: string) => void = () => {}, signal: AbortSignal | undefined;
    const visibility: NonNullable<WorkspaceSocket["statusOriginVisibility"]> = async (_channel, currentSignal) => {
      signal = currentSignal;
      if (outcome === "failure") throw Error("channel unavailable");
      if (outcome === "unavailable") return undefined;
      if (outcome === "timeout") return new Promise<string>(resolve => { release = resolve; });
      return "public_channel";
    };
    const f = await fixture(visibility);
    try {
      const eventId = await f.dispatch();
      assert.equal(f.db.getVerifiedPrincipalBinding(eventId)?.principal_id, "U_TEST");
      assert.equal(JSON.parse(f.db.get(eventId)!.trace_json!).status_origin_visibility, outcome === "success" ? "public_channel" : undefined);
      if (outcome === "timeout") assert.equal(signal?.aborted, true);
      assert.deepEqual((await f.client.listTasks(eventId)).tasks, []);
      assert.equal((await f.client.findIssueTask(eventId, "org/repo", 1)).status, "not_found");
      const created = await f.client.createTask({ source_event_id: eventId, task_key: "ingress", objective: "Issueを実装する",
        workspace: { kind: "github", repository: "org/repo" }, issue_number: 1 });
      const task = created.task as { task_id: string; revision: number; current_attempt_id: string };
      assert.equal(created.outcome, "created");
      assert.equal((await f.client.findIssueTask(eventId, "org/repo", 1)).status, "found");
      assert.equal(((await f.client.controlTask(task.task_id, "pause", { source_event_id: eventId, revision: task.revision })).task as { state: string }).state, "paused");
      // 更新前の未署名Taskも、同じchannelの本人の依頼で照合できる。
      for (const actor of ["U_TEST", "U_OTHER"]) {
        const envelope = eventEnvelope("EvLegacy" + actor); envelope.subject.actor_id = actor;
        const origin = f.db.enqueue(envelope).row, number = actor === "U_TEST" ? 2 : 3;
        f.db.tasks.create(taskRequestSchema.parse({ source_event_id: origin.event_id, task_key: "legacy", objective: "既存Issue",
          workspace: { kind: "github", repository: "org/repo" }, issue_number: number }), f.config.jobsWorkspaceRoot, f.config.jobResultsDir,
          { node_id: "I_" + number, repository: "org/repo", number });
        if (actor === "U_TEST") assert.equal((await f.client.findIssueTask(eventId, "org/repo", number)).status, "found");
        else await assert.rejects(f.client.findIssueTask(eventId, "org/repo", number), /task_owner_mismatch/);
      }
      // visibilityが不明でも本人確認は成立するが、visibility必須の旧status開示は許可しない。
      if (outcome !== "success") assert.equal((await f.client.getJobStatusSummary(task.current_attempt_id)).status, "not_available");
      release("private_channel");
      assert.equal(f.db.getVerifiedPrincipalBinding(eventId)?.principal_id, "U_TEST");
    } finally { release("private_channel"); await f.close(); }
  });
}

test("Slack workspace不一致では署名・保存・ACKを行わない", async () => {
  const f = await fixture(async () => undefined, "T_OTHER");
  try {
    await waitFor(f.rejected);
    assert.equal(f.acked(), false);
    assert.equal(f.db.getByExternalId("slack", "EvIngressTask"), undefined);
  } finally { await f.close(); }
});

test("認証済みworkspaceがない受信では本文のuserからTask権限を作らない", async () => {
  const f = await fixture(undefined, null);
  try {
    const eventId = await f.dispatch();
    assert.equal(f.db.getVerifiedPrincipalBinding(eventId), undefined);
    await assert.rejects(f.client.listTasks(eventId), /task_owner_mismatch/);
    await assert.rejects(f.client.createTask({ source_event_id: eventId, task_key: "unsigned", objective: "調査",
      workspace: { kind: "scratch" } }), /task_owner_mismatch/);
    assert.equal(f.db.listEventJobs(eventId).length, 0);
  } finally { await f.close(); }
});
