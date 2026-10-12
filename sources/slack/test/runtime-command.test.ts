import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { parseRuntimeCommand, verifyRuntimeCommandRequest } from "../src/runtime-command.js";
import { authorizeRuntimeCommand, verifyRuntimeIngressWorkspaces, RuntimeCommandHttpIngress } from "../src/runtime-command-ingress.js";
import type { SlackWorkspaceRegistry } from "../src/workspace-registry.js";
import { SlackWebApiClient } from "../src/slack-api.js";

const workspace = { alias: "test", team_id: "T1", app_id: "A1", enterprise_id: null, signing_secret: "fixture-secret-only-for-test" };
const timestamp = "1791738000", now = Number(timestamp) * 1000, opaque = "rc_" + "a".repeat(32);
function raw(text = "status", overrides: Record<string, string> = {}) {
  return Buffer.from(new URLSearchParams({ team_id: "T1", api_app_id: "A1", user_id: "U1", channel_id: "C1",
    command: "/dona", text, trigger_id: "123.456.fixture", response_url: "https://private-canary.invalid/secret", token: "secret-canary", ...overrides }).toString());
}
function signature(body: Buffer) { return "v0=" + createHmac("sha256", workspace.signing_secret).update(`v0:${timestamp}:`).update(body).digest("hex"); }
test("採用grammarの全operationとopaque参照をtyped unionに限定", () => {
  const cases = ["status", "restart plan", "update plan", `restart confirm ${opaque}`, `update confirm ${opaque}`, `operation ${opaque}`, `cancel ${opaque}`];
  assert.equal(new Set(cases.map(c => parseRuntimeCommand(c).operation)).size, 7);
  for (const invalid of ["", " status", "status ", "status x", "restart  plan", "restart\tplan", "update apply", "update status", "ＳＴＡＴＵＳ",
    "status\u200b", "status\n", "status\0", "status;id", `cancel ${opaque} x`, `cancel ${opaque.slice(1)}`, "a".repeat(257)])
    assert.throws(() => parseRuntimeCommand(invalid));
});
test("raw署名/freshnessの検証後だけdecodeし秘密のfieldを保存projectionへ含めない", () => {
  const body = raw("restart plan"), request = verifyRuntimeCommandRequest(body, timestamp, signature(body), [workspace], now);
  assert.equal(request.command.operation, "runtime.restart.plan.v1");
  assert.doesNotMatch(JSON.stringify(request), /canary|response_url|signing_secret/);
  assert.throws(() => verifyRuntimeCommandRequest(raw("update plan"), timestamp, signature(body), [workspace], now));
  for (const clock of [now - 300001, now + 300001, NaN]) assert.throws(() => verifyRuntimeCommandRequest(body, timestamp, signature(body), [workspace], clock));
  assert.doesNotThrow(() => verifyRuntimeCommandRequest(body, timestamp, signature(body), [workspace], now + 300000));
  const later = String(Number(timestamp) + 1), laterSignature = "v0=" + createHmac("sha256", workspace.signing_secret).update(`v0:${later}:`).update(body).digest("hex");
  assert.notEqual(verifyRuntimeCommandRequest(body, later, laterSignature, [workspace], now).request_id, request.request_id);
  assert.notEqual(verifyRuntimeCommandRequest(raw("update plan"), timestamp, signature(raw("update plan")), [workspace], now).request_id, request.request_id);
});
test("duplicate field・壊れたencoding・別installation・command差替えを拒否", () => {
  for (const body of [Buffer.concat([raw(), Buffer.from("&text=status")]), Buffer.concat([raw(), Buffer.from("&%74ext=status")]),
    Buffer.concat([raw(), Buffer.from("&bad=%FF")]), Buffer.concat([raw(), Buffer.from("&bad=%")]),
    raw("%73tatus"), raw("status", { team_id: "T2" }), raw("status", { api_app_id: "A2" }), raw("status", { enterprise_id: "E1" }),
    raw("status", { command: "/other" }), raw("status", { trigger_id: "../../secret" }), Buffer.alloc(8193)])
    assert.throws(() => verifyRuntimeCommandRequest(body, timestamp, signature(body), [workspace], now));
  assert.throws(() => verifyRuntimeCommandRequest(raw(), timestamp, signature(raw()), [workspace, workspace], now));
});
test("現在の本人所属とchannel状態を再取得し別workspace/人/DM/共有を拒否", async () => {
  const body = raw(), input = verifyRuntimeCommandRequest(body, timestamp, signature(body), [workspace], now);
  let user = { stateKnown: true, id: "U1", teamId: "T1", isBot: false, isAppUser: false, isDeleted: false, isSuspended: false };
  let channel = { id: "C1", visibilityKnown: true, isPrivate: false, isArchived: false, isMember: true, isShared: false };
  let actorMember = true;
  const registry = { get: () => ({ teamId: "T1", client: { getUser: async () => user, getChannel: async () => channel,
    hasChannelMember: async (channelId: string, actorId: string) => { assert.equal(channelId, "C1"); assert.equal(actorId, "U1"); return actorMember; } } }) } as unknown as Pick<SlackWorkspaceRegistry, "get">;
  const check = () => authorizeRuntimeCommand(registry, input, new AbortController().signal);
  assert.deepEqual(await check(), { channel_type: "public_channel" });
  for (const mutation of [{ stateKnown: false }, { id: "U2" }, { teamId: "T2" }, { isBot: true }, { isAppUser: true }, { isDeleted: true }, { isSuspended: true }]) {
    const old = user; user = { ...user, ...mutation }; assert.equal(await check(), null); user = old;
  }
  channel.isMember = false; assert.deepEqual(await check(), { channel_type: "public_channel" });
  actorMember = false; assert.equal(await check(), null); actorMember = true;
  channel.isPrivate = true; assert.equal(await check(), null);
  channel.isMember = true; assert.deepEqual(await check(), { channel_type: "private_channel" }); channel.isPrivate = false;
  for (const mutation of [{ id: "C2" }, { isShared: true }, { isArchived: true }, { visibilityKnown: false }]) {
    const old = channel; channel = { ...channel, ...mutation }; assert.equal(await check(), null); channel = old;
  }
  channel = { ...channel, id: "C1", isIm: true, userId: "U2" } as typeof channel;
  assert.equal(await check(), null);
  channel = { ...channel, userId: "U1" } as typeof channel; assert.deepEqual(await check(), { channel_type: "im" });
  const aborted = new AbortController(); aborted.abort();
  assert.equal(await authorizeRuntimeCommand(registry, input, aborted.signal), null);
});
test("Slack APIのsuspendedを保持し、不正な型を本人確認済みとしない", async t => {
  let suspended: unknown = true;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: true,
    user: { id: "U1", team_id: "T1", is_bot: false, is_app_user: false, deleted: false,
      ...(suspended === undefined ? {} : { suspended }) } }), { headers: { "content-type": "application/json" } }));
  const client = new SlackWebApiClient("fixture-token", { debug() {}, info() {}, warn() {}, error() {} });
  const read = () => client.getUser("U1", new AbortController().signal);
  assert.equal((await read()).isSuspended, true);
  suspended = false; assert.equal((await read()).isSuspended, false);
  suspended = "false"; assert.equal((await read()).stateKnown, false);
  suspended = undefined; assert.equal((await read()).stateKnown, true); assert.equal((await read()).isSuspended, undefined);
});

