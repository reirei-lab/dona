import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import type { SlackWorkspaceRegistry } from "./workspace-registry.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), digest = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER), ts = z.string().regex(/^[0-9]{10}\.[0-9]{6}$/);
const markerSchema = z.strictObject({ instance_id: id, workspace_id: id, kind: z.enum(["execution", "notification"]),
  request_id: id, attempt_id: id, semantic_hash: digest, fence: positive, mac: digest });
const targetSchema = z.strictObject({ channel_id: id, thread_ts: ts });
export type SlackApprovalEvidenceMarker = z.infer<typeof markerSchema>;
export class SlackApprovalEvidenceError extends Error {
  constructor() { super("slack_approval_evidence_unverified"); this.name = "SlackApprovalEvidenceError"; }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
/** 送信側も保存済みmarkerをこのmetadataへ埋め込む。本文や時刻近接は照合しない。 */
export function slackApprovalEvidenceMetadata(markerInput: SlackApprovalEvidenceMarker) {
  const marker = markerSchema.parse(markerInput);
  return { event_type: "dona_approval_" + marker.kind + "_v1", event_payload: marker };
}

/** 認証済みRegistry経由のread-only provider。MCPに公開せず、outcomeを入力しない。
 * 上限・cursor異常・部分pageはcomplete=falseとしてdurableに記録する。
 * HTTP失敗や設定不足は「0件」というreceiptを作らない。 */
export class SlackApprovalEvidenceProbe {
  constructor(private readonly registry: Pick<SlackWorkspaceRegistry, "get" | "getByTeamId">,
    private readonly key: { version: number; purpose: "approval_provider_evidence"; state: "active";
      activated_at: string; signing_expires_at: string; secret: Uint8Array }, private readonly now: () => Date = () => new Date()) {}
  async observe(alias: string, markerInput: SlackApprovalEvidenceMarker, targetInput: z.infer<typeof targetSchema>, evidenceRef: string) {
    try {
      const marker = markerSchema.parse(markerInput), target = targetSchema.parse(targetInput); id.parse(evidenceRef);
      const connection = this.registry.get(alias), current = await connection.client.authenticate();
      if (connection !== this.registry.getByTeamId(marker.workspace_id) || connection.teamId !== marker.workspace_id
        || current.teamId !== marker.workspace_id || current.botUserId !== connection.botUserId || current.botId !== connection.botId
        || current.botUserId === undefined || current.botId === undefined || connection.client.getApprovalEvidencePage === undefined) throw Error();
      const at = this.now(); if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw Error();
      const observedAt = at.toISOString(), upperTs = (at.getTime() / 1000).toFixed(6); ts.parse(upperTs);
      const author = { user_id: current.botUserId, bot_id: current.botId };
      const candidates: { receipt_ref: string; message_ts: string; marker: SlackApprovalEvidenceMarker;
        target: z.infer<typeof targetSchema>; author: { user_id: string; bot_id: string } }[] = [];
      const cursors = new Set<string>(), messages = new Set<string>(); let cursor: string | undefined, complete = false;
      for (let page = 0; page < 20; page++) {
        const result = await connection.client.getApprovalEvidencePage(target.channel_id, target.thread_ts, upperTs, cursor);
        if (!Array.isArray(result.messages) || result.messages.length > 100 || typeof result.hasMore !== "boolean") throw Error();
        let invalid = false;
        for (const message of result.messages) {
          ts.parse(message.ts);
          if (message.ts > upperTs || messages.has(message.ts)) { invalid = true; break; }
          messages.add(message.ts);
          const metadata = message.metadata as { event_type?: unknown; event_payload?: unknown } | undefined;
          if (metadata?.event_type !== "dona_approval_" + marker.kind + "_v1") continue;
          const raw = metadata.event_payload as { mac?: unknown } | undefined;
          if (raw?.mac !== marker.mac) continue;
          const found = markerSchema.safeParse(raw);
          if (!found.success || message.userId === undefined || message.botId === undefined || message.threadTs !== target.thread_ts) { invalid = true; break; }
          candidates.push({ receipt_ref: "msg_" + createHash("sha256").update(JSON.stringify([marker.workspace_id, target.channel_id, message.ts])).digest("hex"),
            message_ts: message.ts, marker: found.data, target, author: { user_id: message.userId, bot_id: message.botId } });
          if (candidates.length >= 100) { invalid = true; break; }
        }
        if (invalid) break;
        if (!result.hasMore && !result.nextCursor) { complete = true; break; }
        if (!result.nextCursor || cursors.has(result.nextCursor)) break;
        cursors.add(result.nextCursor); cursor = result.nextCursor;
      }
      const observation = { codec_version: 1 as const, evidence_ref: evidenceRef, key_version: this.key.version,
        observed_at: observedAt, complete, upper_ts: upperTs, query: marker, target, author, candidates };
      if (!Number.isSafeInteger(this.key.version) || this.key.version < 1 || this.key.purpose !== "approval_provider_evidence"
        || this.key.state !== "active" || !(this.key.secret instanceof Uint8Array) || this.key.secret.byteLength !== 32
        || this.key.activated_at > observedAt || this.key.signing_expires_at <= observedAt) throw Error();
      const mac = createHmac("sha256", this.key.secret).update("dona.approval.provider-evidence.v1\0").update(canonical(observation)).digest("hex");
      return { observation, mac };
    } catch { throw new SlackApprovalEvidenceError(); }
  }
  /** provider custodyへの一回限りの公開。既存refは上書きせず、自動再署名しない。 */
  async capture(directory: string, alias: string, marker: SlackApprovalEvidenceMarker, target: z.infer<typeof targetSchema>, evidenceRef: string) {
    let temporary: string | undefined;
    try {
      if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) throw Error();
      let ancestor = directory;
      for (;;) {
        const info = fs.lstatSync(ancestor);
        if (!info.isDirectory() || info.isSymbolicLink() || ![0, process.getuid?.()].includes(info.uid) || (info.mode & 0o022) !== 0
          || ancestor === directory && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) throw Error();
        const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
      }
      id.parse(evidenceRef); const filename = path.join(directory, evidenceRef + ".json");
      if (fs.existsSync(filename)) throw Error();
      const evidence = await this.observe(alias, marker, target, evidenceRef);
      temporary = path.join(directory, ".evidence-" + randomUUID());
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, canonical(evidence) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.linkSync(temporary, filename); fs.unlinkSync(temporary); temporary = undefined;
      const parent = fs.openSync(directory, "r"); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      return { evidence_ref: evidenceRef, complete: evidence.observation.complete };
    } catch { throw new SlackApprovalEvidenceError(); }
    finally { if (temporary !== undefined) fs.rmSync(temporary, { force: true }); }
  }
}
