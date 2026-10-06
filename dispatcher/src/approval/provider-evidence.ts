import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { assertSynchronousResult } from "../audit/synchronous.js";
import type { OperationsPolicyRepository } from "./operations-policy.js";
import { operationsCanonical } from "./operations-policy.js";
import type { ExecutionReceiptAuthority } from "./execution-authority.js";
import type { NotificationReceiptAuthority } from "./notification-authority.js";
import { ApprovalRequestLifecycle } from "./request-lifecycle.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), digest = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const utc = z.string().length(24).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const ts = z.string().regex(/^[0-9]{10}\.[0-9]{6}$/);
const target = z.strictObject({ channel_id: id, thread_ts: ts });
const marker = z.strictObject({ instance_id: id, workspace_id: id, kind: z.enum(["execution", "notification"]),
  request_id: id, attempt_id: id, semantic_hash: digest, fence: positive, mac: digest });
export const providerEvidenceSchema = z.strictObject({ codec_version: z.literal(1), evidence_ref: id, key_version: positive,
  observed_at: utc, complete: z.boolean(), upper_ts: ts, query: marker, target,
  author: z.strictObject({ user_id: id, bot_id: id }),
  candidates: z.array(z.strictObject({ receipt_ref: id, message_ts: ts, marker, target,
    author: z.strictObject({ user_id: id, bot_id: id }) })).max(100) });
export type ProviderEvidence = z.infer<typeof providerEvidenceSchema>;
export interface ProviderEvidenceKey {
  purpose: "approval_provider_evidence"; version: number; state: "active" | "verification_only" | "revoked";
  activated_at: string; signing_expires_at: string; secret: Uint8Array;
}
const signed = z.strictObject({ observation: providerEvidenceSchema, mac: digest });
export class ProviderEvidenceError extends Error {
  constructor() { super("approval_provider_evidence_unverified"); this.name = "ProviderEvidenceError"; }
}
export function providerEvidenceMac(observation: ProviderEvidence, key: ProviderEvidenceKey): string {
  if (key.purpose !== "approval_provider_evidence" || key.version !== observation.key_version
    || !["active", "verification_only"].includes(key.state) || !(key.secret instanceof Uint8Array) || key.secret.byteLength !== 32
    || utc.parse(key.activated_at) > observation.observed_at || utc.parse(key.signing_expires_at) <= observation.observed_at) throw new ProviderEvidenceError();
  return createHmac("sha256", key.secret).update("dona.approval.provider-evidence.v1\0").update(operationsCanonical(observation)).digest("hex");
}
export function verifyProviderEvidence(raw: unknown, key: ProviderEvidenceKey): ProviderEvidence {
  try {
    assertSynchronousResult(raw); const value = signed.parse(raw);
    if (!timingSafeEqual(Buffer.from(value.mac, "hex"), Buffer.from(providerEvidenceMac(value.observation, key), "hex"))) throw Error();
    return value.observation;
  } catch { throw new ProviderEvidenceError(); }
}
/** 設定されたprovider custody directoryのimmutable署名済みreceiptだけを読む。
 * missing fileは0件の検索結果ではない。通常CLIはこのfileを作成・署名しない。 */
export class DurableProviderEvidence {
  constructor(private readonly directory: string, private readonly keys: (version: number) => ProviderEvidenceKey) {}
  read(reference: string): { observation: ProviderEvidence; digest: string } {
    try {
      id.parse(reference);
      if (!path.isAbsolute(this.directory) || path.normalize(this.directory) !== this.directory) throw Error();
      let current = this.directory;
      for (;;) {
        const info = fs.lstatSync(current);
        if (!info.isDirectory() || info.isSymbolicLink() || ![0, process.getuid?.()].includes(info.uid) || (info.mode & 0o022) !== 0
          || current === this.directory && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) throw Error();
        const parent = path.dirname(current); if (parent === current) break; current = parent;
      }
      const filename = path.join(this.directory, reference + ".json"), info = fs.lstatSync(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 262144) throw Error();
      const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let wire: string;
      try {
        const opened = fs.fstatSync(fd);
        if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw Error();
        wire = fs.readFileSync(fd, "utf8");
        const after = fs.fstatSync(fd);
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw Error();
      } finally { fs.closeSync(fd); }
      const parsed = signed.parse(JSON.parse(wire)), key = this.keys(parsed.observation.key_version);
      const observation = verifyProviderEvidence(parsed, key);
      if (observation.evidence_ref !== reference || wire !== operationsCanonical(parsed) + "\n") throw Error();
      return { observation, digest: createHash("sha256").update(wire).digest("hex") };
    } catch { throw new ProviderEvidenceError(); }
  }
}

/** providerが署名した完全検索とexact marker/author/targetだけをauthorityへ変換。
 * current operatorはbrokerのwriter lock内で再認証し、reason全文を保存しない。 */
