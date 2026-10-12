import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {createHash,createHmac} from "node:crypto";
import {test} from "node:test";
import Database from "better-sqlite3";
import {DispatcherDatabase} from "../src/database.js";
import {taskRequestSchema} from "../src/task-execution.js";
import {principalProofKeyId,verifySlackPrincipalProof} from "../src/principal-proof.js";
import {stableStringify} from "../src/validation.js";
import {AgentContextManager} from "../src/agent-context.js";
import {envelopeFromRow} from "../src/prompt.js";
import {eventEnvelope,tempConfig} from "./helpers.js";
async function fixture(){
 const {root,config}=await tempConfig();let db=new DispatcherDatabase(config.databasePath);
 const e=eventEnvelope("progress-orchestration");e.trace={ingress_attempt:1};
 const now=new Date(Math.floor(Date.now()/1000)*1000),key="progress-policy-fixture-key-000000000000";
 const raw=stableStringify({attempt:1,event_id:e.external_event_id,expires_at:new Date(now.getTime()+60000).toISOString().replace(".000Z","Z"),issued_at:now.toISOString().replace(".000Z","Z"),key_id:principalProofKeyId(key),nonce:"progress-policy-fixture-nonce",principal_id:e.subject.actor_id,principal_kind:"human",tenant_id:e.subject.workspace_id,version:2,envelope_sha256:createHash("sha256").update(stableStringify(e)).digest("hex"),workspace_id:e.subject.workspace_id});
 const source=db.enqueue(e,now,verifySlackPrincipalProof(e,Buffer.from(raw).toString("base64url"),createHmac("sha256",key).update(raw).digest("base64url"),key,now)).row;
 const tasks=["first","second"].map(task_key=>db.tasks.create(taskRequestSchema.parse({source_event_id:source.event_id,task_key,objective:"調査する",workspace:{kind:"scratch"}}),config.jobsWorkspaceRoot,config.jobResultsDir).task);
 for(const t of tasks){db.beginJobPreparation(t.current_attempt_id);db.setJobRuntime(t.current_attempt_id,"w","p","runtime");db.beginJobDispatch(t.current_attempt_id);db.markJobRunning(t.current_attempt_id);}
 const report=(index:number,summary:string,at=new Date())=>db.workerMessages.appendWorkerReport(tasks[index]!.current_attempt_id,"runtime",{schema_version:1,source_event_id:source.event_id,producer_sequence:1,idempotency_key:"checkpoint",occurred_at:at.toISOString(),payload:{kind:"checkpoint",summary}},at);
 const eventFor=(messageId:string)=>{const sql=new Database(config.databasePath);try{return (sql.prepare("SELECT event_id FROM worker_message_deliveries WHERE message_id=? AND consumer='dona-main'").get(messageId) as {event_id:string}).event_id;}finally{sql.close();}};
 return {root,config,tasks,source,get db(){return db;},report,eventFor,reopen(){db.close();db=new DispatcherDatabase(config.databasePath);},async dispose(){db.close();await fs.rm(root,{recursive:true,force:true});}};
}
for(const siblingReady of [false,true])test(`集約待ちを再起動後に一度だけ再評価し最新snapshotを使う（sibling=${siblingReady}）`,async()=>{
 const f=await fixture();try{
  const now=new Date(),m=f.report(0,"最初の検証が進みました",now);f.db.workerMessages.publishPendingReports();const event=f.eventFor(m.message.message_id),jobId=f.tasks[0]!.current_attempt_id;
  const candidate=f.db.workerMessages.progressDecisionCandidate(jobId,event,now)!;assert.equal(candidate.decision.action,"aggregate_wait");
  const applied=f.db.applyTaskProgressDecision(f.tasks[0]!.task_id,event,candidate.decision_id);assert.equal(applied.state,"aggregate_wait");
  assert.equal(f.db.workerMessages.publishDueProgressDecisions(32,new Date(now.getTime()+10000)),0);
  if(siblingReady)f.report(1,"並行した検証も進みました",now);
  f.reopen();assert.equal(f.db.workerMessages.publishDueProgressDecisions(32,new Date(now.getTime()+31000)),1);assert.equal(f.db.workerMessages.publishDueProgressDecisions(32,new Date(now.getTime()+32000)),0);
  const sql=new Database(f.config.databasePath);const id=(sql.prepare("SELECT followup_event_id FROM worker_progress_applications WHERE decision_key=?").get(candidate.decision_id) as {followup_event_id:string}).followup_event_id;sql.close();
  const row=f.db.get(id)!;assert.equal(envelopeFromRow(row).type,"worker_message_aggregate");
  const contexts=new AgentContextManager(f.db,path.join(f.root,"aggregate-context.json"));const dispatch=f.db.beginDispatch(id,path.join(f.root,"result.json"));assert.equal((await contexts.issue(dispatch)).purpose,"worker_report");
  f.db.workerMessages.progressDecisionCandidate(jobId,id,new Date(now.getTime()+31000));
  const next=f.db.taskReports(f.tasks[0]!.task_id,id).progress_decision_candidate!;assert.notEqual(next.decision_id,candidate.decision_id);assert.equal(next.decision.action,"report_to_user");
  assert.equal(f.db.taskReports(f.tasks[0]!.task_id,id).event_report?.message_id,m.message.message_id);
  const artifact=f.db.applyTaskProgressDecision(f.tasks[0]!.task_id,id,next.decision_id);assert.equal(artifact.state,"presentation_ready");assert.ok(artifact.artifact);assert.equal(artifact.replayed,false);
  assert.equal(f.db.applyTaskProgressDecision(f.tasks[0]!.task_id,id,next.decision_id).replayed,true);
 }finally{await f.dispose();}
});
test("pause後の集約timerを投稿候補やworker操作へ進めない",async()=>{
 const f=await fixture();try{
  const now=new Date(),m=f.report(0,"確認が進みました",now);f.db.workerMessages.publishPendingReports();const event=f.eventFor(m.message.message_id),t=f.tasks[0]!;
  const c=f.db.workerMessages.progressDecisionCandidate(t.current_attempt_id,event,now)!;f.db.applyTaskProgressDecision(t.task_id,event,c.decision_id);
  f.db.tasks.control(t.task_id,f.source.event_id,f.db.tasks.get(t.task_id)!.revision,"pause");
  assert.equal(f.db.workerMessages.publishDueProgressDecisions(32,new Date(now.getTime()+31000)),0);
  assert.equal(f.db.workerMessages.progressDecisionCandidate(t.current_attempt_id,event)!.eligible_now,false);
 }finally{await f.dispose();}
});

