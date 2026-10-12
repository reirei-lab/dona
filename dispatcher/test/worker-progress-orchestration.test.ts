import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {createHash,createHmac} from "node:crypto";
import {test} from "node:test";
import {DispatcherWorker} from "../src/worker.js";
import Database from "better-sqlite3";
import {DispatcherDatabase} from "../src/database.js";
import {taskRequestSchema} from "../src/task-execution.js";
import {principalProofKeyId,verifySlackPrincipalProof} from "../src/principal-proof.js";
import {stableStringify} from "../src/validation.js";
import {AgentContextManager} from "../src/agent-context.js";
import {envelopeFromRow} from "../src/prompt.js";
import {eventEnvelope,tempConfig,waitFor} from "./helpers.js";
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
  const now=new Date(),a=f.report(0,"検証Aが進みました",now);f.report(1,"検証Bが進みました",now);f.db.workerMessages.publishPendingReports();f.db.workerMessages.publishPendingReports(100,new Date(now.getTime()+61000));
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


test("未適用の質問candidateはsnapshot変更後にwrite準備で新しいidentityへ更新する",async()=>{
 const f=await fixture();try{
  const t=f.tasks[0]!,q=f.db.workerMessages.appendWorkerReport(t.current_attempt_id,"runtime",{schema_version:1,source_event_id:f.source.event_id,producer_sequence:1,idempotency_key:"refresh-question",occurred_at:new Date().toISOString(),payload:{kind:"question",question:"どの方式にしますか？"}});
  f.db.workerMessages.publishPendingReports();const event=f.eventFor(q.message.message_id),old=f.db.prepareTaskProgressDecision(t.task_id,event)!;
  f.report(1,"siblingの検証が進みました");assert.equal(f.db.taskReports(t.task_id,event).progress_decision_candidate!.eligible_now,false);
  const fresh=f.db.prepareTaskProgressDecision(t.task_id,event)!;assert.notEqual(fresh.decision_id,old.decision_id);assert.equal(fresh.decision.action,"ask_user");
  assert.throws(()=>f.db.applyTaskProgressDecision(t.task_id,event,old.decision_id),/not_current/);
  assert.equal(f.db.applyTaskProgressDecision(t.task_id,event,fresh.decision_id).state,"presentation_ready");
  f.reopen();assert.equal(f.db.taskReports(t.task_id,event).progress_decision_candidate!.application_receipt.receipt_id,`policy_${fresh.decision_id}`);
 }finally{await f.dispose();}
});

for(const tool of ["dona_slack.post_message","mcp__dona_slack__post_message"])test(`providerの宛先・本文・identity receiptを確認した時だけ予約を解放する（${tool}）`,async()=>{
 const f=await fixture();try{
  const now=new Date(),m=f.report(0,"検証が進みました",now);f.report(1,"並行検証が進みました",now);f.db.workerMessages.publishPendingReports();f.db.workerMessages.publishPendingReports(100,new Date(now.getTime()+61000));
  const event=f.eventFor(m.message.message_id),t=f.tasks[0]!,c=f.db.prepareTaskProgressDecision(t.task_id,event)!;
  const a=f.db.applyTaskProgressDecision(t.task_id,event,c.decision_id),artifact=a.artifact as {rendered_body:string;destination:{workspace_id:string;channel_id:string;thread_ts:string}};
  assert.ok(artifact.rendered_body);const ts=(Date.now()/1000).toFixed(6),result={schema_version:1 as const,event_id:event,status:"completed" as const,summary:"報告しました",completed_at:new Date().toISOString(),actions:[{tool,event_id:event,workspace_id:artifact.destination.workspace_id,channel_id:artifact.destination.channel_id,thread_ts:artifact.destination.thread_ts,message_ts:ts,reply_broadcast:false,mrkdwn:true,parse:"none"}]};
  const request=f.db.workerMessages.presentationVerificationRequest(event,result)!;
  const evidence={event_id:event,workspace_id:request.workspace_id,channel_id:request.channel_id,thread_ts:request.thread_ts,message_ts:ts,body_sha256:request.body_sha256,posted_at:new Date(Number(ts)*1000).toISOString(),reply_broadcast:false as const,identity_block_verified:true,session_status:null};
  assert.throws(()=>f.db.workerMessages.confirmPresentation(event,request,{...evidence,channel_id:"COTHER"}),/receipt_mismatch/);
  assert.equal(f.db.taskReports(t.task_id,event).progress_decision_candidate!.application_receipt.state,"presentation_ready");
  f.db.workerMessages.confirmPresentation(event,request,evidence);f.db.workerMessages.confirmPresentation(event,request,evidence);f.reopen();
  assert.equal(f.db.taskReports(t.task_id,event).progress_decision_candidate!.application_receipt.state,"presentation_delivered");
  const sql=new Database(f.config.databasePath);assert.equal((sql.prepare("SELECT COUNT(*) count FROM worker_progress_applications WHERE json_extract(result_json,'$.state')='presentation_ready'").get() as {count:number}).count,0);sql.close();
 }finally{await f.dispose();}
});


