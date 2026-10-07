import { createHash } from "node:crypto";
import { z } from "zod";
import { assertSynchronousResult } from "./audit/synchronous.js";
import { stableStringify } from "./validation.js";
import { taskGrantSchema, type TaskGrantIssuer } from "./task-grants.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const utc = z.string().refine(v => Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
// approvalはplanのhashを参照するため、semantic commandから分離する。
const { approval: _approval, ...grantFields } = taskGrantSchema.shape;
const semanticGrantSchema = z.strictObject(grantFields).refine(g => taskGrantSchema.safeParse({ ...g, approval: { event_id: "codec_only", typed_plan_ref: "codec_only", plan_sha256: "0".repeat(64) } }).success);
const put = z.strictObject({ kind: z.literal("put"), expected_revision: revision,
  grant: semanticGrantSchema });
const revoke = z.strictObject({ kind: z.literal("revoke"), grant_id: id, expected_revision: revision.min(1) });
const planSchema = z.strictObject({ version: z.literal("dona.task-grant-plan.v1"),
  instance_id: id, tenant_id: id, intent_event_id: id,
  requester: taskGrantSchema.shape.principal, task_id: z.string().regex(/^task_[0-9a-hjkmnp-tv-z]{26}$/),
  attempt_id: z.string().regex(/^job_[0-9a-hjkmnp-tv-z]{26}$/),
  policy_revision: revision.min(1), idempotency_key: id, starts_at: utc, expires_at: utc,
  command: z.discriminatedUnion("kind", [put, revoke]),
}).superRefine((p,ctx) => {
  if (Date.parse(p.starts_at) >= Date.parse(p.expires_at) || p.requester.kind !== "human")
    ctx.addIssue({code:"custom",message:"invalid intent scope"});
  if (p.command.kind === "put") {
    const g=p.command.grant;
    if (g.revision !== p.command.expected_revision + 1 || g.revision === Number.MAX_SAFE_INTEGER || g.revoked_at !== null
      || Date.parse(g.starts_at) < Date.parse(p.starts_at) || Date.parse(g.expires_at) > Date.parse(p.expires_at))
      ctx.addIssue({code:"custom",message:"invalid grant revision or interval"});
  }
});
export type TaskGrantPlan = z.infer<typeof planSchema>;
function freeze<T>(value:T):T {
  if(value && typeof value === "object") { for(const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/** 値の検証とimmutable snapshotのみ。本人認証、policy認可、grant発行は行わない。 */
export function encodeTaskGrantPlan(input: unknown): { plan: Readonly<TaskGrantPlan>; canonical: string; sha256: string } {
  assertSynchronousResult(input);
  const plan=planSchema.parse(input);
  // 集合をASCII順へ固定し、入力の配列順序による別plan化を避ける。
  if(plan.command.kind === "put") {
    const g=plan.command.grant;
    const order=<T>(values:T[])=>values.sort((a,b)=>stableStringify(a)<stableStringify(b)?-1:stableStringify(a)>stableStringify(b)?1:0);
    order(g.resources);order(g.operations);order(g.destinations);if(g.epic) order(g.epic.child_issue_node_ids);
  }
  const canonical=stableStringify(plan);
  if(Buffer.byteLength(canonical)>262144) throw Error("task_grant_plan_too_large");
  return {plan:freeze(plan),canonical,sha256:createHash("sha256").update("dona.task-grant-plan.v1\0").update(canonical).digest("hex")};
}
/** 将来のadapterが保存する証拠の値契約。parse成功はverified本人intentではない。 */
export const taskGrantIntentEvidenceSchema = z.strictObject({ version:z.literal(1),
  approval_event_id:id, intent_event_id:id, plan_sha256:digest, principal:taskGrantSchema.shape.principal,
  task_id:planSchema.shape.task_id, attempt_id:planSchema.shape.attempt_id,
  policy_revision:revision.min(1), identity_proof_ref:id, intent_proof_ref:id,
  checked_at:utc, expires_at:utc,
}).refine(p=>Date.parse(p.checked_at)<Date.parse(p.expires_at));
/** receiptの値契約。grant成立と外部operation成功は別。永続writer/lookupは未接続。 */
export const taskGrantIssuanceReceiptSchema = z.strictObject({ version:z.literal(1), receipt_id:id,
  instance_id:id, tenant_id:id, idempotency_key:id, plan_sha256:digest,
  approval_event_id:id, task_id:planSchema.shape.task_id, attempt_id:planSchema.shape.attempt_id,
  grant_id:id, grant_revision:revision.min(1), committed_at:utc });
/** 未採用adapterを構造化値、LLM申告、host承認で代用しない。production wiringなし。 */
export const unavailableTaskGrantIssuer: TaskGrantIssuer = Object.freeze({
  authorize: () => null,
  currentBinding: () => false,
});