test("無音へのhost生成指示を一度だけ受理し、応答喪失後はreceiptで照合する",async()=>{
 const f=await fixture();try{
  const now=new Date();f.report(0,"確認を続けています",now);f.db.workerMessages.publishPendingReports();
  const due=new Date(now.getTime()+901000);assert.equal(f.db.workerMessages.publishDueSilenceEvents(32,due),1);
  const sql=new Database(f.config.databasePath);const event=(sql.prepare("SELECT event_id FROM events WHERE event_type='worker_message_silence' AND json_extract(payload_json,'$.job_id')=?").get(f.tasks[0]!.current_attempt_id) as {event_id:string}).event_id;sql.close();
  const c=f.db.workerMessages.progressDecisionCandidate(f.tasks[0]!.current_attempt_id,event,due)!;assert.equal(c.decision.action,"ask_worker");
  const accepted=f.db.workerMessages.applyProgressDecision(f.tasks[0]!.current_attempt_id,event,c.decision_id,due);assert.equal(accepted.state,"instruction_pending");
  f.reopen();const replay=f.db.workerMessages.applyProgressDecision(f.tasks[0]!.current_attempt_id,event,c.decision_id,due);assert.equal(replay.replayed,true);assert.equal(replay.receipt_id,accepted.receipt_id);
  const instructions=f.db.workerMessages.instructionReceipts(f.tasks[0]!.current_attempt_id,event).instructions;assert.equal(instructions.length,1);
  const lookup=new Database(f.config.databasePath);try{
   const message=lookup.prepare("SELECT payload_json,source_event_id FROM worker_messages WHERE message_id=?").get(accepted.instruction_message_id) as {payload_json:string;source_event_id:string};
   assert.equal(message.source_event_id,event);assert.match(message.payload_json,/読み取りだけ/);assert.doesNotMatch(message.payload_json,/確認を続けています/);
  }finally{lookup.close();}
 }finally{await f.dispose();}
});

