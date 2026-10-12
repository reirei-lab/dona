import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type RuntimeCommand =
  | { operation: "runtime.status.read.v1" }
  | { operation: "runtime.restart.plan.v1" }
  | { operation: "runtime.update.plan.v1" }
  | { operation: "runtime.restart.confirm.v1" | "runtime.update.confirm.v1"; plan_id: string }
  | { operation: "runtime.operation.read.v1" | "runtime.operation.cancel.v1"; operation_id: string };

const opaque = /^rc_[A-Za-z0-9_-]{32}$/;
export class RuntimeCommandError extends Error {
  constructor(readonly code: "invalid_request" | "invalid_command" | "unauthenticated" | "unavailable" | "too_large") {
    super(code);
  }
}

/** ADR 0002のASCII完全一致grammar。互換正規化で別の命令を作らない。 */
export function parseRuntimeCommand(text: string): RuntimeCommand {
  if (Buffer.byteLength(text) > 256 || /[^\x20-\x7e]/.test(text)) throw new RuntimeCommandError("invalid_command");
  if (text === "status") return { operation: "runtime.status.read.v1" };
  if (text === "restart plan") return { operation: "runtime.restart.plan.v1" };
  if (text === "update plan") return { operation: "runtime.update.plan.v1" };
  const parts = text.split(" ");
  if (parts.length === 3 && parts[1] === "confirm" && opaque.test(parts[2]!)) {
    if (parts[0] === "restart") return { operation: "runtime.restart.confirm.v1", plan_id: parts[2]! };
    if (parts[0] === "update") return { operation: "runtime.update.confirm.v1", plan_id: parts[2]! };
  }
  if (parts.length === 2 && opaque.test(parts[1]!)) {
    if (parts[0] === "operation") return { operation: "runtime.operation.read.v1", operation_id: parts[1]! };
    if (parts[0] === "cancel") return { operation: "runtime.operation.cancel.v1", operation_id: parts[1]! };
  }
  throw new RuntimeCommandError("invalid_command");
}

export interface RuntimeCommandWorkspace {
  alias: string;
  team_id: string;
  app_id: string;
  enterprise_id: string | null;
  signing_secret: string;
}
export interface RuntimeCommandRequest {
  version: "runtime-control.v1";
  request_id: string;
  body_sha256: string;
  workspace: string;
  workspace_id: string;
  app_id: string;
  enterprise_id: string | null;
  actor_id: string;
  channel_id: string;
  command: RuntimeCommand;
}
export interface AuthorizedRuntimeCommandRequest extends RuntimeCommandRequest {
  channel_type: "im" | "public_channel" | "private_channel";
}

/** raw bytesを先に検証。署名検証前にform、URL、自由文を解釈しない。 */
export function verifyRuntimeCommandRequest(body: Buffer, timestamp: string, signature: string,
  workspaces: readonly RuntimeCommandWorkspace[], now = Date.now()): RuntimeCommandRequest {
  if (body.length > 8192) throw new RuntimeCommandError("too_large");
  if (!Number.isFinite(now) || !/^[0-9]{1,12}$/.test(timestamp)
    || Math.abs(now - Number(timestamp) * 1000) > 300_000 || !/^v0=[a-f0-9]{64}$/.test(signature))
    throw new RuntimeCommandError("unauthenticated");
  const signed = Buffer.concat([Buffer.from(`v0:${timestamp}:`), body]);
  const actual = Buffer.from(signature.slice(3), "hex");
  const matches = workspaces.filter(w => w.signing_secret.length >= 16
    && timingSafeEqual(createHmac("sha256", w.signing_secret).update(signed).digest(), actual));
  if (!matches.length) throw new RuntimeCommandError("unauthenticated");
  let raw: string;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(body); }
  catch { throw new RuntimeCommandError("invalid_request"); }
  const fields = new Map<string, string>();
  try {
    for (const field of raw.split("&")) {
      const separator = field.indexOf("=");
      if (separator < 1) throw Error();
      const decode = (part: string) => decodeURIComponent(part.replace(/\+/g, " "));
      const key = decode(field.slice(0, separator)), value = decode(field.slice(separator + 1));
      if (fields.has(key)) throw Error();
      fields.set(key, value);
    }
  } catch { throw new RuntimeCommandError("invalid_request"); }
  const workspace = matches.filter(w => fields.get("team_id") === w.team_id && fields.get("api_app_id") === w.app_id
    && (fields.get("enterprise_id") || null) === w.enterprise_id);
  if (workspace.length !== 1 || fields.get("command") !== "/dona") throw new RuntimeCommandError("unauthenticated");
  const actor = fields.get("user_id"), channel = fields.get("channel_id"), trigger = fields.get("trigger_id"), text = fields.get("text");
  if (!actor || !/^[UW][A-Z0-9]{1,127}$/.test(actor) || !channel || !/^[CDG][A-Z0-9]{1,127}$/.test(channel)
    || !trigger || trigger.length > 256 || !/^[A-Za-z0-9_.-]+$/.test(trigger) || text === undefined)
    throw new RuntimeCommandError("invalid_request");
  const w = workspace[0]!;
  // ADR 0002: 同じ署名済み配送だけを同じidentityへ束縛する。
  const request_id = createHash("sha256").update("dona.slack-runtime-request.v1\0")
    .update(JSON.stringify([w.team_id, w.app_id, timestamp])).update("\0").update(body).digest("hex");
  return { version: "runtime-control.v1", request_id, body_sha256: createHash("sha256").update(body).digest("hex"),
    workspace: w.alias, workspace_id: w.team_id, app_id: w.app_id, enterprise_id: w.enterprise_id,
    actor_id: actor, channel_id: channel, command: parseRuntimeCommand(text) };
}

/** internal typed requestのcodec。inboxのcanonical commitmentと照合する。 */
export function runtimeCommandDigest(input: AuthorizedRuntimeCommandRequest): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
      .map(key => [key, canonical((value as Record<string, unknown>)[key])]));
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
}
