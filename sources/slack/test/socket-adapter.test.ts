import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";

import type { SlackAdapterConfig } from "../src/adapter-config.js";
import type { DispatcherResponse } from "../src/dispatcher-client.js";
import type { SlackLogger } from "../src/logger.js";
import { SlackSocketAdapter, type SocketEnvelopeEvent } from "../src/socket-adapter.js";

const config: SlackAdapterConfig = {
  workspaces: ["company"],
  dispatcherSocketPath: "/tmp/dispatcher.sock",
  healthSocketPath: "/tmp/slack-health.sock",
  updateInternalTokenPath: "/tmp/dispatcher.token",
  dispatcherConnectTimeoutMs: 500,
  dispatcherTimeoutMs: 2_000,
  shutdownGraceMs: 200,
  socketModeEnabled: true,
  logLevel: "info",
  buildSha: "development",
  appSchemaWrite: 3,
  appSchemaReadMax: 3,
};
const logger: SlackLogger = { debug() {}, info() {}, warn() {}, error() {} };

class FakeSocketClient extends EventEmitter {
  starts = 0;
  disconnects = 0;
  async start() {
    this.starts += 1;
    this.emit("connecting");
    this.emit("connected");
    return {};
  }
  async disconnect() {
    this.disconnects += 1;
    this.emit("disconnecting");
    this.emit("disconnected");
  }
}

function eventBody(eventId = "Ev0123456789") {
  return {
    type: "event_callback",
    event_id: eventId,
    team_id: "T01234567",
    authorizations: [{ user_id: "U_BOT" }],
    event: {
      type: "app_mention",
      user: "U_USER",
      channel: "C01234567",
      ts: "1756722030.123456",
      event_ts: "1756722030.123456",
      text: "hello",
    },
  };
}