for(const tool of ["dona_slack.post_message","mcp__dona_slack__post_message"])for(const verified of [true,false,"missing"] as const)test(`親Resultの投稿actionをread-only verifierで照合する（成功=${verified}, tool=${tool}）`,async()=>{
 const f=await fixture();let worker:DispatcherWorker|undefined;try{
  f.config.workerMessagingEnabled=true;const now=new Date(),m=f.report(0,"検証が進みました",now);f.report(1,"並行検証が進みました",now);f.db.workerMessages.publishPendingReports();f.db.workerMessages.publishPendingReports(100,new Date(now.getTime()+61000));
  const event=f.eventFor(m.message.message_id),t=f.tasks[0]!,c=f.db.prepareTaskProgressDecision(t.task_id,event)!;
  const a=f.db.applyTaskProgressDecision(t.task_id,event,c.decision_id),artifact=a.artifact as {destination:{workspace_id:string;channel_id:string;thread_ts:string}};
  const resultPath=path.join(f.root,"parent-progress-result.json");f.db.beginDispatch(event,resultPath);f.db.markWaiting(event);
  const ts=(Date.now()/1000).toFixed(6);await fs.writeFile(resultPath,JSON.stringify({schema_version:1,event_id:event,status:"completed",summary:"進捗を報告しました",completed_at:new Date().toISOString(),actions:verified==="missing"?[]:[{tool,event_id:event,workspace_id:artifact.destination.workspace_id,channel_id:artifact.destination.channel_id,thread_ts:artifact.destination.thread_ts,message_ts:ts,reply_broadcast:false,mrkdwn:true,parse:"none"}]}));
  let calls=0;const never=async()=>{throw Error("model再投入・session変更をしてはいけない");};
  worker=new DispatcherWorker(f.db,{get:never,prompt:never,wait:never},f.config,{debug(){},info(){},warn(){},error(){}},{settle:never,async verify(request){calls++;worker!.quiesceAfterCurrent();if(verified!==true)throw Error("job_delivery_not_confirmed");return {event_id:request.event_id,workspace_id:request.workspace_id,channel_id:request.channel_id,thread_ts:request.thread_ts,message_ts:ts,body_sha256:request.body_sha256,posted_at:new Date(Number(ts)*1000).toISOString(),reply_broadcast:false,identity_block_verified:true,session_status:null};}});
  worker.start();await waitFor(()=>f.db.get(event)?.status===(verified===true?"completed":"needs_review"));await worker.stop();
  assert.equal(calls,verified==="missing"?0:1);const sql=new Database(f.config.databasePath),state=JSON.parse((sql.prepare("SELECT result_json FROM worker_progress_applications WHERE decision_key=?").get(c.decision_id) as {result_json:string}).result_json).state;sql.close();assert.equal(state,verified===true?"presentation_delivered":"presentation_ready");
 }finally{await worker?.stop();await f.dispose();}
});

