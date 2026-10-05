import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import Database from "better-sqlite3";
import { DispatcherDatabase, JobCreationError, migrateDispatcherDatabase } from "../../src/database.js";
import { assertTaskGenerationFile } from "../../src/task-execution.js";
import { tempConfig, eventEnvelope } from "../helpers.js";

const owner = { instance_id: "instance", tenant_id: "tenant", principal_id: "principal" };
const input = (key: string, objective = "web command") => ({ ...owner, idempotency_key: key, objective, workspace: { kind: "scratch" as const } });

test("web submitはreply-free sourceから既存queue・Result pathへ一度だけadmitし再起動後もreuseする", async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  let db = new DispatcherDatabase(config.databasePath); const key = "a".repeat(64);
  const created = db.createWebJob(input(key), config.jobsWorkspaceRoot, config.jobResultsDir);
  assert.equal(created.outcome, "created"); assert.equal(created.row.source, "web"); assert.equal(created.row.status, "queued");
  assert.equal(created.row.channel_id, null); assert.equal(created.row.thread_ts, null); assert.equal(created.row.actor_id, owner.principal_id);
  assert.ok(created.row.result_path.startsWith(config.jobResultsDir));
  const source = db.get(created.row.source_event_id)!; assert.equal(source.source, "web"); assert.equal(source.reply_target_json, null); assert.equal(source.status, "completed");
  assert.equal(db.createWebJob(input(key), config.jobsWorkspaceRoot, config.jobResultsDir).outcome, "reused");
  assert.throws(() => db.createWebJob(input(key, "different private token"), config.jobsWorkspaceRoot, config.jobResultsDir),
    (error: unknown) => error instanceof JobCreationError && error.code === "job_idempotency_conflict" && !error.message.includes("private token"));
  db.close(); db = new DispatcherDatabase(config.databasePath);
  assert.equal(db.createWebJob(input(key), config.jobsWorkspaceRoot, config.jobResultsDir).outcome, "reused");
  db.beginWebJobCancellation(created.row.job_id, owner); db.markJobCancelled(created.row.job_id, "fixture");
  const notification = db.enqueueJobNotification(created.row.job_id);
  assert.equal(notification.row.event_id, source.event_id); assert.equal(db.getJob(created.row.job_id)!.completion_event_id, source.event_id);
  db.close();
});

test("web submitはowner quota、canonical concurrency、owner-bound cancel receiptをdurableにする", async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = new DispatcherDatabase(config.databasePath, { jobsPerEventMax: 1, jobObjectiveTotalMaxBytes: 400000 });
  const first = db.createWebJob(input("b".repeat(64)), config.jobsWorkspaceRoot, config.jobResultsDir);
  const peer = new DispatcherDatabase(config.databasePath, { jobsPerEventMax: 1, jobObjectiveTotalMaxBytes: 400000 });
  assert.equal(peer.createWebJob(input("b".repeat(64)), config.jobsWorkspaceRoot, config.jobResultsDir).outcome, "reused");
  assert.throws(() => db.createWebJob(input("c".repeat(64)), config.jobsWorkspaceRoot, config.jobResultsDir),
    (error: unknown) => error instanceof JobCreationError && error.code === "job_group_limit_exceeded");
  assert.throws(() => db.assertWebJobOwner(first.row.job_id, { ...owner, principal_id: "other" }), /web_job_owner_mismatch/);
  const cancelling = db.beginWebJobCancellation(first.row.job_id, owner); assert.equal(cancelling.status, "cancelling");
  db.markJobCancelled(first.row.job_id, "fixture"); const receiptId = "web_cancel_" + "d".repeat(64), payload = "e".repeat(64);
  const receipt = db.recordWebCancelReceipt(receiptId, payload, owner, first.row.job_id);
  assert.equal(db.getWebCommandReceipt(receiptId, owner)?.job_id, first.row.job_id);
  assert.equal(db.recordWebCancelReceipt(receiptId, payload, owner, first.row.job_id).receipt_id, receipt.receipt_id);
  assert.equal(db.getWebCommandReceipt(receiptId, { ...owner, principal_id: "other" }), undefined);
  peer.close(); db.close();
});