test("適用receipt commit前の失敗で指示もrollbackし、read-only照合で未受理を確認する",async()=>{
 const f=await fixture();try{
  const now=new Date();f.report(0,"確認中です",now);f.db.workerMessages.publishPendingReports();const due=new Date(now.getTime()+901000);f.db.workerMessages.publishDueSilenceEvents(32,due);
  const sql=new Database(f.config.databasePath);const event=(sql.prepare("SELECT event_id FROM events WHERE event_type='worker_message_silence' AND json_extract(payload_json,'$.job_id')=?").get(f.tasks[0]!.current_attempt_id) as {event_id:string}).event_id;
  const c=f.db.workerMessages.progressDecisionCandidate(f.tasks[0]!.current_attempt_id,event,due)!;
  sql.exec("CREATE TRIGGER fixture_fail_policy_receipt BEFORE INSERT ON worker_progress_applications BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END;");
  assert.throws(()=>f.db.workerMessages.applyProgressDecision(f.tasks[0]!.current_attempt_id,event,c.decision_id,due),/fixture receipt failure/);
  assert.equal(f.db.workerMessages.instructionReceipts(f.tasks[0]!.current_attempt_id,event).instructions.length,0);
  assert.equal(f.db.workerMessages.progressDecisionCandidate(f.tasks[0]!.current_attempt_id,event,due)!.applied,false);
  sql.exec("DROP TRIGGER fixture_fail_policy_receipt");sql.close();
 }finally{await f.dispose();}
});


test("未処理aggregate timerの無効化を拒否し、終端後の本文だけをretireする",async()=>{
 const f=await fixture();try{
  const now=new Date(),m=f.report(0,"保管期限のある進捗本文",now);f.db.workerMessages.publishPendingReports();const event=f.eventFor(m.message.message_id),jobId=f.tasks[0]!.current_attempt_id;
  const c=f.db.workerMessages.progressDecisionCandidate(jobId,event,now)!;f.db.applyTaskProgressDecision(f.tasks[0]!.task_id,event,c.decision_id);
  const sql=new Database(f.config.databasePath);
  sql.prepare("UPDATE events SET status='completed',completed_at=?,updated_at=? WHERE event_id=?").run(now.toISOString(),now.toISOString(),event);
  assert.throws(()=>f.db.assertWorkerMessagingMode(false),/disable_requires_drain/);
  const future=new Date(now.getTime()+31*86400000);f.db.workerMessages.purge(future);
  assert.equal((sql.prepare("SELECT decision_json FROM worker_progress_decisions WHERE decision_key=?").get(c.decision_id) as {decision_json:string}).decision_json.includes("payload_retired"),false);
  f.db.saveJobResult(jobId,{schema_version:1,job_id:jobId,status:"completed",summary:"確認しました",completed_at:new Date().toISOString()},f.db.getJob(jobId)!.result_path);
  f.db.workerMessages.purge(future);
  const record=sql.prepare("SELECT decision_json FROM worker_progress_decisions WHERE decision_key=?").get(c.decision_id) as {decision_json:string};
  assert.equal(JSON.parse(record.decision_json).payload_retired,true);assert.equal(JSON.parse(record.decision_json).safe_projection,undefined);
  const receipt=sql.prepare("SELECT result_json,next_check_at FROM worker_progress_applications WHERE decision_key=?").get(c.decision_id) as {result_json:string;next_check_at:string|null};
  assert.equal(JSON.parse(receipt.result_json).receipt_id,`policy_${c.decision_id}`);assert.equal(receipt.next_check_at,null);sql.close();
 }finally{await f.dispose();}
});


