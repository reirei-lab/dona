import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { stableStringify } from "./validation.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const opaque = z.string().regex(/^rc_[A-Za-z0-9_-]{32}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const runtimeCommandRequestSchema = z.strictObject({
  version: z.literal("runtime-control.v1"), request_id: digest, body_sha256: digest,
  workspace: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), workspace_id: id, app_id: id,
  enterprise_id: id.nullable(), actor_id: z.string().regex(/^[UW][A-Z0-9]{1,127}$/),
  channel_id: z.string().regex(/^[CDG][A-Z0-9]{1,127}$/),
  command: z.discriminatedUnion("operation", [
    z.strictObject({ operation: z.literal("runtime.status.read.v1") }),
    z.strictObject({ operation: z.literal("runtime.restart.plan.v1") }),
    z.strictObject({ operation: z.literal("runtime.update.plan.v1") }),
    z.strictObject({ operation: z.literal("runtime.restart.confirm.v1"), plan_id: opaque }),
    z.strictObject({ operation: z.literal("runtime.update.confirm.v1"), plan_id: opaque }),
    z.strictObject({ operation: z.literal("runtime.operation.read.v1"), operation_id: opaque }),
    z.strictObject({ operation: z.literal("runtime.operation.cancel.v1"), operation_id: opaque }),
  ]),
});
export interface RuntimeCommandReceipt {
  request_id: string;
  state: "pending";
  received_at: string;
}
/** typed ingressだけのinbox。通常event/LLMへdispatchせず、受付を実行成功にしない。 */
export class RuntimeCommandInbox {
  constructor(private readonly db: Database.Database) {}
  private install(): void {
    this.db.pragma("synchronous = FULL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS slack_runtime_command_inbox (
      request_id TEXT PRIMARY KEY, canonical_sha256 TEXT NOT NULL, request_json TEXT NOT NULL,
      received_at TEXT NOT NULL, state TEXT NOT NULL CHECK(state='pending')
    ) STRICT;`);
  }
  accept(input: unknown, now = new Date()): RuntimeCommandReceipt {
    const request = runtimeCommandRequestSchema.parse(input);
    this.install();
    const canonical = stableStringify(request), hash = createHash("sha256").update(canonical).digest("hex");
    return this.db.transaction(() => {
      const prior = this.db.prepare("SELECT canonical_sha256,received_at,state FROM slack_runtime_command_inbox WHERE request_id=?")
        .get(request.request_id) as { canonical_sha256: string; received_at: string; state: "pending" } | undefined;
      if (prior) {
        if (prior.canonical_sha256 !== hash) throw Error("runtime_command_conflict");
        return { request_id: request.request_id, state: prior.state, received_at: prior.received_at };
      }
      if ((this.db.prepare("SELECT count(*) FROM slack_runtime_command_inbox").pluck().get() as number) >= 1024)
        throw Error("runtime_command_capacity");
      const received_at = now.toISOString();
      this.db.prepare("INSERT INTO slack_runtime_command_inbox VALUES(?,?,?,?, 'pending')")
        .run(request.request_id, hash, canonical, received_at);
      return { request_id: request.request_id, state: "pending" as const, received_at };
    }).immediate();
  }
  receipt(requestId: string): RuntimeCommandReceipt | null {
    if (!digest.safeParse(requestId).success) return null;
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='slack_runtime_command_inbox'").get()) return null;
    const row = this.db.prepare("SELECT request_id,state,received_at FROM slack_runtime_command_inbox WHERE request_id=?")
      .get(requestId) as RuntimeCommandReceipt | undefined;
    return row ?? null;
  }
}