test("v2 bridgeのweb receiptを保持したままv3へmigrationできる", async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const initial = new Database(config.databasePath); migrateDispatcherDatabase(initial, () => {}, false, 2); initial.close();
  let db = new DispatcherDatabase(config.databasePath); const key = "f".repeat(64);
  const created = db.createWebJob(input(key), config.jobsWorkspaceRoot, config.jobResultsDir); db.close();
  const raw = new Database(config.databasePath); raw.pragma("foreign_keys=ON");
  assert.equal(raw.pragma("user_version", { simple: true }), 2); migrateDispatcherDatabase(raw, () => {}, false, 3); raw.close();
  db = new DispatcherDatabase(config.databasePath);
  assert.equal(db.getWebCommandReceipt("web_submit_" + key, owner)?.job_id, created.row.job_id); db.close();
});

test("preparingとdispatchingのweb jobもownerがcancellingへ遷移できる", async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [index, status] of ["preparing", "dispatching"].entries()) {
    let db = new DispatcherDatabase(config.databasePath); const created = db.createWebJob(input(String(index + 1).repeat(64)), config.jobsWorkspaceRoot, config.jobResultsDir); db.close();
    const raw = new Database(config.databasePath); raw.prepare("UPDATE jobs SET status=? WHERE job_id=?").run(status, created.row.job_id); raw.close();
    db = new DispatcherDatabase(config.databasePath); assert.equal(db.beginWebJobCancellation(created.row.job_id, owner).status, "cancelling");
    db.markJobCancelled(created.row.job_id, "fixture"); db.close();
  }
});

test("cancelling中のweb cancel再送はterminalにせずacceptance unknownへ保つ", async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = new DispatcherDatabase(config.databasePath), created = db.createWebJob(input("6".repeat(64)), config.jobsWorkspaceRoot, config.jobResultsDir);
  db.beginWebJobCancellation(created.row.job_id, owner);
  assert.throws(() => db.beginWebJobCancellation(created.row.job_id, owner), /web_cancel_acceptance_unknown/); db.close();
});

test("blockedとneeds_reviewのweb jobもownerが明示解放するまではquotaへ算入する", async t => {
  for (const [index, status] of ["blocked", "needs_review"].entries()) {
    const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
    let db = new DispatcherDatabase(config.databasePath, { jobsPerEventMax: 1, jobObjectiveTotalMaxBytes: 400000 });
    const created = db.createWebJob(input(String(index + 3).repeat(64)), config.jobsWorkspaceRoot, config.jobResultsDir); db.close();
    const raw = new Database(config.databasePath); raw.prepare("UPDATE jobs SET status=? WHERE job_id=?").run(status, created.row.job_id); raw.close();
    db = new DispatcherDatabase(config.databasePath, { jobsPerEventMax: 1, jobObjectiveTotalMaxBytes: 400000 });
    assert.throws(() => db.createWebJob(input(String(index + 7).repeat(64)), config.jobsWorkspaceRoot, config.jobResultsDir),
      (error: unknown) => error instanceof JobCreationError && error.code === "job_group_limit_exceeded");
    if (status === "needs_review") {
      assert.equal(db.beginWebJobCancellation(created.row.job_id, owner).status, "cancelling");
      db.markJobCancelled(created.row.job_id, "owner released reviewed job");
      assert.equal(db.createWebJob(input("9".repeat(64)), config.jobsWorkspaceRoot, config.jobResultsDir).outcome, "created");
    }
    db.close();
  }
});

