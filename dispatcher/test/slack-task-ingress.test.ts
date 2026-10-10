import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
// Slack componentの実装をblack-boxで読み、Dispatcherの型検査へSocket SDK依存を持ち込まない。
// Slack実装自身の型検査はsources/slackの検証で行う。
const { SlackSocketAdapter } = await import(new URL("../../sources/slack/src/socket-adapter.ts", import.meta.url).href);
const { createSocketActorVerifier, socketOriginVisibility } = await import(new URL("../../sources/slack/src/socket-principal.ts", import.meta.url).href);
type Visibility = (channelId: string, signal?: AbortSignal) => Promise<"public_channel" | "private_channel" | "im" | "mpim" | "denied" | undefined>;
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

async function fixture(visibility: Visibility | undefined, team: string | null = "T_TEST", userOverrides: Record<string, unknown> = {}, userLookup?: (signal?: AbortSignal) => Promise<unknown>) {
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
    ...(visibility ? { statusOriginVisibility: visibility } : {}),
    verifyActor: createSocketActorVerifier({ getUser: async (_actorId: string, signal?: AbortSignal) => userLookup ? userLookup(signal) : ({
      id: "U_TEST", teamId: "T_TEST", stateKnown: true, isDeleted: false, isBot: false, isAppUser: false, ...userOverrides,
    }) }, "T_TEST") }],
    new SlackDispatcherClient({ socketPath: config.socketPath, connectTimeoutMs: 500, timeoutMs: 2000, internalTokenPath: config.updateInternalTokenPath }),
    adapterConfig, { ...logger, error() { rejected = true; } });
  await adapter.start();
  // 本番と同じapp_mentionを受信し、署名・HTTP ingress・永続化・workerのcontext発行を通す。
  const deliver = (envelopeId="envelope-task-ingress") => socket.emit("slack_event", { type: "events_api", envelope_id: envelopeId, ack: async () => { acked = true; }, body: {
    type: "event_callback", team_id: "T_TEST", event_id: "EvIngressTask", authorizations: [{ user_id: "U_BOT" }],
    event: { type: "app_mention", user: "U_TEST", channel: "C_TEST", ts: "1791615423.357439", event_ts: "1791615423.357439", text: "Issueを再開してください" },
  } });
  deliver();
  return { db, config, root, contexts, deliver, client: new DispatcherApiClient(config.socketPath),
    acked: () => acked, rejected: () => rejected,
    async dispatch() { await waitFor(() => acked, 5000); worker.start(); await waitFor(() => !!prompt); return /^event_id: (.+)$/m.exec(prompt)![1]!; },
    async close() { release(); await worker.stop(); await adapter.stop(); await api.stop(); db.close(); await fs.rm(root, { recursive: true, force: true }); },
  };
}

