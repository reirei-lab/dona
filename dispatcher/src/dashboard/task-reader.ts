import { sanitizeObservationText } from "../app-server/observation.js";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";

export interface DashboardAttempt {
  attempt_id: string; number: number; status: string; outcome: string | null;
  created_at: string; ended_at: string | null; agent_name: string;
}
export interface DashboardTask {
  task_id: string; task_key: string; revision: number; state: string; desired_state: string;
  progress: string; wait_reason: string | null; current_attempt_id: string;
  attempt_number: number; created_at: string; updated_at: string;
  local_operator_owned: boolean;
  source: string; worker_status: string; next_check_at: string | null;
}
export interface DashboardTaskSnapshot {
  task: DashboardTask; attempts: DashboardAttempt[]; fingerprint: string;
  /** Internal read-only identity evidence; never project this field to the browser. */
  runtime_binding: {agent_name:string;generation:string;thread_id:string} | null;
  selected_attempt_id: string;
  /** Selected Attempt request; public observer requires conversation permission. */
  request?: string;
  result: {status: string; summary: string; completed_at: string; output?: string; artifacts: {display_name:string;kind:string}[]} | null;
  runtime_binding_state: "missing" | "invalid" | "verified";
}
/** This reader never instantiates DispatcherDatabase: starting an observer must
 * not run migrations, recovery or supervisor actions against the active DB. */