test("Web Resultはownerを検証して保存しSlack通知を生成しない", async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = new DispatcherDatabase(config.databasePath); t.after(() => db.close());
  const job = db.createWebJob(input("9".repeat(64)), config.jobsWorkspaceRoot, config.jobResultsDir).row;
  db.beginJobPreparation(job.job_id); db.beginJobDispatch(job.job_id); db.markJobRunning(job.job_id);
  const result = { schema_version: 1 as const, job_id: job.job_id, status: "completed" as const,
    summary: "done", completed_at: new Date().toISOString() };
  const raw = new Database(config.databasePath); t.after(() => raw.close());
  raw.prepare("UPDATE jobs SET actor_id='other' WHERE job_id=?").run(job.job_id);
  assert.throws(() => db.saveJobResult(job.job_id, result, job.result_path), /web_job_owner_mismatch/);
  assert.equal(db.getJob(job.job_id)?.status, "running");
  raw.prepare("UPDATE jobs SET actor_id=? WHERE job_id=?").run(owner.principal_id, job.job_id);
  db.saveJobResult(job.job_id, result, job.result_path);
  const receipt = db.enqueueJobNotification(job.job_id);
  assert.equal(receipt.row.event_id, job.source_event_id);
  assert.equal(receipt.row.source, "web");
  assert.equal(db.enqueueJobNotification(job.job_id).duplicate, true);
  assert.equal((raw.prepare("SELECT count(*) AS n FROM events WHERE source='dona_job'").get() as {n:number}).n, 0);
});


test("Task世代に保存したWeb JobはDispatcher再起動の世代検査を妨げない", async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  let db = new DispatcherDatabase(config.databasePath);
  db.tasks.assertFreshExecutionModel();
  const created = db.createWebJob(input("8".repeat(64)), config.jobsWorkspaceRoot, config.jobResultsDir);
  db.close();
  assert.doesNotThrow(() => assertTaskGenerationFile(config.databasePath));
  db = new DispatcherDatabase(config.databasePath); t.after(() => db.close());
  assert.doesNotThrow(() => db.tasks.assertFreshExecutionModel());
  assert.equal(db.getWebCommandReceipt(created.receipt.receipt_id, owner)?.job_id, created.row.job_id);
  assert.equal(db.getJob(created.row.job_id)?.status, "queued");
});

test("Web Taskはreceiptと一体で作られ、未構成profileを実行せず再起動後も同じidentityを返す", async t => {
  const {root,config}=await tempConfig();t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let db=new DispatcherDatabase(config.databasePath);
  const created=db.createWebTask(input("a".repeat(64)),config.jobsWorkspaceRoot,config.jobResultsDir);
  assert.ok(created.task);assert.equal(created.task.state,"waiting");assert.equal(created.task.wait_reason,"runtime_profile_unavailable");
  assert.equal(created.row.status,"blocked");assert.equal(db.tasks.canRun(created.row),false);assert.equal(db.tasks.candidates().length,0);
  assert.equal(JSON.parse(created.row.workspace_json)._dona_task.task_id,created.task.task_id);
  assert.equal(db.get(created.task.source_event_id)?.source,"web");
  db.close();db=new DispatcherDatabase(config.databasePath);t.after(()=>db.close());
  const replay=db.createWebTask(input("a".repeat(64)),config.jobsWorkspaceRoot,config.jobResultsDir);
  assert.equal(replay.task?.task_id,created.task.task_id);assert.equal(replay.receipt.receipt_id,created.receipt.receipt_id);
  assert.equal(db.tasks.attempts(created.task.task_id).length,1);
  assert.throws(()=>db.createWebTask(input("a".repeat(64),"changed"),config.jobsWorkspaceRoot,config.jobResultsDir),/conflict/);
});

test("Web Task取消はowner・Attempt・revisionとreceiptを同じtransactionで固定する", async t => {
  const {root,config}=await tempConfig();t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const db=new DispatcherDatabase(config.databasePath);t.after(()=>db.close());
  const created=db.createWebTask(input("b".repeat(64)),config.jobsWorkspaceRoot,config.jobResultsDir),task=created.task!;
  const command={...owner,task_id:task.task_id,attempt_id:created.row.job_id,revision:task.revision,idempotency_key:"c".repeat(64)};
  assert.throws(()=>db.cancelWebTask({...command,principal_id:"foreign"}),/owner_mismatch/);
  assert.throws(()=>db.cancelWebTask({...command,revision:task.revision+1}),/revision_conflict/);
  assert.equal(db.getWebCommandReceipt("web_cancel_"+command.idempotency_key,owner),undefined);
  const cancelled=db.cancelWebTask(command);assert.equal(cancelled.task.state,"cancelled");assert.equal(db.getJob(command.attempt_id)?.last_error_code,null);assert.equal(db.getJob(command.attempt_id)?.last_error_message,null);
  const peer=new DispatcherDatabase(config.databasePath);t.after(()=>peer.close());
  assert.equal(peer.cancelWebTask(command).duplicate,true);
  assert.throws(()=>peer.cancelWebTask({...command,revision:task.revision+1}),/conflict/);
  assert.equal(db.tasks.attempts(task.task_id).length,1);
});

