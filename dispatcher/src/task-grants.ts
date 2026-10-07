import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ApprovalTransaction, type ApprovalTransactionProviders } from "./approval/transaction.js";
import type { ClockMark } from "./approval/clock.js";
import { assertActiveClockMutation } from "./audit/file-identity.js";
import { assertSynchronousCallback, assertSynchronousResult } from "./audit/synchronous.js";
import { assertCurrentAuditReadState } from "./audit/repository.js";
import { withSecurityTransactionLock } from "./audit/coordination.js";
import { assertSecurityDurability } from "./audit/durability.js";
import type { AuditEvent, VerifiedAuditState } from "./audit/codec.js";
import { stableStringify } from "./validation.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const utc = z.string().refine(v => Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v);
const scopeSchema = z.strictObject({ instance_id: id, tenant_id: id });
const principalSchema = z.strictObject({ kind: z.enum(["human", "bot", "service"]), id,
  workspace_id: id, identity_binding_revision: revision, authz_revision: revision });
/** #164/PR266のGitHub node identityとresource/binding revisionを保持する。
 * Taskは仕事identity。Attemptの変更でこのbindingを置換・拡張しない。 */
export const grantResourceSchema = z.strictObject({ task_id: z.string().regex(/^task_[0-9a-hjkmnp-tv-z]{26}$/),
  repository_full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/), repository_node_id: id,
  issue_node_id: id, issue_number: revision, resource_revision: revision, binding_revision: revision });
