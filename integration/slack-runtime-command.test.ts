import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { DispatcherApi } from "../dispatcher/src/api.js";
import { DispatcherDatabase } from "../dispatcher/src/database.js";
import { tempConfig } from "../dispatcher/test/helpers.js";
import { RuntimeCommandHttpIngress, readRuntimeIngressConfig } from "../sources/slack/src/runtime-command-ingress.js";
import { DispatcherClient } from "../sources/slack/src/dispatcher-client.js";
import { SlackHealthServer } from "../sources/slack/src/health-server.js";
import { verifyRuntimeCommandRequest } from "../sources/slack/src/runtime-command.js";

const workspace = { alias: "test", team_id: "T1", app_id: "A1", enterprise_id: null,
  signing_secret: "fixture-signing-secret-not-live", actor_ids: ["U1"] };
const deliveryTimestamp = String(Math.floor(Date.now() / 1000));
function raw(text = "status", trigger = "123.456.fixture") {
  return Buffer.from(new URLSearchParams({ team_id: "T1", api_app_id: "A1", user_id: "U1", channel_id: "C1",
    command: "/dona", text, trigger_id: trigger, response_url: "https://private-canary.invalid/secret", token: "secret-canary" }).toString());
}
function headers(body: Buffer) {
  const timestamp = deliveryTimestamp;
  return { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": timestamp,
    "x-slack-signature": "v0=" + createHmac("sha256", workspace.signing_secret).update(`v0:${timestamp}:`).update(body).digest("hex") };
}
function post(socketPath: string, body: Buffer, extra: Record<string, string> = {}) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const request = http.request({ socketPath, path: "/slack/commands", method: "POST", headers: { ...headers(body), ...extra } }, response => {
      let text = ""; response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, text }));
    }); request.on("error", reject); request.end(body);
  });
}
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const { root, config } = await tempConfig(); config.slackRuntimeIngressEnabled = true;
  await fs.mkdir(path.dirname(config.updateInternalTokenPath), { recursive: true });
  await fs.writeFile(config.updateInternalTokenPath, "fixture-internal-token-" + "x".repeat(32), { mode: 0o600 });
  let database = new DispatcherDatabase(config.databasePath);
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  let wakeCount = 0;
  const makeApi = () => new DispatcherApi(database, { isRunning: () => true, wake() { wakeCount++; } },
    { isRunning: () => true, wake() { wakeCount++; }, async steer() { throw Error("forbidden"); }, async cancel() { throw Error("forbidden"); } }, config, logger);
  let api = makeApi(); await api.start();
  const signingConfig = path.join(root, "signing.json");
  await fs.writeFile(signingConfig, JSON.stringify({ version: 1, workspaces: [workspace] }), { mode: 0o600 });
  const client = new DispatcherClient({ socketPath: config.socketPath, internalTokenPath: config.updateInternalTokenPath, timeoutMs: 2000, connectTimeoutMs: 500 });
  let permitted = true, stopping = false, loseResponse = false, persists = 0, delayAuthorization = false, expireDuringAuthorization = false, clockOffset = 0;
  const ingress = new RuntimeCommandHttpIngress({ configured: () => readRuntimeIngressConfig(signingConfig),
    authorize: async (_request, signal) => {
      if (delayAuthorization) await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("deadline")), { once: true }));
      if (expireDuringAuthorization) clockOffset = 301000;
      return permitted ? { channel_type: "public_channel" } : null;
    }, stopping: () => stopping,
    persist: async (input, signal) => { persists++; const receipt = await client.postRuntimeCommand(input, signal); if (loseResponse) throw Error("lost response"); return receipt; },
    ready: signal => client.runtimeCommandIngressReady(signal) }, () => Date.now() + clockOffset);
  const socketPath = path.join(root, "ingress.sock");
  const server = new SlackHealthServer(socketPath, { isSocketReady: () => true, isStopping: () => stopping,
    connectionStates: () => ({}), async quiesce() { stopping = true; },
    drainStatus: () => ({ quiescing: stopping, drained: stopping, in_flight: 0, unsafe_states: [] }) }, client, logger);
  server.setRuntimeCommandIngress(ingress); await server.start();
  t.after(async () => { await server.stop(); await api.stop(); database.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, config, signingConfig, socketPath, client, server, get database() { return database; }, count: () => persists, wakes: () => wakeCount, beginShutdown: () => api.beginShutdown(),
    deny: () => { permitted = false; }, stop: () => { stopping = true; }, lose: (value: boolean) => { loseResponse = value; },
    delay: () => { delayAuthorization = true; }, expire: () => { expireDuringAuthorization = true; },
    async restart() { await api.stop(); database.close(); database = new DispatcherDatabase(config.databasePath); api = makeApi(); await api.start(); } };
}
test("署名HTTP→internal UDS→SQLite durable intake、重複とrestartを通して外部操作0", async t => {
  const f = await setup(t), body = raw();
  const first = await post(f.socketPath, body); assert.equal(first.status, 200); assert.match(first.text, /まだ実行されていません/);
  const signed = headers(body), input = { ...verifyRuntimeCommandRequest(body, signed["x-slack-request-timestamp"], signed["x-slack-signature"], [workspace]), channel_type: "public_channel" as const };
  const receipt = f.database.runtimeCommandReceipt(input.request_id); assert.equal(receipt?.state, "pending");
  assert.equal((await post(f.socketPath, body)).status, 200);
  await f.restart(); assert.deepEqual(f.database.runtimeCommandReceipt(input.request_id), receipt);
  assert.equal((await post(f.socketPath, body)).status, 200);
  assert.equal((await post(f.socketPath, raw("update plan"))).status, 200);
  await assert.rejects(f.client.postRuntimeCommand({ ...input, command: { operation: "runtime.update.plan.v1" } }, new AbortController().signal));
  assert.deepEqual(f.database.runtimeCommandReceipt(input.request_id), receipt);
  assert.equal(f.database.list().length, 0); assert.equal(f.wakes(), 0);
  assert.doesNotMatch(await fs.readFile(f.config.databasePath, "utf8"), /secret-canary|private-canary/);
});
test("commit後のresponse lossを成功ACKにせず、redeliveryは同一receiptに収束", async t => {
  const f = await setup(t), body = raw(); f.lose(true);
  assert.equal((await post(f.socketPath, body)).status, 503);
  const signed = headers(body), input = { ...verifyRuntimeCommandRequest(body, signed["x-slack-request-timestamp"], signed["x-slack-signature"], [workspace]), channel_type: "public_channel" as const };
  const receipt = f.database.runtimeCommandReceipt(input.request_id); assert.ok(receipt);
  f.lose(false); await f.restart(); assert.equal((await post(f.socketPath, body)).status, 200);
  assert.deepEqual(f.database.runtimeCommandReceipt(input.request_id), receipt);
});
test("署名不正・過大body・permission取消・quiesceでは永続writeなし", async t => {
  const f = await setup(t);
  assert.equal((await post(f.socketPath, raw(), { "x-slack-signature": "v0=" + "0".repeat(64) })).status, 403);
  assert.equal((await post(f.socketPath, Buffer.alloc(8193))).status, 413);
  f.deny(); assert.equal((await post(f.socketPath, raw())).status, 403);
  f.stop(); assert.equal((await post(f.socketPath, raw())).status, 503);
  assert.equal(f.count(), 0); assert.equal(f.wakes(), 0);
});
test("Dispatcherのgateとinternal authenticationを別々に検証", async t => {
  const f = await setup(t), body = raw(); f.config.slackRuntimeIngressEnabled = false;
  assert.equal((await post(f.socketPath, body)).status, 503);
  f.config.slackRuntimeIngressEnabled = true;
  const badClient = new DispatcherClient({ socketPath: f.config.socketPath, timeoutMs: 500, connectTimeoutMs: 100 });
  const signed = headers(body), input = { ...verifyRuntimeCommandRequest(body, signed["x-slack-request-timestamp"], signed["x-slack-signature"], [workspace]), channel_type: "public_channel" as const };
  await assert.rejects(badClient.postRuntimeCommand(input, new AbortController().signal));
  assert.equal(f.database.runtimeCommandReceipt(input.request_id), null);
});
test("本人確認が完了しない場合も3秒前に拒否し永続writeしない", async t => {
  const f = await setup(t); f.delay(); const started = performance.now();
  assert.equal((await post(f.socketPath, raw())).status, 503);
  assert.ok(performance.now() - started < 3000); assert.equal(f.count(), 0);
});
test("本人照会中にfreshnessを失った要求をcommit直前に拒否", async t => {
  const f = await setup(t); f.expire(); assert.equal((await post(f.socketPath, raw())).status, 403);
  assert.equal(f.count(), 0);
});
test("全typed operationが同じHTTP/UDS/DB contractを通り実行queueへ入らない", async t => {
  const f = await setup(t), id = "rc_" + "a".repeat(32);
  const commands = ["status", "restart plan", "update plan", `restart confirm ${id}`, `update confirm ${id}`, `operation ${id}`, `cancel ${id}`];
  for (const [index, command] of commands.entries()) assert.equal((await post(f.socketPath, raw(command, `123.456.fixture${index}`))).status, 200);
  assert.equal(f.count(), 7); assert.equal(f.wakes(), 0); assert.equal(f.database.list().length, 0);
});
test("signing configはowner-private通常fileを要求、symlinkと未知fieldを拒否", async t => {
  const f = await setup(t), file = path.join(f.root, "signing.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspaces: [workspace] }), { mode: 0o600 });
  assert.equal((await readRuntimeIngressConfig(file)).workspaces[0]?.alias, "test");
  const link = path.join(f.root, "link"); await fs.symlink(file, link); await assert.rejects(readRuntimeIngressConfig(link));
  await fs.chmod(file, 0o644); await assert.rejects(readRuntimeIngressConfig(file));
  await fs.chmod(file, 0o600); await fs.writeFile(file, JSON.stringify({ version: 1, workspaces: [workspace], approved: true }));
  await assert.rejects(readRuntimeIngressConfig(file));
});
test("UDS応答の切断後はGETで照合し、再配送でもPOSTを繰り返さない", async t => {
  const f = await setup(t), socket = path.join(f.root, "proxy.sock"); let posts = 0;
  const proxy = http.createServer((request, response) => {
    if (request.method === "POST") posts++;
    const upstream = http.request({ socketPath: f.config.socketPath, path: request.url, method: request.method, headers: request.headers }, result => {
      if (request.method === "POST") { result.resume(); result.once("end", () => response.destroy()); }
      else { response.writeHead(result.statusCode!, result.headers); result.pipe(response); }
    }); upstream.once("error", () => response.destroy()); request.pipe(upstream);
  });
  await new Promise<void>(resolve => proxy.listen(socket, resolve));
  t.after(() => new Promise<void>(resolve => proxy.close(() => resolve())));
  const client = new DispatcherClient({ socketPath: socket, internalTokenPath: f.config.updateInternalTokenPath, timeoutMs: 1000, connectTimeoutMs: 100 });
  const body = raw(), signed = headers(body), input = { ...verifyRuntimeCommandRequest(body, signed["x-slack-request-timestamp"], signed["x-slack-signature"], [workspace]), channel_type: "public_channel" as const };
  const first = await client.postRuntimeCommand(input, AbortSignal.timeout(2500));
  assert.equal(first.state, "pending"); assert.equal(posts, 1);
  assert.deepEqual(await client.postRuntimeCommand(input, AbortSignal.timeout(2500)), first); assert.equal(posts, 1);
});
test("POST受理不明かつGETで未確認ならAdapter再起動後の再配送もread-onlyに留める", async t => {
  const f = await setup(t), socket = path.join(f.root, "unknown.sock"); let posts = 0;
  const proxy = http.createServer((request, response) => {
    if (request.method === "POST") { posts++; request.resume(); response.destroy(); return; }
    const upstream = http.request({ socketPath: f.config.socketPath, path: request.url, method: request.method, headers: request.headers }, result => {
      response.writeHead(result.statusCode!, result.headers); result.pipe(response);
    }); upstream.once("error", () => response.destroy()); request.pipe(upstream);
  });
  await new Promise<void>(resolve => proxy.listen(socket, resolve));
  t.after(() => new Promise<void>(resolve => proxy.close(() => resolve())));
  const client = new DispatcherClient({ socketPath: socket, internalTokenPath: f.config.updateInternalTokenPath, timeoutMs: 1000, connectTimeoutMs: 100 });
  const body = raw(), signed = headers(body), input = { ...verifyRuntimeCommandRequest(body, signed["x-slack-request-timestamp"], signed["x-slack-signature"], [workspace]), channel_type: "public_channel" as const };
  await assert.rejects(client.postRuntimeCommand(input, AbortSignal.timeout(2500)), /acceptance_unknown/);
  await assert.rejects(client.postRuntimeCommand(input, AbortSignal.timeout(2500)), /acceptance_unknown/);
  const restarted = new DispatcherClient({ socketPath: socket, internalTokenPath: f.config.updateInternalTokenPath, timeoutMs: 1000, connectTimeoutMs: 100 });
  await assert.rejects(restarted.postRuntimeCommand(input, AbortSignal.timeout(2500)), /acceptance_unknown/);
  assert.equal(posts, 1); assert.equal(f.database.runtimeCommandReceipt(input.request_id), null);
});
test("readinessは半端なenablement・config破損・token失効をreadyにしない", async t => {
  const f = await setup(t);
  const read = (route: string) => new Promise<number>((resolve, reject) => {
    const request = http.get({ socketPath: f.socketPath, path: route }, response => { response.resume(); response.once("end", () => resolve(response.statusCode!)); });
    request.once("error", reject);
  });
  assert.equal(await f.client.runtimeCommandIngressReady(), true);
  assert.equal(await read("/health/ready"), 200); assert.equal(await read("/health/version"), 200);
  f.config.slackRuntimeIngressEnabled = false;
  assert.equal(await f.client.runtimeCommandIngressReady(), false); assert.equal(await read("/health/ready"), 503);
  f.config.slackRuntimeIngressEnabled = true;
  await fs.writeFile(f.signingConfig, "not-json"); assert.equal(await read("/health/version"), 503);
  await fs.writeFile(f.signingConfig, JSON.stringify({ version: 1, workspaces: [workspace] }));
  await fs.chmod(f.config.updateInternalTokenPath, 0o644); assert.equal(await read("/health/ready"), 503);
});
test("Adapter route未設定/Dispatcherだけ有効を両側無効と区別する", async t => {
  const f = await setup(t); f.server.setRuntimeCommandIngress(undefined);
  const read = (route: string) => new Promise<number>((resolve, reject) => {
    const request = http.get({ socketPath: f.socketPath, path: route }, response => { response.resume(); response.once("end", () => resolve(response.statusCode!)); });
    request.once("error", reject);
  });
  assert.equal(await read("/health/ready"), 503); assert.equal(await read("/health/version"), 503);
  assert.equal((await post(f.socketPath, raw())).status, 404);
  f.config.slackRuntimeIngressEnabled = false;
  assert.equal(await read("/health/ready"), 200); assert.equal(await read("/health/version"), 200);
});
test("署名・installation確認後の文法エラーはephemeral 200、未認証入力は非200", async t => {
  const f = await setup(t);
  for (const text of ["status ", "unknown", "status\n", "update apply"]) {
    const response = await post(f.socketPath, raw(text));
    assert.equal(response.status, 200); const payload = JSON.parse(response.text);
    assert.equal(payload.response_type, "ephemeral"); assert.match(payload.text, /受け付けていません/);
  }
  assert.equal((await post(f.socketPath, raw("status "), { "x-slack-signature": "v0=" + "0".repeat(64) })).status, 403);
  assert.equal(f.count(), 0); assert.equal(f.database.list().length, 0);
});
test("inbox満杯のreadinessはnot-ready、既存receiptはGETで再利用する", async t => {
  const f = await setup(t), body = raw(), signed = headers(body), input = {
    ...verifyRuntimeCommandRequest(body, signed["x-slack-request-timestamp"], signed["x-slack-signature"], [workspace]),
    channel_type: "public_channel" as const };
  const receipt = await f.client.postRuntimeCommand(input, AbortSignal.timeout(2500));
  for (let i = 1; i < 1024; i++) f.database.acceptRuntimeCommand({ ...input, request_id: i.toString(16).padStart(64, "0") });
  assert.equal(await f.client.runtimeCommandIngressReady(), false);
  assert.deepEqual(await f.client.postRuntimeCommand(input, AbortSignal.timeout(2500)), receipt);
  assert.equal((await post(f.socketPath, body)).status, 200);
  assert.equal((await post(f.socketPath, raw("status", "new.fixture"))).status, 503);
});

test("受付停止後も認証済みreceipt GETを維持する", async t => {
  const f = await setup(t);
  const body = raw(), signed = headers(body), input = { ...verifyRuntimeCommandRequest(body, signed["x-slack-request-timestamp"], signed["x-slack-signature"], [workspace]), channel_type: "public_channel" as const };
  const first = await f.client.postRuntimeCommand(input, AbortSignal.timeout(2500));
  f.beginShutdown();
  assert.equal(await f.client.runtimeCommandIngressReady(), false);
  assert.deepEqual(await f.client.postRuntimeCommand(input, AbortSignal.timeout(2500)), first);
  await f.restart(); f.config.slackRuntimeIngressEnabled = false;
  assert.equal(await f.client.runtimeCommandIngressReady(), false);
  assert.deepEqual(await f.client.postRuntimeCommand(input, AbortSignal.timeout(2500)), first);
});

test("outbound intentだけの容量不足も受付healthをnot-readyにする", async t => {
  const f = await setup(t), body = raw();
  assert.equal((await post(f.socketPath, body)).status, 200);
  const directory = path.join(path.dirname(f.config.updateInternalTokenPath), "runtime-command-outbound");
  for (let i = 0; i < 1023; i++) await fs.writeFile(path.join(directory, String(i).padStart(64, "0")), "fixture", { mode: 0o600 });
  assert.equal(f.database.runtimeCommandCapacity(), true);
  assert.equal(await f.client.runtimeCommandIngressReady(), false);
  const request = (route: string) => new Promise<number>((resolve, reject) => {
    const req = http.get({ socketPath: f.socketPath, path: route }, response => { response.resume(); response.once("end", () => resolve(response.statusCode!)); });
    req.once("error", reject);
  });
  assert.equal(await request("/health/ready"), 503); assert.equal(await request("/health/version"), 503);
  assert.equal((await post(f.socketPath, body)).status, 200);
});
test("outbound directoryのowner書込不可と残存lockをnot-readyにする", async t => {
  const f = await setup(t); assert.equal((await post(f.socketPath, raw())).status, 200);
  const directory = path.join(path.dirname(f.config.updateInternalTokenPath), "runtime-command-outbound");
  await fs.chmod(directory, 0o500); assert.equal(await f.client.runtimeCommandIngressReady(), false);
  await fs.chmod(directory, 0o700); assert.equal(await f.client.runtimeCommandIngressReady(), true);
  await fs.writeFile(path.join(directory, "reservation.lock"), "", { mode: 0o600 });
  assert.equal(await f.client.runtimeCommandIngressReady(), false);
  assert.equal((await post(f.socketPath, raw("status", "fresh.fixture"))).status, 503);
});
test("同時要求でもoutbound intentの1024件上限を超えない", async t => {
  const f = await setup(t); assert.equal((await post(f.socketPath, raw())).status, 200);
  const directory = path.join(path.dirname(f.config.updateInternalTokenPath), "runtime-command-outbound");
  for (let i = 0; i < 1022; i++) await fs.writeFile(path.join(directory, String(i).padStart(64, "0")), "fixture", { mode: 0o600 });
  const inputs = Array.from({ length: 12 }, (_, index) => {
    const body = raw("status", `concurrent.${index}`), signed = headers(body);
    return { ...verifyRuntimeCommandRequest(body, signed["x-slack-request-timestamp"], signed["x-slack-signature"], [workspace]), channel_type: "public_channel" as const };
  });
  const outcomes = await Promise.allSettled(inputs.map(input => {
    const client = new DispatcherClient({ socketPath: f.config.socketPath, internalTokenPath: f.config.updateInternalTokenPath, timeoutMs: 1000, connectTimeoutMs: 100 });
    return client.postRuntimeCommand(input, AbortSignal.timeout(2500));
  }));
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  const entries = await fs.readdir(directory); assert.equal(entries.length, 1024); assert.equal(entries.includes("reservation.lock"), false);
  assert.equal(await f.client.runtimeCommandIngressReady(), false);
});
for (const cut of ["intent_sync", "lock_close"] as const) test(`POST前の${cut}でabortしたintentは回収し同じ配送を再受付できる`, async t => {
  const f = await setup(t), body = raw(), signed = headers(body);
  const input = { ...verifyRuntimeCommandRequest(body, signed["x-slack-request-timestamp"], signed["x-slack-signature"], [workspace]), channel_type: "public_channel" as const };
  const controller = new AbortController(), originalOpen = fs.open.bind(fs); let abortOnce = true;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (abortOnce && (cut === "intent_sync" ? String(args[0]).endsWith(input.request_id) : String(args[0]).endsWith("reservation.lock"))) {
      abortOnce = false;
      if (cut === "intent_sync") {
        const sync = handle.sync.bind(handle);
        t.mock.method(handle, "sync", async () => { controller.abort(); await sync(); });
      } else {
        const close = handle.close.bind(handle);
        t.mock.method(handle, "close", async () => { await close(); controller.abort(); });
      }
    }
    return handle;
  });
  await assert.rejects(f.client.postRuntimeCommand(input, controller.signal));
  assert.equal(f.database.runtimeCommandReceipt(input.request_id), null);
  const directory = path.join(path.dirname(f.config.updateInternalTokenPath), "runtime-command-outbound");
  assert.deepEqual(await fs.readdir(directory), []);
  assert.equal((await f.client.postRuntimeCommand(input, AbortSignal.timeout(2500))).state, "pending");
});
test("送信前abortでも同名置換された別inodeのintentを削除しない", async t => {
  const f = await setup(t), body = raw(), signed = headers(body);
  const input = { ...verifyRuntimeCommandRequest(body, signed["x-slack-request-timestamp"], signed["x-slack-signature"], [workspace]), channel_type: "public_channel" as const };
  const controller = new AbortController(), originalOpen = fs.open.bind(fs); let injectOnce = true;
  const directory = path.join(path.dirname(f.config.updateInternalTokenPath), "runtime-command-outbound");
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (injectOnce && String(args[0]).endsWith(input.request_id)) {
      injectOnce = false; const sync = handle.sync.bind(handle);
      t.mock.method(handle, "sync", async () => {
        await sync(); await fs.rename(String(args[0]), path.join(directory, "replaced.intent"));
        await fs.writeFile(String(args[0]), "replacement", { mode: 0o600 }); controller.abort();
      });
    }
    return handle;
  });
  await assert.rejects(f.client.postRuntimeCommand(input, controller.signal), /acceptance_unknown/);
  assert.equal(await fs.readFile(path.join(directory, input.request_id), "utf8"), "replacement");
  assert.equal(f.database.runtimeCommandReceipt(input.request_id), null);
});
test("readiness後のtoken rotationで確定403ならintentを回収し再配送できる", async t => {
  const f = await setup(t), socket = path.join(f.root, "rotation.sock"); let rotate = true;
  const tokens: string[] = [];
  const proxy = http.createServer((request, response) => {
    if (request.method === "POST" || request.url?.endsWith("/ready")) tokens.push(String(request.headers["x-dona-update-token"]));
    const upstream = http.request({ socketPath: f.config.socketPath, path: request.url, method: request.method, headers: request.headers }, result => {
      if (rotate && request.url?.endsWith("/ready")) {
        rotate = false; result.resume(); result.once("end", async () => {
          await fs.writeFile(f.config.updateInternalTokenPath, "rotated-fixture-token-" + "x".repeat(32));
          response.writeHead(result.statusCode!); response.end(JSON.stringify({ protocol: "runtime-control.v1", ready: true, acceptance_only: true }));
        });
      } else { response.writeHead(result.statusCode!, result.headers); result.pipe(response); }
    }); upstream.once("error", () => response.destroy()); request.pipe(upstream);
  });
  await new Promise<void>(resolve => proxy.listen(socket, resolve)); t.after(() => new Promise<void>(resolve => proxy.close(() => resolve())));
  const client = new DispatcherClient({ socketPath: socket, internalTokenPath: f.config.updateInternalTokenPath, timeoutMs: 1000, connectTimeoutMs: 100 });
  const body = raw(), signed = headers(body), input = { ...verifyRuntimeCommandRequest(body, signed["x-slack-request-timestamp"], signed["x-slack-signature"], [workspace]), channel_type: "public_channel" as const };
  await assert.rejects(client.postRuntimeCommand(input, AbortSignal.timeout(2500)), /unavailable/);
  assert.equal(tokens[0], tokens[1]); assert.equal(f.database.runtimeCommandReceipt(input.request_id), null);
  assert.deepEqual(await fs.readdir(path.join(path.dirname(f.config.updateInternalTokenPath), "runtime-command-outbound")), []);
  assert.equal((await client.postRuntimeCommand(input, AbortSignal.timeout(2500))).state, "pending");
});
test("local health未準備の間はSlack identity probeを呼ばない", async t => {
  const f = await setup(t), socket = path.join(f.root, "local-health.sock"); let socketReady = false, dispatcherReady = false, probes = 0;
  const server = new SlackHealthServer(socket, { isSocketReady: () => socketReady, isStopping: () => false,
    connectionStates: () => ({}), async quiesce() {}, drainStatus: () => ({ quiescing: false, drained: true, in_flight: 0, unsafe_states: [] }) },
    { healthReady: async () => dispatcherReady }, { debug() {}, info() {}, warn() {}, error() {} });
  server.setRuntimeCommandIngress(new RuntimeCommandHttpIngress({ configured: async () => ({ version: 1, workspaces: [workspace] }),
    ready: async () => { probes++; return true; }, stopping: () => false, authorize: async () => null, persist: async () => { throw Error("no_write"); } }));
  await server.start(); t.after(() => server.stop());
  const read = (route: string) => new Promise<number>((resolve, reject) => {
    const req = http.get({ socketPath: socket, path: route }, response => { response.resume(); response.once("end", () => resolve(response.statusCode!)); }); req.once("error", reject);
  });
  for (let i = 0; i < 5; i++) { assert.equal(await read("/health/ready"), 503); assert.equal(await read("/health/version"), 503); }
  socketReady = true; assert.equal(await read("/health/version"), 503); assert.equal(probes, 0);
  dispatcherReady = true; assert.equal(await read("/health/version"), 200); assert.equal(probes, 1);
});