test("別siblingのcheckpointで予約したhigh riskは自身のeventでも重複しない",async()=>{
 const f=await fixture();try{
  const now=new Date(),a=f.report(0,"検証が進みました",now),b=f.db.workerMessages.appendWorkerReport(f.tasks[1]!.current_attempt_id,"runtime",{schema_version:1,source_event_id:f.source.event_id,producer_sequence:1,idempotency_key:"risk",occurred_at:now.toISOString(),payload:{kind:"risk",severity:"high",summary:"重要な確認が必要です"}},now);
  f.db.workerMessages.publishPendingReports();f.db.workerMessages.publishPendingReports(100,new Date(now.getTime()+61000));
  const ea=f.eventFor(a.message.message_id),eb=f.eventFor(b.message.message_id),ca=f.db.prepareTaskProgressDecision(f.tasks[0]!.task_id,ea)!;
  const first=f.db.applyTaskProgressDecision(f.tasks[0]!.task_id,ea,ca.decision_id);assert.equal(first.state,"presentation_ready");
  const artifact=first.artifact as {rendered_body_sha256:string;destination:{workspace_id:string;channel_id:string;thread_ts:string}},ts=(Date.now()/1000-120).toFixed(6);
  const parentResult={schema_version:1 as const,event_id:ea,status:"completed" as const,summary:"報告しました",completed_at:now.toISOString(),actions:[{tool:"dona_slack.post_message",event_id:ea,...artifact.destination,message_ts:ts,reply_broadcast:false,mrkdwn:true,parse:"none"}]};
  const request=f.db.workerMessages.presentationVerificationRequest(ea,parentResult)!;
  f.db.workerMessages.confirmPresentation(ea,request,{event_id:ea,workspace_id:request.workspace_id,channel_id:request.channel_id,thread_ts:request.thread_ts,message_ts:ts,body_sha256:request.body_sha256,posted_at:new Date(Number(ts)*1000).toISOString(),reply_broadcast:false,identity_block_verified:true,session_status:null});
  f.db.workerMessages.appendWorkerReport(f.tasks[0]!.current_attempt_id,"runtime",{schema_version:1,source_event_id:f.source.event_id,producer_sequence:2,idempotency_key:"later-checkpoint",occurred_at:now.toISOString(),payload:{kind:"checkpoint",summary:"追加の検証が進みました"}},now);
  const cb=f.db.prepareTaskProgressDecision(f.tasks[1]!.task_id,eb)!;
  assert.equal(cb.decision.action,"report_to_user");assert.notEqual(cb.decision.observed?.group_fingerprint,ca.decision.observed?.group_fingerprint);
  const result=f.db.applyTaskProgressDecision(f.tasks[1]!.task_id,eb,cb.decision_id);assert.equal(result.state,"presentation_duplicate");assert.equal(result.artifact,undefined);
 }finally{await f.dispose();}
});

test('最新checkpointとgroup fingerprintが同じでも未提示high riskを失わない',async()=>{
 const f=await fixture();try{
  const now=new Date(),t=f.tasks[0]!,risk=f.db.workerMessages.appendWorkerReport(t.current_attempt_id,'runtime',{schema_version:1,source_event_id:f.source.event_id,producer_sequence:1,idempotency_key:'risk',occurred_at:now.toISOString(),payload:{kind:'risk',severity:'high',summary:'未提示の重要な確認です'}},now);
  const cp=f.db.workerMessages.appendWorkerReport(t.current_attempt_id,'runtime',{schema_version:1,source_event_id:f.source.event_id,producer_sequence:2,idempotency_key:'checkpoint',occurred_at:now.toISOString(),payload:{kind:'checkpoint',summary:'別の検証が進みました'}},now);f.report(1,'並行検証が進みました',now);
  f.db.workerMessages.publishPendingReports();f.db.workerMessages.publishPendingReports(100,new Date(now.getTime()+121000));
  const ec=f.eventFor(cp.message.message_id),er=f.eventFor(risk.message.message_id),cc=f.db.prepareTaskProgressDecision(t.task_id,ec)!;assert.equal(cc.decision.action,'report_to_user');assert.deepEqual(cc.decision.observed?.high_risk_message_ids,[]);
  assert.equal(f.db.applyTaskProgressDecision(t.task_id,ec,cc.decision_id).state,'presentation_ready');
  const cr=f.db.prepareTaskProgressDecision(t.task_id,er)!;assert.equal(cr.decision.observed?.group_fingerprint,cc.decision.observed?.group_fingerprint);assert.equal(cr.decision.action,'report_to_user');
  const applied=f.db.applyTaskProgressDecision(t.task_id,er,cr.decision_id);assert.equal(applied.state,'presentation_ready');assert.ok(JSON.stringify(applied.artifact).includes('未提示の重要な確認です'));
 }finally{await f.dispose();}
});

