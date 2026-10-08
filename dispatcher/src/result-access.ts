import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, jobResultEnvelopeMaxBytes } from "./job-result-publish.js";
import { parseJobResultEnvelope } from "./validation.js";

// 独立read_resultの未採用契約。task-grantsのreadやstatus/internal completionへ暗黙mappingしない。
const id = z.string().min(1).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const destination = z.strictObject({ workspace_id: id, channel_id: id, thread_ts: z.string().regex(/^\d+\.\d+$/),
  visibility: z.enum(["private", "public"]) });
const requestSchema = z.strictObject({ principal_id: id, tenant_id: id, task_id: id, attempt_id: id,
  terminal_revision: revision, destination });
export type ResultAccessRequest = z.infer<typeof requestSchema>;
const prSchema = z.strictObject({ repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  number: revision, head_sha: z.string().regex(/^[a-f0-9]{40}$/), base_sha: z.string().regex(/^[a-f0-9]{40}$/) });
export type ResultPRReference = z.infer<typeof prSchema>;
export type ResultComparisonReceipt = Readonly<
  { schema_version: 1; outcome: "unknown" } |
  { schema_version: 1; outcome: "matched"; terminal_revision: number; canonical_digest: string; prs: ResultPRReference[] }
>;
const snapshotSchema = z.strictObject({ task_id: id, attempt_id: id, terminal_revision: revision,
  terminal: z.literal(true), accepted: z.literal(true), policy_revision: revision, grant_revision: revision,
  origin: destination, result_json: z.string().max(jobResultEnvelopeMaxBytes), canonical_digest: digest });
export type ResultAccessSnapshot = z.infer<typeof snapshotSchema>;
const permitSchema = z.strictObject({ operation: z.literal("read_result"), request: requestSchema,
  policy_revision: revision, grant_revision: revision,
  fields: z.array(z.enum(["status", "completed_at", "summary", "output"])).max(4),
  artifacts: z.array(prSchema).max(16), authority: z.literal(true), disclosure: z.literal(true) });
export type ResultAccessPermit = z.infer<typeof permitSchema>;
export interface ResultAccessPorts {
  /** server所有のdurable accepted Resultだけを返す。Result本文のclaimから組み立てない。 */
  snapshot(request: Readonly<ResultAccessRequest>): unknown;
  /** current principal/resource/grantとdestination visibilityを独立して検証する。既定deny。 */
  authorize(request: Readonly<ResultAccessRequest>, snapshot: Readonly<ResultAccessSnapshot>): unknown;
  /** 外部取得の本実装は未接続。exact PRをscheme/host/resource制限下で検証するserver port。 */
  verifyPR(reference: Readonly<ResultPRReference>): Promise<boolean>;
}
const unavailable = Object.freeze({ schema_version: 1, status: "not_available" } as const);
const unknown = Object.freeze({ schema_version: 1, outcome: "unknown" } as const);
const defaultPorts: ResultAccessPorts = { snapshot: () => undefined, authorize: () => undefined, verifyPR: async () => false };

/** ingestion request digestとは別の、accepted envelope全体の内部照合identity。本文は返さない。 */
export function acceptedResultDigest(result: unknown, attemptId: string): string {
  const parsed = parseJobResultEnvelope(result, attemptId);
  return createHash("sha256").update("dona.accepted-result.v1\0").update(canonicalJson(parsed)).digest("hex");
}

/** URL文字列をfetchしない。Github PRのcanonical公開参照だけをtyped identityへ変換する。 */
export function parseResultPRReference(value: unknown): ResultPRReference | undefined {
  try {
    const artifact = z.strictObject({ kind: z.literal("github_pr"), reference: z.string(), head_sha: prSchema.shape.head_sha,
      base_sha: prSchema.shape.base_sha }).parse(value);
    const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/.exec(artifact.reference);
    if (!match) return;
    return prSchema.parse({ repository: match[1], number: Number(match[2]), head_sha: artifact.head_sha, base_sha: artifact.base_sha });
  } catch { return; }
}

export class ResultAccessContract {
  constructor(private readonly ports: ResultAccessPorts = defaultPorts) {}
  private capture(input: unknown) {
    const request = requestSchema.parse(input);
    const snapshot = snapshotSchema.parse(this.ports.snapshot(request));
    if (snapshot.task_id !== request.task_id || snapshot.attempt_id !== request.attempt_id ||
      snapshot.terminal_revision !== request.terminal_revision || snapshot.origin.workspace_id !== request.destination.workspace_id ||
      snapshot.origin.visibility === "private" && request.destination.visibility === "public") throw Error();
    if (Buffer.byteLength(snapshot.result_json, "utf8") > jobResultEnvelopeMaxBytes) throw Error();
    const result = parseJobResultEnvelope(JSON.parse(snapshot.result_json), request.attempt_id);
    if (acceptedResultDigest(result, request.attempt_id) !== snapshot.canonical_digest) throw Error();
    const permit = permitSchema.parse(this.ports.authorize(request, snapshot));
    if (canonicalJson(permit.request) !== canonicalJson(request) || permit.policy_revision !== snapshot.policy_revision ||
      permit.grant_revision !== snapshot.grant_revision) throw Error();
    return { request, snapshot, result, permit };
  }
  private async verified(input: unknown) {
    const before = this.capture(input);
    const references: ResultPRReference[] = [];
    // 参照allowlistはserver permitから。本文/URL/claimは認可証拠に使わない。
    for (const candidate of before.result.artifacts ?? []) {
      const reference = parseResultPRReference(candidate);
      if (!reference || !before.permit.artifacts.some(p => canonicalJson(p) === canonicalJson(reference))) continue;
      if (!await this.ports.verifyPR(Object.freeze(reference))) throw Error();
      if (!references.some(p => canonicalJson(p) === canonicalJson(reference))) references.push(reference);
    }
    const after = this.capture(input); // await中のrevoke、destination swap、late Resultをfail closed。
    if (canonicalJson(before) !== canonicalJson(after)) throw Error();
    return { ...after, references };
  }
  async read(input: unknown): Promise<Record<string, unknown>> {
    try {
      const { result, permit, references } = await this.verified(input);
      const projection: Record<string, unknown> = {};
      for (const field of permit.fields) {
        if (field === "output") { if (result.output) projection.output = { format: result.output.format, text: result.output.text }; }
        else projection[field] = result[field];
      }
      return { schema_version: 1, result: projection, artifacts: references };
    } catch { return unavailable; }
  }
  /** server内部専用。既存receiptを信頼せず毎回current snapshot/authorityを再検証。write/handoff許可ではない。 */
  async reconcile(input: unknown, expected: unknown): Promise<ResultComparisonReceipt> {
    try {
      const evidence = z.strictObject({ terminal_revision: revision, canonical_digest: digest, prs: z.array(prSchema).max(16) }).parse(expected);
      const { snapshot, references } = await this.verified(input);
      const sort = (refs: ResultPRReference[]) => refs.map(canonicalJson).sort();
      if (evidence.terminal_revision !== snapshot.terminal_revision || evidence.canonical_digest !== snapshot.canonical_digest ||
        canonicalJson(sort(evidence.prs)) !== canonicalJson(sort(references))) return unknown;
      return { schema_version: 1, outcome: "matched", terminal_revision: snapshot.terminal_revision,
        canonical_digest: snapshot.canonical_digest, prs: references };
    } catch { return unknown; }
  }
}