function socketEnvelope(
  envelopeId: string,
  ack: () => Promise<void>,
  body: Record<string, unknown> = eventBody(),
): SocketEnvelopeEvent {
  return { type: "events_api", envelope_id: envelopeId, body, ack };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("SlackSocketAdapter", () => {
  test("does not ACK until Dispatcher returns persisted status", async () => {
    const client = new FakeSocketClient();
    let finishDispatch: ((response: DispatcherResponse) => void) | undefined;
    const dispatcher = {
      postEvent: () => new Promise<DispatcherResponse>((resolve) => void (finishDispatch = resolve)),
      healthReady: async () => true,
    };
    const adapter = new SlackSocketAdapter([{ workspace: "company", client }], dispatcher, config, logger);
    await adapter.start();
    let acked = false;
    client.emit("slack_event", socketEnvelope("env-1", async () => void (acked = true)));
    await waitFor(() => finishDispatch !== undefined);
    assert.equal(acked, false);
    finishDispatch!({ statusCode: 202, body: "{}" });
    await waitFor(() => acked);
    await adapter.stop();
  });

  test("ACKs duplicate 200 responses but not Dispatcher failures or 4xx", async () => {
    const client = new FakeSocketClient();
    const responses: Array<DispatcherResponse | Error> = [
      { statusCode: 200, body: "{}" },
      new Error("offline"),
      { statusCode: 400, body: "{}" },
      { statusCode: 503, body: "{}" },
    ];
    const dispatcher = {
      async postEvent() {
        const response = responses.shift()!;
        if (response instanceof Error) throw response;
        return response;
      },
      healthReady: async () => true,
    };
    const adapter = new SlackSocketAdapter([{ workspace: "company", client }], dispatcher, config, logger);
    await adapter.start();
    let ackCount = 0;
    for (const envelopeId of ["env-1", "env-2", "env-3", "env-4"]) {
      client.emit("slack_event", socketEnvelope(envelopeId, async () => void (ackCount += 1)));
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.equal(ackCount, 1);
    await adapter.stop();
  });

  test("deduplication identity comes from inner event_id, not changing envelope_id", async () => {
    const client = new FakeSocketClient();
    const sent: Array<Record<string, any>> = [];
    const dispatcher = {
      async postEvent(envelope: unknown) {
        sent.push(envelope as Record<string, any>);
        return { statusCode: sent.length === 1 ? 202 : 200, body: "{}" };
      },
      healthReady: async () => true,
    };
    const adapter = new SlackSocketAdapter([{ workspace: "company", client }], dispatcher, config, logger);
    await adapter.start();
    let ackCount = 0;
    client.emit(
      "slack_event",
      socketEnvelope("env-first", async () => {
        throw new Error("connection closed before ACK");
      }),
    );
    client.emit("slack_event", socketEnvelope("env-retry", async () => void (ackCount += 1)));
    await waitFor(() => sent.length === 2 && ackCount === 1);
    assert.equal(sent[0]!.external_event_id, "Ev0123456789");
    assert.equal(sent[1]!.external_event_id, "Ev0123456789");
    assert.equal(sent[0]!.trace.socket_envelope_id, "env-first");
    assert.equal(sent[1]!.trace.socket_envelope_id, "env-retry");
    await adapter.stop();
  });

  test("ACKs deliberately ignored events without calling Dispatcher", async () => {
    const client = new FakeSocketClient();
    let calls = 0;
    const adapter = new SlackSocketAdapter(
      [{ workspace: "company", client }],
      {
        async postEvent() {
          calls += 1;
          return { statusCode: 202, body: "{}" };
        },
        healthReady: async () => true,
      },
      config,
      logger,
    );
    await adapter.start();
    let acked = false;
    client.emit(
      "slack_event",
      socketEnvelope("env-ignore", async () => void (acked = true), {
        ...eventBody(),
        event: { type: "reaction_added" },
      }),
    );
    await waitFor(() => acked);
    assert.equal(calls, 0);
    await adapter.stop();
  });

  test("ACKs duplicate message delivery for an app mention without dispatching it", async () => {
    const client = new FakeSocketClient();
    let calls = 0;
    const adapter = new SlackSocketAdapter(
      [{ workspace: "company", client }],
      {
        async postEvent() {
          calls += 1;
          return { statusCode: 202, body: "{}" };
        },
        healthReady: async () => true,
      },
      config,
      logger,
    );
    await adapter.start();
    let acked = false;
    client.emit(
      "slack_event",
      socketEnvelope("env-message-duplicate", async () => void (acked = true), {
        ...eventBody("Ev-message-duplicate"),
        event: {
          type: "message",
          user: "U_USER",
          channel: "C01234567",
          channel_type: "channel",
          ts: "1756722030.123456",
          event_ts: "1756722030.123456",
          text: "<@U_BOT> hello",
        },
      }),
    );
    await waitFor(() => acked);
    assert.equal(calls, 0);
    await adapter.stop();
  });

  test("reconnects after an unexpected disconnect", async () => {
    const client = new FakeSocketClient();
    const adapter = new SlackSocketAdapter(
      [{ workspace: "company", client }],
      { postEvent: async () => ({ statusCode: 202, body: "{}" }), healthReady: async () => true },
      config,
      logger,
      () => 0,
    );
    await adapter.start();
    client.emit(
      "ws_message",
      JSON.stringify({ type: "disconnect", reason: "refresh_requested" }),
      false,
    );
    client.emit("disconnected", new Error("network lost"));
    await waitFor(() => client.starts === 2, 1_500);
    assert.equal(adapter.connectionStates().company, "connected");
    await adapter.stop();
  });

  test("does not schedule retries for permanent authentication errors", async () => {
    class AuthFailureClient extends FakeSocketClient {
      override async start(): Promise<never> {
        this.starts += 1;
        throw { data: { error: "invalid_auth" } };
      }
    }
    const client = new AuthFailureClient();
    const adapter = new SlackSocketAdapter(
      [{ workspace: "company", client }],
      { postEvent: async () => ({ statusCode: 202, body: "{}" }), healthReady: async () => true },
      config,
      logger,
    );
    await assert.rejects(adapter.start());
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(client.starts, 1);
    assert.equal(adapter.connectionStates().company, "authentication_failed");
    await adapter.stop();
  });

  test("quiesce stops new ingress and exposes incomplete then completed ACK drain", async () => {
    const client = new FakeSocketClient();
    let finishDispatch: ((response: DispatcherResponse) => void) | undefined;
    const adapter = new SlackSocketAdapter(
      [{ workspace: "company", client }],
      {
        postEvent: () => new Promise<DispatcherResponse>((resolve) => void (finishDispatch = resolve)),
        healthReady: async () => true,
      },
      { ...config, shutdownGraceMs: 10 },
      logger,
    );
    await adapter.start();
    let acked = false;
    client.emit("slack_event", socketEnvelope("env-drain", async () => void (acked = true)));
    await waitFor(() => finishDispatch !== undefined);
    await adapter.quiesce();
    assert.equal(adapter.drainStatus().drained, false);
    let ignoredAck = false;
    client.emit("slack_event", socketEnvelope("env-after-quiesce", async () => void (ignoredAck = true)));
    finishDispatch!({ statusCode: 202, body: "{}" });
    await waitFor(() => acked && adapter.drainStatus().drained);
    assert.equal(ignoredAck, false);
    assert.equal(client.disconnects, 1);
  });

  test("quiesceは進行中のreminder配送もdrain対象にする", async () => {
    const client = new FakeSocketClient();
    const adapter = new SlackSocketAdapter(
      [{ workspace: "company", client }],
      { postEvent: async () => ({ statusCode: 202, body: "{}" }), healthReady: async () => true },
      { ...config, shutdownGraceMs: 10 },
      logger,
    );
    await adapter.start();
    let finish: (() => void) | undefined;
    const delivery = adapter.trackOperation(new Promise<void>((resolve) => void (finish = resolve)));
    await adapter.quiesce();
    assert.equal(adapter.drainStatus().drained, false);
    finish!();
    await delivery;
    await waitFor(() => adapter.drainStatus().drained);
  });
});

for(const outcome of ["timeout","failure","success"] as const)test(`origin visibility ${outcome}はdurable ingressとACKを阻害しない`,async()=>{
 const client=new FakeSocketClient();let release:(v:"public_channel"|"private_channel")=>void=()=>{},acked=false,readSignal:AbortSignal|undefined;const calls:Array<{value:unknown;team:unknown}>=[];
 const visibility=outcome==="timeout"?new Promise<"public_channel"|"private_channel">(r=>{release=r;}):outcome==="failure"?Promise.reject(Error("visibility unavailable")):Promise.resolve("public_channel" as const);
 // rejection handlerはeventを処理するときに付くため、ここでのunhandled rejectionを避ける。
 void visibility.catch(()=>{});
 const dispatcher={async postEvent(value:unknown,team?:string){calls.push({value,team});return {statusCode:202,body:"{}"};},healthReady:async()=>true};
 const adapter=new SlackSocketAdapter([{workspace:"company",client,authenticatedTeamId:"T01234567",verifyActor:async()=>true,statusOriginVisibility:(_value,signal)=>{readSignal=signal;return visibility;}}],dispatcher,config,logger);
 await adapter.start();try {
  client.emit("slack_event",socketEnvelope(`visibility-${outcome}`,async()=>{acked=true;}));
  await waitFor(()=>acked,1000);assert.equal(calls.length,1);
  const value=calls[0]!.value as {trace?:{status_origin_visibility?:string}};
  assert.equal(value.trace?.status_origin_visibility,outcome==="success"?"public_channel":undefined);
  if(outcome==="timeout")assert.equal(readSignal?.aborted,true);
  assert.equal(calls[0]!.team,"T01234567");
  release("private_channel");await new Promise(r=>setTimeout(r,10));assert.equal(calls.length,1);
 }finally{release("public_channel");await adapter.stop();}
});

test("本人照会の期限後もDispatcherのcommitを待ち、通常のACK予算内で応答する",async()=>{
 const client=new FakeSocketClient();let acked=false,committed=false,signal:AbortSignal|undefined;
 const adapter=new SlackSocketAdapter([{workspace:"company",client,authenticatedTeamId:"T01234567",verifyActor:async(_id,current)=>{signal=current;return new Promise(()=>{});}}],
 {postEvent:async(_value,team)=>{assert.equal(team,undefined);await new Promise(resolve=>setTimeout(resolve,1200));committed=true;return {statusCode:202,body:"{}"};},healthReady:async()=>true},config,logger);
 await adapter.start();try {
  const started=Date.now();client.emit("slack_event",socketEnvelope("actor-budget",async()=>{assert.equal(committed,true);acked=true;}));
  await waitFor(()=>acked,2900);assert.equal(signal?.aborted,true);assert.ok(Date.now()-started<2900);
 }finally{await adapter.stop();}
});