for(const kind of ['question','decision_request','risk'] as const)test(`steer終了後に元の重要報告をdurable timerで再評価する（${kind}）`,async()=>{
 const f=await fixture();const sql=new Database(f.config.databasePath);try{
  const now=new Date(),t=f.tasks[0]!,payload=kind==='risk'?{kind,severity:'high' as const,summary:'重要な確認です'}:kind==='decision_request'?{kind,question:'方式を選んでください',options:['方式A','方式B']}:{kind,question:'続行できますか？'};
  sql.prepare('UPDATE tasks SET steer_pending_event_id=? WHERE task_id=?').run(f.source.event_id,t.task_id);
  const m=f.db.workerMessages.appendWorkerReport(t.current_attempt_id,'runtime',{schema_version:1,source_event_id:f.source.event_id,producer_sequence:1,idempotency_key:'important',occurred_at:now.toISOString(),payload},now);f.db.workerMessages.publishPendingReports();const event=f.eventFor(m.message.message_id),c=f.db.prepareTaskProgressDecision(t.task_id,event)!;
  assert.equal(c.decision.action,'aggregate_wait');assert.equal(f.db.applyTaskProgressDecision(t.task_id,event,c.decision_id).state,'aggregate_wait');
  assert.equal(f.db.workerMessages.publishDueProgressDecisions(32,new Date(now.getTime()+31000)),0);
  f.db.workerMessages.appendWorkerReport(t.current_attempt_id,'runtime',{schema_version:1,source_event_id:f.source.event_id,producer_sequence:2,idempotency_key:'later',occurred_at:now.toISOString(),payload:{kind:'checkpoint',summary:'別の検証が進みました'}},now);
  sql.prepare('UPDATE tasks SET steer_pending_event_id=NULL WHERE task_id=?').run(t.task_id);f.reopen();
  assert.equal(f.db.workerMessages.publishDueProgressDecisions(32,new Date(now.getTime()+62000)),1);
  const follow=(sql.prepare('SELECT followup_event_id FROM worker_progress_applications WHERE decision_key=?').get(c.decision_id) as {followup_event_id:string}).followup_event_id;
  const fresh=f.db.prepareTaskProgressDecision(t.task_id,follow)!;assert.equal(fresh.decision.target?.message_id,m.message.message_id);assert.equal(fresh.decision.action,kind==='risk'?'report_to_user':'ask_user');
  if(kind!=='risk'){
   const answer={schema_version:1,source_event_id:follow,producer_sequence:1,idempotency_key:'aggregate-answer',occurred_at:new Date().toISOString(),correlation_message_id:m.message.message_id,conversation_revision:1,payload:{operation:'answer',text:'既存の範囲で続行してください'}};
   assert.throws(()=>f.db.workerMessages.appendInstruction(f.tasks[1]!.current_attempt_id,answer),{code:"worker_message_instruction_source_invalid"});
   assert.equal(f.db.workerMessages.appendInstruction(t.current_attempt_id,answer).outcome,'created');
  }
 }finally{sql.close();await f.dispose();}
});

test('期限timer検索が履歴全体ではなくpartial indexを使用する',async()=>{
 const f=await fixture(),sql=new Database(f.config.databasePath);try{
  void f.db.workerMessages;
  const plan=sql.prepare('EXPLAIN QUERY PLAN SELECT a.decision_key,p.job_id,p.decision_json FROM worker_progress_applications a JOIN worker_progress_decisions p USING(decision_key) WHERE a.next_check_at<=? AND a.followup_event_id IS NULL ORDER BY a.next_check_at,a.decision_key LIMIT ?').all(new Date().toISOString(),32);
  assert.ok(JSON.stringify(plan).includes('worker_progress_applications_due_idx'));assert.ok(!JSON.stringify(plan).includes('USE TEMP B-TREE'));
 }finally{sql.close();await f.dispose();}
});