export class OperationsReconcileAuthority {
  private readonly reasonDigest: string;
  constructor(private readonly policies: OperationsPolicyRepository, private readonly evidence: DurableProviderEvidence,
    private readonly lifecycle: ApprovalRequestLifecycle, reason: string,
    private readonly author: { user_id: string; bot_id: string }, private readonly expectedPolicyRevision?: number) {
    try {
      z.string().min(8).max(512).parse(reason); id.parse(author.user_id); id.parse(author.bot_id);
      this.reasonDigest = createHash("sha256").update("dona.approval.operator-reason.v1\0").update(reason).digest("hex");
    } catch { throw new ProviderEvidenceError(); }
  }
  private resolve(reference: string, query: z.infer<typeof marker>, targetInput: z.infer<typeof target>, at: string) {
    const evidence = this.evidence.read(reference), observation = evidence.observation;
    if (operationsCanonical(observation.query) !== operationsCanonical(query)
      || operationsCanonical(observation.target) !== operationsCanonical(targetInput)
      || operationsCanonical(observation.author) !== operationsCanonical(this.author) || observation.observed_at > at) throw new ProviderEvidenceError();
    const context = "orc_" + createHash("sha256").update(operationsCanonical([this.reasonDigest, evidence.digest, reference])).digest("hex");
    const valid = observation.complete && observation.candidates.length === 1
      && operationsCanonical(observation.candidates[0]!.marker) === operationsCanonical(query)
      && operationsCanonical(observation.candidates[0]!.target) === operationsCanonical(targetInput)
      && operationsCanonical(observation.candidates[0]!.author) === operationsCanonical(this.author)
      && observation.candidates[0]!.message_ts <= observation.upper_ts;
    return { context, outcome: !observation.complete || observation.candidates.length > 1 || observation.candidates.length === 1 && !valid
      ? "ambiguous" as const : observation.candidates.length === 0 ? "unknown" as const : "accepted" as const,
      receipt_ref: valid ? observation.candidates[0]!.receipt_ref : null };
  }
  execution: ExecutionReceiptAuthority = (command, request, attempt, sealed, mark, state) => {
    try {
      const grant = this.policies.authorize(state, mark, "reconcile"), snapshot = this.lifecycle.snapshot(request);
      if (!this.policies.matchesScope(request.scope) || this.expectedPolicyRevision !== undefined && grant.policy_revision !== this.expectedPolicyRevision) throw Error();
      if (operationsCanonical(this.policies.readInState(state)?.provider_author) !== operationsCanonical(this.author)) throw Error();
      const proof = this.resolve(command.authority_ref, { instance_id: sealed.marker.scope.instance_id, workspace_id: sealed.marker.scope.workspace_id,
        kind: "execution", request_id: request.row.request_id, attempt_id: attempt.row.attempt_id, semantic_hash: request.row.semantic_hash,
        fence: sealed.marker.execution_fence, mac: sealed.mac }, snapshot.target, mark.effective_utc);
      if (command.expected_fence !== attempt.row.fence) throw Error();
      return { status: "verified", scope: request.scope, attempt_id: attempt.row.attempt_id, consumer_id: grant.principal_id,
        execution_fence: attempt.row.fence, proof_kind: "reconcile", operator_context_ref: proof.context, operator_revision: grant.policy_revision,
        receipt: proof.outcome === "accepted" ? { outcome: "accepted", receipt_ref: proof.receipt_ref! } : { outcome: proof.outcome } };
    } catch { return { status: "denied", reason: "proof_invalid" }; }
  };
  notification: NotificationReceiptAuthority = (command, request, notification, mark, state) => {
    try {
      const grant = this.policies.authorize(state, mark, "reconcile"), snapshot = this.lifecycle.snapshot(request);
      if (!this.policies.matchesScope(request.scope) || this.expectedPolicyRevision !== undefined && grant.policy_revision !== this.expectedPolicyRevision) throw Error();
      if (operationsCanonical(this.policies.readInState(state)?.provider_author) !== operationsCanonical(this.author)) throw Error();
      const proof = this.resolve(command.authority_ref, { ...request.scope, kind: "notification", request_id: request.row.request_id,
        attempt_id: notification.row.notification_attempt_id, semantic_hash: request.row.semantic_hash, fence: 1,
        mac: notification.row.marker_mac }, snapshot.target, mark.effective_utc);
      if (command.expected_fence !== notification.row.fence) throw Error();
      return { status: "verified", scope: request.scope, notification_id: notification.row.notification_attempt_id, consumer_id: grant.principal_id,
        delivery_fence: notification.row.fence, proof_kind: "reconcile", operator_context_ref: proof.context, operator_revision: grant.policy_revision,
        receipt: proof.outcome === "accepted" ? { outcome: "sent", presentation_ref: proof.receipt_ref! } : { outcome: proof.outcome } };
    } catch { return { status: "denied", reason: "proof_invalid" }; }
  };
}