export class DashboardTaskReader {
  private readonly sql: Database.Database;
  constructor(file: string) {
    this.sql = new Database(file, { readonly: true, fileMustExist: true });
    try {
      this.sql.pragma("query_only = ON");
      this.sql.pragma("busy_timeout = 1000");
      this.sql.prepare(`${projection} LIMIT 0`).all();
      this.sql.prepare("SELECT identity_version,herdr_agent_session_id,agent_name,recorded_at,generation_nonce FROM job_live_session_identities LIMIT 0").all();
      this.sql.prepare("SELECT a.attempt_id,a.number,a.outcome,a.created_at,a.ended_at,j.agent_name FROM task_attempts a JOIN jobs j ON j.job_id=a.attempt_id LIMIT 0").all();
    } catch(error) { this.sql.close(); throw error; }
  }
  close(): void { this.sql.close(); }
  /** A caller must supply its current server-side resource authorization.
   * Filtering precedes pagination, so invisible rows cannot hide later results. */
  list(visible: (task: DashboardTask) => boolean, after: string | null = null, limit = 20): {items: DashboardTask[]; next: string | null} {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || (after !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(after))) throw Error("dashboard_query_invalid");
    return this.sql.transaction(() => {
      const items: DashboardTask[] = [];
      const rows = this.sql.prepare(`${projection} WHERE (? IS NULL OR t.task_id < ?) ORDER BY t.task_id DESC`).iterate(after, after);
      for (const value of rows) {
        const task = projectTask(value as DashboardTask);
        if (!visible(task)) continue;
        if (items.length === limit) return {items, next: items[items.length - 1]!.task_id};
        items.push(task);
      }
      return {items, next: null};
    })();
  }
  snapshot(id: string, attemptId?: string): DashboardTaskSnapshot | null {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || (attemptId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(attemptId))) throw Error("dashboard_query_invalid");
    return this.sql.transaction(() => {
      const row = this.sql.prepare(`${projection} WHERE t.task_id = ?`).get(id) as DashboardTask | undefined;
      if (!row) return null;
      const task=projectTask(row);
      const attempts = this.sql.prepare(`SELECT a.attempt_id,a.number,j.status,a.outcome,a.created_at,a.ended_at,j.agent_name
        FROM task_attempts a JOIN jobs j ON j.job_id=a.attempt_id WHERE a.task_id=? ORDER BY a.number`).all(id) as DashboardAttempt[];
      if (attempts.length > 100) throw Error("dashboard_attempt_limit");
      const selected_attempt_id = attemptId ?? task.current_attempt_id;
      const selected = attempts.find(attempt => attempt.attempt_id === selected_attempt_id);
      if (!selected) return null;
      const resultRow = this.sql.prepare("SELECT result_json,objective,steer_event_id,steer_state FROM jobs WHERE job_id=?").get(selected_attempt_id) as {result_json:string|null;objective:string;steer_event_id:string|null;steer_state:string|null};
      const effective = this.sql.prepare("SELECT objective,steer_pending_event_id FROM tasks WHERE task_id=?").get(id) as {objective:string;steer_pending_event_id:string|null};
      const current = selected_attempt_id === task.current_attempt_id;
      const objective = current ? effective.objective : resultRow.objective;
      // prepareSteer records the requested change before the worker acknowledges it.
      // Do not parse delimiters or hide earlier accepted additions while awaiting proof.
      const pending = current && effective.steer_pending_event_id !== null &&
        !(resultRow.steer_event_id === effective.steer_pending_event_id && resultRow.steer_state === "accepted");
      const request=(pending?"追加指示のワーカー受理は未確認です。\n\n":"")+sanitizeObservationText(objective)+(objective.length>8192?"\n[長い依頼内容の末尾を省略]":"");
      let result: DashboardTaskSnapshot["result"] = null;
      if (["completed","failed","cancelled"].includes(selected.status) && resultRow.result_json && resultRow.result_json.length <= 1_048_576) try {
        const value:unknown=JSON.parse(resultRow.result_json);
        if(value && typeof value === "object" && !Array.isArray(value)) {
          const row=value as Record<string,unknown>;
          if(row.job_id===selected_attempt_id && row.status===selected.status && typeof row.completed_at==="string" && row.completed_at.length<=64 && Number.isFinite(Date.parse(row.completed_at)))
            {
            const output=row.output as {format?:unknown;text?:unknown}|undefined;
            result={status:selected.status,summary:typeof row.summary==="string"?row.summary.slice(0,8192):"",completed_at:row.completed_at,
              ...(output&&["text","markdown"].includes(String(output.format))&&typeof output.text==="string"?{output:output.text.slice(0,16384)}:{}),
              artifacts:Array.isArray(row.artifacts)?row.artifacts.slice(0,32).flatMap(item=>{
                if(!item||typeof item!=="object"||Array.isArray(item))return [];
                const artifact=item as Record<string,unknown>;
                return typeof artifact.display_name==="string"&&typeof artifact.kind==="string"&&/^[a-z_]{1,32}$/.test(artifact.kind)?[{display_name:artifact.display_name.slice(0,160),kind:artifact.kind}]:[];
              }):[]};
          }
        }
      } catch { /* Invalid Result envelopes never authorize a raw projection. */ }
      const identity = this.sql.prepare(`SELECT identity_version,herdr_agent_session_id,agent_name,recorded_at,generation_nonce
        FROM job_live_session_identities WHERE job_id=?`).get(selected_attempt_id) as {
          identity_version:number;herdr_agent_session_id:string;agent_name:string;recorded_at:string;generation_nonce:string;
        } | undefined;
      let runtime_binding: DashboardTaskSnapshot["runtime_binding"] = null;
      if (identity?.identity_version === 1 && identity.agent_name === selected.agent_name) {
        try {
          if(typeof identity.herdr_agent_session_id!=="string"||identity.herdr_agent_session_id.length>512)throw Error();
          const tuple:unknown = JSON.parse(identity.herdr_agent_session_id);
          if(Array.isArray(tuple)&&tuple.length===2&&tuple.every(value=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,160}$/.test(value)))
            runtime_binding={agent_name:identity.agent_name,generation:tuple[0] as string,thread_id:tuple[1] as string};
        } catch { /* Missing/legacy/malformed identities never authorize a history read. */ }
      }
      // New releases retain immutable bindings after worker cleanup. Older DBs
      // remain readable, but absent history never permits an inferred binding.
      let archived: unknown[] = [];
      if (this.sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='job_runtime_bindings'").get()) {
        archived=this.sql.prepare("SELECT job_id,task_id,agent_name,generation,thread_id,recorded_at FROM job_runtime_bindings WHERE job_id=? ORDER BY recorded_at DESC LIMIT 2").all(selected_attempt_id);
        const rows=archived as {job_id:string;task_id:string|null;agent_name:string;generation:string;thread_id:string;recorded_at:string}[];
        if (!identity && rows.length) {
          const row=rows[0]!;
          if(row.task_id===id && row.agent_name===selected.agent_name && /^[A-Za-z0-9_-]{1,160}$/.test(row.generation) && /^[A-Za-z0-9_-]{1,160}$/.test(row.thread_id) && Number.isFinite(Date.parse(row.recorded_at)) && rows[1]?.recorded_at!==row.recorded_at)
            runtime_binding={agent_name:row.agent_name,generation:row.generation,thread_id:row.thread_id};
        }
      }
      // The fingerprint is public even without conversation permission. Do not
      // make the private request recoverable through candidate hashing.
      const fingerprint = createHash("sha256").update(JSON.stringify({task, attempts, selected_attempt_id, result, archived, identity:identity??null})).digest("hex");
      const runtime_binding_state:DashboardTaskSnapshot["runtime_binding_state"]=runtime_binding?"verified":identity||archived.length?"invalid":"missing";
      return {task, attempts, selected_attempt_id, result, request, fingerprint, runtime_binding, runtime_binding_state};
    })();
  }
}
const projection = `SELECT t.task_id,t.task_key,t.revision,t.state,t.desired_state,t.progress,t.wait_reason,t.current_attempt_id,
  t.attempt_number,t.created_at,t.updated_at,t.next_check_at,j.source,j.status AS worker_status,
  CASE WHEN json_valid(b.owner_json) THEN json_extract(b.owner_json,'$.kind')='local_dashboard' ELSE 0 END AS local_operator_owned
  FROM tasks t JOIN jobs j ON j.job_id=t.current_attempt_id LEFT JOIN job_owner_bindings b ON b.job_id=t.current_attempt_id`;
function projectTask(row:DashboardTask):DashboardTask {
  // This UI hint never replaces Dispatcher authorization of the current grant.
  return {...row,local_operator_owned:(row.local_operator_owned as unknown)===1};
}