const destinationSchema = z.strictObject({ workspace_id: id, channel_id: id, thread_ts: z.string().regex(/^\d+\.\d+$/) });
const unique = <T>(values: T[]) => new Set(values.map(stableStringify)).size === values.length;
export const taskGrantSchema = z.strictObject({ grant_id: id, principal: principalSchema,
  resources: z.array(grantResourceSchema).min(1).max(128).refine(unique),
  epic: z.strictObject({ repository_node_id: id, epic_node_id: id, membership_revision: revision,
    child_issue_node_ids: z.array(id).min(1).max(128).refine(unique) }).nullable(),
  operations: z.array(z.enum(["status", "read", "steer", "cancel", "merge", "production"])).min(1).max(6).refine(unique),
  destinations: z.array(destinationSchema).min(1).max(128).refine(unique),
  approval: z.strictObject({ event_id: id, typed_plan_ref: id, plan_sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  starts_at: utc, expires_at: utc, revoked_at: utc.nullable(), revision,
  parent: z.strictObject({ grant_id: id, revision }).nullable(),
}).superRefine((g, ctx) => {
  if (Date.parse(g.starts_at) >= Date.parse(g.expires_at) || g.epic && g.resources.some(r =>
    r.repository_node_id !== g.epic!.repository_node_id || !g.epic!.child_issue_node_ids.includes(r.issue_node_id)))
    ctx.addIssue({ code: "custom", message: "invalid grant scope" });
});
export type TaskGrant = z.infer<typeof taskGrantSchema>;
export type GrantResource = z.infer<typeof grantResourceSchema>;
type Scope = z.infer<typeof scopeSchema>;
const stateSchema = z.strictObject({ version: z.literal(1), scope: scopeSchema,
  grants: z.array(taskGrantSchema).max(1024).refine(g => unique(g.map(row => row.grant_id))) });
type State = z.infer<typeof stateSchema>;
const resourceId = "task_grants_v1";
const snapshotMaxBytes = 4194304;
/** ISO UTCの最大長27文字+引用符からnullの4 byteを引いた25 byte。
 * revokeでrevisionが最大safe integerの16桁まで増えても保存できる余白。 */
function revokeReserveBytes(grants: TaskGrant[]): number {
  return grants.reduce((bytes,g) => bytes + (g.revoked_at === null ? 25 + 16 - String(g.revision).length : 0),0);
}
const ddl = `CREATE TABLE task_grant_schema(version INTEGER PRIMARY KEY CHECK(version=1)) STRICT;
INSERT INTO task_grant_schema VALUES(1);
CREATE TABLE task_grant_state(instance_id TEXT NOT NULL,tenant_id TEXT NOT NULL,state_json TEXT NOT NULL
CHECK(length(CAST(state_json AS BLOB))<=4194304 AND json_valid(state_json)),PRIMARY KEY(instance_id,tenant_id)) STRICT;`;
function shape(db: Database.Database) {
  return stableStringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'task_grant_%' OR tbl_name LIKE 'task_grant_%' ORDER BY name").all());
}
let expectedShape: string | undefined;
function verifySchema(db: Database.Database) {
  if (!expectedShape) { const expected = new Database(":memory:"); try { expected.exec(ddl); expectedShape = shape(expected); } finally { expected.close(); } }
  if (shape(db) !== expectedShape || db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name LIKE 'task_grant_%' OR tbl_name LIKE 'task_grant_%'").get()
    || stableStringify(db.prepare("SELECT version FROM task_grant_schema").all()) !== '[{"version":1}]') throw Error();
}
/** 明示的なopt-in migration。旧DBにgrantを推測backfillしない。root admissionは別のissuer操作。 */
export function installTaskGrantSchema(db: Database.Database): void {
  if (db.inTransaction) throw Error("task_grant_unverified");
  withSecurityTransactionLock(db, () => db.transaction(() => {
    assertSecurityDurability(db);
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'task_grant_%' OR tbl_name LIKE 'task_grant_%'").get()) db.exec(ddl);
    verifySchema(db);
  }).immediate());
}
function encode(input: State) {
  // 内部所有stateまたはJSON.parseしたDB snapshotだけが到達する。
  // 共通同期guardの10000-node budgetをscope/各grantに適用する。
  // 外側の1024件/4MiBと各grantの集合上限もcodecで検証する。
  assertSynchronousResult(input.scope);
  if (!Array.isArray(input.grants) || input.grants.length > 1024) throw Error();
  for (const grant of input.grants) assertSynchronousResult(grant);
  const state = stateSchema.parse(input);
  state.grants.sort((a,b) => a.grant_id < b.grant_id ? -1 : a.grant_id > b.grant_id ? 1 : 0);
  const canonical = stableStringify(state);
  if (Buffer.byteLength(canonical) > snapshotMaxBytes) throw Error();
  return { state, canonical, digest: createHash("sha256").update("dona.task-grants.v1\0").update(canonical).digest("hex") };
}
function same(a: unknown,b: unknown) { return stableStringify(a) === stableStringify(b); }
function subset<T>(child: T[],parent: T[]) { return child.every(v => parent.some(p => same(v,p))); }
function active(g: TaskGrant, grants: TaskGrant[], now: string, seen = new Set<string>()): boolean {
  if (seen.has(g.grant_id) || g.revoked_at !== null || Date.parse(now) < Date.parse(g.starts_at) || Date.parse(now) >= Date.parse(g.expires_at)) return false;
  seen.add(g.grant_id);
  if (!g.parent) return true;
  const parent = grants.find(p => p.grant_id === g.parent!.grant_id);
  return !!parent && parent.revision === g.parent.revision && active(parent,grants,now,seen);
}
function shrinks(g: TaskGrant,p: TaskGrant) {
  const epic = g.epic === null || p.epic !== null && g.epic.repository_node_id === p.epic.repository_node_id
    && g.epic.epic_node_id === p.epic.epic_node_id && g.epic.membership_revision === p.epic.membership_revision
    && subset(g.epic.child_issue_node_ids,p.epic.child_issue_node_ids);
  return subset(g.resources,p.resources) && subset(g.operations,p.operations) && subset(g.destinations,p.destinations)
    && g.principal.workspace_id === p.principal.workspace_id && epic
    && Date.parse(g.starts_at) >= Date.parse(p.starts_at) && Date.parse(g.expires_at) <= Date.parse(p.expires_at);
}
export type GrantWrite = { kind: "initialize" } | { kind: "put"; expected_revision: number; grant: TaskGrant }
  | { kind: "revoke"; grant_id: string; expected_revision: number };
/** 信頼済みcomposition rootだけが注入。ID文字列やMCP引数をcapabilityにしない。
 * callbackはwriter lock内で現principal/bindingとtyped approvalを検証する。 */
export interface TaskGrantIssuer {
  authorize(command: Readonly<GrantWrite>, mark: Readonly<ClockMark>, state: VerifiedAuditState):
    { issuer_id: string; approval: TaskGrant["approval"] | null } | null;
  currentBinding(resource: Readonly<GrantResource>, principal: Readonly<TaskGrant["principal"]>, state: VerifiedAuditState,
    epic: Readonly<TaskGrant["epic"]>): boolean;
}
export interface GrantEvaluation {
  grant_id: string; revision: number; principal: TaskGrant["principal"]; resource: GrantResource;
  operation: TaskGrant["operations"][number]; destination: TaskGrant["destinations"][number];
  epic_membership_revision: number | null;
}
const freeze = <T>(value:T):T => { if (value && typeof value === "object") { for (const v of Object.values(value)) freeze(v); Object.freeze(value); } return value; };
export class TaskGrantRepository {
  private readonly scope: Scope;
  private readonly transaction: ApprovalTransaction;
  constructor(private readonly db: Database.Database, providers: ApprovalTransactionProviders, scope: Scope, private readonly issuer: TaskGrantIssuer) {
    this.scope = scopeSchema.parse(scope); verifySchema(db);
    assertSynchronousCallback(issuer.authorize); assertSynchronousCallback(issuer.currentBinding);
    this.transaction = new ApprovalTransaction(db,providers);
  }
  private read(state: VerifiedAuditState): ReturnType<typeof encode> | null {
    assertCurrentAuditReadState(this.db,state); verifySchema(this.db);
    const bindings = state.resource_bindings.filter(b => b.resource_id === resourceId && same(b.scope,this.scope));
    const row = this.db.prepare("SELECT CASE WHEN typeof(state_json)='text' AND length(CAST(state_json AS BLOB))<=4194304 THEN state_json ELSE NULL END AS state_json FROM main.task_grant_state WHERE instance_id=? AND tenant_id=?")
      .get(this.scope.instance_id,this.scope.tenant_id) as {state_json:string|null}|undefined;
    if (!row) { if (bindings.length) throw Error(); return null; }
    if (typeof row.state_json !== "string") throw Error();
    const result = encode(JSON.parse(row.state_json));
    if (row.state_json !== result.canonical || !same(result.state.scope,this.scope) || bindings.length !== 1 || bindings[0]!.resource_digest !== result.digest) throw Error();
    return result;
  }
  private current(g: TaskGrant, grants: TaskGrant[], state: VerifiedAuditState): boolean {
    const seen = new Set<string>(); let cursor: TaskGrant | undefined = g;
    while (cursor) {
      if (seen.has(cursor.grant_id)) return false; seen.add(cursor.grant_id);
      for (const resource of cursor.resources) {
        const valid = this.issuer.currentBinding(freeze(structuredClone(resource)),freeze(structuredClone(cursor.principal)),state,freeze(structuredClone(cursor.epic)));
        assertSynchronousResult(valid); if (valid !== true) return false;
      }
      if (!cursor.parent) return true;
      cursor = grants.find(p => p.grant_id === cursor!.parent!.grant_id);
      if (!cursor) return false;
    }
    return false;
  }
  write(transactionId: string, input: GrantWrite): { status: "succeeded" | "denied"; revision: number | null } {
    try {
      assertSynchronousResult(input);
      const command = freeze(z.discriminatedUnion("kind",[
        z.strictObject({kind:z.literal("initialize")}),
        z.strictObject({kind:z.literal("put"),expected_revision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),grant:taskGrantSchema}),
        z.strictObject({kind:z.literal("revoke"),grant_id:id,expected_revision:revision}),
      ]).parse(input));
      return this.transaction.runPrepared<() => {status:"succeeded"|"denied";revision:number|null}>(transactionId,(mark,state) => {
        const prior = this.read(state);
        const raw = this.issuer.authorize(command,mark,state); assertSynchronousResult(raw);
        // callbackの出力をstrict codecで再検証し、callerがapprovalを自己申告できないようにする。
        const proof = raw === null ? null : z.strictObject({issuer_id:id,approval:z.strictObject({event_id:id,typed_plan_ref:id,plan_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).nullable()}).parse(raw);
        const event: Omit<AuditEvent,"occurred_at"> = {scope:this.scope,actor:proof?{kind:"system",id:proof.issuer_id}:{kind:"unauthenticated",id:null},
          action:"binding_change",operation:"binding.change.v1",resource_id:resourceId,outcome:"denied",reason:"unauthorized",session_ref:null,receipt_id:null,attempt_id:null,policy_revision:0,binding_revision:0,authz_revision:0};
        const denied = (reason: AuditEvent["reason"] = "unauthorized") => ({event:{...event,reason},resource_digest:null,mutation:()=>({status:"denied" as const,revision:null})});
        if (!proof) return denied();
        let next: State; let resultRevision: number | null = null;
        if (command.kind === "initialize") {
          if (prior) return denied();
          next = {version:1,scope:this.scope,grants:[]};
        } else {
          if (!prior) throw Error();
          next = structuredClone(prior.state);
          const key = command.kind === "put" ? command.grant.grant_id : command.grant_id;
          const previous = next.grants.find(g => g.grant_id === key);
          if ((previous?.revision ?? 0) !== command.expected_revision || previous?.revoked_at !== null && previous !== undefined) return denied();
          if (command.kind === "put" && previous && !active(previous,next.grants,mark.effective_utc)) return denied();
          if (command.expected_revision === Number.MAX_SAFE_INTEGER) return denied();
          if (command.kind === "revoke") {
            if (!previous) return denied();
            previous.revoked_at = mark.effective_utc; previous.revision++; resultRevision=previous.revision;
          } else {
            const grant = structuredClone(command.grant);
            // 最後のrevision値はrevoke用に残し、失効不能なactive grantを作らない。
            if (grant.revision === Number.MAX_SAFE_INTEGER) return denied("revision_mismatch");
            if (grant.revision !== command.expected_revision+1 || grant.revoked_at !== null || !same(grant.approval,proof.approval)
              || Date.parse(grant.expires_at) <= Date.parse(mark.effective_utc)) return denied();
            if (grant.parent) {
              const parent = next.grants.find(p => p.grant_id === grant.parent!.grant_id);
              if (!parent || parent.grant_id === key || parent.revision !== grant.parent.revision || !active(parent,next.grants,mark.effective_utc)
                || !this.current(parent,next.grants,state) || !shrinks(grant,parent)) return denied();
              // cycles are rejected even when replacing an existing ancestor.
              let cursor: TaskGrant | undefined = parent; const seen = new Set([key]);
              while (cursor) { if (seen.has(cursor.grant_id)) return denied(); seen.add(cursor.grant_id); cursor=cursor.parent?next.grants.find(p=>p.grant_id===cursor!.parent!.grant_id):undefined; }
            }
            for (const resource of grant.resources) {
              const valid = this.issuer.currentBinding(freeze(resource),freeze(grant.principal),state,freeze(grant.epic)); assertSynchronousResult(valid);
              if (valid !== true) return denied();
            }
            if (previous) next.grants[next.grants.indexOf(previous)] = grant;
            else { if (next.grants.length >= 1024) return denied("quota_exceeded"); next.grants.push(grant); }
            resultRevision=grant.revision;
          }
        }
        // 全未失効grantが後からrevokeされてもsnapshotの上限に収まる。
        // revoke自身をquotaで拒否する代わりに、putのadmission時に予約する。
        if (command.kind === "put" && Buffer.byteLength(stableStringify(next)) + revokeReserveBytes(next.grants) > snapshotMaxBytes)
          return denied("quota_exceeded");
        const value=encode(next);
        return {event:{...event,outcome:"succeeded" as const,reason:"none" as const,binding_revision:resultRevision??0},resource_digest:value.digest,
          mutation:()=>{
            assertActiveClockMutation(this.db,mark.transaction_id); verifySchema(this.db);
            if (prior) {
              const updated=this.db.prepare("UPDATE main.task_grant_state SET state_json=? WHERE instance_id=? AND tenant_id=? AND state_json=?").run(value.canonical,this.scope.instance_id,this.scope.tenant_id,prior.canonical);
              if (updated.changes !== 1) throw Error();
            } else this.db.prepare("INSERT INTO main.task_grant_state VALUES(?,?,?)").run(this.scope.instance_id,this.scope.tenant_id,value.canonical);
            return {status:"succeeded" as const,revision:resultRevision};
          }};
      });
    } catch { throw Error("task_grant_unverified"); }
  }
  /** 評価も保護時計と現在bindingを同じsecurity transactionで照合。外部実行はしない。 */
  evaluate(transactionId:string,input:GrantEvaluation): boolean {
    try {
      assertSynchronousResult(input);
      const query=freeze(z.strictObject({grant_id:id,revision,principal:principalSchema,resource:grantResourceSchema,
        operation:z.enum(["status","read","steer","cancel","merge","production"]),destination:destinationSchema,
        epic_membership_revision:revision.nullable()}).parse(input));
      return this.transaction.runPrepared<()=>boolean>(transactionId,(mark,state)=>{
        const value=this.read(state); const grant=value?.state.grants.find(g=>g.grant_id===query.grant_id);
        let allowed=!!grant && grant.revision===query.revision && same(grant.principal,query.principal)
          && subset([query.resource],grant.resources) && grant.operations.includes(query.operation) && subset([query.destination],grant.destinations)
          && (grant.epic?.membership_revision??null)===query.epic_membership_revision && active(grant,value!.state.grants,mark.effective_utc);
        if (allowed) allowed = this.current(grant!,value!.state.grants,state);
        const event:Omit<AuditEvent,"occurred_at">={scope:this.scope,actor:allowed?{kind:"principal",id:query.principal.id}:{kind:"unauthenticated",id:null},action:"binding_change",operation:"binding.change.v1",resource_id:resourceId,
          outcome:allowed?"allowed":"denied",reason:allowed?"none":"unauthorized",session_ref:null,receipt_id:null,attempt_id:null,policy_revision:0,binding_revision:allowed?query.revision:0,authz_revision:allowed?query.principal.authz_revision:0};
        return {event,resource_digest:null,mutation:()=>allowed};
      });
    } catch { throw Error("task_grant_unverified"); }
  }
}