for(const severity of ['medium','high'] as const)test(`risk→checkpoint→同じmediumのpipelineで基準を保つ（${severity}）`,async()=>{
 const f=await fixture();try{
  const t=f.tasks[0]!,now=new Date(),first=f.db.workerMessages.appendWorkerReport(t.current_attempt_id,'runtime',{schema_version:1,source_event_id:f.source.event_id,producer_sequence:1,idempotency_key:'first-risk',occurred_at:now.toISOString(),payload:{kind:'risk',severity,summary:'確認事項があります'}},now);f.db.workerMessages.publishPendingReports();f.report(1,'並行検証が進みました',now);
  const e=f.eventFor(first.message.message_id),c=f.db.prepareTaskProgressDecision(t.task_id,e)!;f.db.applyTaskProgressDecision(t.task_id,e,c.decision_id);
  const cp=f.db.workerMessages.appendWorkerReport(t.current_attempt_id,'runtime',{schema_version:1,source_event_id:f.source.event_id,producer_sequence:2,idempotency_key:'checkpoint',occurred_at:now.toISOString(),payload:{kind:'checkpoint',summary:'検証が進みました'}},now);f.db.workerMessages.publishPendingReports(100,new Date(now.getTime()+121000));f.db.workerMessages.publishPendingReports(100,new Date(now.getTime()+182000));
  const ec=f.eventFor(cp.message.message_id),cc=f.db.prepareTaskProgressDecision(t.task_id,ec)!;f.db.applyTaskProgressDecision(t.task_id,ec,cc.decision_id);
  const medium=f.db.workerMessages.appendWorkerReport(t.current_attempt_id,'runtime',{schema_version:1,source_event_id:f.source.event_id,producer_sequence:3,idempotency_key:'medium',occurred_at:now.toISOString(),payload:{kind:'risk',severity:'medium',summary:'同じ確認事項があります'}},now);f.db.workerMessages.publishPendingReports(100,new Date(now.getTime()+302000));
  const cm=f.db.prepareTaskProgressDecision(t.task_id,f.eventFor(medium.message.message_id))!;assert.equal(cm.decision.signals.risk_escalation,false);assert.equal(cm.decision.action,'aggregate_wait');
 }finally{await f.dispose();}
});

test('checkpointに含まれる新しいsibling high riskを同じgroup fingerprintでも提示する',async()=>{
 const f=await fixture();try{
  const now=new Date(),t=f.tasks[0]!,a=f.report(0,'検証が進みました',now),riskInput={schema_version:1,source_event_id:f.source.event_id,producer_sequence:1,idempotency_key:'risk-one',occurred_at:now.toISOString(),payload:{kind:'risk' as const,severity:'high' as const,summary:'重要な確認です'}};
  f.db.workerMessages.publishPendingReports();f.db.workerMessages.appendWorkerReport(f.tasks[1]!.current_attempt_id,'runtime',riskInput,now);
  const ea=f.eventFor(a.message.message_id),ca=f.db.prepareTaskProgressDecision(t.task_id,ea)!;assert.equal(f.db.applyTaskProgressDecision(t.task_id,ea,ca.decision_id).state,'presentation_ready');
  const newer=f.db.workerMessages.appendWorkerReport(f.tasks[1]!.current_attempt_id,'runtime',{...riskInput,producer_sequence:2,idempotency_key:'risk-two',payload:{...riskInput.payload,summary:'重要な確認です '}},now),cp=f.db.workerMessages.appendWorkerReport(t.current_attempt_id,'runtime',{schema_version:1,source_event_id:f.source.event_id,producer_sequence:2,idempotency_key:'checkpoint-two',occurred_at:now.toISOString(),payload:{kind:'checkpoint',summary:'検証が進みました '}},now);f.db.workerMessages.publishPendingReports(100,new Date(now.getTime()+301000));f.db.workerMessages.publishPendingReports(100,new Date(now.getTime()+362000));
  const ec=f.eventFor(cp.message.message_id),cc=f.db.prepareTaskProgressDecision(t.task_id,ec)!;assert.equal(cc.decision.observed?.group_fingerprint,ca.decision.observed?.group_fingerprint);assert.equal(cc.decision.signals.risk_escalation,true);assert.ok(cc.decision.observed?.high_risk_message_ids?.includes(newer.message.message_id));
  assert.equal(f.db.applyTaskProgressDecision(t.task_id,ec,cc.decision_id).state,'presentation_ready');
 }finally{await f.dispose();}
});

