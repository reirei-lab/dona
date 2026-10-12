import { constants } from "node:fs";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { RuntimeCommandError, verifyRuntimeCommandRequest, type RuntimeCommandRequest, type AuthorizedRuntimeCommandRequest } from "./runtime-command.js";
import type { SlackWorkspaceRegistry } from "./workspace-registry.js";

export async function authorizeRuntimeCommand(registry: Pick<SlackWorkspaceRegistry, "get">,
  request: RuntimeCommandRequest, signal: AbortSignal): Promise<{ channel_type: AuthorizedRuntimeCommandRequest["channel_type"] } | null> {
  try {
    const connection = registry.get(request.workspace);
    if (connection.teamId !== request.workspace_id) return null;
    const [user, channel] = await Promise.all([
      connection.client.getUser(request.actor_id, signal), connection.client.getChannel(request.channel_id, signal),
    ]);
    signal.throwIfAborted();
    const principalValid = user.stateKnown === true && user.id === request.actor_id && user.teamId === request.workspace_id
      && !user.isBot && !user.isAppUser && !user.isDeleted && !user.isAgentforceBot && !user.isSuspended
      && channel.id === request.channel_id && !channel.isShared && !channel.isArchived
      && (channel.isIm ? channel.userId === request.actor_id : channel.visibilityKnown === true && !channel.isMpim);
    if (!principalValid) return null;
    const permitted = channel.isIm || !!connection.client.hasChannelMember
      && await connection.client.hasChannelMember(request.channel_id, request.actor_id, signal);
    signal.throwIfAborted();
    return permitted ? { channel_type: channel.isIm ? "im" : channel.isPrivate ? "private_channel" : "public_channel" } : null;
  } catch { return null; }
}

const configSchema = z.strictObject({ version: z.literal(1), workspaces: z.array(z.strictObject({
  alias: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), team_id: z.string().regex(/^T[A-Z0-9]{1,127}$/),
  app_id: z.string().regex(/^A[A-Z0-9]{1,127}$/), enterprise_id: z.string().regex(/^E[A-Z0-9]{1,127}$/).nullable(),
  signing_secret: z.string().min(16).max(256), actor_ids: z.array(z.string().regex(/^[UW][A-Z0-9]{1,127}$/)).min(1).max(128),
})).min(1).max(16) });
export type RuntimeIngressConfig = z.infer<typeof configSchema>;
export async function readRuntimeIngressConfig(filename: string): Promise<RuntimeIngressConfig> {
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid?.() || before.nlink !== 1
      || (before.mode & 0o077) !== 0 || before.size > 65536) throw Error("runtime_ingress_config_unverified");
    const raw = await file.readFile("utf8");
    if (Buffer.byteLength(raw) > 65536) throw Error("runtime_ingress_config_unverified");
    const result = configSchema.parse(JSON.parse(raw));
    if (new Set(result.workspaces.map(w => w.alias)).size !== result.workspaces.length
      || new Set(result.workspaces.map(w => `${w.team_id}:${w.app_id}`)).size !== result.workspaces.length)
      throw Error("runtime_ingress_config_unverified");
    return result;
  } finally { await file.close(); }
}

interface Receipt { request_id: string; canonical_sha256: string; state: "pending"; received_at: string }
export interface RuntimeIngressPorts {
  configured(): Promise<RuntimeIngressConfig>;
  authorize(request: RuntimeCommandRequest, signal: AbortSignal): Promise<{ channel_type: AuthorizedRuntimeCommandRequest["channel_type"] } | null>;
  persist(request: AuthorizedRuntimeCommandRequest, signal: AbortSignal): Promise<Receipt>;
  stopping(): boolean;
  ready(signal: AbortSignal): Promise<boolean>;
}

function readRaw(request: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => {
      request.off("data", data); request.off("end", end); request.off("error", fail);
      request.off("aborted", aborted); signal.removeEventListener("abort", abort);
    };
    const fail = (error: Error) => { cleanup(); request.pause(); reject(error); };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8192) { fail(new RuntimeCommandError("too_large")); return; }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const abort = () => fail(new RuntimeCommandError("unavailable"));
    const aborted = () => fail(new RuntimeCommandError("unavailable"));
    request.on("data", data); request.once("end", end); request.once("error", fail); request.once("aborted", aborted);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** 2.5秒でACK/拒否。receiptを失ったwriteを再送せず同じrequestのdurable intakeで照合する。 */
export class RuntimeCommandHttpIngress {
  constructor(private readonly ports: RuntimeIngressPorts, private readonly now = Date.now) {}
  async ready(): Promise<boolean> {
    const signal = AbortSignal.timeout(2500);
    try {
      const config = await this.ports.configured(); signal.throwIfAborted();
      if (this.ports.stopping() || !await this.ports.ready(signal)) return false;
      const current = await this.ports.configured(); signal.throwIfAborted();
      return !this.ports.stopping() && JSON.stringify(current) === JSON.stringify(config);
    } catch { return false; }
  }
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = (status: number, text: string) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "connection": "close" });
      response.once("finish", () => request.destroy());
      response.end(JSON.stringify({ response_type: "ephemeral", text }));
    };
    timer = setTimeout(() => { controller.abort(); send(503, "受付結果を確認できません。実行成功は確認されていません。"); }, 2500);
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method !== "POST" || url.search || request.headers["content-type"]?.split(";")[0]?.trim() !== "application/x-www-form-urlencoded")
        throw new RuntimeCommandError("invalid_request");
      if (this.ports.stopping()) throw new RuntimeCommandError("unavailable");
      const body = await readRaw(request, controller.signal);
      const timestamp = request.headers["x-slack-request-timestamp"], signature = request.headers["x-slack-signature"];
      if (typeof timestamp !== "string" || typeof signature !== "string") throw new RuntimeCommandError("unauthenticated");
      const config = await this.ports.configured(); controller.signal.throwIfAborted();
      const input = verifyRuntimeCommandRequest(body, timestamp, signature, config.workspaces, this.now());
      if (!config.workspaces.find(w => w.alias === input.workspace)?.actor_ids.includes(input.actor_id))
        throw new RuntimeCommandError("unauthenticated");
      const evidence = await this.ports.authorize(input, controller.signal);
      if (!evidence || !["im", "public_channel", "private_channel"].includes(evidence.channel_type))
        throw new RuntimeCommandError("unauthenticated");
      controller.signal.throwIfAborted();
      if (this.ports.stopping() || JSON.stringify(await this.ports.configured()) !== JSON.stringify(config))
        throw new RuntimeCommandError("unavailable");
      controller.signal.throwIfAborted();
      verifyRuntimeCommandRequest(body, timestamp, signature, config.workspaces, this.now());
      const receipt = await this.ports.persist({ ...input, channel_type: evidence.channel_type }, controller.signal);
      controller.signal.throwIfAborted();
      if (receipt.request_id !== input.request_id || receipt.state !== "pending" || !Number.isFinite(Date.parse(receipt.received_at)))
        throw new RuntimeCommandError("unavailable");
      send(200, "要求を永続的に受け付けました。操作はまだ実行されていません。");
    } catch (error) {
      const code = error instanceof RuntimeCommandError ? error.code : "unavailable";
      if (code === "invalid_command") send(200, "命令の形式を確認してください。status、restart plan、update planなどの完全一致形式を使います。この入力は受け付けていません。");
      else send(code === "too_large" ? 413 : code === "invalid_request" ? 400 : code === "unauthenticated" ? 403 : 503,
        "要求を受け付けられません。操作成功は確認されていません。");
    } finally { clearTimeout(timer); }
  }
}