test("runtime Bot identityはauth.testのBotとbots.infoのappを照合する", async t => {
  let actualBot = "B1";
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("bots.info")) assert.match(String(init?.body), /team_id=T1/);
    return new Response(JSON.stringify(String(url).endsWith("auth.test")
    ? { ok: true, team_id: "T1", bot_id: "B1" }
    : { ok: true, bot: { id: actualBot, app_id: "A1", deleted: false } }), { headers: { "content-type": "application/json" } }); });
  const client = new SlackWebApiClient("fixture-token", { debug() {}, info() {}, warn() {}, error() {} });
  assert.deepEqual(await client.runtimeCommandIdentity(AbortSignal.timeout(2500)), { teamId: "T1", appId: "A1", enterpriseId: null });
  actualBot = "B2";
  await assert.rejects(client.runtimeCommandIdentity(AbortSignal.timeout(2500)), /bot_unverified/);
});

test("同じteamの別App Botをruntime signing configへ結び付けない", async () => {
  let appId = "A2";
  const registry = { get: () => ({ teamId: "T1", client: { runtimeCommandIdentity: async () => ({ teamId: "T1", appId, enterpriseId: null }) } }) } as unknown as Pick<SlackWorkspaceRegistry, "get">;
  const config = { version: 1 as const, workspaces: [{ ...workspace, actor_ids: ["U1"] }] };
  await assert.rejects(verifyRuntimeIngressWorkspaces(registry, config, AbortSignal.timeout(2500)), /workspace_unverified/);
  appId = "A1";
  assert.deepEqual((await verifyRuntimeIngressWorkspaces(registry, config, AbortSignal.timeout(2500))).get("test"), { teamId: "T1", appId: "A1", enterpriseId: null });
});
test("private channelのBot未参加によるAPIエラーをfail-closedにする", async () => {
  const body = raw(), input = verifyRuntimeCommandRequest(body, timestamp, signature(body), [workspace], now);
  const registry = { get: () => ({ teamId: "T1", client: {
    getUser: async () => ({ stateKnown: true, id: "U1", teamId: "T1" }),
    getChannel: async () => { throw Error("channel_not_found"); },
    hasChannelMember: async () => true,
  } }) } as unknown as Pick<SlackWorkspaceRegistry, "get">;
  assert.equal(await authorizeRuntimeCommand(registry, input, AbortSignal.timeout(2500)), null);
});

