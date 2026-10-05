/** mainのDispatcher migrationが所有する既知triggerの固定定義。
 * DBから観測した定義を信頼済みとして登録しない。変更時は宣言元DDLと
 * audit/approvalへの副作用をreviewし、改変拒否testを通して更新する。 */
const dispatcherCoreTriggers: readonly { name: string; tbl_name: string; sql: string }[] = [
  {
    "name": "event_job_binding_immutable",
    "tbl_name": "event_job_bindings",
    "sql": "CREATE TRIGGER event_job_binding_immutable BEFORE UPDATE ON event_job_bindings BEGIN SELECT RAISE(ABORT,'event_job_binding_immutable'); END"
  },
  {
    "name": "job_attention_no_post_no_delete",
    "tbl_name": "job_attention_no_post_reconciliations",
    "sql": "CREATE TRIGGER job_attention_no_post_no_delete BEFORE DELETE ON job_attention_no_post_reconciliations\n    BEGIN SELECT RAISE(ABORT,'attention_no_post_append_only'); END"
  },
  {
    "name": "job_attention_no_post_no_update",
    "tbl_name": "job_attention_no_post_reconciliations",
    "sql": "CREATE TRIGGER job_attention_no_post_no_update BEFORE UPDATE ON job_attention_no_post_reconciliations\n    BEGIN SELECT RAISE(ABORT,'attention_no_post_append_only'); END"
  },
  {
    "name": "job_completion_outbox_insert",
    "tbl_name": "connector_outbox",
    "sql": "CREATE TRIGGER job_completion_outbox_insert AFTER INSERT ON connector_outbox\n      WHEN NEW.kind='slack.work_result.post' AND NEW.completion_job_status IS NOT NULL BEGIN\n        UPDATE job_completion_results SET notification_state='pending'\n        WHERE job_id=(SELECT job_id FROM schedule_runs WHERE run_id=NEW.run_id) AND job_status=NEW.completion_job_status;\n      END"
  },
  {
    "name": "job_completion_outbox_update",
    "tbl_name": "connector_outbox",
    "sql": "CREATE TRIGGER job_completion_outbox_update AFTER UPDATE OF status ON connector_outbox\n      WHEN NEW.kind='slack.work_result.post' AND NEW.completion_job_status IS NOT NULL BEGIN\n        UPDATE job_completion_results SET notification_state=CASE NEW.status\n          WHEN 'sent' THEN 'accepted' WHEN 'failed' THEN 'failed' WHEN 'needs_review' THEN 'needs_review'\n          WHEN 'cancelled' THEN 'none' ELSE 'pending' END\n        WHERE job_id=(SELECT job_id FROM schedule_runs WHERE run_id=NEW.run_id) AND job_status=NEW.completion_job_status;\n      END"
  },
  {
    "name": "job_late_result_reconciliations_no_update",
    "tbl_name": "job_late_result_reconciliations",
    "sql": "CREATE TRIGGER job_late_result_reconciliations_no_update\n        BEFORE UPDATE ON job_late_result_reconciliations BEGIN SELECT RAISE(ABORT, 'late_result_reconciliation_append_only'); END"
  },
  {
    "name": "job_operator_assertion_recoveries_no_delete",
    "tbl_name": "job_operator_assertion_recoveries",
    "sql": "CREATE TRIGGER job_operator_assertion_recoveries_no_delete\n    BEFORE DELETE ON job_operator_assertion_recoveries\n    BEGIN SELECT RAISE(ABORT,'operator_assertion_recovery_append_only'); END"
  },
  {
    "name": "job_operator_assertion_recoveries_no_update",
    "tbl_name": "job_operator_assertion_recoveries",
    "sql": "CREATE TRIGGER job_operator_assertion_recoveries_no_update\n    BEFORE UPDATE ON job_operator_assertion_recoveries\n    BEGIN SELECT RAISE(ABORT,'operator_assertion_recovery_append_only'); END"
  },
  {
    "name": "job_owner_binding_immutable",
    "tbl_name": "job_owner_bindings",
    "sql": "CREATE TRIGGER job_owner_binding_immutable BEFORE UPDATE ON job_owner_bindings BEGIN SELECT RAISE(ABORT,'job_owner_binding_immutable'); END"
  },
  {
    "name": "jobs_agent_identity_immutable",
    "tbl_name": "jobs",
    "sql": "CREATE TRIGGER jobs_agent_identity_immutable\n        BEFORE UPDATE OF job_id,agent_name ON jobs\n        WHEN NEW.job_id <> OLD.job_id OR NEW.agent_name <> OLD.agent_name\n        BEGIN SELECT RAISE(ABORT,'job_agent_identity_immutable'); END"
  },
  {
    "name": "live_session_receipts_no_update",
    "tbl_name": "live_session_query_receipts",
    "sql": "CREATE TRIGGER live_session_receipts_no_update\n      BEFORE UPDATE ON live_session_query_receipts BEGIN SELECT RAISE(ABORT, 'live_session_receipt_append_only'); END"
  },
  {
    "name": "task_attempt_completion",
    "tbl_name": "jobs",
    "sql": "CREATE TRIGGER task_attempt_completion AFTER UPDATE OF status ON jobs\n      WHEN NEW.status IN ('completed','failed','cancelled') AND EXISTS(SELECT 1 FROM tasks WHERE current_attempt_id=NEW.job_id)\n      BEGIN\n        UPDATE task_attempts SET outcome=NEW.status,ended_at=NEW.completed_at WHERE attempt_id=NEW.job_id AND outcome IS NULL;\n        UPDATE tasks SET state=NEW.status,progress=CASE WHEN NEW.status='completed' THEN CASE WHEN json_extract(project_json,'$.completion_status')='Merge Ready' THEN 'merge_ready' ELSE 'completed' END WHEN NEW.status='cancelled' THEN 'cancelled' ELSE progress END,wait_reason=NULL,next_check_at=NULL,revision=revision+1,\n          project_state=CASE WHEN project_state IN ('attempting','unknown') THEN project_state ELSE 'pending' END,updated_at=NEW.updated_at WHERE current_attempt_id=NEW.job_id;\n      END"
  },
  {
    "name": "task_attempt_started",
    "tbl_name": "jobs",
    "sql": "CREATE TRIGGER task_attempt_started AFTER UPDATE OF status ON jobs\n      WHEN NEW.status='preparing'\n      BEGIN UPDATE tasks SET progress='in_progress',revision=revision+1,project_state=CASE WHEN project_state IN ('attempting','unknown') THEN project_state ELSE 'pending' END WHERE current_attempt_id=NEW.job_id; END"
  }
];

export function isDispatcherCoreTrigger(row: { name: string; tbl_name: string; sql: string }): boolean {
  return dispatcherCoreTriggers.some(expected => expected.name === row.name
    && expected.tbl_name === row.tbl_name && expected.sql === row.sql);
}