for(const stage of ["preflight","prompt"] as const)test(`集約eventの${stage}確定失敗を再起動後に新eventで再評価する`,async()=>{
 const f=await fixture();try{
  const now=new Date(),m=f.report(0,"確認が進みました",now);f.db.workerMessages.publishPendingReports();const event=f.eventFor(m.message.message_id),t=f.tasks[0]!;
  const c=f.db.workerMessages.progressDecisionCandidate(t.current_attempt_id,event,now)!;f.db.applyTaskProgressDecision(t.task_id,event,c.decision_id);
  f.db.workerMessages.publishDueProgressDecisions(32,new Date(now.getTime()+31000));
  const read=()=>{const sql=new Database(f.config.databasePath);try{return sql.prepare("SELECT followup_event_id,next_check_at FROM worker_progress_applications WHERE decision_key=?").get(c.decision_id) as {followup_event_id:string|null;next_check_at:string|null};}finally{sql.close();}};
  const first=read().followup_event_id!;
  if(stage==="preflight")f.db.recordPreDispatchFailure(first,"unavailable","確定未送信",1,new Date(now.getTime()+32000));
  else{f.db.beginDispatch(first,path.join(f.root,"aggregate-failed.json"));f.db.recordSafePromptFailure(first,"not_sent","確定未送信",1,new Date(now.getTime()+32000));}
  assert.equal(f.db.get(first)?.status,"dead_letter");assert.equal(read().followup_event_id,null);assert.ok(read().next_check_at);
  f.reopen();assert.equal(f.db.workerMessages.publishDueProgressDecisions(32,new Date(now.getTime()+120000)),1);
  const next=read().followup_event_id!;assert.notEqual(next,first);assert.equal(f.db.get(first)?.status,"dead_letter");
  assert.equal(JSON.parse(f.db.get(next)!.payload_json).message_id,m.message.message_id);
  assert.equal(f.db.workerMessages.ownsProgressAggregateEvent(t.current_attempt_id,next),true);
  assert.ok(f.db.workerMessages.progressDecisionCandidate(t.current_attempt_id,next,new Date(now.getTime()+120000)));
  assert.equal(f.db.workerMessages.ownsProgressAggregateEvent(t.current_attempt_id,first),false);
  assert.equal(f.db.workerMessages.publishDueProgressDecisions(32,new Date(now.getTime()+121000)),0);
 }finally{await f.dispose();}
});

test("最大長decision_requestの質問と全選択肢を欠落なく描画する",async()=>{
 const f=await fixture();try{
  const t=f.tasks[0]!,question="Q".repeat(4000),options=Array.from({length:8},(_,i)=>String(i+1).repeat(1000));
  const m=f.db.workerMessages.appendWorkerReport(t.current_attempt_id,"runtime",{schema_version:1,source_event_id:f.source.event_id,producer_sequence:1,idempotency_key:"maximum-question",occurred_at:new Date().toISOString(),payload:{kind:"decision_request",question,options}});
  f.db.workerMessages.publishPendingReports();const event=f.eventFor(m.message.message_id),candidate=f.db.prepareTaskProgressDecision(t.task_id,event)!;
  assert.equal(candidate.decision.action,"ask_user");
  const applied=f.db.applyTaskProgressDecision(t.task_id,event,candidate.decision_id),artifact=applied.artifact as {rendered_body:string};
  assert.equal(artifact.rendered_body,[question,...options.map(option=>`- ${option}`)].join("\n"));assert.equal(artifact.rendered_body.length,12024);
 }finally{await f.dispose();}
});