test("遅れた古いreportを最新の進捗として再投稿しない",async()=>{
 const f=await fixture();try{
  const now=new Date(),old=f.report(0,"最初の検証を開始しました",now);f.db.workerMessages.publishPendingReports();const event=f.eventFor(old.message.message_id);
  f.db.workerMessages.appendWorkerReport(f.tasks[0]!.current_attempt_id,"runtime",{schema_version:1,source_event_id:f.source.event_id,producer_sequence:2,idempotency_key:"newest",occurred_at:now.toISOString(),payload:{kind:"checkpoint",summary:"最新の検証が進みました"}},now);
  const c=f.db.workerMessages.progressDecisionCandidate(f.tasks[0]!.current_attempt_id,event,now)!;
  assert.equal(c.decision.action,"ack_internal");assert.equal(c.decision.reason,"stale_report");assert.equal(c.decision.safe_projection,undefined);
 }finally{await f.dispose();}
});


for(const order of [[0,1],[1,0]])test(`並行した別質問を各exact jobへ束縛し、順序に依存しない（${order}）`,async()=>{
 const f=await fixture();try{
  const questions=["最初の作業で必要な選択は？","並行作業で必要な選択は？"],messages=new Map<number,string>();
  for(const index of order){const m=f.db.workerMessages.appendWorkerReport(f.tasks[index]!.current_attempt_id,"runtime",{
   schema_version:1,source_event_id:f.source.event_id,producer_sequence:1,idempotency_key:"question",occurred_at:new Date().toISOString(),payload:{kind:"question",question:questions[index]!}});messages.set(index,m.message.message_id);}
  f.db.workerMessages.publishPendingReports();
  for(const index of order){const task=f.tasks[index]!,event=f.eventFor(messages.get(index)!);
   const c=f.db.workerMessages.progressDecisionCandidate(task.current_attempt_id,event)!;assert.equal(c.decision.action,"ask_user");assert.equal(c.decision.safe_projection?.question,questions[index]);
   const a=f.db.applyTaskProgressDecision(task.task_id,event,c.decision_id),artifact=a.artifact as {reply_broadcast:boolean;safe_projection:{question:string}};
   assert.equal(artifact.reply_broadcast,false);assert.equal(artifact.safe_projection.question,questions[index]);
   assert.equal(f.db.workerMessages.progressDecisionCandidate(f.tasks[1-index]!.current_attempt_id,event),undefined);
   assert.throws(()=>f.db.applyTaskProgressDecision(task.task_id,event,"f".repeat(64)),/progress_decision_not_current/);
  }
  f.reopen();for(const index of order){const t=f.tasks[index]!,event=f.eventFor(messages.get(index)!);assert.ok(f.db.taskReports(t.task_id,event).progress_decision_candidate!.application_receipt);}
 }finally{await f.dispose();}
});

test("後続checkpointで未回答質問を失わず、保存済みanswerへ一度だけリンクする",async()=>{
 const f=await fixture();try{
  const t=f.tasks[0]!,q=f.db.workerMessages.appendWorkerReport(t.current_attempt_id,"runtime",{schema_version:1,source_event_id:f.source.event_id,producer_sequence:1,idempotency_key:"question",occurred_at:new Date().toISOString(),payload:{kind:"question",question:"元の範囲で継続できますか？"}});
  f.db.workerMessages.publishPendingReports();const event=f.eventFor(q.message.message_id);
  f.db.workerMessages.appendWorkerReport(t.current_attempt_id,"runtime",{schema_version:1,source_event_id:f.source.event_id,producer_sequence:2,idempotency_key:"waiting",occurred_at:new Date().toISOString(),payload:{kind:"checkpoint",summary:"回答を待っています"}});
  const c=f.db.workerMessages.progressDecisionCandidate(t.current_attempt_id,event)!;assert.equal(c.decision.action,"ask_user");
  const answer=f.db.instructTask(t.task_id,f.db.tasks.get(t.task_id)!.revision,{schema_version:1,source_event_id:event,producer_sequence:1,idempotency_key:"answer",occurred_at:new Date().toISOString(),correlation_message_id:q.message.message_id,conversation_revision:1,payload:{operation:"answer",text:"元の依頼範囲で継続してください"}});
  const applied=f.db.applyTaskProgressDecision(t.task_id,event,c.decision_id);assert.equal(applied.state,"instruction_pending");assert.equal(applied.instruction_message_id,answer.message.message_id);
  assert.equal(f.db.applyTaskProgressDecision(t.task_id,event,c.decision_id).replayed,true);assert.equal(f.db.workerMessages.instructionReceipts(t.current_attempt_id,event).instructions.length,1);
 }finally{await f.dispose();}
});