test("旧Web receiptはTaskへ自動採用せず表示identityを保持する", async t => {
  const {root,config}=await tempConfig();t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let db=new DispatcherDatabase(config.databasePath);
  const legacy=db.createWebJob(input("d".repeat(64)),config.jobsWorkspaceRoot,config.jobResultsDir);db.close();
  db=new DispatcherDatabase(config.databasePath);t.after(()=>db.close());
  const replay=db.createWebTask(input("d".repeat(64)),config.jobsWorkspaceRoot,config.jobResultsDir);
  assert.equal(replay.task,undefined);assert.equal(replay.row.job_id,legacy.row.job_id);assert.deepEqual(replay.receipt,legacy.receipt);
  assert.throws(()=>db.cancelWebTask({...owner,task_id:"task_00000000000000000000000000",attempt_id:legacy.row.job_id,revision:1,idempotency_key:"e".repeat(64)}),/migration_required/);
});

test("実行中Web Taskの取消receiptは停止完了と区別し、応答喪失後も同じ要求を照合できる", async t => {
  const {root,config}=await tempConfig();t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const db=new DispatcherDatabase(config.databasePath);t.after(()=>db.close());
  const created=db.createWebTask(input("8".repeat(64)),config.jobsWorkspaceRoot,config.jobResultsDir);
  // 将来のprotected providerが開始済みの状態をfixtureで表す。実workerは起動しない。
  const raw=new Database(config.databasePath);
  raw.prepare("UPDATE jobs SET status='running',dispatch_started_at=? WHERE job_id=?").run(new Date().toISOString(),created.row.job_id);
  raw.close();
  const task=db.tasks.get(created.task!.task_id)!;
  const command={...owner,task_id:task.task_id,attempt_id:task.current_attempt_id,revision:task.revision,idempotency_key:"7".repeat(64)};
  const receipt=db.cancelWebTask(command);
  assert.equal(receipt.task.state,"waiting");assert.equal(receipt.task.wait_reason,"cancel_requested");
  assert.equal(db.getJob(task.current_attempt_id)?.status,"running");
  assert.equal(db.cancelWebTask(command).duplicate,true);
  assert.equal(db.tasks.candidates()[0]?.task_id,task.task_id);
  assert.throws(()=>db.cancelWebTask({...command,idempotency_key:"6".repeat(64)}),/revision_conflict/);
});

 test("Web profile待機の除外はwait_reason未設定の通常Task回復を妨げない", async t => {
  const {root,config}=await tempConfig();t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const db=new DispatcherDatabase(config.databasePath);t.after(()=>db.close());
  db.createWebTask(input("4".repeat(64)),config.jobsWorkspaceRoot,config.jobResultsDir);
  const event=db.enqueue(eventEnvelope("web-profile-regression")).row;
  const ordinary=db.tasks.create({source_event_id:event.event_id,task_key:"ordinary",objective:"test",workspace:{kind:"scratch"},policy:{max_attempts:3,retry_delay_ms:60000}},config.jobsWorkspaceRoot,config.jobResultsDir).task;
  const raw=new Database(config.databasePath);raw.prepare("UPDATE jobs SET status='blocked' WHERE job_id=?").run(ordinary.current_attempt_id);raw.close();
  assert.equal(db.tasks.get(ordinary.task_id)?.wait_reason,null);
  assert.deepEqual(db.tasks.candidates().map(task=>task.task_id),[ordinary.task_id]);
 });
