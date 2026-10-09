import type { DispatcherDatabase } from "./database.js";
import { resolveVerifiedSlackOwner } from "./verified-owner-origin.js";

/** 計画だけの継承。更新の適用・取消に内部通知を使用しない。 */
export function resolveCompletedUpdatePlanOrigin(database: DispatcherDatabase, eventId: string) {
  const resolved = resolveVerifiedSlackOwner(database, eventId);
  if (!resolved || resolved.path.length === 0) return;
  for (const link of resolved.path) {
    const event = database.get(link.event_id as string);
    const job = database.getJob(link.job_id as string);
    if (event?.event_type !== "job_completed" || job?.status !== "completed" || !job.result_json) return;
    const task = database.tasks.forAttempt(job.job_id);
    if (task && (task.current_attempt_id !== job.job_id || task.state !== "completed")) return;
    const group = database.getJobGroup(job.source_event_id);
    if (!group || (group.notification_mode === "grouped"
      ? !group.sealed_at || group.all_terminal_event_id !== event.event_id
      : job.completion_event_id !== event.event_id)) return;
  }
  return resolved.origin;
}