for (const outcome of ["success", "failure", "timeout", "unavailable"] as const) {
  test(`Slack channel情報の${outcome}でも受信から既存Task照合・新規委任・制御まで通る`, async () => {
    let release: (value: "public_channel" | "private_channel") => void = () => {}, signal: AbortSignal | undefined;
    const visibility: Visibility = async (_channel, currentSignal) => {
      signal = currentSignal;
      if (outcome === "failure") throw Error("channel unavailable");
      if (outcome === "unavailable") return undefined;
      if (outcome === "timeout") return new Promise<"public_channel" | "private_channel">(resolve => { release = resolve; });
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

for (const [reason, changes] of Object.entries({ external: { teamId: "T_OTHER" }, bot: { isBot: true }, app: { isAppUser: true },
  suspended: { isSuspended: true }, deleted: { isDeleted: true }, unknown: { stateKnown: false }, mismatched: { id: "U_OTHER" }, agentforce: { isAgentforceBot: true } })) {
  test(`channel照会不能でも${reason}のactorにはTask権限を発行しない`, async () => {
    const f = await fixture(async () => undefined, "T_TEST", changes);
    try {
      const eventId = await f.dispatch();
      assert.equal(f.db.getVerifiedPrincipalBinding(eventId), undefined);
      await assert.rejects(f.client.listTasks(eventId), /task_owner_mismatch/);
    } finally { await f.close(); }
  });
}

for (const changes of [{ isShared: true }, { isArchived: true }, { id: "C_OTHER" }]) {
  test(`channelの明示deny ${JSON.stringify(changes)}では本人が一致しても署名しない`, async () => {
    const f = await fixture((channelId, signal) => socketOriginVisibility({ getChannel: async () => ({
      id: "C_TEST", isShared: false, isArchived: false, isPrivate: false, isMember: true, visibilityKnown: true, ...changes,
    }) }, channelId, signal));
    try {
      const eventId = await f.dispatch();
      assert.equal(f.db.getVerifiedPrincipalBinding(eventId), undefined);
      assert.equal(JSON.parse(f.db.get(eventId)!.trace_json!).status_origin_visibility, undefined);
      assert.equal(JSON.parse(f.db.get(eventId)!.trace_json!).principal_origin_denied, true);
      await assert.rejects(f.client.listTasks(eventId), /task_owner_mismatch/);
    } finally { await f.close(); }
  });
}

for (const outcome of ["failure", "timeout"] as const) {
  test(`本人の照会${outcome}は永続化とACKをせず、再配送でTask操作まで回復する`, async () => {
    let signal: AbortSignal | undefined, release: () => void = () => {}, recovered=false;
    const human={ id: "U_TEST", teamId: "T_TEST", stateKnown: true, isDeleted: false, isBot: false, isAppUser: false };
    const f = await fixture(async () => "public_channel", "T_TEST", {}, async currentSignal => {
      signal = currentSignal;
      if(recovered)return human;
      if (outcome === "failure") throw Error("users.info unavailable");
      return new Promise(resolve => { release = () => resolve({ id: "U_TEST", teamId: "T_TEST", stateKnown: true, isDeleted: false, isBot: false, isAppUser: false }); });
    });
    try {
      await waitFor(f.rejected);
      assert.equal(f.acked(),false);
      assert.equal(f.db.getByExternalId("slack","EvIngressTask"),undefined);
      if (outcome === "timeout") assert.equal(signal?.aborted, true);
      release(); await new Promise(resolve => setImmediate(resolve));
      recovered=true;f.deliver("redelivery-envelope");
      const eventId=await f.dispatch();
      assert.equal(f.db.getVerifiedPrincipalBinding(eventId)?.principal_id,"U_TEST");
      assert.deepEqual((await f.client.listTasks(eventId)).tasks,[]);
    } finally { release(); await f.close(); }
  });
}

test("本人照会がchannelの200ms期限を超えても、所属確認後にTask権限を発行する", async () => {
  const f = await fixture(async () => undefined, "T_TEST", {}, async () => {
    await new Promise(resolve => setTimeout(resolve, 250));
    return { id: "U_TEST", teamId: "T_TEST", stateKnown: true, isDeleted: false, isBot: false, isAppUser: false };
  });
  try {
    const eventId = await f.dispatch();
    assert.equal(f.db.getVerifiedPrincipalBinding(eventId)?.principal_id, "U_TEST");
    assert.deepEqual((await f.client.listTasks(eventId)).tasks, []);
  } finally { await f.close(); }
});

 test("Enterpriseの対象workspace所属を確認した利用者はTask照合できる", async () => {
  const f = await fixture(async () => undefined, "T_TEST", {teamId:"T_HOME", enterpriseTeamIds:["T_TEST"]});
  try { const id=await f.dispatch(); assert.equal(f.db.getVerifiedPrincipalBinding(id)?.principal_id,"U_TEST");
    assert.deepEqual((await f.client.listTasks(id)).tasks,[]);
  } finally { await f.close(); }
});

for(const reason of ["failure","timeout"] as const)test(`channel明示denyでは本人照会${reason}でも未署名で保存しACKする`,async()=>{
 const f=await fixture(async()=>"denied","T_TEST",{},async()=>{
  if(reason==="failure")throw Error("users.info failed");
  return new Promise(()=>{});
 });
 try {
  const id=await f.dispatch();assert.equal(f.acked(),true);
  assert.equal(f.db.getVerifiedPrincipalBinding(id),undefined);
  await assert.rejects(f.client.listTasks(id),/task_owner_mismatch/);
 }finally{await f.close();}
});
