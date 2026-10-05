import Database from "better-sqlite3";
import { createHash } from "node:crypto";

export interface DashboardAttempt {
  attempt_id: string; number: number; status: string; outcome: string | null;
  created_at: string; ended_at: string | null; agent_name: string;
}
export interface DashboardTask {
  task_id: string; revision: number; state: string; desired_state: string;
  progress: string; wait_reason: string | null; current_attempt_id: string;
  attempt_number: number; created_at: string; updated_at: string;
  source: string; worker_status: string; next_check_at: string | null;
}
export interface DashboardTaskSnapshot {
  task: DashboardTask; attempts: DashboardAttempt[]; fingerprint: string;
}
/** This reader never instantiates DispatcherDatabase: starting an observer must
 * not run migrations, recovery or supervisor actions against the active DB. */
export class DashboardTaskReader {
  private readonly sql: Database.Database;
  constructor(file: string) {
    this.sql = new Database(file, { readonly: true, fileMustExist: true });
    this.sql.pragma("query_only = ON");
    this.sql.pragma("busy_timeout = 1000");
  }
  close(): void { this.sql.close(); }
  /** A caller must supply its current server-side resource authorization.
   * Filtering precedes pagination, so invisible rows cannot hide later results. */
  list(visible: (task: DashboardTask) => boolean, after: string | null = null, limit = 20): {items: DashboardTask[]; next: string | null} {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || (after !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(after))) throw Error("dashboard_query_invalid");
    return this.sql.transaction(() => {
      const items: DashboardTask[] = [];
      const rows = this.sql.prepare(`${projection} WHERE t.task_id > ? ORDER BY t.task_id`).iterate(after ?? "");
      for (const value of rows) {
        const task = value as DashboardTask;
        if (!visible(task)) continue;
        if (items.length === limit) return {items, next: items[items.length - 1]!.task_id};
        items.push(task);
      }
      return {items, next: null};
    })();
  }
  snapshot(id: string): DashboardTaskSnapshot | null {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw Error("dashboard_query_invalid");
    return this.sql.transaction(() => {
      const task = this.sql.prepare(`${projection} WHERE t.task_id = ?`).get(id) as DashboardTask | undefined;
      if (!task) return null;
      const attempts = this.sql.prepare(`SELECT a.attempt_id,a.number,j.status,a.outcome,a.created_at,a.ended_at,j.agent_name
        FROM task_attempts a JOIN jobs j ON j.job_id=a.attempt_id WHERE a.task_id=? ORDER BY a.number`).all(id) as DashboardAttempt[];
      if (attempts.length > 100) throw Error("dashboard_attempt_limit");
      const fingerprint = createHash("sha256").update(JSON.stringify({task, attempts})).digest("hex");
      return {task, attempts, fingerprint};
    })();
  }
}
const projection = `SELECT t.task_id,t.revision,t.state,t.desired_state,t.progress,t.wait_reason,t.current_attempt_id,
  t.attempt_number,t.created_at,t.updated_at,t.next_check_at,j.source,j.status AS worker_status
  FROM tasks t JOIN jobs j ON j.job_id=t.current_attempt_id`;