test("別threadのeventとDB読取不能ではdecisionを作らずfail closedする",async()=>{
 const f=await fixture();try{
  const m=f.report(0,"確認が進みました");f.db.workerMessages.publishPendingReports();const event=f.eventFor(m.message.message_id),t=f.tasks[0]!;
  const other=eventEnvelope("other-thread");other.subject.thread_ts="999.000001";const foreign=f.db.enqueue(other).row;
  assert.equal(f.db.workerMessages.progressDecisionCandidate(t.current_attempt_id,foreign.event_id),undefined);
  assert.equal(f.db.taskReports(t.task_id,foreign.event_id).progress_decision_candidate,undefined);
  assert.throws(()=>f.db.applyTaskProgressDecision(t.task_id,foreign.event_id,"f".repeat(64)),/progress_decision_not_current/);
  const sql=new Database(f.config.databasePath);sql.exec("ALTER TABLE worker_progress_decisions RENAME TO fixture_unavailable_decisions");
  assert.throws(()=>f.db.workerMessages.progressDecisionCandidate(t.current_attempt_id,event),/no such table/);
  sql.exec("ALTER TABLE fixture_unavailable_decisions RENAME TO worker_progress_decisions");sql.close();
  assert.equal(f.db.workerMessages.progressDecisionCandidate(t.current_attempt_id,event)!.replayed,false);
 }finally{await f.dispose();}
});

test("同じsnapshotで先に作った並行candidateも適用時にgroup予約へ収束する",async()=>{
 const f=await fixture();try{
  const now=new Date(),a=f.report(0,"検証Aが進みました",now),b=f.report(1,"検証Bが進みました",now);f.db.workerMessages.publishPendingReports();f.db.workerMessages.publishPendingReports(100,new Date(now.getTime()+61000));
  const candidates=[a,b].map((m,i)=>f.db.workerMessages.progressDecisionCandidate(f.tasks[i]!.current_attempt_id,f.eventFor(m.message.message_id),now)!);
  assert.ok(candidates.every(c=>c.decision.action==="report_to_user"));
  const first=f.db.applyTaskProgressDecision(f.tasks[0]!.task_id,f.eventFor(a.message.message_id),candidates[0]!.decision_id);
  const second=f.db.applyTaskProgressDecision(f.tasks[1]!.task_id,f.eventFor(b.message.message_id),candidates[1]!.decision_id);
  assert.equal(first.state,"presentation_ready");assert.equal(second.state,"presentation_duplicate");assert.equal(second.artifact,undefined);
 }finally{await f.dispose();}
});

test("high riskの後続checkpointが先に届いても未提示riskを失わない",async()=>{
 const f=await fixture();try{
  const t=f.tasks[0]!,m=f.db.workerMessages.appendWorkerReport(t.current_attempt_id,"runtime",{schema_version:1,source_event_id:f.source.event_id,producer_sequence:1,idempotency_key:"risk",occurred_at:new Date().toISOString(),payload:{kind:"risk",severity:"high",summary:"重要な確認が必要です"}});
  f.db.workerMessages.publishPendingReports();const event=f.eventFor(m.message.message_id);
  f.db.workerMessages.appendWorkerReport(t.current_attempt_id,"runtime",{schema_version:1,source_event_id:f.source.event_id,producer_sequence:2,idempotency_key:"checkpoint",occurred_at:new Date().toISOString(),payload:{kind:"checkpoint",summary:"別の検証が進みました"}});
  const c=f.db.workerMessages.progressDecisionCandidate(t.current_attempt_id,event)!;assert.equal(c.decision.action,"report_to_user");assert.equal(c.decision.signals.risk_escalation,true);
  assert.equal(f.db.applyTaskProgressDecision(t.task_id,event,c.decision_id).state,"presentation_ready");
 }finally{await f.dispose();}
});

