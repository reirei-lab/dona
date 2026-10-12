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
