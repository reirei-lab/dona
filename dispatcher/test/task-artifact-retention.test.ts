import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";
import { DispatcherDatabase } from "../src/database.js";
import { taskRequestSchema } from "../src/task-execution.js";
import { eventEnvelope, tempConfig } from "./helpers.js";

test("retention ledger works with current Dispatcher migrations and Task triggers in a private database", async () => {
  const { root, config } = await tempConfig();
  const canonical = await fs.realpath(root);
  config.jobsWorkspaceRoot = path.join(canonical, "workspaces");
  config.jobResultsDir = path.join(canonical, "job-results");
  const database = new DispatcherDatabase(config.databasePath);
  try {
    const event = database.enqueue(eventEnvelope("retention-fixture")).row;
    const task = database.tasks.create(taskRequestSchema.parse({
      source_event_id: event.event_id, task_key: "retention", objective: "isolated fixture",
      workspace: { kind: "scratch" }, policy: { max_attempts: 1, retry_delay_ms: 1000 },
      initial_operation: "read_only", continuation_scope: {
        objective: "isolated retention continuation", targets: [], allow_scratch: true,
        operations: ["read_only"], max_tasks: 2, max_attempts_per_task: 1,
      },
    }), config.jobsWorkspaceRoot, config.jobResultsDir).task;
    const job = database.getJob(task.current_attempt_id)!;
    for (const directory of [job.workspace_path, path.dirname(job.result_path),
      path.join(path.dirname(job.workspace_path), ".dona-progress", job.job_id)]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(directory, "evidence"), "isolated");
    }
    await fs.chmod(config.jobsWorkspaceRoot, 0o700);
    await fs.chmod(config.jobResultsDir, 0o700);
    const old = "2026-09-01T00:00:00Z";
    database.beginJobPreparation(job.job_id);
    database.setJobRuntime(job.job_id, "fixture-workspace", "fixture-pane");
    database.beginJobDispatch(job.job_id);
    database.markJobRunning(job.job_id);
    database.saveJobResult(job.job_id, {
      schema_version: 1, job_id: job.job_id, status: "completed", summary: "fixture", completed_at: old,
    }, job.result_path);
    database.sealJobGroup(event.event_id);
    const notification = database.enqueueJobNotification(job.job_id).row;
    const local = database.localDashboard.create({ instance_id: "fixture", owner_id: "operator", device_id: "device", grant_revision: 1 }, {
      request_id: "local-retention", objective: "isolated local completion", workspace: { kind: "scratch" },
    }, config.jobsWorkspaceRoot, config.jobResultsDir);
    const localJob = database.getJob(local.task.current_attempt_id)!;
    for (const directory of [localJob.workspace_path, path.dirname(localJob.result_path),
      path.join(path.dirname(localJob.workspace_path), ".dona-progress", localJob.job_id)]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(directory, "evidence"), "local isolated");
    }
    database.beginJobPreparation(localJob.job_id);
    database.setJobRuntime(localJob.job_id, "local-fixture", "local-pane");
    database.beginJobDispatch(localJob.job_id);
    database.markJobRunning(localJob.job_id);
    database.saveJobResult(localJob.job_id, {
      schema_version: 1, job_id: localJob.job_id, status: "completed", summary: "local fixture", completed_at: old,
    }, localJob.result_path);
    database.enqueueJobNotification(localJob.job_id);
    const authority = { instance_id: "fixture", owner_id: "operator", device_id: "device", grant_revision: 1 };
    const cancelled = database.localDashboard.create(authority, {
      request_id: "cancel-retention", objective: "isolated local cancellation", workspace: { kind: "scratch" },
    }, config.jobsWorkspaceRoot, config.jobResultsDir);
    const cancelJob = cancelled.row;
    for (const directory of [cancelJob.workspace_path, path.dirname(cancelJob.result_path),
      path.join(path.dirname(cancelJob.workspace_path), ".dona-progress", cancelJob.job_id)]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(directory, "evidence"), "cancel isolated");
    }
    database.beginJobPreparation(cancelJob.job_id);
    database.setJobRuntime(cancelJob.job_id, "cancel-fixture", "cancel-pane");
    database.beginJobDispatch(cancelJob.job_id);
    database.markJobRunning(cancelJob.job_id);
    const request = database.localDashboard.cancel(authority, {
      request_id: "cancel-command", task_id: cancelled.task.task_id, attempt_id: cancelJob.job_id,
      revision: database.tasks.get(cancelled.task.task_id)!.revision,
    });
    assert.equal(request.task.state, "waiting");
    const simulatedStop = { state: "stopped" as const, reason: "app_server_verified_empty_scope" as const,
      observed_at: old, process_ids: [], process_groups: [] };
    database.tasks.claimStop(request.task, simulatedStop);
    database.tasks.stopped(request.task, simulatedStop);
    database.tasks.replaceStopped(cancelled.task.task_id, config.jobResultsDir);
    assert.equal(database.tasks.get(cancelled.task.task_id)!.state, "cancelled");
    assert.equal(database.getJob(cancelJob.job_id)!.result_json, null);
    // Model already-verified stop and delivered notification in this private DB.
    // No runtime/Slack calls are made, and this is not live stop evidence.
    const sql = new Database(config.databasePath);
    try {
      sql.prepare("UPDATE jobs SET created_at=? WHERE job_id IN (?,?)").run(old, job.job_id, localJob.job_id);
      sql.prepare("UPDATE jobs SET created_at=?,completed_at=? WHERE job_id=?").run(old, old, cancelJob.job_id);
      sql.prepare("UPDATE task_attempts SET stop_receipt_json=? WHERE attempt_id=?").run(JSON.stringify(simulatedStop), cancelJob.job_id);
      sql.prepare("UPDATE local_dashboard_command_receipts SET created_at=? WHERE attempt_id=?").run(old, cancelJob.job_id);
      sql.prepare("UPDATE task_attempts SET stop_receipt_json=? WHERE attempt_id=?").run(
        JSON.stringify({ state: "stopped", reason: "app_server_verified_empty_scope", observed_at: old }), job.job_id);
      sql.prepare("UPDATE task_attempts SET stop_receipt_json=? WHERE attempt_id=?").run(
        JSON.stringify({ state: "stopped", reason: "app_server_verified_empty_scope", observed_at: old }), localJob.job_id);
      const target = JSON.parse(notification.reply_target_json!);
      sql.prepare("UPDATE events SET status='completed',completed_at=?,result_json=? WHERE event_id=?").run(old,
        JSON.stringify({ schema_version: 1, event_id: notification.event_id, status: "completed", actions: [
          { tool: "dona_slack.post_message", ...target, message_ts: "1756684800.000001", reply_broadcast: false, success: true },
          { tool: "dona_slack.set_agent_session_status", ...target, status: "active", success: true },
        ] }), notification.event_id);
    } finally { sql.close(); }
    const result = spawnSync("python3", ["-B", "-c", `
import json,sqlite3,sys
from task_artifact_retention import Retention,Policy
db=sqlite3.connect(sys.argv[1])
db.execute('PRAGMA foreign_keys=ON')
engine=Retention(db,sys.argv[2],sys.argv[3],Policy(7,0))
engine.install()
assert engine.inventory(sys.argv[4],1791244800)['protection_reasons']==['continuation_unsettled']
db.execute("UPDATE task_continuation_scopes SET state='paused'")
db.commit()
assert engine.inventory(sys.argv[4],1791244800)['protection_reasons']==['continuation_unsettled']
# Only this private fixture's irreversible cancellation releases the scope.
db.execute("UPDATE task_continuation_scopes SET state='cancelled'")
db.commit()
item=engine.inventory(sys.argv[4],1791244800)
assert item.get('size_is_complete'),item
event=db.execute('SELECT all_terminal_event_id FROM job_groups WHERE source_event_id=(SELECT source_event_id FROM jobs WHERE job_id=?)',(sys.argv[4],)).fetchone()[0]
saved=db.execute('SELECT result_json FROM events WHERE event_id=?',(event,)).fetchone()[0]
# Incomplete historical action records cannot establish delivery or session success.
for index in (0,1):
    broken=json.loads(saved)
    del broken['actions'][index]['success']
    db.execute('UPDATE events SET result_json=? WHERE event_id=?',(json.dumps(broken),event))
    db.commit()
    assert engine.inventory(sys.argv[4],1791244800)['protection_reasons']==['notification_unsettled']
    broken['actions'][index]['ok']=True
    db.execute('UPDATE events SET result_json=? WHERE event_id=?',(json.dumps(broken),event))
    db.commit()
    assert engine.inventory(sys.argv[4],1791244800).get('size_is_complete')
broken=json.loads(saved)
broken['actions'][0]['ambiguous']=True
db.execute('UPDATE events SET result_json=? WHERE event_id=?',(json.dumps(broken),event))
db.commit()
assert engine.inventory(sys.argv[4],1791244800)['protection_reasons']==['notification_unsettled']
db.execute('UPDATE events SET result_json=? WHERE event_id=?',(saved,event))
db.commit()
db.execute('''INSERT OR IGNORE INTO job_completion_results(job_id,job_status,source_event_id,owner_json,destination_json,work_state,notification_state,materialized_at,content_delete_at,notification_event_id)
SELECT j.job_id,j.status,j.source_event_id,b.owner_json,b.destination_json,'completed','accepted',j.completed_at,j.completed_at,?
FROM jobs j JOIN job_owner_bindings b USING(job_id) WHERE j.job_id=?''',(event,sys.argv[4]))
db.execute("UPDATE events SET completed_at='2026-10-05T00:00:00Z' WHERE event_id=?",(event,))
db.commit()
assert engine.inventory(sys.argv[4],1791244800)['protection_reasons']==['retention_not_expired']
db.execute("UPDATE events SET completed_at='2026-09-01T00:00:00Z' WHERE event_id=?",(event,))
db.commit()
if sys.platform=='darwin':
    assert engine.cleanup(sys.argv[4],'result',1791244800)=='deleted'
local=engine.inventory(sys.argv[5],1791244800)
assert local.get('size_is_complete'),local
# The current web route normally has no completion row. Also cover a
# materialized/legacy row so it cannot bypass the local create receipt.
db.execute('''INSERT OR IGNORE INTO job_completion_results(job_id,job_status,source_event_id,owner_json,destination_json,work_state,notification_state,materialized_at,content_delete_at)
SELECT j.job_id,j.status,j.source_event_id,b.owner_json,b.destination_json,'completed','none',j.completed_at,j.completed_at
FROM jobs j JOIN job_owner_bindings b USING(job_id) WHERE j.job_id=?''',(sys.argv[5],))
task=db.execute('SELECT task_id FROM task_attempts WHERE attempt_id=?',(sys.argv[5],)).fetchone()[0]
db.execute("UPDATE local_dashboard_command_receipts SET operation='cancel' WHERE task_id=? AND operation='create'",(task,))
db.commit()
assert engine.inventory(sys.argv[5],1791244800)['protection_reasons']==['notification_binding_mismatch']
db.execute("UPDATE local_dashboard_command_receipts SET operation='create' WHERE task_id=? AND operation='cancel'",(task,))
db.commit()
assert engine.inventory(sys.argv[5],1791244800).get('size_is_complete')
if sys.platform=='darwin':
    assert engine.cleanup(sys.argv[5],'result',1791244800)=='deleted'
    retained=json.loads(db.execute('SELECT result_json FROM jobs WHERE job_id=?',(sys.argv[5],)).fetchone()[0])
    assert retained['summary']=='local fixture'
cancel=sys.argv[6]
assert engine.inventory(cancel,1791244800).get('size_is_complete')
db.execute("UPDATE local_dashboard_command_receipts SET owner_id='other' WHERE attempt_id=? AND operation='cancel'",(cancel,))
db.commit()
assert engine.inventory(cancel,1791244800)['protection_reasons']==['local_cancel_unverified']
db.execute("UPDATE local_dashboard_command_receipts SET owner_id='operator' WHERE attempt_id=? AND operation='cancel'",(cancel,))
db.execute("UPDATE tasks SET stop_state='attempting' WHERE current_attempt_id=?",(cancel,))
db.commit()
assert engine.inventory(cancel,1791244800)['protection_reasons']==['local_cancel_unverified']
db.execute("UPDATE tasks SET stop_state='stopped' WHERE current_attempt_id=?",(cancel,))
db.execute("UPDATE local_dashboard_command_receipts SET created_at='2026-10-05T00:00:00Z' WHERE attempt_id=? AND operation='cancel'",(cancel,))
db.commit()
assert engine.inventory(cancel,1791244800)['protection_reasons']==['retention_not_expired']
db.execute("UPDATE local_dashboard_command_receipts SET created_at='2026-09-01T00:00:00Z' WHERE attempt_id=? AND operation='cancel'",(cancel,))
db.commit()
if sys.platform=='darwin':
    assert engine.cleanup(cancel,'result',1791244800)=='deleted'
    assert db.execute('SELECT result_json FROM jobs WHERE job_id=?',(cancel,)).fetchone()[0] is None
print(json.dumps(item))
db.close()
`, config.databasePath, config.jobsWorkspaceRoot, config.jobResultsDir, job.job_id, localJob.job_id, cancelJob.job_id], {
      cwd: fileURLToPath(new URL("../../scripts/maintenance", import.meta.url)), encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.equal(JSON.parse(result.stdout).artifacts.length, 3);
  } finally {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