test("未来のworker時刻でもserver受付から30秒で集約を進める",async()=>{
 const f=await fixture();try{
  const now=new Date(),t=f.tasks[0]!,m=f.db.workerMessages.appendWorkerReport(t.current_attempt_id,"runtime",{schema_version:1,source_event_id:f.source.event_id,producer_sequence:1,idempotency_key:"future",occurred_at:new Date(now.getTime()+86400000).toISOString(),payload:{kind:"checkpoint",summary:"検証が進みました"}},now);
  f.db.workerMessages.publishPendingReports(100,now);const event=f.eventFor(m.message.message_id),c=f.db.workerMessages.progressDecisionCandidate(t.current_attempt_id,event,now)!;
  assert.equal(c.decision.action,"aggregate_wait");f.db.workerMessages.applyProgressDecision(t.current_attempt_id,event,c.decision_id,now);
  const due=new Date(now.getTime()+31000);assert.equal(f.db.workerMessages.publishDueProgressDecisions(32,due),1);
  const sql=new Database(f.config.databasePath),next=(sql.prepare("SELECT followup_event_id FROM worker_progress_applications WHERE decision_key=?").get(c.decision_id) as {followup_event_id:string}).followup_event_id;sql.close();
  assert.equal(f.db.workerMessages.progressDecisionCandidate(t.current_attempt_id,next,due)!.decision.action,"report_to_user");
 }finally{await f.dispose();}
});


test("未配送presentation待ちのtimerを未来へ戻し、取得枠を占有し続けない",async()=>{
 const f=await fixture();try{
  const now=new Date(),a=f.report(0,"検証Aが進みました",now);f.report(1,"検証Bが進みました",now);f.db.workerMessages.publishPendingReports();
  const event=f.eventFor(a.message.message_id),t=f.tasks[0]!,c=f.db.workerMessages.progressDecisionCandidate(t.current_attempt_id,event,now)!;
  assert.equal(f.db.workerMessages.applyProgressDecision(t.current_attempt_id,event,c.decision_id,now).state,"presentation_ready");
  const later=new Date(now.getTime()+61000),b=f.db.workerMessages.appendWorkerReport(t.current_attempt_id,"runtime",{schema_version:1,source_event_id:f.source.event_id,producer_sequence:2,idempotency_key:"later",occurred_at:later.toISOString(),payload:{kind:"checkpoint",summary:"次の検証も進みました"}},later);
  f.db.workerMessages.publishPendingReports(100,later);const current=new Date(later.getTime()+61000);f.db.workerMessages.publishPendingReports(100,current);const next=f.eventFor(b.message.message_id),waiting=f.db.workerMessages.progressDecisionCandidate(t.current_attempt_id,next,current)!;
  assert.equal(waiting.decision.action,"aggregate_wait");f.db.workerMessages.applyProgressDecision(t.current_attempt_id,next,waiting.decision_id,current);
  const due=new Date(current.getTime()+31000);assert.equal(f.db.workerMessages.publishDueProgressDecisions(1,due),0);
  const sql=new Database(f.config.databasePath),record=sql.prepare("SELECT next_check_at,followup_event_id FROM worker_progress_applications WHERE decision_key=?").get(waiting.decision_id) as {next_check_at:string;followup_event_id:string|null};sql.close();
  assert.ok(Date.parse(record.next_check_at)>due.getTime());assert.equal(record.followup_event_id,null);assert.equal(f.db.workerMessages.publishDueProgressDecisions(1,due),0);
 }finally{await f.dispose();}
});
