import { signSlackPrincipalProof } from "./principal-proof.js";
import http from "node:http";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { runtimeCommandDigest, type RuntimeCommandRequest } from "./runtime-command.js";

export interface DispatcherResponse {
  statusCode: number;
  body: string;
}

export interface DispatcherClientOptions {
  socketPath: string;
  connectTimeoutMs: number;
  timeoutMs: number;
  internalTokenPath?: string;
}

export class DispatcherClient {
  constructor(private readonly options: DispatcherClientOptions) {}

  private readonly ambiguousRuntimeRequests = new Set<string>();

  private async runtimeCommandToken(signal: AbortSignal): Promise<string> {
    if (!this.options.internalTokenPath) throw Error("runtime_command_unavailable");
    signal.throwIfAborted();
    const file = await fs.open(this.options.internalTokenPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 4096)
        throw Error("runtime_command_unavailable");
      const token = (await file.readFile("utf8")).trim();
      if (token.length < 32 || Buffer.byteLength(token) > 4096) throw Error("runtime_command_unavailable");
      signal.throwIfAborted(); return token;
    } finally { await file.close(); }
  }

  async runtimeCommandIngressReady(signal = AbortSignal.timeout(2500)): Promise<boolean> {
    try {
      const token = await this.runtimeCommandToken(signal);
      const response = await this.request("GET", "/v1/internal/slack-runtime-commands/ready", undefined, token, {}, signal);
      const body = JSON.parse(response.body) as Record<string, unknown>;
      return response.statusCode === 200 && body.ready === true && body.protocol === "runtime-control.v1"
        && body.acceptance_only === true;
    } catch { return false; }
  }

  async postRuntimeCommand(input: RuntimeCommandRequest, signal: AbortSignal) {
    const token = await this.runtimeCommandToken(signal);
    const expected = runtimeCommandDigest(input);
    type Receipt = { request_id: string; canonical_sha256: string; state: "pending"; received_at: string };
    const verify = (raw: unknown): Receipt => {
      const value = raw as Partial<Receipt> | null;
      if (!value || value.request_id !== input.request_id || value.canonical_sha256 !== expected || value.state !== "pending"
        || typeof value.received_at !== "string" || !Number.isFinite(Date.parse(value.received_at))) throw Error("runtime_command_unverified");
      return value as Receipt;
    };
    const lookup = async (): Promise<Receipt | null> => {
      const response = await this.request("GET", `/v1/internal/slack-runtime-commands/${input.request_id}`, undefined, token, {}, signal);
      if (response.statusCode !== 200) throw Error("runtime_command_unavailable");
      const value = JSON.parse(response.body) as { receipt?: unknown };
      if (value.receipt === null) return null;
      return verify(value.receipt);
    };
    // 再配送でも最初に照合する。同じclientでの受理不明は新しいPOSTで迂回しない。
    const prior = await lookup();
    if (prior) { this.ambiguousRuntimeRequests.delete(input.request_id); return prior; }
    if (this.ambiguousRuntimeRequests.has(input.request_id) || this.ambiguousRuntimeRequests.size >= 1024)
      throw Error("runtime_command_acceptance_unknown");
    let response: DispatcherResponse;
    try {
      response = await this.request("POST", "/v1/internal/slack-runtime-commands", Buffer.from(JSON.stringify(input)), token, {}, signal);
    } catch {
      this.ambiguousRuntimeRequests.add(input.request_id);
      const receipt = await lookup();
      if (!receipt) throw Error("runtime_command_acceptance_unknown");
      this.ambiguousRuntimeRequests.delete(input.request_id); return receipt;
    }
    if (response.statusCode >= 500) {
      this.ambiguousRuntimeRequests.add(input.request_id);
      const receipt = await lookup();
      if (!receipt) throw Error("runtime_command_acceptance_unknown");
      this.ambiguousRuntimeRequests.delete(input.request_id); return receipt;
    }
    if (response.statusCode !== 200) throw Error("runtime_command_unavailable");
    return verify(JSON.parse(response.body));
  }

  async postEvent(envelope: unknown, authenticatedWorkspaceId?:string): Promise<DispatcherResponse> {
    const value=envelope as Record<string,unknown>;
    let headers:Record<string,string>={};
    if(authenticatedWorkspaceId && this.options.internalTokenPath) {
      const key=(await fs.readFile(this.options.internalTokenPath,"utf8")).trim();
      const trace={...(value.trace as Record<string,unknown>??{}),ingress_attempt:1};
      envelope={...value,trace};
      const signed=signSlackPrincipalProof(envelope as Record<string,unknown>,1,authenticatedWorkspaceId,key);
      headers={"x-dona-slack-principal-proof":signed.proof,"x-dona-slack-principal-signature":signed.signature};
    }
    const body = Buffer.from(JSON.stringify(envelope));
    return this.request("POST", "/v1/events", body,undefined,headers);
  }

  healthReady(): Promise<boolean> {
    return this.request("GET", "/health/ready").then(
      (response) => response.statusCode === 200,
      () => false,
    );
  }

  async resolveJobProgress(progressId: string, deliveryToken: string): Promise<unknown> {
    try {
      const token = this.options.internalTokenPath ? (await fs.readFile(this.options.internalTokenPath, "utf8")).trim() : "";
      const response = await this.request("GET", `/v1/internal/job-progress?progress_id=${encodeURIComponent(progressId)}&delivery_token=${encodeURIComponent(deliveryToken)}`, undefined, token);
      if (response.statusCode !== 200) throw Object.assign(new Error(`Dispatcher rejected progress resolution with HTTP ${response.statusCode}`), response.statusCode===403||response.statusCode===425||response.statusCode>=500 ? {progressRetryable:true} : {progressPermanent:true});
      return JSON.parse(response.body);
    } catch (error) {
      const tagged=error as Error & {progressRetryable?:boolean;progressPermanent?:boolean};
      if(tagged.progressRetryable||tagged.progressPermanent)throw tagged;
      throw Object.assign(error instanceof Error?error:new Error(String(error)),{progressRetryable:true});
    }
  }

  private request(method: "GET" | "POST", path: string, body?: Buffer, internalToken?: string,extraHeaders:Record<string,string>={}, signal?: AbortSignal): Promise<DispatcherResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let connectTimer: NodeJS.Timeout | undefined;
      const finish = (
        outcome: { response: DispatcherResponse } | { error: Error },
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        if (connectTimer) clearTimeout(connectTimer);
        if ("error" in outcome) reject(outcome.error);
        else resolve(outcome.response);
      };
      const request = http.request(
        {
          socketPath: this.options.socketPath,
          method,
          path,
          ...(signal ? { signal } : {}),
          headers: {
            ...extraHeaders,
            ...(body ? {
                "content-type": "application/json",
                "content-length": body.length,
              } : {}),
            ...(internalToken ? { "x-dona-update-token":internalToken } : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= 1_048_576) chunks.push(chunk);
          });
          response.on("end", () => {
            finish({
              response: {
                statusCode: response.statusCode ?? 500,
                body: Buffer.concat(chunks).toString("utf8"),
              },
            });
          });
          response.once("error", (error) => finish({ error }));
        },
      );
      const totalTimer = setTimeout(
        () => request.destroy(new Error("Dispatcher request timeout")),
        this.options.timeoutMs,
      );
      request.once("socket", (socket) => {
        if (!socket.connecting) return;
        connectTimer = setTimeout(() => request.destroy(new Error("Dispatcher connect timeout")), this.options.connectTimeoutMs);
        socket.once("connect", () => {
          if (connectTimer) clearTimeout(connectTimer);
        });
      });
      request.once("error", (error) => {
        finish({ error });
      });
      request.end(body);
    });
  }
}