for(const outcome of ["suspended","unchanged","failure"] as const)test(`質問投稿とsession suspendedを一体で確定する（${outcome}）`,async()=>{
 const f=await fixture();let worker:DispatcherWorker|undefined;try{
  f.config.workerMessagingEnabled=true;const t=f.tasks[0]!;
  const message=f.db.workerMessages.appendWorkerReport(t.current_attempt_id,"runtime",{schema_version:1,source_event_id:f.source.event_id,producer_sequence:1,idempotency_key:"ask-session",occurred_at:new Date().toISOString(),payload:{kind:"question",question:"続行できますか？"}});f.db.workerMessages.publishPendingReports();
  const event=f.eventFor(message.message.message_id),candidate=f.db.prepareTaskProgressDecision(t.task_id,event)!;
  const applied=f.db.applyTaskProgressDecision(t.task_id,event,candidate.decision_id),artifact=applied.artifact as {desired_session_status:string;destination:{workspace_id:string;channel_id:string;thread_ts:string}};
  assert.equal(artifact.desired_session_status,"suspended");
  const resultPath=path.join(f.root,"question-result.json"),ts=(Date.now()/1000).toFixed(6);f.db.beginDispatch(event,resultPath);f.db.markWaiting(event);
  await fs.writeFile(resultPath,JSON.stringify({schema_version:1,event_id:event,status:"completed",summary:"質問しました",completed_at:new Date().toISOString(),actions:[{tool:"dona_slack.post_message",event_id:event,...artifact.destination,message_ts:ts,reply_broadcast:false,mrkdwn:true,parse:"none"}]}));
  let calls=0;const never=async()=>{throw Error("再投入・read-only verifyは使用しない");};
  worker=new DispatcherWorker(f.db,{get:never,prompt:never,wait:never},f.config,{debug(){},info(){},warn(){},error(){}},{verify:never,async settle(request){calls++;worker!.quiesceAfterCurrent();assert.equal(request.desired_session_status,"suspended");if(outcome==="failure")throw Error("job_delivery_session_not_settled");return {event_id:event,workspace_id:request.workspace_id,channel_id:request.channel_id,thread_ts:request.thread_ts,message_ts:ts,body_sha256:request.body_sha256,posted_at:new Date(Number(ts)*1000).toISOString(),reply_broadcast:false,identity_block_verified:true,session_status:outcome==="suspended"?"suspended":null};}});
  worker.start();await waitFor(()=>f.db.get(event)?.status===(outcome==="suspended"?"completed":"needs_review"));await worker.stop();assert.equal(calls,1);
  assert.equal(f.db.taskReports(t.task_id,event).progress_decision_candidate!.application_receipt.state,outcome==="suspended"?"presentation_delivered":"presentation_ready");
 }finally{await worker?.stop();await f.dispose();}
});


test("ETAなしのcheckpointを挟んでも同じAttemptの最後のETAを比較する",async()=>{
 const f=await fixture();try{
  const t=f.tasks[0]!,now=new Date();
  for(const [index,summary] of ["見込み 30 分","検証を継続しています","見込み 60 分"].entries()){
   const at=new Date(now.getTime()+index*61000);
   const m=f.db.workerMessages.appendWorkerReport(t.current_attempt_id,"runtime",{schema_version:1,source_event_id:f.source.event_id,producer_sequence:index+1,idempotency_key:`eta-${index}`,occurred_at:at.toISOString(),payload:{kind:"checkpoint",summary}},at);
   f.db.workerMessages.publishPendingReports(100,at);const event=f.eventFor(m.message.message_id);
   const candidate=f.db.workerMessages.progressDecisionCandidate(t.current_attempt_id,event,at)!;
   if(index===2){assert.equal(candidate.decision.signals.eta_changed,true);assert.equal(candidate.decision.action,"report_to_user");}
   else f.db.workerMessages.applyProgressDecision(t.current_attempt_id,event,candidate.decision_id,at);
  }
 }finally{await f.dispose();}
});