test("runtime継続readinessは起動後のBot token失効を検知する", async t => {
  let revoked = false;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => new Response(JSON.stringify(revoked
    ? { ok: false, error: "token_revoked" }
    : String(url).endsWith("auth.test") ? { ok: true, team_id: "T1", bot_id: "B1" }
    : { ok: true, bot: { id: "B1", app_id: "A1", deleted: false } }), { headers: { "content-type": "application/json" } }));
  const client = new SlackWebApiClient("fixture-token", { debug() {}, info() {}, warn() {}, error() {} });
  const registry = { get: () => ({ teamId: "T1", client }) } as unknown as Pick<SlackWorkspaceRegistry, "get">;
  const config = { version: 1 as const, workspaces: [{ ...workspace, actor_ids: ["U1"] }] };
  await verifyRuntimeIngressWorkspaces(registry, config, AbortSignal.timeout(2500));
  const ingress = new RuntimeCommandHttpIngress({ configured: async () => config, stopping: () => false,
    ready: async signal => { await verifyRuntimeIngressWorkspaces(registry, config, signal); return true; },
    authorize: async () => null, persist: async () => { throw Error("must_not_write"); } });
  assert.equal(await ingress.ready(), true);
  revoked = true; assert.equal(await ingress.ready(), false);
});

test("Enterprise IDの設定誤りを起動と継続readinessで拒否する", async t => {
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => new Response(JSON.stringify(String(url).endsWith("auth.test")
    ? { ok: true, team_id: "T1", bot_id: "B1", enterprise_id: "E1" }
    : { ok: true, bot: { id: "B1", app_id: "A1", deleted: false } }), { headers: { "content-type": "application/json" } }));
  const client = new SlackWebApiClient("fixture-token", { debug() {}, info() {}, warn() {}, error() {} });
  const registry = { get: () => ({ teamId: "T1", client }) } as unknown as Pick<SlackWorkspaceRegistry, "get">;
  const config = { version: 1 as const, workspaces: [{ ...workspace, enterprise_id: "E2", actor_ids: ["U1"] }] };
  await assert.rejects(verifyRuntimeIngressWorkspaces(registry, config, AbortSignal.timeout(2500)), /workspace_unverified/);
  config.workspaces[0]!.enterprise_id = "E1";
  assert.equal((await verifyRuntimeIngressWorkspaces(registry, config, AbortSignal.timeout(2500))).get("test")?.enterpriseId, "E1");
});

test("認可照会が一方失敗したら残る兄弟照会を直ちにabortする", async () => {
  const body = raw(), input = verifyRuntimeCommandRequest(body, timestamp, signature(body), [workspace], now);
  let aborted = false;
  const registry = { get: () => ({ teamId: "T1", client: {
    getUser: async () => { throw Error("token_revoked"); },
    getChannel: (_id: string, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(Error("aborted")); }, { once: true });
    }),
  } }) } as unknown as Pick<SlackWorkspaceRegistry, "get">;
  assert.equal(await authorizeRuntimeCommand(registry, input, AbortSignal.timeout(2500)), null);
  assert.equal(aborted, true);
});
